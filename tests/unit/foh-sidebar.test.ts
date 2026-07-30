/**
 * FOH sidebar scoping (app/foh/sidebar.server.ts) over the FakeStore: admins/owners see every
 * org repo (and lazily mint missing repo teams, D9); members see only their teams' repos;
 * needs-you badges count the viewer-visible pending question/approval items per agent (D5),
 * while the 🔔 count includes finished items too.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// teams.server pulls in the Better Auth instance — the sidebar takes injected deps, so the
// real module never runs in this suite.
vi.mock("~/auth/teams.server", () => ({
  ensureProjectTeam: vi.fn(),
  listMemberProjectIds: vi.fn(),
}));

import { listViewerProjectIds, loadFohSidebar } from "~/foh/sidebar.server";
import { makeFakeStore, type FakeStore } from "../fakes/store";

let store: FakeStore;

beforeEach(() => {
  store = makeFakeStore();
  store.seedProject({ id: "proj_a", orgId: "org_1", name: "repo-a", teamId: "team_a" });
  store.seedProject({ id: "proj_b", orgId: "org_1", name: "repo-b", teamId: null });
  store.seedProject({ id: "proj_other", orgId: "org_2", name: "other-org" });
  store.seedAgent({ id: "agent_ivy", projectId: "proj_a", name: "ivy" });
  store.seedAgent({ id: "agent_sam", projectId: "proj_a", name: "sam" });
  store.seedAgent({ id: "agent_ops", projectId: "proj_b", name: "ops" });
  // Internal assistant rows never show in the FOH roster.
  store.seedAgent({
    id: "agent_assist",
    projectId: "proj_a",
    name: "assistant",
    kind: "assistant",
  });
});

const flatPresence = async (ids: string[]) =>
  new Map(ids.map((id) => [id, "idle" as const]));

describe("listViewerProjectIds", () => {
  it("admins see every org project", async () => {
    const ids = await listViewerProjectIds(
      { userId: "u1", orgId: "org_1", backOfHouse: true },
      { store },
    );
    expect(new Set(ids)).toEqual(new Set(["proj_a", "proj_b"]));
  });

  it("members see only their teams' projects", async () => {
    const ids = await listViewerProjectIds(
      { userId: "u1", orgId: "org_1", backOfHouse: false },
      { store, memberProjectIds: async () => ["proj_a"] },
    );
    expect(ids).toEqual(["proj_a"]);
  });
});

describe("loadFohSidebar", () => {
  it("scopes teams to the member's repos and never leaks other orgs", async () => {
    const sidebar = await loadFohSidebar(
      { userId: "u1", orgId: "org_1", backOfHouse: false },
      {
        store,
        memberProjectIds: async () => ["proj_a"],
        presence: flatPresence,
      },
    );
    expect(sidebar.teams.map((t) => t.projectId)).toEqual(["proj_a"]);
    expect(sidebar.teams[0].agents.map((a) => a.name)).toEqual(["ivy", "sam"]);
  });

  it("admins see all org repos and lazily ensure missing teams", async () => {
    const ensureTeam = vi.fn(async () => "team_new");
    const sidebar = await loadFohSidebar(
      { userId: "u1", orgId: "org_1", backOfHouse: true },
      { store, ensureTeam, presence: flatPresence },
    );
    expect(new Set(sidebar.teams.map((t) => t.projectId))).toEqual(
      new Set(["proj_a", "proj_b"]),
    );
    // Only the team-less repo gets minted.
    expect(ensureTeam).toHaveBeenCalledTimes(1);
    expect(ensureTeam).toHaveBeenCalledWith(
      "org_1",
      expect.objectContaining({ id: "proj_b" }),
    );
  });

  it("a failing ensureTeam never takes down the sidebar", async () => {
    const sidebar = await loadFohSidebar(
      { userId: "u1", orgId: "org_1", backOfHouse: true },
      {
        store,
        ensureTeam: async () => {
          throw new Error("better auth down");
        },
        presence: flatPresence,
      },
    );
    expect(sidebar.teams).toHaveLength(2);
  });

  it("counts needs-you badges per agent under D5 visibility; finished feeds only the bell", async () => {
    store.seedInboxItem({
      id: "i_own",
      projectId: "proj_a",
      sessionId: "s1",
      kind: "question",
      agentId: "agent_ivy",
      userId: "u1",
    });
    store.seedInboxItem({
      id: "i_team",
      projectId: "proj_a",
      sessionId: "s2",
      kind: "approval",
      agentId: "agent_ivy",
      userId: null,
    });
    // Another user's personal item — invisible to u1.
    store.seedInboxItem({
      id: "i_other",
      projectId: "proj_a",
      sessionId: "s3",
      kind: "question",
      agentId: "agent_ivy",
      userId: "u2",
    });
    // Finished: counts toward the bell, not the per-agent needs-you badge.
    store.seedInboxItem({
      id: "i_fin",
      projectId: "proj_a",
      sessionId: "s4",
      kind: "finished",
      agentId: "agent_sam",
      userId: "u1",
    });
    // #278: an item whose session was archived in the same instant it was filed. It must not
    // become a badge — nothing behind it can ever clear it, since the session is out of FOH.
    store.seedInboxItem({
      id: "i_archived",
      projectId: "proj_a",
      sessionId: "s5",
      kind: "question",
      agentId: "agent_ivy",
      userId: "u1",
    });
    const sidebar = await loadFohSidebar(
      { userId: "u1", orgId: "org_1", backOfHouse: false },
      {
        store,
        memberProjectIds: async () => ["proj_a"],
        presence: flatPresence,
        sessionsByIds: async (ids) =>
          ids.map((id) => ({
            id,
            archivedAt: id === "s5" ? new Date("2026-07-02T00:00:00Z") : null,
          })),
      },
    );
    const agents = Object.fromEntries(
      sidebar.teams[0].agents.map((a) => [a.name, a.needsYou]),
    );
    expect(agents).toEqual({ ivy: 2, sam: 0 });
    expect(sidebar.inboxCount).toBe(3);
  });
});
