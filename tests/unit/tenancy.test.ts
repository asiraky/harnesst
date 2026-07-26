/**
 * Tenant isolation (D2) + slug uniqueness — against the in-memory store (no DB). A query scoped
 * to org A must never return org B's rows; a bug here is a security incident, so it gets
 * regression coverage. The org-scoping mirrors the Drizzle WHERE clause (trusted at schema
 * level); this pins the logic shape and the slug-suffix behaviour.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  createProject,
  getProject,
  listProjects,
  resolveUniqueSlug,
} from "~/db/queries.server";
import {
  resolveAgentContext,
  resolveSyncedAgentContext,
} from "~/project/agent-context.server";
import { makeFakeStore, type FakeStore } from "../fakes/store";

let store: FakeStore;
const ORG_A = "org_a";
const ORG_B = "org_b";

beforeEach(() => {
  store = makeFakeStore();
});

describe("resolveUniqueSlug", () => {
  it("returns the base when free, else suffixes -2, -3, …", async () => {
    const taken = new Set(["alpha-agent", "alpha-agent-2"]);
    expect(await resolveUniqueSlug("alpha-agent", async (s) => taken.has(s))).toBe("alpha-agent-3");
    expect(await resolveUniqueSlug("fresh", async () => false)).toBe("fresh");
  });
});

describe("tenant isolation", () => {
  it("returns a project to its own org but hides it from another", async () => {
    const a = await createProject({ orgId: ORG_A, name: "Alpha Agent" }, store);
    const b = await createProject({ orgId: ORG_B, name: "Beta Agent" }, store);

    expect((await getProject(ORG_A, a.id, store))?.id).toBe(a.id);
    expect(await getProject(ORG_A, b.id, store)).toBeUndefined();
    expect(await getProject(ORG_B, a.id, store)).toBeUndefined();
  });

  it("lists only the tenant's projects", async () => {
    const a = await createProject({ orgId: ORG_A, name: "Alpha Agent" }, store);
    const b = await createProject({ orgId: ORG_B, name: "Beta Agent" }, store);

    const listA = await listProjects(ORG_A, store);
    expect(listA.some((p) => p.id === a.id)).toBe(true);
    expect(listA.some((p) => p.id === b.id)).toBe(false);
  });

  it("suffixes colliding slugs within an org and seeds the single default environment", async () => {
    const first = await createProject({ orgId: ORG_A, name: "Alpha Agent" }, store);
    const again = await createProject({ orgId: ORG_A, name: "Alpha Agent" }, store);
    expect(first.slug).toBe("alpha-agent");
    expect(again.slug).toMatch(/^alpha-agent-\d+$/);
    // Environments are user-defined (M5.7): a new member starts with exactly one.
    expect((await store.environments.listByProject(first.id)).map((e) => e.name)).toEqual([
      "default",
    ]);
  });
});

describe("agent context", () => {
  it("treats a one-member agents/* roster as a team repo", async () => {
    const project = await createProject(
      {
        orgId: ORG_A,
        name: "My Team",
        layout: "team",
        roster: [{ name: "deployer", root: "agents/deployer/agent" }],
      },
      store,
    );

    const ctx = await resolveAgentContext(project.id, null, store);

    expect(ctx.isTeam).toBe(true);
    expect(ctx.active?.name).toBe("deployer");
  });

  it("syncs a stale single-agent roster from the repo's team layout", async () => {
    const project = await createProject({ orgId: ORG_A, name: "My Team", layout: "team" }, store);

    const ctx = await resolveSyncedAgentContext(
      project.id,
      null,
      ["agents/deployer/agent/agent.ts"],
      store,
    );

    expect(ctx.isTeam).toBe(true);
    expect(ctx.roster.map((a) => ({ name: a.name, root: a.root }))).toEqual([
      { name: "deployer", root: "agents/deployer/agent" },
    ]);
  });

  it("persists team classification with an explicitly empty roster", async () => {
    const project = await createProject(
      { orgId: ORG_A, name: "Empty Team", layout: "team", roster: [] },
      store,
    );

    const ctx = await resolveAgentContext(project.id, null, store);
    expect(project.layout).toBe("team");
    expect(ctx).toMatchObject({ isTeam: true, roster: [], active: null });
  });

  it("syncs to zero only when the empty-team marker proves the read is genuine", async () => {
    const project = await createProject(
      {
        orgId: ORG_A,
        name: "My Team",
        layout: "team",
        roster: [{ name: "deployer", root: "agents/deployer/agent" }],
      },
      store,
    );
    await store.agents.createAssistant({
      projectId: project.id,
      name: "assistant",
      root: ".harnesst/assistant",
    });

    const markerless = await resolveSyncedAgentContext(project.id, null, [], store);
    expect(markerless.roster.map((a) => a.name)).toEqual(["deployer"]);

    const empty = await resolveSyncedAgentContext(
      project.id,
      null,
      ["agents/README.md"],
      store,
    );
    expect(empty).toMatchObject({ isTeam: true, roster: [], active: null });
    expect((await store.agents.listByProject(project.id)).map((a) => a.kind)).toEqual([
      "assistant",
    ]);
  });
});
