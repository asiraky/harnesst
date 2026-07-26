import { describe, expect, it } from "vitest";

import { listAgents, listAllAgents, findAssistantAgent } from "~/db/queries.server";
import { normalizeAgentPath, isAssistantConfigPath } from "~/project/guard.server";
import { makeFakeStore } from "../fakes/store";

describe("assistant agent roster semantics", () => {
  it("syncRoster prunes removed members but never the assistant", async () => {
    const store = makeFakeStore();
    store.seedProject({ id: "p", orgId: "o" });
    store.seedAgent({ id: "m1", projectId: "p", name: "pm", root: "agents/pm/agent" });
    store.seedAgent({ id: "m2", projectId: "p", name: "qa", root: "agents/qa/agent" });
    const assistant = await store.agents.createAssistant({
      projectId: "p",
      name: "assistant",
      root: ".harnesst/assistant",
    });

    // A tree re-detection that only sees "pm" (qa was deleted from the repo).
    const after = await store.agents.syncRoster("p", [{ name: "pm", root: "agents/pm/agent" }]);

    const names = after.map((a) => a.name).sort();
    expect(names).toContain("pm");
    expect(names).not.toContain("qa"); // pruned
    expect(names).toContain("assistant"); // exempt

    expect(await store.agents.findAssistant("p")).toMatchObject({ id: assistant.id });
  });

  it("listAgents hides the assistant; listAllAgents / findAssistantAgent expose it", async () => {
    const store = makeFakeStore();
    store.seedProject({ id: "p", orgId: "o" });
    store.seedAgent({ id: "m1", projectId: "p", name: "pm", root: "agents/pm/agent" });
    await store.agents.createAssistant({
      projectId: "p",
      name: "assistant",
      root: ".harnesst/assistant",
    });

    expect((await listAgents("p", store)).map((a) => a.name)).toEqual(["pm"]);
    expect((await listAllAgents("p", store)).map((a) => a.name).sort()).toEqual([
      "assistant",
      "pm",
    ]);
    expect(await findAssistantAgent("p", store)).toMatchObject({ kind: "assistant" });
  });
});

describe("assistant config path policy", () => {
  it("accepts the assistant markdown/JSON config surface, rejects code and traversal", () => {
    for (const ok of [
      ".harnesst/assistant/instructions.md",
      ".harnesst/assistant/skills/building-eve-agents.md",
      ".harnesst/assistant/schedules/daily.md",
      ".harnesst/assistant/assistant.json",
    ]) {
      expect(normalizeAgentPath(ok)).toBe(ok);
    }
    for (const bad of [
      ".harnesst/assistant/agent.ts",
      ".harnesst/assistant/tools/x.ts",
      ".harnesst/assistant/../secrets",
      ".harnesst/other/instructions.md",
    ]) {
      expect(normalizeAgentPath(bad)).toBeNull();
    }
    expect(isAssistantConfigPath(".harnesst/assistant/skills/x.md")).toBe(true);
    expect(isAssistantConfigPath(".harnesst/assistant/x.ts")).toBe(false);
    // Member surface still works.
    expect(normalizeAgentPath("agent/tools/foo.ts")).toBe("agent/tools/foo.ts");
  });
});
