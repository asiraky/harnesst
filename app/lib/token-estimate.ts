/**
 * Rough token counts for text harnesst never tokenized: 4 UTF-8 bytes per token, the estimate the
 * Codex CLI uses. Shared by the gateway call log (context composition) and the run record (tool
 * result sizes), so both report sizes on one scale.
 */

export const BYTES_PER_TOKEN = 4;

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function estimateTokens(text: string): number {
  return Math.ceil(utf8Bytes(text) / BYTES_PER_TOKEN);
}

export function tokensForBytes(bytes: number): number {
  return Math.ceil(Math.max(0, bytes) / BYTES_PER_TOKEN);
}
