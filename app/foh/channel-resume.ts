/**
 * The ONE seam between "which channel homes this eve session" and "how do we deliver an answer
 * back into it" (WS1). Every future channel pays this cost once, here — nothing github-specific
 * belongs in the UI, the stream route, or the drain.
 *
 * Background (all three proven against a production run on 2026-07-26/27):
 *
 *  - eve homes a channel-dispatched session ON that channel. Its continuation token is
 *    namespaced `"<channel>:<raw>"`, and eve resolves it only through the owning channel:
 *    POSTing a GitHub-homed session's own byte-exact token to the built-in
 *    `POST /eve/v1/session/:id` with `inputResponses` returns HTTP 500 "Cannot deliver
 *    inputResponses — the target session was not found via continuation token".
 *  - eve's channel-side `send()` RE-PREFIXES the channel name (`${channelName}:${token}`), so
 *    the token handed back to it must have the namespace STRIPPED or the resume looks for
 *    `github:github:…` and misses.
 *  - a stateful channel's `SendOptions` requires `state`, and eve does not export
 *    `continuationTokenFromState`, so harnesst cannot recompute either half — both must be
 *    persisted at park time. That is what `SessionResumeVia` is.
 *
 * The allowlist is a security control, not bookkeeping: `routePath` arrives from an agent
 * container and is later concatenated into an outbound URL. It is never taken verbatim.
 */
import type { SessionResumeVia } from "~/db/schema";

/**
 * Channels that can home a resumable session, mapped to the answer route their harnesst-authored
 * channel template registers. Adding a channel means adding its route here AND shipping the
 * matching template route — nothing else in the answer path changes.
 */
export const CHANNEL_ANSWER_ROUTES = {
  github: "/eve/v1/github/harnesst/answer",
} as const satisfies Record<string, string>;

export type ResumeChannel = keyof typeof CHANNEL_ANSWER_ROUTES;

export function isResumeChannel(value: unknown): value is ResumeChannel {
  return typeof value === "string" && value in CHANNEL_ANSWER_ROUTES;
}

/** The answer route harnesst will POST to for this channel, or null if it homes nothing. */
export function answerRouteFor(channel: string): string | null {
  return isResumeChannel(channel) ? CHANNEL_ANSWER_ROUTES[channel] : null;
}

/**
 * Drop the `"<channel>:"` namespace eve prepends, exactly once. A token that does not carry the
 * prefix comes back verbatim — never guess, and never strip twice (`github:repo:1:issue:2` must
 * become `repo:1:issue:2`, not `1:issue:2`).
 */
export function stripChannelNamespace(channel: string, token: string): string {
  const prefix = `${channel}:`;
  return token.startsWith(prefix) ? token.slice(prefix.length) : token;
}

/**
 * Build the persisted descriptor from what an agent container reported. Returns null when the
 * channel is unknown or the claimed route path is not the one harnesst registers for it — a
 * container must not be able to aim harnesst's authenticated POST at an arbitrary path.
 */
export function buildResumeVia(input: {
  channel: string;
  routePath: string;
  /** The token as eve reported it to the handler (namespaced). */
  continuationToken: string;
  state: Record<string, unknown>;
}): SessionResumeVia | null {
  const routePath = answerRouteFor(input.channel);
  if (!routePath || routePath !== input.routePath) return null;
  if (!input.continuationToken) return null;
  return {
    channel: input.channel,
    routePath,
    rawToken: stripChannelNamespace(input.channel, input.continuationToken),
    state: input.state,
  };
}

/** What `streamTurn` needs to aim a delivery at a channel route instead of eve's session route. */
export interface ChannelDelivery {
  routePath: string;
  rawToken: string;
  state: Record<string, unknown>;
  bearer: string;
}

/**
 * The delivery descriptor for a session row, or null for an ordinary HTTP-homed session (the
 * overwhelming majority — playground, assistant, and relay-parked FOH rows all take the
 * unchanged path).
 *
 * Re-validates the stored `routePath` against the allowlist on the way OUT as well as in: a row
 * written by an older/looser build, or by hand, must not become a request aimed anywhere else.
 * `bearer` is minted for the deployment resolved at ANSWER time — a redeploy rotates the
 * container's baked `HARNESST_TEAM_TOKEN`, so a token minted at park time would 401.
 */
export function channelDeliveryFor(
  session: { resumeVia?: SessionResumeVia | null },
  bearer: string,
): ChannelDelivery | null {
  const via = session.resumeVia;
  if (!via) return null;
  const routePath = answerRouteFor(via.channel);
  if (!routePath || routePath !== via.routePath) return null;
  if (!via.rawToken) return null;
  return {
    routePath,
    rawToken: via.rawToken,
    state: via.state ?? {},
    bearer,
  };
}
