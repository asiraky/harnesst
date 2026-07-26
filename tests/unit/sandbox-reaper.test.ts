/**
 * Sandbox reaper (issue #118) — proven against a fake docker + fake store, no daemon, no DB.
 *
 * The fake `runDocker` answers `ps` with canned ids, `inspect` with canned container JSON, and
 * records the ids passed to `rm -f`. The fake store's `environments.listAll` seeds the
 * volume→environment map the reaper uses to attribute a reaped stall to its project. We pin: a young
 * running sandbox is spared; an old running one with no in-flight exec (and a known env) is reaped
 * AND records a `failed` run keyed `reaped:<sessionId>`; a live exec spares it; an old EXITED one is
 * GC'd with NO run row; a non-harnesst volume is untouched; a known-label but unknown env is reaped
 * without a run; a docker error soft-fails without throwing; and the ceiling boundary is exclusive.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DataStore } from "~/data/ports";
import {
  SANDBOX_REAP_CEILING_MS,
  sweepLeakedSandboxes,
  type SandboxReaperDeps,
} from "~/deploy/sandbox-reaper.server";
import { homeVolumeName } from "~/seams/oss/deploy.localdocker.server";

const NOW = Date.parse("2026-07-12T00:00:00.000Z");
const now = () => new Date(NOW);

const KNOWN_ENV = "env_known";
const KNOWN_PROJECT = "proj_known";
const KNOWN_VOLUME = homeVolumeName(KNOWN_ENV);
const UNKNOWN_VOLUME = homeVolumeName("env_ghost");

interface FakeContainer {
  Id: string;
  Name: string;
  Created: string;
  State: { Status: string; FinishedAt: string };
  ExecIDs: string[] | null;
  Config: { Labels: Record<string, string> };
  Mounts: { Name: string }[];
}

function container(opts: {
  id: string;
  status?: "running" | "exited";
  createdMsAgo: number;
  finishedMsAgo?: number;
  execIds?: string[] | null;
  volume?: string | null;
  channel?: string;
  sessionId?: string;
}): FakeContainer {
  const status = opts.status ?? "running";
  const mounts = opts.volume === null ? [] : [{ Name: opts.volume ?? KNOWN_VOLUME }];
  return {
    Id: opts.id,
    Name: `eve-sbx-ses-${opts.id}`,
    Created: new Date(NOW - opts.createdMsAgo).toISOString(),
    State: {
      Status: status,
      FinishedAt:
        status === "exited" && opts.finishedMsAgo != null
          ? new Date(NOW - opts.finishedMsAgo).toISOString()
          : "0001-01-01T00:00:00Z",
    },
    ExecIDs: opts.execIds ?? [],
    Config: {
      Labels: {
        "eve.sandbox.role": "session",
        "eve.sandbox.tag.channel": opts.channel ?? "schedule",
        "eve.sandbox.tag.sessionId": opts.sessionId ?? `wrun_${opts.id}`,
        "eve.sandbox.tag.agent": "engineer",
      },
    },
    Mounts: mounts,
  };
}

function fakeStore(
  envs: { id: string; projectId: string }[] = [{ id: KNOWN_ENV, projectId: KNOWN_PROJECT }],
): DataStore {
  return {
    environments: { async listAll() {
      return envs.map((e) => ({ ...e, agentId: "a", name: "n", createdAt: new Date(0) }));
    } },
  } as unknown as DataStore;
}

function makeDeps(
  containers: FakeContainer[],
  opts: { failOn?: string; store?: DataStore } = {},
): {
  deps: SandboxReaperDeps;
  removed: string[];
  recorded: { projectId: string; payload: Record<string, unknown> }[];
} {
  const removed: string[] = [];
  const recorded: { projectId: string; payload: Record<string, unknown> }[] = [];
  const runDocker = async (args: string[]): Promise<string> => {
    if (opts.failOn && args[0] === opts.failOn) throw new Error("docker daemon unreachable");
    if (args[0] === "ps") return containers.map((c) => c.Id).join("\n");
    if (args[0] === "inspect") {
      const ids = args.slice(1);
      return JSON.stringify(containers.filter((c) => ids.includes(c.Id)));
    }
    if (args[0] === "rm") {
      removed.push(...args.slice(2));
      return "";
    }
    return "";
  };
  const deps: SandboxReaperDeps = {
    store: opts.store ?? fakeStore(),
    runDocker,
    recordRun: async (projectId, payload) => {
      recorded.push({ projectId, payload: payload as unknown as Record<string, unknown> });
    },
    now,
  };
  return { deps, removed, recorded };
}

const OLD = SANDBOX_REAP_CEILING_MS + 60_000;
const YOUNG = SANDBOX_REAP_CEILING_MS - 60_000;

afterEach(() => vi.restoreAllMocks());

describe("sweepLeakedSandboxes", () => {
  it("spares a young running sandbox", async () => {
    const { deps, removed, recorded } = makeDeps([
      container({ id: "young", createdMsAgo: YOUNG }),
    ]);
    const res = await sweepLeakedSandboxes(deps);
    expect(res).toEqual({ scanned: 1, reaped: 0, recorded: 0, spared: 1 });
    expect(removed).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it("reaps an old running sandbox and records a failed run keyed reaped:<sessionId>", async () => {
    const { deps, removed, recorded } = makeDeps([
      container({ id: "stall", createdMsAgo: OLD, sessionId: "wrun_STALL" }),
    ]);
    const res = await sweepLeakedSandboxes(deps);
    expect(res).toEqual({ scanned: 1, reaped: 1, recorded: 1, spared: 0 });
    expect(removed).toEqual(["stall"]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].projectId).toBe(KNOWN_PROJECT);
    expect(recorded[0].payload.externalRunId).toBe("reaped:wrun_STALL");
    expect(recorded[0].payload.status).toBe("failed");
    expect(recorded[0].payload.channel).toBe("schedule");
    expect(String(recorded[0].payload.error)).toMatch(/stalled before its first step/i);
    expect(recorded[0].payload.session).toMatchObject({
      externalSessionId: "wrun_STALL",
      channel: "schedule",
      trigger: "schedule",
    });
    expect(recorded[0].payload.metadata).toMatchObject({ reapedSandbox: true });
  });

  it("spares an old running sandbox with a live docker exec in flight", async () => {
    const { deps, removed, recorded } = makeDeps([
      container({ id: "busy", createdMsAgo: OLD, execIds: ["exec_abc"] }),
    ]);
    const res = await sweepLeakedSandboxes(deps);
    expect(res).toEqual({ scanned: 1, reaped: 0, recorded: 0, spared: 1 });
    expect(removed).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it("reaps an old EXITED sandbox but records NO run (may be a finished turn)", async () => {
    const { deps, removed, recorded } = makeDeps([
      container({ id: "exited", status: "exited", createdMsAgo: OLD * 2, finishedMsAgo: OLD }),
    ]);
    const res = await sweepLeakedSandboxes(deps);
    expect(res).toEqual({ scanned: 1, reaped: 1, recorded: 0, spared: 0 });
    expect(removed).toEqual(["exited"]);
    expect(recorded).toEqual([]);
  });

  it("leaves a sandbox mounting a non-harnesst volume untouched", async () => {
    const { deps, removed, recorded } = makeDeps([
      container({ id: "foreign", createdMsAgo: OLD, volume: "some-other-volume" }),
    ]);
    const res = await sweepLeakedSandboxes(deps);
    expect(res).toEqual({ scanned: 1, reaped: 0, recorded: 0, spared: 1 });
    expect(removed).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it("reaps a known-label sandbox whose env is unknown, WITHOUT recording a run", async () => {
    const { deps, removed, recorded } = makeDeps([
      container({ id: "ghost", createdMsAgo: OLD, volume: UNKNOWN_VOLUME }),
    ]);
    const res = await sweepLeakedSandboxes(deps);
    expect(res).toEqual({ scanned: 1, reaped: 1, recorded: 0, spared: 0 });
    expect(removed).toEqual(["ghost"]);
    expect(recorded).toEqual([]);
  });

  it("soft-fails on a docker error without throwing or reaping", async () => {
    const { deps, removed, recorded } = makeDeps(
      [container({ id: "x", createdMsAgo: OLD })],
      { failOn: "ps" },
    );
    const res = await sweepLeakedSandboxes(deps);
    expect(res.reaped).toBe(0);
    expect(res.error).toMatch(/docker daemon unreachable/);
    expect(removed).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it("respects the ceiling boundary exactly (age == ceiling spared, age > ceiling reaped)", async () => {
    const atCeiling = makeDeps([
      container({ id: "at", createdMsAgo: SANDBOX_REAP_CEILING_MS }),
    ]);
    expect((await sweepLeakedSandboxes(atCeiling.deps)).reaped).toBe(0);

    const pastCeiling = makeDeps([
      container({ id: "past", createdMsAgo: SANDBOX_REAP_CEILING_MS + 1 }),
    ]);
    expect((await sweepLeakedSandboxes(pastCeiling.deps)).reaped).toBe(1);
  });
});
