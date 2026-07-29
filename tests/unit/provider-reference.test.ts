import { describe, expect, it } from "vitest";

import {
  buildProviderModelReference,
  parseProviderModelReference,
  providerConnectionEnvName,
} from "~/models/provider-reference";

const CONNECTION_ID = "abcdefghijkl";

describe("provider model references", () => {
  it("round-trips an upstream id containing slashes", () => {
    const reference = buildProviderModelReference(
      "openrouter",
      CONNECTION_ID,
      "anthropic/claude-sonnet-5",
    );
    expect(reference).toBe("openrouter/abcdefghijkl/anthropic/claude-sonnet-5");
    expect(parseProviderModelReference(reference)).toEqual({
      provider: "openrouter",
      connectionId: CONNECTION_ID,
      upstreamModelId: "anthropic/claude-sonnet-5",
    });
  });

  it("keeps the Phase 1 Codex reference shape compatible", () => {
    expect(parseProviderModelReference("codex/abcdefghijkl/gpt-5.4")).toEqual({
      provider: "codex",
      connectionId: CONNECTION_ID,
      upstreamModelId: "gpt-5.4",
    });
  });

  it("rejects unknown providers, missing models, and malformed connection ids", () => {
    expect(parseProviderModelReference("other/abcdefghijkl/model")).toBeNull();
    expect(parseProviderModelReference("openai/abcdefghijkl/")).toBeNull();
    expect(parseProviderModelReference("openai/abc123/model")).toBeNull();
    expect(parseProviderModelReference("openai/ABCDEFGHIJKL/model")).toBeNull();
    expect(() => buildProviderModelReference("openai", "bad", "gpt-5")).toThrow(
      /12 lowercase letters/,
    );
  });
});

describe("providerConnectionEnvName", () => {
  it("constructs exact API-key vars only from safe provider/connection values", () => {
    expect(providerConnectionEnvName("anthropic", CONNECTION_ID)).toBe(
      "HARNESST_PROVIDER_ANTHROPIC_ABCDEFGHIJKL_API_KEY",
    );
    expect(providerConnectionEnvName("codex", CONNECTION_ID)).toBeNull();
    expect(providerConnectionEnvName("unknown", CONNECTION_ID)).toBeNull();
    expect(providerConnectionEnvName("openai", "abc-def")).toBeNull();
  });
});
