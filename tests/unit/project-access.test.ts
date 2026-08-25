/**
 * The pure half of app/auth/project-access.server.ts: role parsing and ordering. The database
 * side (grants, backfill, invitation application) is covered by the db integration suite.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("~/db/client.server", () => ({ db: {} }));

import {
  parseProjectRole,
  PROJECT_ROLES,
  roleSatisfies,
} from "~/auth/project-access.server";

describe("parseProjectRole", () => {
  it("accepts exactly read and write", () => {
    expect(PROJECT_ROLES).toEqual(["read", "write"]);
    expect(parseProjectRole("read")).toBe("read");
    expect(parseProjectRole("write")).toBe("write");
  });

  it("rejects everything else — there is no repo admin", () => {
    for (const value of ["admin", "owner", "none", "", null, undefined, 1, "READ"]) {
      expect(parseProjectRole(value)).toBeNull();
    }
  });
});

describe("roleSatisfies", () => {
  it("write covers read; read does not cover write; nothing covers no grant", () => {
    expect(roleSatisfies("write", "read")).toBe(true);
    expect(roleSatisfies("write", "write")).toBe(true);
    expect(roleSatisfies("read", "read")).toBe(true);
    expect(roleSatisfies("read", "write")).toBe(false);
    expect(roleSatisfies(null, "read")).toBe(false);
    expect(roleSatisfies(undefined, "read")).toBe(false);
  });
});
