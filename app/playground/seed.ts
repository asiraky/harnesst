/**
 * Strippable conversation-context seed.
 *
 * When harnesst starts a FRESH eve session that continues an existing conversation (the #288
 * succession of a channel-homed session), the prior conversation is rendered into a plain-text
 * block and prepended to the first message on the new session, so the agent continues with the
 * history in context.
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
/**
 * Succession (#288 3b): the prior session was homed on one of the agent's channels (e.g. a
 * GitHub thread) and is being succeeded by a fresh HTTP-homed session so the human can talk
 * freely. The old session is not dead — it just stops being where this conversation lives.
 */
export const SUCCESSION_INSTRUCTION =
  "[harnesst] This conversation started on one of your channels (e.g. a GitHub thread) in a previous session; the human is now continuing it here directly, so this fresh session carries the transcript below as context. Continue the conversation naturally; do not mention the handover unless asked.";
/**
 * Agent-initiated conversations (#288 3c): the row was opened by the agent's `notify-user`
 * notification (sent from some other run) and had no eve session until this reply. The
 * notification rides in as the same strippable block so the fresh session knows what the
 * human is replying to.
 */
const NOTICE_INSTRUCTION =
  "[harnesst] You previously sent the notification below to the humans who run you (via your notify-user tool, from a different session). A human read it and is now replying, opening this fresh conversation. Continue naturally; do not mention the session boundary unless asked.";

/** Build the strippable seed block that carries a notify-user notification (#288 3c). */
export function buildNoticeSeedContext(openingMessage: string): string {
  return [
    SEED_CONTEXT_START,
    NOTICE_INSTRUCTION,
    `Your notification: ${sanitize(openingMessage)}`,
    SEED_CONTEXT_END,
  ].join("\n\n");
}

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
export function buildSeedContext(
  entries: ChatEntry[],
  instruction: string = INSTRUCTION,
): string | null {
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

  return [SEED_CONTEXT_START, instruction, body, SEED_CONTEXT_END].join("\n\n");
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
