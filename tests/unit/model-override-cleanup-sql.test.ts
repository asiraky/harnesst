/**
 * Override cleanup and workspace-default mutations must not delete someone else's configuration.
 *
 *  - `cleanupSubagentOverrides` must take the removed subagent AND its descendants, nothing
 *    shallower and nothing merely prefix-similar, and must leave a LEGACY top-level row (no
 *    project pin) alone even when the whole member goes — another repo's same-named agent may
 *    still be resolving through it;
 *  - `setWorkspaceAssistantSelection` must retain every explicit pin, even when a pin equals
 *    the new workspace default. Equality does not mean inheritance (issue #392).
 *
 * The `db` seam is faked down to the WHERE clause, which is rendered with drizzle's own dialect —
 * so the assertion is about the predicate that would reach Postgres, not about a re-implementation
 * of it.
 */
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  deletes: [] as unknown[],
  writes: [] as unknown[],
}));

vi.mock("~/db/client.server", () => {
  const del = () => ({
    where: async (condition: unknown) => {
      captured.deletes.push(condition);
    },
  });
  const tx = {
    delete: del,
    insert: () => ({
      values: (row: unknown) => ({
        onConflictDoUpdate: async () => {
          captured.writes.push(row);
        },
      }),
    }),
  };
  return {
    db: {
      delete: del,
      transaction: async (callback: (t: typeof tx) => Promise<void>) =>
        callback(tx),
    },
  };
});

const { cleanupSubagentOverrides } =
  await import("~/models/agent-model-config.server");
const { setWorkspaceAssistantSelection } =
  await import("~/org/workspace.server");

const dialect = new PgDialect();

/** The last WHERE clause a delete received, as the SQL text + bound params Postgres would see. */
function lastDelete(): { sql: string; params: unknown[] } {
  const condition = captured.deletes.at(-1);
  const query = dialect.sqlToQuery(condition as SQL);
  return { sql: query.sql, params: query.params };
}

beforeEach(() => {
  captured.deletes = [];
  captured.writes = [];
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
    // …but a legacy, repo-agnostic TOP-LEVEL row survives: only this repo's rows and nested
    // legacy rows are in scope (`subagent_path <> ''`). The legacy pin is `project_id = ''`
    // (part of the primary key since #344), never NULL.
    expect(sql).toContain('"project_id" =');
    expect(sql).not.toContain('"project_id" is null');
    expect(params).toContain("");
    expect(sql).toContain("<> ''");
  });
});

describe("setWorkspaceAssistantSelection", () => {
  it("saves a new default without clearing matching agent or subagent pins", async () => {
    await setWorkspaceAssistantSelection("org_1", {
      model: "anthropic/conn_1/claude-opus-4.8",
      effort: "high",
    });

    expect(captured.deletes).toEqual([]);
    expect(captured.writes).toEqual([
      {
        orgId: "org_1",
        assistantModel: "anthropic/conn_1/claude-opus-4.8",
        assistantEffort: "high",
      },
    ]);
  });

  it("preserves pins when the default changes away and back", async () => {
    for (const model of [
      "openai/conn_1/first",
      "openai/conn_1/second",
      "openai/conn_1/first",
    ]) {
      await setWorkspaceAssistantSelection("org_1", { model, effort: null });
    }
    expect(captured.deletes).toEqual([]);
    expect(captured.writes).toHaveLength(3);
  });

  it("clears the default and its reasoning without clearing agent pins", async () => {
    await setWorkspaceAssistantSelection("org_1", {
      model: null,
      effort: "high",
    });

    expect(captured.deletes).toEqual([]);
    expect(captured.writes).toEqual([
      { orgId: "org_1", assistantModel: null, assistantEffort: null },
    ]);
  });
});
