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

const TRANSIENT_MESSAGE =
  "The model provider had a temporary error. Retry your message.";

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
): NormalizedTurnError | null {
  if (!raw) return null;
  const text = raw.trim();
  if (!text) return null;
  if (isTransientProviderError(text)) {
    return { message: TRANSIENT_MESSAGE, detail: text, retryable: true };
  }
  return { message: text, detail: null, retryable: false };
}
