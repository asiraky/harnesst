import { createSign, randomUUID, timingSafeEqual } from "node:crypto";

import { POST } from "eve/channels";
import {
  githubChannel,
  type GitHubChannelState,
  type GitHubEventContext,
  type GitHubInboundContext,
  type GitHubInboundResult,
  type GitHubIssueEvent,
  type GitHubPullRequestEvent,
} from "eve/channels/github";
import type { SandboxSession } from "eve/sandbox";

// PLATFORM-OWNED. This file lives under `harnesst/`, sibling to `agent/`, because eve claims every
// directory inside the agent root and a helper under `agent/channels/` would be discovered as a
// channel (or as a discovery error). It is rewritten in full by every marketplace update and
// verified against a recorded hash at publish time — do not edit it. The customer's file is the
// three-line `agent/channels/github.ts` that imports this factory; that one is written once, at
// install, and never touched again. An earlier release shipped this body inside `agent/` and an
// update overwrote two agents' customisations, which is the whole reason for the split.
//
// GitHub App credentials come from the GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY /
// GITHUB_WEBHOOK_SECRET environment variables, and the bot name from GITHUB_APP_SLUG (set them as
// agent secrets in harnesst). @mention the app in an issue or pull-request comment to start a turn.
//
// Four things are layered on top of eve's stock channel.
//
// The first two are ONE problem: when the agent needs a human answer before it can continue, eve
// raises `input.requested` — and stock `githubChannel` installs no handler for it, so the
// question dies inside the container. It is not posted to the issue and it never reaches
// harnesst.
//
//   1. an `input.requested` handler that files the question to harnesst's Front of House inbox —
//      or, when there is no inbox to file it to, posts it on the thread instead. One or the
//      other, never both: see the handler for why the duplicate is worse than useless;
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
//      why its failure was invisible;
//   4. `onIssue` / `onPullRequest` wake rules — see the WAKE block. eve dispatches nothing for
//      these webhooks by default, so without them the only way to reach the agent is an @mention.

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
// WAKE
//
// eve dispatches `issues` and `pull_request` webhooks only if `onIssue`/`onPullRequest` are
// defined — there is no default. So an agent that should notice a `ready` label, or a new issue,
// or a fresh push to a PR it is reviewing, has to be woken here.
//
// Which events wake it is CONFIGURATION, not code: the operator sets repositories, wake labels and
// wake-on-new-issues on the agent's Deployment tab, harnesst stores them in the marketplace lock
// and projects them into this container as `HARNESST_CHANNEL_GITHUB_*`. The whole namespace is
// harnesst-owned and swept on every deploy, so a stale rule cannot survive a change.
//
// Absent or empty reads as INERT — no repositories configured means no branch dispatches. Taking
// this update must not change any existing agent's behaviour: no surprise turns, no surprise spend.
//
// Two properties carry the design:
//
//   - Self-suppression is a SENDER check, not a bot check, and it is CASE-FOLDED. GitHub logins
//     are case-preserving, so an exact-case comparison silently falls open and the agent wakes
//     itself on its own label — an unbounded loop that costs money. It is a sender check because
//     another agent's bot labelling this repo SHOULD wake this agent; only its own must not.
//   - Dispatch keys off the TRANSITION — `raw.label.name`, the label that was just added — never a
//     re-read of the issue's current labels. Re-reading is how one edit came to match three rules.
//
// The context handed to the agent is deliberately mechanism-free: it names what happened and
// refuses to say what to do, because the policy lives in the customer's `instructions.md`. An
// agent told "you were woken because X, therefore do Y" stops reading its own instructions.
// ---------------------------------------------------------------------------

/** The wake rules, as the operator set them on the Deployment tab. */
export interface GitHubWakeSettings {
  /** `owner/repo` entries. EMPTY MEANS INERT — not "every repository". */
  readonly repos: readonly string[];
  /** Label names that wake the agent when applied to an issue or pull request. */
  readonly wakeLabels: readonly string[];
  /** Whether a newly opened or reopened issue wakes the agent. */
  readonly wakeOnNewIssues: boolean;
  /** This agent's own App slug, for self-suppression. Empty = nothing to suppress against. */
  readonly appSlug: string;
}

/** One normalised `issues` / `pull_request` webhook, flattened so the predicate needs no eve. */
export interface GitHubWakeEvent {
  readonly kind: "issue" | "pull_request";
  readonly action: string;
  readonly number: number;
  /** `raw.label.name` — the label just added. Null for every non-label action. */
  readonly label: string | null;
  readonly headSha: string | null;
  readonly repoFullName: string;
  readonly senderLogin: string;
}

/** Comma-separated env list → trimmed, non-empty entries. Absent or empty yields none. */
function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

const WAKE_SETTINGS: GitHubWakeSettings = {
  repos: splitList(process.env.HARNESST_CHANNEL_GITHUB_REPOS),
  wakeLabels: splitList(process.env.HARNESST_CHANNEL_GITHUB_WAKE_LABELS),
  // Rendered `"1"` when on and empty/absent when off, so anything falsy is off.
  wakeOnNewIssues: ["1", "true"].includes(
    (process.env.HARNESST_CHANNEL_GITHUB_WAKE_ON_NEW_ISSUES ?? "").toLowerCase(),
  ),
  appSlug: process.env.GITHUB_APP_SLUG ?? "",
};

/** Case-folded membership. GitHub is case-insensitive about repo and label names; operators aren't. */
function includesFolded(list: readonly string[], value: string): boolean {
  const needle = value.trim().toLowerCase();
  return list.some((entry) => entry.trim().toLowerCase() === needle);
}

/** The label a `labeled` webhook just added. Anything else — including `unlabeled` — has none. */
function transitionLabel(raw: unknown): string | null {
  const label = (raw as { label?: { name?: unknown } } | null | undefined)?.label;
  return typeof label?.name === "string" && label.name.length > 0 ? label.name : null;
}

/**
 * The wake predicate — pure, and the single place the rules live.
 *
 * Returns the model-visible context line to dispatch with, or `null` to ignore the event. Pure so
 * it can be driven directly in tests: catalog files are excluded from typecheck and import `eve`,
 * which the control plane does not depend on, so a predicate tangled into the channel factory
 * would only ever be exercised in production.
 */
export function githubWakeContext(
  event: GitHubWakeEvent,
  settings: GitHubWakeSettings,
): string | null {
  // FIRST, before any rule can match: never wake on our own action. Checked case-folded, because
  // `sender.login` preserves whatever case GitHub minted the App under.
  if (
    settings.appSlug &&
    event.senderLogin.toLowerCase() === `${settings.appSlug}[bot]`.toLowerCase()
  ) {
    return null;
  }
  if (!includesFolded(settings.repos, event.repoFullName)) return null;

  const subject = event.kind === "issue" ? `issue #${event.number}` : `pull request #${event.number}`;
  const head = event.headSha ? ` (head ${event.headSha.slice(0, 7)}…)` : "";
  const where = `by @${event.senderLogin} in ${event.repoFullName}${head}`;
  const describe = (what: string) => `GitHub event: ${subject} ${what} ${where}.`;

  const labelled =
    event.action === "labeled" &&
    event.label !== null &&
    includesFolded(settings.wakeLabels, event.label)
      ? describe(`labeled "${event.label}"`)
      : null;

  let what: string | null = null;
  if (event.kind === "issue") {
    if (event.action === "opened" || event.action === "reopened") {
      what = settings.wakeOnNewIssues ? describe(event.action) : null;
    } else {
      what = labelled;
    }
  } else if (event.action === "synchronize") {
    what = describe("updated with new commits");
  } else if (event.action === "ready_for_review") {
    what = describe("marked ready for review");
  } else {
    what = labelled;
  }
  // Everything else — unlabeled, closed, edited, assigned — falls through as null.
  if (what === null) return null;

  return [
    what,
    "Decide from your instructions whether this is yours to act on.",
    "If the work is already done, or belongs to someone else, do nothing and post nothing.",
  ].join(" ");
}

/** eve dispatches on `{auth}` and ignores on `null`; `auth: null` means "no delegated identity". */
function wakeResult(context: string | null): GitHubInboundResult {
  return context === null ? null : { auth: null, context: [context] };
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

/**
 * Teach git that the checkout directory is ours to touch.
 *
 * The sandbox mounts the workspace with an owner uid that is not the uid git runs as, so every
 * git command inside it dies with `fatal: detected dubious ownership in repository at
 * '/workspace'` (exit 128) — including the very first `git remote add`, which is where the
 * checkout used to fail outright. Adding the path to the REAL global config (not the scoped
 * credential file below, which is torn down after the fetch) matters because the agent runs its
 * own `git status` / `git diff` in this directory for the rest of the session.
 *
 * `--add` is not idempotent and the sandbox outlives a single checkout, so the entry is only
 * appended when it is not already there — otherwise a long session accumulates duplicates.
 */
async function allowGitInDirectory(sandbox: SandboxSession, dir: string): Promise<void> {
  const quoted = shellQuote(dir);
  const result = await sandbox.run({
    command: `git config --global --get-all safe.directory 2>/dev/null | grep -qxF ${quoted} || git config --global --add safe.directory ${quoted}`,
  });
  if (result.exitCode !== 0) {
    // Not fatal on its own: the scoped config the fetch runs under carries the same entry, and
    // a workspace that git is already happy with needs none of this. Worth a line in the log
    // when the agent's own later git commands start failing.
    console.error(
      `[harnesst] github checkout: marking ${dir} as a safe git directory failed (exit ${result.exitCode})`,
    );
  }
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

  // Before ANY git command, including the reuse probe below — an ownership rejection there
  // would otherwise read as "not on the target commit" and re-clone on every single event.
  await allowGitInDirectory(sandbox, dir);

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

  // `GIT_CONFIG_GLOBAL` REPLACES ~/.gitconfig rather than layering over it, so the fetch runs
  // blind to the safe.directory entry written above — it has to be repeated here.
  await sandbox.writeTextFile({
    path: configPath,
    content:
      `[http "https://github.com/"]\n\textraHeader = Authorization: ${authorization}\n` +
      `[safe]\n\tdirectory = ${dir}\n`,
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
    // `send()` only THROWS on a failed delivery when `inputResponses` is non-empty. With an
    // empty array it silently falls back to `run()` and starts a brand-new session from the
    // `state` in this request — which on this channel means posting a fresh comment on whatever
    // owner/repo/issue the caller named. This route exists to answer a pending question; it must
    // never be the way a new thread gets opened.
    if (!body.inputResponses || body.inputResponses.length === 0) {
      return Response.json(
        { ok: false, error: "inputResponses must name at least one pending request" },
        { status: 400 },
      );
    }
    try {
      const session = await send(
        {
          inputResponses: body.inputResponses,
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
      const message = redactSecrets(
        error instanceof Error ? error.message : String(error),
      ).slice(0, 500);
      // TWO different failures, and conflating them told the human a confident lie. eve throws
      // "not found via continuation token" when the token names no live session — the usual
      // cause is a redeploy, which takes the container's in-process session state with it.
      // Nothing is broken there; the session this answer belonged to is simply gone, and
      // harnesst says exactly that and recovers. A GitHub outage, an expired installation
      // token, a malformed state or a model error is NOT that, and reporting it as a redeploy
      // sent people looking in the wrong place. Those are 500s carrying their own message.
      const gone =
        /not found|no such session|unknown session|continuation token|session (?:has )?expired/iu.test(
          message,
        );
      return Response.json(
        { ok: false, code: gone ? "session_gone" : "send_failed", error: message },
        { status: gone ? 409 : 500 },
      );
    }
  },
);

/**
 * The channel the customer's `agent/channels/github.ts` default-exports. A factory rather than a
 * ready-made object so the customer file reads as a call they own, and so nothing here runs in a
 * process that merely imports the module.
 */
export function harnesstGitHubChannel() {
  const base = githubChannel({
    /**
     * A newly opened issue, or a wake label landing on an issue. eve dispatches nothing for
     * `issues` webhooks unless this hook exists — see the WAKE block.
     */
    onIssue(ctx: GitHubInboundContext, issue: GitHubIssueEvent): GitHubInboundResult {
      return wakeResult(
        githubWakeContext(
          {
            kind: "issue",
            action: issue.action,
            number: issue.issueNumber,
            label: transitionLabel(issue.raw),
            headSha: null,
            repoFullName: ctx.repository.fullName,
            senderLogin: ctx.sender.login,
          },
          WAKE_SETTINGS,
        ),
      );
    },

    /** A wake label, a new push, or a draft becoming reviewable. Same rules, same settings. */
    onPullRequest(
      ctx: GitHubInboundContext,
      pullRequest: GitHubPullRequestEvent,
    ): GitHubInboundResult {
      return wakeResult(
        githubWakeContext(
          {
            kind: "pull_request",
            action: pullRequest.action,
            number: pullRequest.pullRequestNumber,
            label: transitionLabel(pullRequest.raw),
            headSha: pullRequest.headSha,
            repoFullName: ctx.repository.fullName,
            senderLogin: ctx.sender.login,
          },
          WAKE_SETTINGS,
        ),
      );
    },

    events: {
      /**
       * Acknowledge, then put the repository in front of the agent.
       *
       * An override REPLACES eve's built-in `turn.started`, so the eyes reaction it posts has to
       * be re-asserted here or it silently disappears. The checkout is ours because eve's cannot
       * run on a Docker sandbox at all (see the CHECKOUT block above).
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
          // NEVER swallow. eve's built-in does, which is how an agent came to answer three turns
          // of a real issue with an empty workspace and nothing anywhere said so.
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
       * The agent stopped to ask. ONE question goes to ONE place: a person who needs an answer
       * asks in the inbox or on the thread, not both — asking twice reads as two questions, and
       * the copy on the issue is un-answerable anyway (a comment reply starts a NEW turn; only
       * the park's answer route resumes the session that is actually waiting).
       *
       * So: park it when harnesst wired a park up, and post it on the thread only when that is
       * not possible — no park configured (a self-hosted eve), or the park refused or never
       * answered. The thread is the fallback, not the duplicate; better a question in the wrong
       * place than a question that dies inside the container, which is the whole failure this
       * handler exists to close. Either way the turn survives.
       */
      async "input.requested"(event, channel, ctx) {
        const body = event.requests.map(renderRequest).join("\n\n---\n\n");
        const postToThread = async () => {
          try {
            await channel.thread.post(
              `I need input before I can continue:\n\n${body}`,
            );
          } catch (error) {
            console.error(
              "[harnesst] posting the question to GitHub failed",
              error,
            );
          }
        };

        if (!PARK_URL || !TEAM_TOKEN) {
          await postToThread();
          return;
        }
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
            await postToThread();
          }
        } catch (error) {
          console.error("[harnesst] park failed", error);
          await postToThread();
        }
      },
    },
  });

  return { ...base, routes: [...base.routes, answerRoute] };
}
