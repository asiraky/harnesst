/**
 * Tool-result size limit, enforced by harnesst's model gateway.
 *
 * A tool result too large for the model is withheld entirely: the model gets an error saying so,
 * never a partial result it might act on as if it were complete. A 2026-11 timekeeper run read a
 * whole spreadsheet (~220k tokens) into one tool result, filled the context window, compacted,
 * re-read it, and repeated that 114 times in one turn until the Codex plan ran out. The Codex CLI
 * caps tool output for the same reason (10k tokens, truncated); harnesst rejects instead.
 *
 * The tool has already run by the time its result reaches the gateway, so the message says the
 * call ran: a read can be retried with a narrower request, a write must not be repeated.
 */

/** The share of the model's context window one tool result may take. */
export const TOOL_RESULT_WINDOW_SHARE = 0.1;

/** Used when the model's window is unknown: 10% of the smallest window harnesst serves. */
const FALLBACK_LIMIT_TOKENS = 12_800;

/** Rough token count, 4 UTF-8 bytes per token, the same estimate the Codex CLI uses. */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

export function toolResultLimitTokens(contextWindow: number | null | undefined): number {
  if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow <= 0)
    return FALLBACK_LIMIT_TOKENS;
  return Math.floor(contextWindow * TOOL_RESULT_WINDOW_SHARE);
}

/** The HTTP status a connection tool reported (`{"status": 200, ...}`), when there is one. */
function reportedStatus(output: string): number | null {
  const match = output.slice(0, 200).match(/^\s*\{\s*"status"\s*:\s*(\d{3})\b/);
  return match ? Number(match[1]) : null;
}

export interface WithheldToolResult {
  callId: string;
  toolName: string;
  tokens: number;
  limitTokens: number;
  status: number | null;
}

/**
 * Check one tool result against the limit. Returns null when it fits, otherwise what was withheld
 * and the error text the model sees in its place.
 */
export function checkToolResult(
  output: string,
  limitTokens: number,
  call: { callId: string; toolName: string },
): { withheld: WithheldToolResult; message: string } | null {
  const tokens = estimateTokens(output);
  if (tokens <= limitTokens) return null;
  const status = reportedStatus(output);
  const ran =
    status === null
      ? "The call ran."
      : status < 400
        ? `The call ran and succeeded (HTTP ${status}).`
        : `The call ran and returned HTTP ${status}.`;
  const message =
    `Error: tool result withheld. ${call.toolName} returned about ${tokens.toLocaleString("en-US")} tokens, ` +
    `over this model's ${limitTokens.toLocaleString("en-US")}-token limit for one tool result. ` +
    `${ran} None of its output is shown, so do not assume anything about it. ` +
    "If you were reading data, request less: a smaller range, a filter, specific columns, or one page at a time. " +
    "If the call changed something, that change is done: do not repeat it.";
  return {
    withheld: { ...call, tokens, limitTokens, status },
    message,
  };
}
