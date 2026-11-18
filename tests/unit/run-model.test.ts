import { describe, expect, it } from "vitest";

import { chooseRunModel } from "~/observability/run-model";

describe("chooseRunModel", () => {
  it("replaces the dynamic build-time fallback with the configured model", () => {
    expect(
      chooseRunModel(
        { modelId: "unconfigured", modelSource: "fallback" },
        { model: "anthropic/abc/claude-x", contextWindowTokens: null },
        200000,
      ),
    ).toEqual({ modelId: "anthropic/abc/claude-x", contextWindowTokens: 200000 });
  });

  it("records no model when the fallback turn's configuration does not resolve", () => {
    expect(
      chooseRunModel({ modelId: "unconfigured", modelSource: "fallback" }, null, 1),
    ).toEqual({ modelId: null, contextWindowTokens: null });
  });

  it("keeps the directive's model and prefers its window over the catalog's", () => {
    expect(
      chooseRunModel(
        { modelId: "openai/abc/gpt-x", modelSource: "directive", contextWindowTokens: 400000 },
        { model: "ignored", contextWindowTokens: 1 },
        272000,
      ),
    ).toEqual({ modelId: "openai/abc/gpt-x", contextWindowTokens: 400000 });
  });

  it("uses the catalog window when the turn carried none", () => {
    expect(
      chooseRunModel({ modelId: "m/x", modelSource: "runtime" }, null, 128000),
    ).toEqual({ modelId: "m/x", contextWindowTokens: 128000 });
  });

  it("has no window without a model", () => {
    expect(chooseRunModel({ modelId: null }, null, 128000)).toEqual({
      modelId: null,
      contextWindowTokens: null,
    });
  });
});
