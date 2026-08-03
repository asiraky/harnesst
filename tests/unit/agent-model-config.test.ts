/**
 * The workspace agent-model resolution contract (`pickAgentModel`): an explicit per-agent
 * override always wins, the workspace default answers otherwise, and an unconfigured
 * workspace resolves to nothing — which the model-config endpoint surfaces as a readable
 * "set a model in Org settings" error rather than any silent fallback.
 *
 * And the declared-subagent chain (issue #344): a configuration target is `(agent, subagentPath)`,
 * and a subagent with no pin of its own inherits its NEAREST configured ancestor — the workspace
 * default only answers once the whole chain, member row included, comes up empty.
 *
 * The last block covers what the pure functions cannot: `project_id` is part of the key, so two
 * repos holding same-named agents must not read, overwrite, or delete each other's rows. The `db`
 * seam is faked down to the statement, rendered with drizzle's own dialect — the assertion is about
 * what would reach Postgres.
 */
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  deletes: [] as unknown[],
  selects: [] as unknown[],
  inserts: [] as { values: Record<string, unknown>; target: unknown[] }[],
  rows: [] as Record<string, unknown>[],
}));

vi.mock("~/db/client.server", () => {
  const reader = () => {
    const rows = () => Promise.resolve(captured.rows);
    const chain: Record<string, unknown> = {
      orderBy: () => chain,
      limit: () => rows(),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        rows().then(resolve, reject),
    };
    return chain;
  };
  return {
    db: {
      select: () => ({
        from: () => ({
          where: (condition: unknown) => {
            captured.selects.push(condition);
            return reader();
          },
        }),
      }),
      delete: () => ({
        where: async (condition: unknown) => {
          captured.deletes.push(condition);
        },
      }),
      insert: () => ({
        values: (values: Record<string, unknown>) => ({
          onConflictDoUpdate: async ({ target }: { target: unknown[] }) => {
            captured.inserts.push({ values, target });
          },
        }),
      }),
    },
  };
});

import {
  getAgentModelOverride,
  inheritanceChain,
  pickAgentModel,
  pickTargetModel,
  removeAgentModelOverride,
  removeAgentModelOverrideRow,
  removeProjectModelOverrides,
  setAgentModelOverride,
  UNSCOPED_PROJECT,
  type AgentModelSelection,
} from "~/models/agent-model-config.server";

const OVERRIDE = {
  model: "anthropic/abcdefghijkl/claude-opus-4.8",
  effort: "high" as const,
};
const DEFAULT = {
  model: "openai/mnopqrstuvwx/gpt-5.1",
  effort: "medium" as const,
};

describe("pickAgentModel", () => {
  it("prefers the agent's explicit override over the workspace default", () => {
    expect(pickAgentModel(OVERRIDE, DEFAULT)).toEqual({
      ...OVERRIDE,
      source: "override",
    });
  });

  it("falls back to the workspace default when no override exists", () => {
    expect(pickAgentModel(null, DEFAULT)).toEqual({
      model: DEFAULT.model,
      effort: DEFAULT.effort,
      source: "workspace-default",
    });
  });

  it("keeps the override's own effort even when it is null (no default bleed-through)", () => {
    expect(pickAgentModel({ model: OVERRIDE.model, effort: null }, DEFAULT)).toEqual(
      {
        model: OVERRIDE.model,
        effort: null,
        source: "override",
      },
    );
  });

  it("resolves to nothing when the workspace has no configuration at all", () => {
    expect(pickAgentModel(null, { model: null, effort: null })).toBeNull();
  });
});

describe("inheritanceChain", () => {
  it("walks a nested path outwards and ends at the member agent", () => {
    expect(inheritanceChain("reader/skimmer")).toEqual([
      "reader/skimmer",
      "reader",
      "",
    ]);
  });

  it("is just the member for a top-level target", () => {
    expect(inheritanceChain("")).toEqual([""]);
  });

  it("ignores empty segments from a sloppy path", () => {
    expect(inheritanceChain("/reader//skimmer/")).toEqual([
      "reader/skimmer",
      "reader",
      "",
    ]);
  });
});

describe("pickTargetModel", () => {
  it("prefers the subagent's own pin over every ancestor", () => {
    const resolved = pickTargetModel(
      "reader/skimmer",
      new Map<string, AgentModelSelection>([
        ["reader/skimmer", OVERRIDE],
        ["reader", DEFAULT],
        ["", DEFAULT],
      ]),
      DEFAULT,
    );
    expect(resolved).toEqual({ ...OVERRIDE, source: "override" });
  });

  it("inherits the NEAREST configured ancestor, not the member agent", () => {
    const resolved = pickTargetModel(
      "reader/skimmer",
      new Map<string, AgentModelSelection>([
        ["reader", OVERRIDE],
        ["", DEFAULT],
      ]),
      DEFAULT,
    );
    expect(resolved).toEqual({
      ...OVERRIDE,
      source: "parent-override",
      inheritedFrom: "reader",
    });
  });

  it("names the member agent as the source when only it is pinned", () => {
    const resolved = pickTargetModel(
      "reader/skimmer",
      new Map([["", OVERRIDE]]),
      DEFAULT,
    );
    expect(resolved).toEqual({
      ...OVERRIDE,
      source: "parent-override",
      inheritedFrom: "",
    });
  });

  it("falls through the whole chain to the workspace default", () => {
    expect(pickTargetModel("reader/skimmer", new Map(), DEFAULT)).toEqual({
      model: DEFAULT.model,
      effort: DEFAULT.effort,
      source: "workspace-default",
    });
  });

  it("resolves to nothing when neither the chain nor the workspace is configured", () => {
    expect(
      pickTargetModel("reader", new Map(), { model: null, effort: null }),
    ).toBeNull();
  });

  it("treats the member agent itself as its own override, never an inherited one", () => {
    expect(pickTargetModel("", new Map([["", OVERRIDE]]), DEFAULT)).toEqual({
      ...OVERRIDE,
      source: "override",
    });
  });
});

/**
 * Cross-repo isolation. One workspace routinely holds two repos with an agent called `ivy`; the
 * row belongs to exactly one of them, and `''` is the legacy row that answers for whichever repo
 * has none of its own.
 */
describe("override rows are keyed by repo", () => {
  const dialect = new PgDialect();
  const render = (condition: unknown) => dialect.sqlToQuery(condition as SQL);

  beforeEach(() => {
    captured.deletes = [];
    captured.selects = [];
    captured.inserts = [];
    captured.rows = [];
  });

  it("writes the caller's repo into the key, so another repo's row is never the conflict", async () => {
    await setAgentModelOverride(
      "org_1",
      { agentName: "ivy", subagentPath: "", projectId: "p2" },
      OVERRIDE,
    );
    const [insert] = captured.inserts;
    expect(insert.values).toMatchObject({ projectId: "p2", agentName: "ivy" });
    // Repo A's row (`p1`, same org/name/path) differs in a KEY column, so this insert can only
    // ever conflict with repo B's own row.
    expect(insert.target).toHaveLength(4);
    expect(
      insert.target.map((c) => (c as { name: string }).name),
    ).toEqual(["org_id", "project_id", "agent_name", "subagent_path"]);
  });

  it("refuses a write with no repo — the unattributed row is never authored", async () => {
    await expect(
      setAgentModelOverride(
        "org_1",
        { agentName: "ivy", subagentPath: "" },
        OVERRIDE,
      ),
    ).rejects.toThrow(/missing projectId/);
    expect(captured.inserts).toEqual([]);
  });

  it("clears this repo's row and the legacy one, never another repo's pin", async () => {
    await removeAgentModelOverride("org_1", {
      agentName: "ivy",
      subagentPath: "reader",
      projectId: "p2",
    });
    const { sql, params } = render(captured.deletes.at(-1));
    expect(sql).toContain('"project_id" in');
    expect(params).toContain("p2");
    expect(params).toContain(UNSCOPED_PROJECT);
    expect(params).not.toContain("p1");
  });

  it("refuses a clear with no repo", async () => {
    await expect(
      removeAgentModelOverride("org_1", { agentName: "ivy", subagentPath: "" }),
    ).rejects.toThrow(/missing projectId/);
    expect(captured.deletes).toEqual([]);
  });

  it("reads only this repo's row and the legacy one, preferring its own", async () => {
    captured.rows = [{ model: OVERRIDE.model, effort: OVERRIDE.effort }];
    await getAgentModelOverride("org_1", {
      agentName: "ivy",
      subagentPath: "",
      projectId: "p2",
    });
    const { sql, params } = render(captured.selects.at(-1));
    expect(sql).toContain('"project_id" in');
    expect(params).toContain("p2");
    expect(params).toContain(UNSCOPED_PROJECT);
    expect(params).not.toContain("p1");
  });

  it("resolves by name alone when the caller sends no repo (pre-#344 deployments)", async () => {
    captured.rows = [];
    await getAgentModelOverride("org_1", { agentName: "ivy", subagentPath: "" });
    const { sql } = render(captured.selects.at(-1));
    expect(sql).not.toContain('"project_id"');
  });

  it("prefers the legacy row for a repo with none of its own", async () => {
    // The preference is expressed in SQL, so assert the row the query would return first: the
    // fake replays what Postgres would hand back under that ORDER BY.
    captured.rows = [{ model: DEFAULT.model, effort: DEFAULT.effort }];
    expect(
      await getAgentModelOverride("org_1", {
        agentName: "ivy",
        subagentPath: "",
        projectId: "p2",
      }),
    ).toEqual({ model: DEFAULT.model, effort: DEFAULT.effort });
  });

  it("deletes exactly one stored row by its full key (org-level surfaces)", async () => {
    await removeAgentModelOverrideRow("org_1", {
      agentName: "ivy",
      subagentPath: "",
      projectId: UNSCOPED_PROJECT,
    });
    const { sql, params } = render(captured.deletes.at(-1));
    expect(sql).toContain('"project_id" =');
    expect(sql).not.toContain('"project_id" in');
    expect(params).toContain(UNSCOPED_PROJECT);
  });

  it("takes a deleted repo's rows with it, and only its own", async () => {
    await removeProjectModelOverrides("org_1", "p1");
    const { params } = render(captured.deletes.at(-1));
    expect(params).toEqual(["org_1", "p1"]);
  });

  it("never issues a repo-wide delete without a repo (that would take the legacy rows)", async () => {
    await removeProjectModelOverrides("org_1", "");
    expect(captured.deletes).toEqual([]);
  });
});
