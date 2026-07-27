import { timingSafeEqual } from "node:crypto";

import { POST } from "eve/channels";
import { githubChannel, type GitHubChannelState } from "eve/channels/github";

// GitHub App credentials come from the GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY /
// GITHUB_WEBHOOK_SECRET environment variables, and the bot name from
// GITHUB_APP_SLUG (set them as agent secrets in harnesst). @mention the app in an
// issue or pull-request comment to start a turn.
//
// Two things are layered on top of eve's stock channel, both about ONE problem: when the agent
// needs a human answer before it can continue, eve raises `input.requested` — and stock
// `githubChannel` installs no handler for it, so the question dies inside the container. It is
// not posted to the issue and it never reaches harnesst.
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

const base = githubChannel({
  events: {
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
