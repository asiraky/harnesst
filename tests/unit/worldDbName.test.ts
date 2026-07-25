/**
 * worldDbName — the environment-keyed Workflow world database name (the durability fix).
 * Verifies the two properties the durability model depends on: STABILITY (one worldKey always
 * maps to one db name, so a redeploy reattaches the same world) and COLLISION-SAFETY (keys that
 * sanitize to the same identifier still land on distinct databases, via the raw-key sha1 slug).
 */
import { describe, expect, it } from "vitest";

import { worldDbName } from "~/seams/oss/deploy.localdocker.server";

describe("worldDbName", () => {
  it("is stable for a given worldKey (a redeploy reuses the same world)", () => {
    expect(worldDbName("env_abc123")).toBe(worldDbName("env_abc123"));
  });

  it("produces a legal, lowercase pg identifier prefixed harnesst_env_", () => {
    const name = worldDbName("Env-With/Weird.Chars");
    expect(name).toMatch(/^harnesst_env_[a-z0-9_]*_[0-9a-f]{8}$/);
    expect(name).toBe(name.toLowerCase());
    expect(name.length).toBeLessThanOrEqual(63); // Postgres identifier limit
  });

  it("keeps keys that sanitize identically on DISTINCT databases (sha1 of the raw key)", () => {
    // Both sanitize to "enva" — only the raw-key hash slug keeps them apart.
    expect(worldDbName("env/a")).not.toBe(worldDbName("env.a"));
  });
});
