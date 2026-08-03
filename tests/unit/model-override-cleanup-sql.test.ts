/**
 * The two DELETE predicates over `agent_model_overrides` that no other test can reach — they are
 * pure SQL, and getting them wrong deletes someone else's configuration (issue #344).
 *
 *  - `cleanupSubagentOverrides` must take the removed subagent AND its descendants, nothing
 *    shallower and nothing merely prefix-similar, and must leave a LEGACY top-level row (no
 *    project pin) alone even when the whole member goes — another repo's same-named agent may
 *    still be resolving through it;
 *  - `setWorkspaceAssistantSelection`'s "redundant pin" sweep must be restricted to top-level
 *    rows, because a subagent row equal to the new default is still a deliberate exception to its
 *    parent's selection.
 *
 * The `db` seam is faked down to the WHERE clause, which is rendered with drizzle's own dialect —
 * so the assertion is about the predicate that would reach Postgres, not about a re-implementation
 * of it.
 */
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ deletes: [] as unknown[] }));

vi.mock("~/db/client.server", () => {
  const del = () => ({
    where: async (condition: unknown) => {
      captured.deletes.push(condition);
    },
  });
  const tx = {
    delete: del,
    insert: () => ({ values: () => ({ onConflictDoUpdate: async () => {} }) }),
  };
  return {
    db: {
      delete: del,
      transaction: async (callback: (t: typeof tx) => Promise<void>) => callback(tx),
    },
  };
});

const { cleanupSubagentOverrides } = await import(
  "~/models/agent-model-config.server"
);
const { setWorkspaceAssistantSelection } = await import("~/org/workspace.server");

const dialect = new PgDialect();

/** The last WHERE clause a delete received, as the SQL text + bound params Postgres would see. */
function lastDelete(): { sql: string; params: unknown[] } {
  const condition = captured.deletes.at(-1);
  const query = dialect.sqlToQuery(condition as SQL);
  return { sql: query.sql, params: query.params };
}

beforeEach(() => {
  captured.deletes = [];
});

describe("cleanupSubagentOverrides", () => {
  it("matches the removed subagent and every descendant of it, and nothing else", async () => {
    await cleanupSubagentOverrides("org_1", "p1", "ivy", "reader");

    const { sql, params } = lastDelete();
    expect(sql).toContain('"subagent_path" =');
    expect(sql).toContain('"subagent_path" like');
    // Exactly the subtree: the row itself, and anything below `reader/`.
    expect(params).toContain("reader");
    expect(params).toContain("reader/%");
    // Scoped to one org, one agent name, one repo.
    expect(params).toContain("org_1");
    expect(params).toContain("ivy");
    expect(params).toContain("p1");
  });

  it("prunes a whole removed member without a path filter", async () => {
    await cleanupSubagentOverrides("org_1", "p1", "ivy", "");

    const { sql, params } = lastDelete();
    expect(params).not.toContain("/%");
    // …but a legacy, repo-less TOP-LEVEL row survives: only repo-pinned rows and nested legacy
    // rows are in scope (`subagent_path <> ''`).
    expect(sql).toContain('"project_id" is null');
    expect(sql).toContain("<> ''");
  });
});

describe("setWorkspaceAssistantSelection", () => {
  it("sweeps only top-level pins that equal the new default", async () => {
    await setWorkspaceAssistantSelection("org_1", {
      model: "anthropic/conn_1/claude-opus-4.8",
      effort: "high",
    });

    const { sql, params } = lastDelete();
    expect(sql).toContain('"subagent_path" =');
    // The empty string is the top-level target — subagent rows are never swept.
    expect(params).toContain("");
    expect(params).toContain("anthropic/conn_1/claude-opus-4.8");
    expect(params).toContain("high");
  });

  it("sweeps nothing when the default is cleared", async () => {
    await setWorkspaceAssistantSelection("org_1", { model: null, effort: "high" });

    expect(captured.deletes).toEqual([]);
  });
});
