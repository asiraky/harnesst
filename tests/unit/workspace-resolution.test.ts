/**
 * Workspace resolution (issue #56) — the two pure decision helpers behind shared workspaces.
 * `chooseWorkspaceEntry` picks which workspace an org-less session enters (or defers to the
 * chooser); `resolveCrossWorkspaceRedirect` decides whether a project miss is a deep link into
 * another workspace the viewer belongs to. Both are pure over injected inputs, so the branching
 * gets regression coverage without mocking Better Auth or the DB.
 */
import { describe, expect, it, vi } from "vitest";

// This suite exercises the pure workspace decisions. Avoid constructing the database-backed
// Better Auth singleton just to import those helpers.
vi.mock("~/lib/auth.server", () => ({ auth: { api: {} } }));

import { chooseWorkspaceEntry } from "~/auth/workspace.server";
import { canonicalProjectUrl, resolveCrossWorkspaceRedirect } from "~/project/guard.server";

describe("canonicalProjectUrl", () => {
  it("redirects a page GET from id to slug and preserves the suffix and query", () => {
    expect(canonicalProjectUrl(
      new Request("https://example.test/repos/abcdefghijkl/runs?status=live"),
      "abcdefghijkl", "support-agents",
    )).toBe("/repos/support-agents/runs?status=live");
    expect(canonicalProjectUrl(
      new Request("https://example.test/t/abcdefghijkl/agent-1"),
      "abcdefghijkl", "support-agents",
    )).toBe("/t/support-agents/agent-1");
  });

  it("strips single-fetch details so client navigations land on the page, not the .data url", () => {
    expect(canonicalProjectUrl(
      new Request("https://example.test/repos/abcdefghijkl/deployment.data?_routes=a"),
      "abcdefghijkl", "support-agents",
    )).toBe("/repos/support-agents/deployment");
    expect(canonicalProjectUrl(
      new Request("https://example.test/repos/abcdefghijkl/_.data"),
      "abcdefghijkl", "support-agents",
    )).toBe("/repos/support-agents/");
  });

  it("does not redirect actions, canonical pages, or API routes", () => {
    expect(canonicalProjectUrl(
      new Request("https://example.test/repos/abcdefghijkl/settings", { method: "POST" }),
      "abcdefghijkl", "support-agents",
    )).toBeNull();
    expect(canonicalProjectUrl(
      new Request("https://example.test/repos/support-agents/settings"),
      "support-agents", "support-agents",
    )).toBeNull();
    expect(canonicalProjectUrl(
      new Request("https://example.test/api/repos/abcdefghijkl/publish"),
      "abcdefghijkl", "support-agents",
    )).toBeNull();
  });
});

describe("chooseWorkspaceEntry", () => {
  it("creates a workspace when the user has no memberships", () => {
    expect(chooseWorkspaceEntry({ membershipOrgIds: [] })).toEqual({
      kind: "create",
    });
  });

  it("enters the only workspace when there is exactly one", () => {
    expect(chooseWorkspaceEntry({ membershipOrgIds: ["org_a"] })).toEqual({
      kind: "enter",
      orgId: "org_a",
    });
  });

  it("defers to the chooser when the user belongs to several workspaces", () => {
    expect(
      chooseWorkspaceEntry({ membershipOrgIds: ["org_a", "org_b"] }),
    ).toEqual({
      kind: "choose",
    });
  });

  it("re-enters the remembered workspace when the user is still a member", () => {
    expect(
      chooseWorkspaceEntry({
        membershipOrgIds: ["org_a", "org_b"],
        lastOrgId: "org_b",
      }),
    ).toEqual({ kind: "enter", orgId: "org_b" });
  });

  it("falls back to the chooser when the remembered workspace was left", () => {
    expect(
      chooseWorkspaceEntry({
        membershipOrgIds: ["org_a", "org_b"],
        lastOrgId: "org_gone",
      }),
    ).toEqual({ kind: "choose" });
  });
});

describe("resolveCrossWorkspaceRedirect", () => {
  const projects: Record<string, { orgId: string }> = {
    p_a: { orgId: "org_a" },
    p_b: { orgId: "org_b" },
  };
  const findById = async (id: string) => projects[id] ?? null;

  it("returns null for a project already in the current org", async () => {
    const target = await resolveCrossWorkspaceRedirect({
      projectId: "p_a",
      currentOrgId: "org_a",
      findById,
      isMember: async () => true,
    });
    expect(target).toBeNull();
  });

  it("returns the other org when the project lives there and the viewer is a member", async () => {
    const target = await resolveCrossWorkspaceRedirect({
      projectId: "p_b",
      currentOrgId: "org_a",
      findById,
      isMember: async (orgId) => orgId === "org_b",
    });
    expect(target).toBe("org_b");
  });

  it("returns null (404 path) when the viewer is not a member of the other org", async () => {
    const target = await resolveCrossWorkspaceRedirect({
      projectId: "p_b",
      currentOrgId: "org_a",
      findById,
      isMember: async () => false,
    });
    expect(target).toBeNull();
  });

  it("returns null for an unknown project id", async () => {
    const target = await resolveCrossWorkspaceRedirect({
      projectId: "p_missing",
      currentOrgId: "org_a",
      findById,
      isMember: async () => true,
    });
    expect(target).toBeNull();
  });
});
