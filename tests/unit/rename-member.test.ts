/**
 * Renaming a roster member. Two mechanisms are under test:
 *  - `planPendingRenames` (pure): the decision that maps a member row carrying a `pendingName`
 *    onto a freshly-detected roster — apply on merge, clear when stale, leave when unmerged.
 *  - `syncProjectAgents` against the in-memory store: a landed rename maps the row IN PLACE, so
 *    its id (and thus its environments/history) survives and its staged drafts move with it.
 *  - `renameMember` (pure): rewriting eden-lock.json install ownership + file paths.
 *
 * The load-bearing guarantee is that a rename is NEVER a prune+recreate (which would cascade the
 * member's environments, releases, secrets and drafts away).
 */
import { beforeEach, describe, expect, it } from "vitest";

import { planPendingRenames, syncProjectAgents } from "~/db/queries.server";
import { emptyLock, renameMember, type HarnesstLock } from "~/marketplace/lock";
import { makeFakeStore, type FakeStore } from "../fakes/store";

const PROJECT = "proj_1";

function agent(over: {
  id: string;
  name: string;
  root?: string;
  kind?: string;
  pendingName?: string | null;
}) {
  return {
    id: over.id,
    projectId: PROJECT,
    name: over.name,
    root: over.root ?? `agents/${over.name}/agent`,
    kind: over.kind ?? "member",
    pendingName: over.pendingName ?? null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

describe("planPendingRenames", () => {
  it("applies when the new directory appeared and the old one is gone (merge landed)", () => {
    const existing = [agent({ id: "a1", name: "pm", pendingName: "product" })];
    const detected = [{ name: "product", root: "agents/product/agent" }];
    const plan = planPendingRenames(existing, detected);
    expect(plan.clear).toEqual([]);
    expect(plan.apply).toEqual([
      {
        id: "a1",
        oldName: "pm",
        newName: "product",
        root: "agents/product/agent",
      },
    ]);
  });

  it("clears a stale pending mark when BOTH directories are detected", () => {
    const existing = [agent({ id: "a1", name: "pm", pendingName: "product" })];
    const detected = [
      { name: "pm", root: "agents/pm/agent" },
      { name: "product", root: "agents/product/agent" },
    ];
    const plan = planPendingRenames(existing, detected);
    expect(plan.apply).toEqual([]);
    expect(plan.clear).toEqual(["a1"]);
  });

  it("leaves the mark untouched while the rename PR is unmerged (new dir absent)", () => {
    const existing = [agent({ id: "a1", name: "pm", pendingName: "product" })];
    const detected = [{ name: "pm", root: "agents/pm/agent" }];
    const plan = planPendingRenames(existing, detected);
    expect(plan).toEqual({ apply: [], clear: [] });
  });

  it("ignores rows without a pending mark and non-member rows", () => {
    const existing = [
      agent({ id: "a1", name: "pm" }),
      agent({
        id: "a2",
        name: "assistant",
        kind: "assistant",
        pendingName: "x",
      }),
    ];
    const detected = [
      { name: "pm", root: "agents/pm/agent" },
      { name: "x", root: "agents/x/agent" },
    ];
    expect(planPendingRenames(existing, detected)).toEqual({
      apply: [],
      clear: [],
    });
  });
});

describe("syncProjectAgents — pending rename mapping", () => {
  let store: FakeStore;
  beforeEach(() => {
    store = makeFakeStore();
    store.seedProject({
      id: PROJECT,
      orgId: "org_1",
      repoOwner: "acme",
      repoName: "team",
    });
  });

  it("maps a landed rename in place — same row id, new name/root, drafts follow", async () => {
    store.seedAgent({
      id: "a_pm",
      projectId: PROJECT,
      name: "pm",
      root: "agents/pm/agent",
      pendingName: "product",
    });
    store.seedAgent({
      id: "a_qa",
      projectId: PROJECT,
      name: "qa",
      root: "agents/qa/agent",
    });
    store.seedEnvironment({
      id: "e_pm",
      projectId: PROJECT,
      agentId: "a_pm",
      name: "production",
    });
    await store.drafts.upsert({
      projectId: PROJECT,
      agentId: "a_pm",
      path: "agents/pm/agent/tools/x.ts",
      content: "// staged",
    });

    const roster = await syncProjectAgents(
      PROJECT,
      [
        { name: "product", root: "agents/product/agent" },
        { name: "qa", root: "agents/qa/agent" },
      ],
      store,
    );

    // Same row id survives with the new name/root — no prune+recreate.
    const renamed = await store.agents.findById("a_pm");
    expect(renamed?.name).toBe("product");
    expect(renamed?.root).toBe("agents/product/agent");
    expect(renamed?.pendingName).toBeNull();
    expect(roster.map((a) => a.name).sort()).toEqual(["product", "qa"]);

    // Its environment (keyed by the preserved id) is untouched.
    expect(
      (await store.environments.listByAgent("a_pm")).map((e) => e.name),
    ).toEqual(["production"]);

    // Its staged draft moved under the new directory, still attributed to the same agent.
    const drafts = await store.drafts.listByProject(PROJECT);
    expect(drafts.map((d) => d.path)).toEqual([
      "agents/product/agent/tools/x.ts",
    ]);
    expect(drafts[0].agentId).toBe("a_pm");
  });

  it("clears a stale pending mark without renaming when both directories exist", async () => {
    store.seedAgent({
      id: "a_pm",
      projectId: PROJECT,
      name: "pm",
      root: "agents/pm/agent",
      pendingName: "product",
    });

    const roster = await syncProjectAgents(
      PROJECT,
      [
        { name: "pm", root: "agents/pm/agent" },
        { name: "product", root: "agents/product/agent" },
      ],
      store,
    );

    expect(roster.map((a) => a.name).sort()).toEqual(["pm", "product"]);
    expect((await store.agents.findById("a_pm"))?.pendingName).toBeNull();
  });

  it("leaves a normal add/remove sync unaffected by the rename path", async () => {
    store.seedAgent({
      id: "a_pm",
      projectId: PROJECT,
      name: "pm",
      root: "agents/pm/agent",
    });

    const roster = await syncProjectAgents(
      PROJECT,
      [
        { name: "pm", root: "agents/pm/agent" },
        { name: "qa", root: "agents/qa/agent" },
      ],
      store,
    );

    expect(roster.map((a) => a.name).sort()).toEqual(["pm", "qa"]);
    // pm's original row id is preserved (matched by name), qa is a fresh row.
    expect((await store.agents.findById("a_pm"))?.name).toBe("pm");
  });
});

describe("renameMember (eden-lock.json)", () => {
  const lock: HarnesstLock = {
    version: 1,
    installs: [
      {
        id: "web-search",
        type: "tool",
        name: "Web Search",
        version: "1.0.0",
        hash: "h1",
        registry: "fixture",
        member: "pm",
        files: ["agents/pm/agent/tools/web-search.ts"],
      },
      {
        id: "web-search",
        type: "tool",
        name: "Web Search",
        version: "1.0.0",
        hash: "h1",
        registry: "fixture",
        member: "qa",
        files: ["agents/qa/agent/tools/web-search.ts"],
      },
    ],
  };

  it("retags the member and remaps its file paths, leaving other members alone", () => {
    const { lock: out, changed } = renameMember(lock, "pm", "product");
    expect(changed).toBe(true);
    const pmEntry = out.installs.find((e) => e.files[0].includes("product"));
    expect(pmEntry?.member).toBe("product");
    expect(pmEntry?.files).toEqual([
      "agents/product/agent/tools/web-search.ts",
    ]);
    const qaEntry = out.installs.find((e) => e.member === "qa");
    expect(qaEntry?.files).toEqual(["agents/qa/agent/tools/web-search.ts"]);
  });

  it("reports no change when the member owns no installs", () => {
    expect(renameMember(lock, "nobody", "x").changed).toBe(false);
    expect(renameMember(emptyLock(), "pm", "product").changed).toBe(false);
  });
});
