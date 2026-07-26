/**
 * Cross-redeploy conversation seed (#71).
 *
 * When a playground follow-up lands on a deployment that did NOT create the conversation's eve
 * session (the owning container was replaced, or a different deployment was explicitly selected),
 * the eve-side runtime context is gone — it died with the old container and can't be migrated. So
 * instead of dead-ending the user, harnesst seeds a FRESH eve session on the replacement deployment
 * from its own durable transcript cache (`playground_events`): the prior conversation is rendered
 * into a plain-text block and prepended to the first message on the new session, so the agent
 * continues with the history in context.
 *
 * That block must be invisible to the human transcript. It rides inside the durable
 * `message.received` event (same as the model directive), so it is wrapped in strippable
 * HTML-comment markers and removed on replay — see `stripSeedContext`, called alongside
 * `stripModelDirective` in `projectEventsToEntries`.
 */
import type { ChatEntry } from "~/chat/types";

export const SEED_CONTEXT_START = "<!-- harnesst:context-start -->";
export const SEED_CONTEXT_END = "<!-- harnesst:context-end -->";

/** Cap per message so one huge turn can't dominate the seed. */
const MAX_MESSAGE_CHARS = 4_000;
/** Cap on the whole transcript body; newest messages are kept when it overflows. */
const MAX_BODY_CHARS = 24_000;
const OMITTED_NOTE = "[Earlier messages were omitted to fit.]";
const INSTRUCTION =
  "[harnesst] This conversation continues from a previous deployment of this agent that has since been replaced, so your runtime context was reset. The transcript so far is below. Continue the conversation naturally; do not mention the reset unless asked.";

/** Truncate a single message and de-fang the end marker so content can't break the wrapper. */
function sanitize(text: string): string {
  const stripped = text.replaceAll(SEED_CONTEXT_END, "");
  const collapsed = stripped.trim();
  if (collapsed.length <= MAX_MESSAGE_CHARS) return collapsed;
  return `${collapsed.slice(0, MAX_MESSAGE_CHARS)}…`;
}

/**
 * Build the strippable seed block from a cached transcript, or null when nothing contributes text.
 * User turns become `User: …`; assistant replies become `Assistant: …`; each pending question the
 * agent asked becomes `Assistant (asked): …` (that pending question is exactly the context a
 * "try again" reply needs).
 */
export function buildSeedContext(entries: ChatEntry[]): string | null {
  const lines: string[] = [];
  for (const entry of entries) {
    const text = sanitize(entry.text ?? "");
    if (entry.role === "user") {
      if (text) lines.push(`User: ${text}`);
      continue;
    }
    if (text) lines.push(`Assistant: ${text}`);
    for (const request of entry.inputRequests ?? []) {
      const prompt = sanitize(request.prompt ?? "");
      if (prompt) lines.push(`Assistant (asked): ${prompt}`);
    }
  }
  if (lines.length === 0) return null;

  // Keep the NEWEST messages when the body overflows the budget; note the drop up front.
  let dropped = false;
  while (lines.length > 0 && lines.join("\n\n").length > MAX_BODY_CHARS) {
    lines.shift();
    dropped = true;
  }
  const body = [dropped ? OMITTED_NOTE : null, ...lines]
    .filter(Boolean)
    .join("\n\n");

  return [SEED_CONTEXT_START, INSTRUCTION, body, SEED_CONTEXT_END].join("\n\n");
}

/**
 * Remove a leading seed block (through the first end marker and any trailing newlines). The block
 * always sits at the front of the sent message — after the model directive has been stripped — so
 * a message that merely mentions the marker words elsewhere is left untouched.
 */
export function stripSeedContext(text: string): string {
  if (!text.startsWith(SEED_CONTEXT_START)) return text;
  const end = text.indexOf(SEED_CONTEXT_END);
  if (end === -1) return text;
  return text.slice(end + SEED_CONTEXT_END.length).replace(/^\n+/, "");
}
