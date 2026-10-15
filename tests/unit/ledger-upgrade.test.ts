import { readdirSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { HOSTED_MIGRATIONS } from "~/marketplace/supabase-provisioning.server";
import { ServiceConnectionUnusableError } from "~/service-connections/connections.server";

// The row's sealed state is replaced by a plain object so the test can read what was written.
const state = vi.hoisted(() => ({
  row: null as null | Record<string, unknown>,
  linked: null as null | ((fn: (token: string) => unknown) => unknown),
  exclusive: true,
  updates: [] as Array<Record<string, unknown>>,
}));

vi.mock("~/db/client.server", () => ({
  db: { transaction: (fn: (tx: unknown) => unknown) => fn({}) },
}));

vi.mock("~/provisioners/state.server", () => ({
  lockProvisioning: async () => {},
  getProvisioning: async () => state.row,
  updateProvisioning: async (
    _projectId: string,
    _provisioner: string,
    values: Record<string, unknown>,
  ) => {
    state.updates.push(values);
    if (state.row && values.encryptedState)
      state.row = { ...state.row, encryptedState: values.encryptedState };
  },
  sealState: (s: object) => s,
  openState: (row: { encryptedState: object }) => row.encryptedState,
  withExclusiveRun: async (_p: string, _id: string, fn: () => unknown) =>
    state.exclusive ? fn() : "busy",
  withLinkedCredential: (
    _p: string,
    _id: string,
    fn: (token: string) => unknown,
  ) => (state.linked ? state.linked(fn) : fn("sbp_secret")),
}));

const { upgradeLedger } =
  await import("~/provisioners/supabase-ledger/provisioner.server");

const files = readdirSync(HOSTED_MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const latest = files.at(-1)!;

function installed(extra: Record<string, unknown> = {}) {
  return {
    projectId: "p",
    provisioner: "supabase-ledger",
    status: "ready",
    projectRef: "abcdefghijklmnopqrst",
    encryptedState: { approvalsKey: "k", ...extra },
  };
}

beforeEach(() => {
  state.row = installed();
  state.linked = null;
  state.exclusive = true;
  state.updates = [];
  vi.unstubAllGlobals();
});

describe("upgradeLedger", () => {
  it("applies only migrations the ledger hasn't journalled, then records the version", async () => {
    const queries: string[] = [];
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(
        "https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/database/query",
      );
      expect((init.headers as Record<string, string>).Authorization).toBe(
        "Bearer sbp_secret",
      );
      const { query } = JSON.parse(String(init.body)) as { query: string };
      queries.push(query);
      if (query.startsWith("select version"))
        return new Response(
          JSON.stringify(files.slice(0, -1).map((version) => ({ version }))),
        );
      return new Response("[]");
    });
    vi.stubGlobal("fetch", fetch);

    await expect(upgradeLedger("p")).resolves.toEqual({
      outcome: "upgraded",
      applied: [latest],
    });
    const migrations = queries.filter((q) =>
      q.includes("harnesst_install.migrations values"),
    );
    expect(migrations).toHaveLength(1);
    expect(migrations[0]).toContain(`'${latest}'`);
    expect(state.row?.encryptedState).toMatchObject({
      approvalsKey: "k",
      migratedThrough: latest,
    });
    expect(state.updates.at(-1)).toMatchObject({ error: null });
  });

  it("records a reconnect message and fails without throwing when the connection is unusable", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    state.linked = () => {
      throw new ServiceConnectionUnusableError(
        "invalid",
        "Reconnect Supabase: the Prod connection was rejected.",
      );
    };
    await expect(upgradeLedger("p")).resolves.toEqual({
      outcome: "failed",
      error: "Reconnect Supabase: the Prod connection was rejected.",
    });
    expect(state.updates.at(-1)).toEqual({
      step: "Ledger update failed",
      error: "Reconnect Supabase: the Prod connection was rejected.",
    });
    expect(state.row?.status).toBe("ready");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("hides upstream failure detail behind a generic message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("relation secret_query failed", { status: 400 }),
      ),
    );
    const result = await upgradeLedger("p");
    expect(result).toMatchObject({ outcome: "failed" });
    expect(JSON.stringify(result)).not.toContain("secret_query");
  });

  it("skips a ledger that isn't installed", async () => {
    state.row = { ...installed(), status: "pending" };
    await expect(upgradeLedger("p")).resolves.toEqual({ outcome: "skipped" });
  });

  it("reports busy when another upgrade holds the project", async () => {
    state.exclusive = false;
    await expect(upgradeLedger("p")).resolves.toEqual({ outcome: "busy" });
    expect(state.updates).toEqual([]);
  });
});
