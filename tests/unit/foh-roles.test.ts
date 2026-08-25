/**
 * Workspace-role gating: `isWorkspaceAdmin` decides which org roles may manage the workspace
 * (members, settings, GitHub install, creating repos), and `requireWorkspaceAdmin` enforces it —
 * redirect home for page routes, 403 JSON for API/resource routes. Pure over an
 * ActiveWorkspace, no Better Auth needed.
 */
import { describe, expect, it, vi } from "vitest";

// Pure role decisions only — never construct the database-backed Better Auth singleton.
vi.mock("~/lib/auth.server", () => ({ auth: { api: {} } }));

import {
  isWorkspaceAdmin,
  isWorkspaceOwner,
  requireWorkspaceAdmin,
  type ActiveWorkspace,
} from "~/auth/workspace.server";

function active(role: string): ActiveWorkspace {
  return {
    org: { id: "org_1", name: "Workspace", slug: "workspace" },
    member: { id: "mem_1", organizationId: "org_1", userId: "user_1", role },
  };
}

describe("isWorkspaceAdmin", () => {
  it("admits owners and admins, turns members away", () => {
    expect(isWorkspaceAdmin("owner")).toBe(true);
    expect(isWorkspaceAdmin("admin")).toBe(true);
    expect(isWorkspaceAdmin("member")).toBe(false);
  });

  it("handles Better Auth's comma-separated multi-role grants", () => {
    expect(isWorkspaceAdmin("member,admin")).toBe(true);
    expect(isWorkspaceAdmin("owner, member")).toBe(true);
    expect(isWorkspaceAdmin("member,member")).toBe(false);
  });

  it("never matches on substrings or unknown roles", () => {
    expect(isWorkspaceAdmin("administrator")).toBe(false);
    expect(isWorkspaceAdmin("co-owner")).toBe(false);
    expect(isWorkspaceAdmin("")).toBe(false);
  });
});

describe("isWorkspaceOwner", () => {
  it("only the owner role counts — admins hold no implicit repo access", () => {
    expect(isWorkspaceOwner("owner")).toBe(true);
    expect(isWorkspaceOwner("member,owner")).toBe(true);
    expect(isWorkspaceOwner("admin")).toBe(false);
    expect(isWorkspaceOwner("co-owner")).toBe(false);
  });
});

describe("requireWorkspaceAdmin", () => {
  it("is a no-op for owners and admins in both modes", () => {
    expect(() => requireWorkspaceAdmin(active("owner"), "page")).not.toThrow();
    expect(() => requireWorkspaceAdmin(active("admin"), "api")).not.toThrow();
  });

  it("redirects a member to the FOH home from page routes", () => {
    let thrown: unknown;
    try {
      requireWorkspaceAdmin(active("member"), "page");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(302);
    expect((thrown as Response).headers.get("location")).toBe("/");
  });

  it("throws 403 JSON at a member on API routes and mutations", async () => {
    let thrown: unknown;
    try {
      requireWorkspaceAdmin(active("member"), "api");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Response);
    const response = thrown as Response;
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(((await response.json()) as { error: string }).error).toMatch(
      /workspace admin/i,
    );
  });
});
