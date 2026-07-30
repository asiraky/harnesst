/**
 * FOH archive lifecycle (#278) — the decision logic in `~/playground/sessions.server`, with the
 * database as a capturing fake (the foh-reconcile pattern). SQL predicates are not asserted
 * here; they are exercised for real in tests/integration/foh-schema.db.test.ts. What this file
 * pins is what the code DECIDES and WRITES:
 *
 *  - a still-working conversation is refused as a VALUE, before any write, and its inbox is
 *    left alone — archiving mid-turn would hide a session that is still writing to itself;
 *  - the refusal survives the read-then-write race (the guarded UPDATE matching nothing means
 *    a turn was claimed in between, which is the same answer a moment earlier);
 *  - a successful archive stamps who/when, retracts the needs-you park, and resolves EVERY
 *    pending bell item — `finished` included, since nobody can open the row to acknowledge it;
 *  - re-archiving is idempotent (double-click, stale tab) and costs no write;
 *  - the back-of-house destructive helpers refuse to run without the admin flag;
 *  - `adoptChannelHomedSession` clears the archive marks on BOTH of its write paths. A new
 *    question landing on an archived session must resurface it, or the question is lost — and
 *    the mid-turn fallback path is the easy one to forget.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionResumeVia } from "~/db/schema";

const dbState = vi.hoisted(() => ({
  /** Queued results, shifted per call; an empty queue yields no rows. */
  selects: [] as unknown[][],
  updateResults: [] as unknown[][],
  deleteResults: [] as unknown[][],
  insertResults: [] as unknown[][],
  /** Captured writes. */
  updates: [] as Array<Record<string, unknown>>,
  inserts: [] as Array<Record<string, unknown>>,
  conflictSets: [] as Array<Record<string, unknown>>,
}));

const inbox = vi.hoisted(() => ({
  openInboxQuestion: vi.fn(async () => ({ id: "inb_1" })),
  resolveInboxForArchivedSession: vi.fn(async () => {}),
}));

vi.mock("~/db/client.server", () => {
  const take = (queue: unknown[][]) => (queue.length ? queue.shift()! : []);
  // One chainable, awaitable node stands in for the whole query builder: every builder method
  // returns it, and awaiting it yields the queued rows.
  const node = (result: () => unknown[]) => {
    const self: Record<string, unknown> = {};
    for (const method of [
      "from",
      "leftJoin",
      "innerJoin",
      "where",
      "limit",
      "orderBy",
      "returning",
      "onConflictDoUpdate",
      "onConflictDoNothing",
    ]) {
      self[method] = () => self;
    }
    self.then = (
      resolve: (value: unknown[]) => unknown,
      reject: (reason: unknown) => unknown,
    ) => Promise.resolve(result()).then(resolve, reject);
    return self;
  };
  return {
    db: {
      select: () => node(() => take(dbState.selects)),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          dbState.updates.push(values);
          return node(() => take(dbState.updateResults));
        },
      }),
      delete: () => node(() => take(dbState.deleteResults)),
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          dbState.inserts.push(values);
          const self = node(() => take(dbState.insertResults));
          self.onConflictDoUpdate = (cfg: { set: Record<string, unknown> }) => {
            dbState.conflictSets.push(cfg.set);
            return self;
          };
          return self;
        },
      }),
    },
  };
});

vi.mock("~/foh/inbox.server", () => ({
  openInboxQuestion: inbox.openInboxQuestion,
  resolveInboxForArchivedSession: inbox.resolveInboxForArchivedSession,
  resolveInboxForSession: vi.fn(async () => {}),
}));

import {
  adoptChannelHomedSession,
  archiveFohSession,
  deleteFohSessionPermanently,
  restoreFohSession,
  unarchiveFohSessionForViewer,
  type PlaygroundSession,
} from "~/playground/sessions.server";

function session(over: Partial<PlaygroundSession> = {}): PlaygroundSession {
  return {
    id: "ps_1",
    projectId: "proj_1",
    agentId: "agent_1",
    createdBy: "user_1",
    surface: "foh",
    status: "waiting",
    pendingInputAt: null,
    archivedAt: null,
    archivedBy: null,
    openedByAgentId: null,
    delegationId: null,
    externalSessionId: "sess_ext",
    continuationToken: "tok_1",
    streamIndex: 0,
    cacheIndexOffset: 0,
    title: null,
    lastEventAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as PlaygroundSession;
}

const SCOPE = { id: "ps_1", projectId: "proj_1", viewerId: "user_1" };

beforeEach(() => {
  dbState.selects.length = 0;
  dbState.updateResults.length = 0;
  dbState.deleteResults.length = 0;
  dbState.insertResults.length = 0;
  dbState.updates.length = 0;
  dbState.inserts.length = 0;
  dbState.conflictSets.length = 0;
  vi.clearAllMocks();
});

describe("archiveFohSession", () => {
  it("refuses a session that is still working, before writing anything", async () => {
    dbState.selects.push([session({ status: "running" })]);

    const result = await archiveFohSession(SCOPE);

    expect(result).toEqual({ ok: false, reason: "working" });
    expect(dbState.updates).toHaveLength(0);
    // The bell items belong to a live turn; a refused archive must not clear them.
    expect(inbox.resolveInboxForArchivedSession).not.toHaveBeenCalled();
  });

  it("archives a parked (needs-you) session — only a live turn blocks the tidy-up", async () => {
    const parked = session({
      status: "waiting",
      pendingInputAt: new Date("2026-07-01T09:00:00Z"),
    });
    dbState.selects.push([parked]);
    dbState.updateResults.push([{ ...parked, archivedAt: new Date() }]);

    const result = await archiveFohSession(SCOPE);

    expect(result.ok).toBe(true);
  });

  it("stamps who and when, retracts the park, and resolves the pending inbox items", async () => {
    const now = new Date("2026-07-02T12:00:00Z");
    dbState.selects.push([
      session({ pendingInputAt: new Date("2026-07-01T09:00:00Z") }),
    ]);
    dbState.updateResults.push([
      session({ archivedAt: now, archivedBy: "user_1", pendingInputAt: null }),
    ]);

    const result = await archiveFohSession({ ...SCOPE, now });

    expect(result).toMatchObject({ ok: true, session: { archivedAt: now } });
    expect(dbState.updates).toHaveLength(1);
    expect(dbState.updates[0]).toMatchObject({
      archivedAt: now,
      archivedBy: "user_1",
      // Leaving the park set would restore the conversation straight back into "needs you"
      // with no inbox item behind it.
      pendingInputAt: null,
      updatedAt: now,
    });
    // The all-kinds variant, not the question/approval one a stop uses: a `finished` item left
    // pending here would be a bell entry whose link 404s and which nothing can ever resolve.
    expect(inbox.resolveInboxForArchivedSession).toHaveBeenCalledWith("ps_1");
  });

  it("treats an already-archived row as done without a second write", async () => {
    const archived = session({
      archivedAt: new Date("2026-07-01T00:00:00Z"),
      archivedBy: "user_9",
    });
    dbState.selects.push([archived]);

    const result = await archiveFohSession(SCOPE);

    expect(result).toEqual({ ok: true, session: archived });
    expect(dbState.updates).toHaveLength(0);
    expect(inbox.resolveInboxForArchivedSession).not.toHaveBeenCalled();
  });

  it("reports not_found when the session is outside the viewer's scope", async () => {
    dbState.selects.push([]);

    expect(await archiveFohSession(SCOPE)).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(dbState.updates).toHaveLength(0);
  });

  it("re-refuses when a turn is claimed between the read and the write", async () => {
    dbState.selects.push([session({ status: "waiting" })]);
    // The guarded UPDATE (status <> 'running') matched nothing: someone started a turn.
    dbState.updateResults.push([]);

    expect(await archiveFohSession(SCOPE)).toEqual({
      ok: false,
      reason: "working",
    });
    expect(inbox.resolveInboxForArchivedSession).not.toHaveBeenCalled();
  });
});

describe("unarchiveFohSessionForViewer", () => {
  it("clears both archive marks and reports the restored row", async () => {
    const restored = session();
    dbState.updateResults.push([restored]);

    const result = await unarchiveFohSessionForViewer(SCOPE);

    expect(result).toEqual({ ok: true, session: restored });
    expect(dbState.updates[0]).toMatchObject({
      archivedAt: null,
      archivedBy: null,
    });
  });

  it("reports not_found when no archived row matches the viewer's scope", async () => {
    dbState.updateResults.push([]);
    expect(await unarchiveFohSessionForViewer(SCOPE)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});

describe("back-of-house restore / permanent delete", () => {
  it("restores by clearing the archive marks", async () => {
    const restored = session();
    dbState.updateResults.push([restored]);

    expect(
      await restoreFohSession({
        id: "ps_1",
        projectId: "proj_1",
        backOfHouse: true,
      }),
    ).toEqual(restored);
    expect(dbState.updates[0]).toMatchObject({
      archivedAt: null,
      archivedBy: null,
    });
  });

  it("reports whether the permanent delete matched a row", async () => {
    dbState.deleteResults.push([{ id: "ps_1" }]);
    expect(
      await deleteFohSessionPermanently({
        id: "ps_1",
        projectId: "proj_1",
        backOfHouse: true,
      }),
    ).toBe(true);

    dbState.deleteResults.push([]);
    expect(
      await deleteFohSessionPermanently({
        id: "ps_1",
        projectId: "proj_1",
        backOfHouse: true,
      }),
    ).toBe(false);
  });

  it("refuses to run at all without back-of-house access", async () => {
    // A caller that forgets the guard must fail loudly, not quietly grant a member admin reach.
    await expect(
      restoreFohSession({
        id: "ps_1",
        projectId: "proj_1",
        backOfHouse: false,
      }),
    ).rejects.toThrow(/back-of-house/);
    await expect(
      deleteFohSessionPermanently({
        id: "ps_1",
        projectId: "proj_1",
        backOfHouse: false,
      }),
    ).rejects.toThrow(/back-of-house/);
    expect(dbState.updates).toHaveLength(0);
  });
});

describe("adoptChannelHomedSession un-archives on park", () => {
  const RESUME = {
    channel: "github",
    rawToken: "tok",
    state: {},
  } as unknown as SessionResumeVia;
  const NOW = new Date("2026-07-03T08:00:00Z");
  const input = {
    projectId: "proj_1",
    agentId: "agent_1",
    environmentId: "env_1",
    deploymentId: "dep_1",
    releaseId: "rel_1",
    version: "v1",
    externalSessionId: "sess_ext",
    continuationToken: "tok_1",
    resumeVia: RESUME,
    staleAfterMs: 300_000,
    now: NOW,
  };

  it("clears the marks in the upsert that wins the park", async () => {
    dbState.insertResults.push([session()]);

    const result = await adoptChannelHomedSession(input);

    expect(result).toMatchObject({ ok: true, parkDeferred: false });
    expect(dbState.conflictSets[0]).toMatchObject({
      archivedAt: null,
      archivedBy: null,
    });
  });

  it("clears the marks in the mid-turn fallback too — the easy path to forget", async () => {
    // The fenced upsert skips (a live turn holds the claim), the row reads back as ours, and
    // the narrow fallback refreshes only what no turn owns.
    dbState.insertResults.push([]);
    dbState.selects.push([session({ status: "running", archivedAt: NOW })]);
    dbState.updateResults.push([session()]);

    const result = await adoptChannelHomedSession(input);

    expect(result).toMatchObject({ ok: true, parkDeferred: true });
    expect(dbState.updates).toHaveLength(1);
    expect(dbState.updates[0]).toMatchObject({
      archivedAt: null,
      archivedBy: null,
    });
  });

  it("writes nothing when the eve session belongs to another agent", async () => {
    dbState.insertResults.push([]);
    dbState.selects.push([session({ agentId: "agent_other" })]);

    expect(await adoptChannelHomedSession(input)).toEqual({
      ok: false,
      reason: "session_not_owned",
    });
    expect(dbState.updates).toHaveLength(0);
  });
});
