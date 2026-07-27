/**
 * Normalizes a settled turn's raw error text for display. Transient upstream provider errors
 * (an Azure/OpenAI 500 mid-stream, a 503, "overloaded", rate limits) reach harnesst as a raw
 * eve.mjs stack-trace blob; we map those to a short, retryable message and keep the raw text
 * for operators. Genuine config/validation errors (bad model id, missing credential, 401/403)
 * are left untouched so their specific, actionable text still reaches the user.
 *
 * Detection keys on transient MESSAGE signatures, not on the `MODEL_CALL_FAILED` code alone:
 * a bad model id can also surface under MODEL_CALL_FAILED, so keying on the code would
 * misclassify config errors as transient. The signatures below only match clearly-transient
 * upstream conditions.
 */
export interface NormalizedTurnError {
  /** Short, user-facing default message — safe to render directly. */
  message: string;
  /** Raw error text for operators (a details toggle); null when it adds nothing over `message`. */
  detail: string | null;
  /** Clearly-transient provider error → offer a one-click retry. */
  retryable: boolean;
}

export interface NormalizeTurnErrorOptions {
  /**
   * Display name of the channel that HOMES this session ("GitHub"), when one does.
   *
   * A channel-homed conversation cannot be retried from harnesst, transient though the error was.
   * harnesst may only deliver an ANSWER to a question the agent is parked on, and the retry button
   * re-sends the last user message as an ordinary one — which `talk.server.ts` refuses outright.
   * Re-delivering the same answer is no better: the input request was consumed by the very turn
   * that then failed. So the offer is a dead end, and we name the recovery that does work instead
   * — say it again on the thread, which starts a fresh turn on the same session.
   *
   * Observed in production 2026-07-27: an answered GitHub question resumed, the turn died on
   * "Our servers are currently overloaded", and Retry landed the user in the refusal.
   */
  channelLabel?: string | null;
}

const TRANSIENT_MESSAGE =
  "The model provider had a temporary error. Retry your message.";

const transientOnChannel = (label: string) =>
  `The model provider had a temporary error. harnesst cannot retry a conversation that lives on the agent's ${label} thread — post there to pick it back up.`;

const TRANSIENT_PATTERNS: RegExp[] = [
  /server had an error processing your request/i,
  /internal server error/i,
  /\bserver[_ ]error\b/i,
  /\boverloaded\b/i,
  /temporarily unavailable/i,
  /service unavailable/i,
  /bad gateway/i,
  /gateway timeout/i,
  /too many requests/i,
  /rate[ _]?limit(?:ed|ing|s)?/i,
  /\b(500|502|503|504)\b/,
  /\b429\b/,
  /econnreset|socket hang ?up|etimedout|econnrefused/i,
];

export function isTransientProviderError(raw: string): boolean {
  return TRANSIENT_PATTERNS.some((re) => re.test(raw));
}

export function normalizeTurnError(
  raw: string | null | undefined,
  options: NormalizeTurnErrorOptions = {},
): NormalizedTurnError | null {
  if (!raw) return null;
  const text = raw.trim();
  if (!text) return null;
  const channelLabel = options.channelLabel?.trim() || null;
  if (isTransientProviderError(text)) {
    return channelLabel
      ? {
          message: transientOnChannel(channelLabel),
          detail: text,
          retryable: false,
        }
      : { message: TRANSIENT_MESSAGE, detail: text, retryable: true };
  }
  return { message: text, detail: null, retryable: false };
}
