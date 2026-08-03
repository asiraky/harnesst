/**
 * The workspace agent-model resolution contract (`pickAgentModel`): an explicit per-agent
 * override always wins, the workspace default answers otherwise, and an unconfigured
 * workspace resolves to nothing — which the model-config endpoint surfaces as a readable
 * "set a model in Org settings" error rather than any silent fallback.
 *
 * And the declared-subagent chain (issue #344): a configuration target is `(agent, subagentPath)`,
 * and a subagent with no pin of its own inherits its NEAREST configured ancestor — the workspace
 * default only answers once the whole chain, member row included, comes up empty.
 */
import { describe, expect, it } from "vitest";

import {
  inheritanceChain,
  pickAgentModel,
  pickTargetModel,
  type AgentModelSelection,
} from "~/models/agent-model-config.server";

const OVERRIDE = {
  model: "anthropic/abcdefghijkl/claude-opus-4.8",
  effort: "high" as const,
};
const DEFAULT = {
  model: "openai/mnopqrstuvwx/gpt-5.1",
  effort: "medium" as const,
};

describe("pickAgentModel", () => {
  it("prefers the agent's explicit override over the workspace default", () => {
    expect(pickAgentModel(OVERRIDE, DEFAULT)).toEqual({
      ...OVERRIDE,
      source: "override",
    });
  });

  it("falls back to the workspace default when no override exists", () => {
    expect(pickAgentModel(null, DEFAULT)).toEqual({
      model: DEFAULT.model,
      effort: DEFAULT.effort,
      source: "workspace-default",
    });
  });

  it("keeps the override's own effort even when it is null (no default bleed-through)", () => {
    expect(pickAgentModel({ model: OVERRIDE.model, effort: null }, DEFAULT)).toEqual(
      {
        model: OVERRIDE.model,
        effort: null,
        source: "override",
      },
    );
  });

  it("resolves to nothing when the workspace has no configuration at all", () => {
    expect(pickAgentModel(null, { model: null, effort: null })).toBeNull();
  });
});

describe("inheritanceChain", () => {
  it("walks a nested path outwards and ends at the member agent", () => {
    expect(inheritanceChain("reader/skimmer")).toEqual([
      "reader/skimmer",
      "reader",
      "",
    ]);
  });

  it("is just the member for a top-level target", () => {
    expect(inheritanceChain("")).toEqual([""]);
  });

  it("ignores empty segments from a sloppy path", () => {
    expect(inheritanceChain("/reader//skimmer/")).toEqual([
      "reader/skimmer",
      "reader",
      "",
    ]);
  });
});

describe("pickTargetModel", () => {
  it("prefers the subagent's own pin over every ancestor", () => {
    const resolved = pickTargetModel(
      "reader/skimmer",
      new Map<string, AgentModelSelection>([
        ["reader/skimmer", OVERRIDE],
        ["reader", DEFAULT],
        ["", DEFAULT],
      ]),
      DEFAULT,
    );
    expect(resolved).toEqual({ ...OVERRIDE, source: "override" });
  });

  it("inherits the NEAREST configured ancestor, not the member agent", () => {
    const resolved = pickTargetModel(
      "reader/skimmer",
      new Map<string, AgentModelSelection>([
        ["reader", OVERRIDE],
        ["", DEFAULT],
      ]),
      DEFAULT,
    );
    expect(resolved).toEqual({
      ...OVERRIDE,
      source: "parent-override",
      inheritedFrom: "reader",
    });
  });

  it("names the member agent as the source when only it is pinned", () => {
    const resolved = pickTargetModel(
      "reader/skimmer",
      new Map([["", OVERRIDE]]),
      DEFAULT,
    );
    expect(resolved).toEqual({
      ...OVERRIDE,
      source: "parent-override",
      inheritedFrom: "",
    });
  });

  it("falls through the whole chain to the workspace default", () => {
    expect(pickTargetModel("reader/skimmer", new Map(), DEFAULT)).toEqual({
      model: DEFAULT.model,
      effort: DEFAULT.effort,
      source: "workspace-default",
    });
  });

  it("resolves to nothing when neither the chain nor the workspace is configured", () => {
    expect(
      pickTargetModel("reader", new Map(), { model: null, effort: null }),
    ).toBeNull();
  });

  it("treats the member agent itself as its own override, never an inherited one", () => {
    expect(pickTargetModel("", new Map([["", OVERRIDE]]), DEFAULT)).toEqual({
      ...OVERRIDE,
      source: "override",
    });
  });
});
