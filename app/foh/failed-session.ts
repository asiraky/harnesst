/**
 * What a FOH conversation whose session row says `failed` must tell the reader (issue #250).
 *
 * The old rule rendered a notice only when the cached transcript ended with a user message,
 * which is the one failure shape that leaves an obvious hole. The other shapes — a turn that
 * died before eve recorded anything (no entries at all), or one whose history could not be
 * read — rendered nothing, so opening the session looked exactly like opening a fresh one and
 * the reader had no way to tell the click had even registered.
 *
 * Pure so the rule is testable without a DOM: the component only maps the result to markup.
 */

/** The transcript slice the decision needs; `ChatEntry` satisfies it. */
export interface FailedSessionEntry {
  role: string;
  text: string;
  error?: string | null;
}

export type FailedSessionNoticeKind = "interrupted" | "empty" | "unknown";

export interface FailedSessionNotice {
  kind: FailedSessionNoticeKind;
  /** What happened, in the reader's terms. */
  message: string;
  /** The message to resend, when resending is the meaningful next step — else null. */
  retryText: string | null;
}

const MESSAGES: Record<FailedSessionNoticeKind, string> = {
  interrupted:
    "This turn failed before it finished, so there is no reply. Send the message again to retry.",
  empty:
    "This conversation ended in an error before anything was recorded. Send a message to start it again.",
  unknown:
    "This conversation ended in an error. Send another message to carry on.",
};

const HISTORY_UNAVAILABLE =
  "This conversation ended in an error, and its history could not be loaded.";

/**
 * The failure state to render under the transcript, or null when nothing should be added.
 *
 * Null in exactly two cases, both of which already show the failure somewhere better:
 * - a live turn is on screen — its own bubble carries the error and the retry button;
 * - the newest conversational entry is an errored assistant turn — `TurnError` renders that
 *   entry's real message (and a retry, when the turn is retryable), which is strictly more
 *   informative than a generic notice repeating it underneath.
 */
export function failedSessionNotice(input: {
  sessionStatus: string;
  /** A live turn is visible in the transcript. */
  liveTurnVisible: boolean;
  /** The history read failed — the transcript says nothing about how the turn ended. */
  historyUnavailable: boolean;
  entries: readonly FailedSessionEntry[];
}): FailedSessionNotice | null {
  if (input.sessionStatus !== "failed" || input.liveTurnVisible) return null;
  if (input.historyUnavailable) {
    return { kind: "unknown", message: HISTORY_UNAVAILABLE, retryText: null };
  }
  // The newest CONVERSATIONAL entry: an artifact card (#290) trails the turn that produced
  // it and says nothing about how that turn ended.
  const last = newestConversationalEntry(input.entries);
  if (last === null) {
    return { kind: "empty", message: MESSAGES.empty, retryText: null };
  }
  if (last.role === "assistant" && last.error) return null;
  if (last.role === "user") {
    return {
      kind: "interrupted",
      message: MESSAGES.interrupted,
      retryText: last.text.trim() ? last.text : null,
    };
  }
  // An assistant tail with no error on a `failed` row: the reply landed but the turn ended
  // badly afterwards. Resending the previous message would repeat work that already
  // happened, so the composer — not a retry button — is the next step.
  return { kind: "unknown", message: MESSAGES.unknown, retryText: null };
}

function newestConversationalEntry(
  entries: readonly FailedSessionEntry[],
): FailedSessionEntry | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].role !== "artifact") return entries[i];
  }
  return null;
}
