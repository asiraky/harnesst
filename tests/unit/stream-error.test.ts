import { describe, expect, it } from "vitest";

import {
  isTransientProviderError,
  normalizeTurnError,
} from "~/chat/stream-error";

const FRIENDLY = "The model provider had a temporary error. Retry your message.";

// The verbatim blob harnesst receives when an Azure-hosted OpenAI call 500s mid-stream: the
// provider message, the MODEL_CALL_FAILED code, and a Details JSON carrying the eve.mjs stack.
const AZURE_500_BLOB = `The server had an error processing your request. Sorry about that! You can retry your request, or contact us through an Azure support request at https://portal.azure.com if the error persists. (Please include the request ID f3a88be5-0000-0000-0000-000000000000 in your email.)
Code: MODEL_CALL_FAILED
Details: {
  "detail": "Error: The server had an error processing your request ...\\n      at toError (file:///app/.output/server/_libs/eve.mjs:14412:10)\\n      at normalizeModelStreamError (file:///app/.output/server/_libs/eve.mjs:56852:10)",
  "errorId": "738f0b67-0000-0000-0000-000000000000",
  "message": "Error: The server had an error processing your request ..."
}`;

describe("normalizeTurnError — transient provider errors", () => {
  it("maps the verbatim Azure 500 blob to the friendly, retryable message and keeps the raw detail", () => {
    const result = normalizeTurnError(AZURE_500_BLOB);
    expect(result).not.toBeNull();
    expect(result!.retryable).toBe(true);
    expect(result!.message).toBe(FRIENDLY);
    expect(result!.detail).toContain("eve.mjs");
    // The friendly text must NOT include the raw stack or the Azure support instruction.
    expect(result!.message).not.toContain("eve.mjs");
    expect(result!.message).not.toContain("Azure support");
  });

  it("treats a 503 Service Unavailable as transient", () => {
    const result = normalizeTurnError("Agent returned 503 Service Unavailable");
    expect(result!.retryable).toBe(true);
    expect(result!.message).toBe(FRIENDLY);
  });

  it("treats an overloaded provider as transient", () => {
    const result = normalizeTurnError(
      "The model provider is overloaded, please try again",
    );
    expect(result!.retryable).toBe(true);
    expect(result!.message).toBe(FRIENDLY);
  });

  it("treats 429 / rate limit conditions as transient", () => {
    expect(normalizeTurnError("429 Too Many Requests")!.retryable).toBe(true);
    expect(normalizeTurnError("rate limit exceeded")!.retryable).toBe(true);
  });
});

describe("normalizeTurnError — genuine config/validation errors are left untouched", () => {
  it("keeps a bad model id error specific and non-retryable", () => {
    const result = normalizeTurnError("Model 'gpt-9-turbo' not found");
    expect(result!.retryable).toBe(false);
    expect(result!.message).toBe("Model 'gpt-9-turbo' not found");
    expect(result!.detail).toBeNull();
  });

  it("keeps auth errors specific and non-retryable", () => {
    expect(normalizeTurnError("Invalid API key")!.retryable).toBe(false);
    expect(normalizeTurnError("401 Unauthorized")!.retryable).toBe(false);
  });

  it("keeps a missing-credential error specific and non-retryable", () => {
    const result = normalizeTurnError("Missing provider credential for openai");
    expect(result!.retryable).toBe(false);
    expect(result!.message).toBe("Missing provider credential for openai");
    expect(result!.detail).toBeNull();
  });
});

describe("normalizeTurnError — empty inputs", () => {
  it("returns null for null, empty, and whitespace-only input", () => {
    expect(normalizeTurnError(null)).toBeNull();
    expect(normalizeTurnError(undefined)).toBeNull();
    expect(normalizeTurnError("")).toBeNull();
    expect(normalizeTurnError("   ")).toBeNull();
  });
});

describe("isTransientProviderError", () => {
  it("matches transient signatures and rejects config errors", () => {
    expect(isTransientProviderError("internal server error")).toBe(true);
    expect(isTransientProviderError("bad gateway")).toBe(true);
    expect(isTransientProviderError("ECONNRESET")).toBe(true);
    expect(isTransientProviderError("Model 'x' not found")).toBe(false);
    expect(isTransientProviderError("Invalid API key")).toBe(false);
  });
});
