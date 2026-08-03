import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import type { EvalGrant } from "~/gateway/eval-grant.server";
import {
  activeEvalGrantError,
  evalGrantLimitError,
} from "~/gateway/eval-grant.server";
import {
  mintEvalGatewayToken,
  verifyEvalGatewayToken,
} from "~/gateway/eval-token.server";
import { mintGatewayToken } from "~/gateway/token.server";

const KEY = crypto.randomBytes(32);

function grant(patch: Partial<EvalGrant> = {}): EvalGrant {
  return {
    id: "grantabcdefg",
    orgId: "org_1",
    projectId: "projectabcde",
    conversationId: "convabcdefgh",
    memberName: "researcher",
    model: "codex/abcdefghijkl/gpt-5.5",
    effort: "high",
    modelSource: "override",
    expiresAt: new Date("2030-01-01T00:10:00Z"),
    maxConcurrentCalls: 4,
    activeCalls: 0,
    maxCalls: 64,
    usedCalls: 0,
    maxTokens: 500_000,
    reservedTokens: 0,
    revokedAt: null,
    createdAt: new Date("2030-01-01T00:00:00Z"),
    updatedAt: new Date("2030-01-01T00:00:00Z"),
    ...patch,
  };
}

describe("eval gateway token", () => {
  it("round-trips only its signed grant id", () => {
    const token = mintEvalGatewayToken("grantabcdefg", KEY);
    expect(token).toMatch(/^edne_/);
    expect(verifyEvalGatewayToken(token, KEY)).toBe("grantabcdefg");
  });

  it("rejects tampering and long-lived org gateway tokens", () => {
    const token = mintEvalGatewayToken("grantabcdefg", KEY);
    expect(verifyEvalGatewayToken(`${token.slice(0, -1)}x`, KEY)).toBeNull();
    expect(
      verifyEvalGatewayToken(mintGatewayToken("org_1", KEY), KEY),
    ).toBeNull();
  });
});

describe("eval grant boundaries", () => {
  it("rejects missing, expired, and revoked grants", () => {
    const now = new Date("2030-01-01T00:10:00Z");
    expect(activeEvalGrantError(null, now)?.status).toBe(401);
    expect(activeEvalGrantError(grant(), now)?.message).toMatch(/expired/i);
    expect(
      activeEvalGrantError(grant({ revokedAt: new Date() }), now)?.status,
    ).toBe(401);
  });

  it("pins the exact member model and enforces concurrency, calls, and token spend", () => {
    expect(
      evalGrantLimitError(grant(), {
        model: "codex/abcdefghijkl/other",
        reservedTokens: 1,
      }).status,
    ).toBe(403);
    expect(
      evalGrantLimitError(grant({ activeCalls: 4 }), {
        model: grant().model,
        reservedTokens: 1,
      }).message,
    ).toMatch(/concurrency/i);
    expect(
      evalGrantLimitError(grant({ usedCalls: 64 }), {
        model: grant().model,
        reservedTokens: 1,
      }).message,
    ).toMatch(/model-call limit/i);
    expect(
      evalGrantLimitError(grant({ reservedTokens: 499_999 }), {
        model: grant().model,
        reservedTokens: 2,
      }).message,
    ).toMatch(/token spend limit/i);
  });
});
