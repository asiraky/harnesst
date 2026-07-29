/**
 * Codex model-id helpers (issue #28) — the `codex/<connectionId>/<slug>` id is the single value a
 * picker carries; the gateway parses it back into connection + upstream slug. Round-trips and
 * rejection rules must be exact.
 */
import { describe, expect, it } from "vitest";

import {
  buildCodexModelId,
  CODEX_MODEL_SPECS,
  findCodexSpec,
  parseCodexModelId,
} from "~/models/codex-catalog";

describe("buildCodexModelId / parseCodexModelId", () => {
  it("round-trips a connection id + slug", () => {
    const id = buildCodexModelId("conn_123", "gpt-5.5");
    expect(id).toBe("codex/conn_123/gpt-5.5");
    expect(parseCodexModelId(id)).toEqual({
      connectionId: "conn_123",
      slug: "gpt-5.5",
    });
  });

  it("keeps a slug that itself contains slashes intact", () => {
    expect(parseCodexModelId("codex/conn_1/vendor/model-x")).toEqual({
      connectionId: "conn_1",
      slug: "vendor/model-x",
    });
  });

  it("rejects non-codex and malformed ids", () => {
    expect(parseCodexModelId("anthropic/claude-sonnet-5")).toBeNull();
    expect(parseCodexModelId("codex/")).toBeNull();
    expect(parseCodexModelId("codex/onlyconnection")).toBeNull();
    expect(parseCodexModelId("codex//gpt-5.5")).toBeNull();
    expect(parseCodexModelId("codex/conn_1/")).toBeNull();
  });
});

describe("findCodexSpec", () => {
  it("returns a curated spec by slug", () => {
    const spec = findCodexSpec("gpt-5.5");
    expect(spec?.name).toBe("GPT-5.5");
    expect(spec?.contextWindow).toBeGreaterThan(0);
  });

  it("is null for an unknown slug", () => {
    expect(findCodexSpec("not-a-model")).toBeNull();
  });

  it("every curated spec parses back through the id helpers", () => {
    for (const spec of CODEX_MODEL_SPECS) {
      const parsed = parseCodexModelId(buildCodexModelId("c", spec.slug));
      expect(parsed?.slug).toBe(spec.slug);
    }
  });
});
