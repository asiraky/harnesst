import { createSign, randomUUID, timingSafeEqual } from "node:crypto";

import { POST } from "eve/channels";
import {
  githubChannel,
  type GitHubChannelState,
  type GitHubEventContext,
} from "eve/channels/github";
import type { SandboxSession } from "eve/sandbox";

// GitHub App credentials come from the GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY /
// GITHUB_WEBHOOK_SECRET environment variables, and the bot name from
// GITHUB_APP_SLUG (set them as agent secrets in harnesst). @mention the app in an
// issue or pull-request comment to start a turn.
//
// Three things are layered on top of eve's stock channel.
//
// The first two are ONE problem: when the agent needs a human answer before it can continue, eve
// raises `input.requested` — and stock `githubChannel` installs no handler for it, so the
// question dies inside the container. It is not posted to the issue and it never reaches
// harnesst.
//
//   1. an `input.requested` handler that posts the question on the thread AND files it to
//      harnesst's Front of House inbox, so it can be seen from either side;
//   2. an answer route registered ON THIS CHANNEL, which harnesst POSTs the human's answer to.
//
// (2) cannot be replaced by eve's built-in `POST /eve/v1/session/:id`. A session dispatched from
// this channel is OWNED by it: its continuation token is namespaced `github:…` and eve resolves
// it only through the channel that homed it. Delivering `inputResponses` through the HTTP
// session route fails with "the target session was not found via continuation token". Only a
// route defined here holds this channel's own `send`.
//
//   3. a `turn.started` handler that checks the repository out itself — see the CHECKOUT block
//      below for why eve's built-in one cannot work on a self-hosted (Docker-sandbox) agent, and
//      why its failure was invisible.

/** Set by harnesst at deploy time. Empty (self-hosted eve, or no lock entry) = park disabled. */
const PARK_URL = process.env.HARNESST_FOH_PARK_URL ?? "";
/** The deployment-scoped delegation token harnesst bakes in; used in BOTH directions. */
const TEAM_TOKEN = process.env.HARNESST_TEAM_TOKEN ?? "";
const ANSWER_ROUTE = "/eve/v1/github/harnesst/answer";

/**
 * eve does not authenticate channel routes (an `HttpRouteDefinition` has no auth field) and this
 * instance is reachable through a public ingress, so the route authenticates itself. Without a
 * baked token there is nothing to compare against — REFUSE, never fall open: an unauthenticated
 * answer route would let anyone inject `inputResponses` into a live agent session.
 */
function bearerOk(request: Request): boolean {
  if (!TEAM_TOKEN) return false;
  const presented = (request.headers.get("authorization") ?? "").replace(
    /^Bearer\s+/i,
    "",
  );
  const a = Buffer.from(presented);
  const b = Buffer.from(TEAM_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Render one parked request as GitHub-flavoured markdown. */
function renderRequest(request: {
  prompt: string;
  options?: readonly { id: string; label: string; description?: string }[];
}): string {
  const options = (request.options ?? []).map(
    (option) =>
      `- **${option.label}**${option.description ? ` — ${option.description}` : ""}`,
  );
  return [request.prompt, ...(options.length > 0 ? ["", ...options] : [])].join(
    "\n",
  );
}

// ---------------------------------------------------------------------------
// CHECKOUT
//
// eve's built-in `turn.started` checks the repository out into the sandbox, and on a harnesst
// agent it has NEVER succeeded — silently. Its first await is
// `sandbox.setNetworkPolicy(brokerPolicy)`, which brokers the installation token as an
// `Authorization` header at the sandbox firewall (the remote URL it clones from carries no
// credential at all). The Docker sandbox backend accepts only the policies `"allow-all"` and
// `"deny-all"`, so it throws — before `mkdir`, before `git init`. Nothing is created, nothing is
// fetched, and eve's handler catches the error and logs it at debug level inside the container.
// The turn then runs normally and the agent answers about a repository it never read.
//
// harnesst deploys agents as Docker containers with the host docker socket mounted precisely so
// eve picks the Docker backend, so this is not a misconfiguration we can undo: the alternatives
// are Vercel (abandons self-hosting) and microsandbox (needs KVM). `GitHubChannelConfig` exposes
// no checkout option, so there is no supported way to configure the built-in out of the way
// either. Overriding `turn.started` is the whole surface — and eve documents that an override
// REPLACES the built-in for that key, which is why the eyes reaction is re-asserted here too.
//
// So we do the same checkout with the credential in the request instead of at the firewall: mint
// an installation token from the App's own credentials and hand it to git through an
// `http.extraHeader` in a throwaway config file. That works because the sandbox's standing
// network policy is already `allow-all` and we never call `setNetworkPolicy`.
//
// Losing firewall brokering is a real, if small, hygiene regression against upstream: the token
// is briefly readable inside the sandbox. It is scoped to the App installation, short-lived
// (~1h), never written to `.git/config`, never passed on a command line, and the file holding it
// is deleted as soon as the fetch returns.
//
// The other half of the fix is that a failure is no longer swallowed. When the checkout fails the
// agent says so on the thread, immediately above the answer it is about to give, so a reader can
// tell "read the repo and answered" from "answered blind".
// ---------------------------------------------------------------------------

/** Where the repository is checked out. eve's default, and the sandbox's working directory. */
const CHECKOUT_PATH = "/workspace";
/** Overridable for GitHub Enterprise Server; matches eve's `api.apiBaseUrl` default. */
const GITHUB_API_URL = process.env.GITHUB_API_URL ?? "https://api.github.com";
const FULL_SHA = /^[a-f0-9]{40}$/iu;

/** Single-quote a value for `sh -c`, the way eve's own checkout does. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

/**
 * Strip anything shaped like a GitHub credential. Checkout failures are echoed onto a public
 * issue thread, and git is perfectly capable of quoting a request header back at you in an error.
 */
function redactSecrets(text: string): string {
  return text.replace(
    /\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|v1\.[a-f0-9]{40})\b/gu,
    "[redacted]",
  );
}

/** Cached per installation, like eve's own token cache — `turn.started` fires on every turn. */
const tokenCache = new Map<number, { expiresAtMs: number; token: string }>();

/** RS256 App JWT. Reimplemented because eve exports no runtime helper from `channels/github`. */
function createAppJwt(): string {
  const appId = process.env.GITHUB_APP_ID ?? "";
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY ?? "";
  if (!appId) throw new Error("GITHUB_APP_ID is not set on this agent");
  if (!privateKey) throw new Error("GITHUB_APP_PRIVATE_KEY is not set on this agent");
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    exp: now + 540,
    iat: now - 60,
    iss: appId,
  })}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    // Secrets storage round-trips PEMs through JSON, so a literal "\n" is common.
    .sign(privateKey.replace(/\\n/gu, "\n"), "base64url");
  return `${signingInput}.${signature}`;
}

async function resolveInstallationToken(installationId: number): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && Date.now() < cached.expiresAtMs - 60_000) return cached.token;

  const response = await fetch(
    `${GITHUB_API_URL}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${createAppJwt()}`,
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  if (!response.ok) {
    throw new Error(
      `minting an installation token for installation ${installationId} failed with HTTP ${response.status}`,
    );
  }
  const body = (await response.json()) as { expires_at?: string; token?: string };
  if (typeof body?.token !== "string" || body.token.length === 0) {
    throw new Error("the installation token response carried no token");
  }
  const expiresAtMs = Number.isFinite(Date.parse(body.expires_at ?? ""))
    ? Date.parse(body.expires_at ?? "")
    : Date.now() + 3_600_000;
  tokenCache.set(installationId, { expiresAtMs, token: body.token });
  return body.token;
}

/** Which ref this conversation is about. Mirrors eve's precedence, minus the PR metadata call. */
async function resolveCheckoutRef(channel: GitHubEventContext): Promise<string> {
  const state = channel.state;
  if (state.headSha) return state.headSha;
  if (state.pullRequestNumber !== null) {
    return `refs/pull/${state.pullRequestNumber}/head`;
  }
  if (state.headRef) return state.headRef;
  if (state.defaultBranch) return state.defaultBranch;
  // `channel.github` already authenticates as the installation, so this needs no token of ours.
  const repository = await channel.github.request<{ default_branch?: string }>({
    method: "GET",
    path: `/repos/${state.owner}/${state.repo}`,
  });
  const defaultBranch = repository.body?.default_branch;
  if (typeof defaultBranch === "string" && defaultBranch.length > 0) {
    state.defaultBranch = defaultBranch;
    return defaultBranch;
  }
  throw new Error(
    "could not work out which ref to check out (no head sha, pull request, head ref or default branch)",
  );
}

async function runOrThrow(
  sandbox: SandboxSession,
  command: string,
  label: string,
): Promise<{ stdout: string }> {
  const result = await sandbox.run({ command });
  const stdout = String(result.stdout ?? "");
  if (result.exitCode !== 0) {
    const detail = String(result.stderr ?? "").trim() || stdout.trim();
    throw new Error(
      `${label} failed (exit ${result.exitCode})${detail ? `: ${detail}` : ""}`,
    );
  }
  return { stdout };
}

async function checkoutRepository(
  sandbox: SandboxSession,
  channel: GitHubEventContext,
): Promise<{ baseRef: string | null; path: string; sha: string }> {
  const state = channel.state;
  if (state.installationId === null) {
    throw new Error("this conversation's channel state carries no GitHub App installation id");
  }

  const dir = sandbox.resolvePath(CHECKOUT_PATH);
  const ref = await resolveCheckoutRef(channel);

  // The sandbox persists for the whole session, so when the workspace already sits on the target
  // commit this is a no-op probe — no token is minted and nothing is fetched.
  if (FULL_SHA.test(ref)) {
    const head = await sandbox.run({
      command: `cd ${shellQuote(dir)} && git rev-parse HEAD 2>/dev/null`,
    });
    if (
      head.exitCode === 0 &&
      String(head.stdout ?? "").trim().toLowerCase() === ref.toLowerCase()
    ) {
      return { baseRef: state.baseRef, path: dir, sha: ref };
    }
  }

  const token = await resolveInstallationToken(state.installationId);
  const authorization = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  // Written as a file rather than passed as `git -c …`: a command line is visible to anything
  // running in the sandbox, and `.git/config` would leave the credential in the workspace the
  // model can read. The URL-scoped section also stops git offering the header to any other host.
  const configPath = `/tmp/.harnesst-git-${randomUUID()}`;
  const gitEnv = `GIT_CONFIG_GLOBAL=${shellQuote(configPath)} GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0`;
  const remote = `https://github.com/${state.owner}/${state.repo}.git`;
  const target = FULL_SHA.test(ref) ? ref : "FETCH_HEAD";

  await sandbox.writeTextFile({
    path: configPath,
    content: `[http "https://github.com/"]\n\textraHeader = Authorization: ${authorization}\n`,
  });
  try {
    await runOrThrow(sandbox, `mkdir -p ${shellQuote(dir)}`, "creating the checkout directory");
    await runOrThrow(
      sandbox,
      `cd ${shellQuote(dir)} && git init -q`,
      "initialising the git repository",
    );
    await sandbox.run({
      command: `cd ${shellQuote(dir)} && git remote remove origin >/dev/null 2>&1 || true`,
    });
    await runOrThrow(
      sandbox,
      `cd ${shellQuote(dir)} && git remote add origin ${shellQuote(remote)}`,
      "configuring the git remote",
    );
    await runOrThrow(
      sandbox,
      `cd ${shellQuote(dir)} && ${gitEnv} git fetch --depth 1 origin ${shellQuote(ref)}`,
      `fetching ${ref}`,
    );
    await runOrThrow(
      sandbox,
      `cd ${shellQuote(dir)} && git checkout --detach ${shellQuote(target)}`,
      "checking out the fetched ref",
    );
    const diffBase = state.baseSha ?? state.baseRef;
    if (state.pullRequestNumber !== null && diffBase) {
      // Best effort. The diff base makes review possible, but its absence is not a failed
      // checkout — the head ref is already in the workspace and the agent can read the code.
      const fetched = await sandbox.run({
        command: `cd ${shellQuote(dir)} && ${gitEnv} git fetch --depth 1 origin ${shellQuote(diffBase)}`,
      });
      if (fetched.exitCode !== 0) {
        console.error(
          `[harnesst] github checkout: fetching the pull request base ${diffBase} failed — continuing without it`,
        );
      }
    }
  } finally {
    // Narrow the window in which the credential exists inside the sandbox at all.
    await sandbox
      .run({ command: `rm -f ${shellQuote(configPath)}` })
      .catch(() => undefined);
  }

  const head = await runOrThrow(
    sandbox,
    `cd ${shellQuote(dir)} && git rev-parse HEAD`,
    "resolving the checked-out commit",
  );
  return {
    baseRef: state.baseRef,
    path: dir,
    sha: head.stdout.trim() || state.headSha || ref,
  };
}

const base = githubChannel({
  events: {
    /**
     * Acknowledge, then put the repository in front of the agent.
     *
     * An override REPLACES eve's built-in `turn.started`, so the eyes reaction it posts has to be
     * re-asserted here or it silently disappears. The checkout is ours because eve's cannot run
     * on a Docker sandbox at all (see the CHECKOUT block above).
     */
    async "turn.started"(_event, channel, ctx) {
      try {
        await channel.thread.react("eyes");
      } catch (error) {
        console.error("[harnesst] reacting to the GitHub comment failed", error);
      }

      try {
        const checkout = await checkoutRepository(await ctx.getSandbox(), channel);
        channel.state.checkoutPath = checkout.path;
        channel.state.headSha = checkout.sha;
        channel.state.baseRef = checkout.baseRef;
      } catch (error) {
        // NEVER swallow. eve's built-in does, which is how an agent came to answer three turns of
        // a real issue with an empty workspace and nothing anywhere said so.
        channel.state.checkoutPath = null;
        const detail = redactSecrets(
          error instanceof Error ? error.message : String(error),
        )
          .replace(/`/gu, "'")
          .slice(0, 1200);
        console.error(
          `[harnesst] github checkout failed for ${channel.state.owner}/${channel.state.repo}: ${detail}`,
        );
        try {
          await channel.thread.react("confused");
        } catch {
          // A missing reaction must not cost us the comment below, which is the real signal.
        }
        try {
          await channel.thread.post(
            [
              `**I could not check out \`${channel.state.owner}/${channel.state.repo}\` into my workspace.**`,
              "",
              "Anything I say next is answered without the repository in front of me — treat it as a guess about the code rather than a reading of it.",
              "",
              "```",
              detail,
              "```",
            ].join("\n"),
          );
        } catch (postError) {
          console.error(
            "[harnesst] posting the checkout failure to GitHub failed",
            postError,
          );
        }
      }
    },

    /**
     * The agent stopped to ask. Post the question on the thread so the conversation stays
     * readable where it happened, then file it to harnesst so a human can answer it there and
     * resume this exact session. Best-effort: a park that fails must not take the turn down —
     * the question is still on the issue.
     */
    async "input.requested"(event, channel, ctx) {
      const body = event.requests.map(renderRequest).join("\n\n---\n\n");
      try {
        await channel.thread.post(
          `I need input before I can continue:\n\n${body}`,
        );
      } catch (error) {
        console.error("[harnesst] posting the question to GitHub failed", error);
      }

      if (!PARK_URL || !TEAM_TOKEN) return;
      try {
        const response = await fetch(PARK_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${TEAM_TOKEN}`,
          },
          body: JSON.stringify({
            channel: "github",
            routePath: ANSWER_ROUTE,
            eveSessionId: ctx.session.id,
            // Namespaced, exactly as eve reports it. harnesst strips the namespace before
            // handing it back — eve's `send()` re-prefixes the channel name.
            continuationToken: channel.continuationToken,
            state: channel.state,
            title: channel.state.issueNumber
              ? `${channel.state.owner}/${channel.state.repo}#${channel.state.issueNumber}`
              : `${channel.state.owner}/${channel.state.repo}`,
            requests: event.requests.map((request) => ({
              requestId: request.requestId,
              prompt: request.prompt,
              display: request.display ?? null,
              allowFreeform: request.allowFreeform ?? null,
              options: request.options ?? [],
            })),
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          console.error(
            `[harnesst] park returned ${response.status} ${response.statusText}`,
          );
        }
      } catch (error) {
        console.error("[harnesst] park failed", error);
      }
    },
  },
});

/**
 * harnesst delivers a human's Front of House answer here, so the resume runs through THIS
 * channel's `send` and the agent's reply lands back on the issue thread.
 *
 * `continuationToken` arrives RAW (harnesst stripped the `github:` namespace); `state` is the
 * channel state round-tripped from the park, required by `SendOptions` for a stateful channel.
 */
const answerRoute = POST<GitHubChannelState>(
  ANSWER_ROUTE,
  async (request, { send }) => {
    if (!bearerOk(request)) {
      return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    let body: {
      continuationToken?: string;
      state?: GitHubChannelState;
      message?: string;
      inputResponses?: { requestId: string; optionId?: string; text?: string }[];
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json(
        { ok: false, error: "malformed JSON body" },
        { status: 400 },
      );
    }
    if (!body.continuationToken || !body.state) {
      return Response.json(
        { ok: false, error: "continuationToken and state are required" },
        { status: 400 },
      );
    }
    try {
      const session = await send(
        {
          inputResponses: body.inputResponses ?? [],
          ...(body.message ? { message: body.message } : {}),
        },
        {
          auth: null,
          continuationToken: body.continuationToken,
          state: body.state,
        },
      );
      return Response.json({ ok: true, sessionId: session.id });
    } catch (error) {
      // eve throws when the token names no live session — the usual cause is a redeploy, which
      // takes the container's in-process session state with it. 409, not 500: nothing is broken,
      // the session this answer belonged to is simply gone.
      return Response.json(
        { ok: false, error: (error as Error).message },
        { status: 409 },
      );
    }
  },
);

export default { ...base, routes: [...base.routes, answerRoute] };
