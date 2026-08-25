/**
 * FOH sidebar scoping (app/foh/sidebar.server.ts) over the FakeStore: the viewer sees exactly
 * the repos they hold a grant on (owners get every repo from `listAccessibleProjects`, which
 * is injected here), each team carries the viewer's repo role; needs-you badges count the
 * viewer-visible pending question/approval items per agent (D5), while the 🔔 count includes
 * finished items too.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// project-access.server pulls in the db client — the sidebar takes injected deps, so the real
// module never runs in this suite.
vi.mock("~/auth/project-access.server", () => ({
  listAccessibleProjects: vi.fn(),
}));

import {
  listViewerProjectIds,
  loadFohSidebar,
  type FohViewer,
} from "~/foh/sidebar.server";
import { makeFakeStore, type FakeStore } from "../fakes/store";

let store: FakeStore;
const viewer: FohViewer = { userId: "u1", orgId: "org_1", workspaceRole: "member" };

beforeEach(() => {
  store = makeFakeStore();
  store.seedProject({ id: "proj_a", orgId: "org_1", name: "repo-a" });
  store.seedProject({ id: "proj_b", orgId: "org_1", name: "repo-b" });
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
  it("returns exactly the granted project ids", async () => {
    const ids = await listViewerProjectIds(viewer, {
      store,
      accessibleProjects: async () => [
        { projectId: "proj_a", role: "read" },
        { projectId: "proj_b", role: "write" },
      ],
    });
    expect(ids).toEqual(["proj_a", "proj_b"]);
  });

  it("passes the viewer through to the grant lookup", async () => {
    const accessibleProjects = vi.fn(async () => []);
    await listViewerProjectIds(viewer, { store, accessibleProjects });
    expect(accessibleProjects).toHaveBeenCalledWith(viewer);
  });
});

describe("loadFohSidebar", () => {
  it("scopes teams to the granted repos and never leaks other orgs", async () => {
    const sidebar = await loadFohSidebar(viewer, {
      store,
      accessibleProjects: async () => [
        { projectId: "proj_a", role: "read" },
        // A grant on another org's project (impossible in prod, but never trust it).
        { projectId: "proj_other", role: "write" },
      ],
      presence: flatPresence,
    });
    expect(sidebar.teams.map((t) => t.projectId)).toEqual(["proj_a"]);
    expect(sidebar.teams[0].role).toBe("read");
    expect(sidebar.teams[0].agents.map((a) => a.name)).toEqual(["ivy", "sam"]);
  });

  it("carries the per-repo role so the shell can gate the build link", async () => {
    const sidebar = await loadFohSidebar(viewer, {
      store,
      accessibleProjects: async () => [
        { projectId: "proj_a", role: "read" },
        { projectId: "proj_b", role: "write" },
      ],
      presence: flatPresence,
    });
    expect(
      Object.fromEntries(sidebar.teams.map((t) => [t.projectId, t.role])),
    ).toEqual({ proj_a: "read", proj_b: "write" });
  });

  it("a viewer with no grants gets an empty sidebar", async () => {
    const sidebar = await loadFohSidebar(viewer, {
      store,
      accessibleProjects: async () => [],
      presence: flatPresence,
    });
    expect(sidebar.teams).toEqual([]);
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
    const sidebar = await loadFohSidebar(viewer, {
      store,
      accessibleProjects: async () => [{ projectId: "proj_a", role: "read" }],
      presence: flatPresence,
      sessionsByIds: async (ids) =>
        ids.map((id) => ({
          id,
          archivedAt: id === "s5" ? new Date("2026-07-02T00:00:00Z") : null,
        })),
    });
    const agents = Object.fromEntries(
      sidebar.teams[0].agents.map((a) => [a.name, a.needsYou]),
    );
    expect(agents).toEqual({ ivy: 2, sam: 0 });
    expect(sidebar.inboxCount).toBe(3);
  });
});
