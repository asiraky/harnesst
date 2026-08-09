/**
 * FOH needs-you chokepoint #2: `reconcilePlaygroundSessionFromEve` recovering the park state
 * for drains that died with the process. Eve is a scripted NDJSON tail behind a fetch stub,
 * the DB is a capturing fake, and the inbox helpers are spies — so this pins exactly which
 * writes each tail shape produces, and that builder-surface sessions never see any of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Target } from "~/chat/playground.server";

const dbState = vi.hoisted(() => ({
  updates: [] as Array<Record<string, unknown>>,
  inserts: [] as unknown[],
}));

const inbox = vi.hoisted(() => ({
  openInboxQuestion: vi.fn(async () => ({ id: "inb_1" })),
  resolveInboxForSession: vi.fn(async () => {}),
  unansweredInboxRequests: vi.fn(
    async (_sessionId: string, requests: unknown[]) => requests,
  ),
}));

vi.mock("~/db/client.server", () => ({
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        dbState.updates.push(values);
        // Awaitable directly (cursor/clear writers) AND chainable with .returning()
        // (markSessionPendingInput reports whether its stop-wins claim updated a row).
        return {
          where: () =>
            Object.assign(Promise.resolve([]), {
              returning: () => Promise.resolve([{ id: "ps_1" }]),
            }),
        };
      },
    }),
    insert: () => ({
      values: (values: unknown) => {
        dbState.inserts.push(values);
        return { onConflictDoNothing: () => Promise.resolve() };
      },
    }),
  },
}));

vi.mock("~/foh/inbox.server", () => ({
  openInboxQuestion: inbox.openInboxQuestion,
  resolveInboxForSession: inbox.resolveInboxForSession,
  unansweredInboxRequests: inbox.unansweredInboxRequests,
}));

import {
  reconcilePlaygroundSessionFromEve,
  type PlaygroundSession,
} from "~/playground/sessions.server";

const TARGET: Target = {
  deploymentId: "dep_1",
  releaseId: "rel_1",
  environmentId: "env_1",
  url: "http://inst",
  version: "v1",
} as Target;

function session(over: Partial<PlaygroundSession> = {}): PlaygroundSession {
  return {
    id: "ps_1",
    projectId: "proj_1",
    agentId: "agent_1",
    createdBy: "user_1",
    surface: "foh",
    pendingInputAt: null,
    openedByAgentId: null,
    delegationId: null,
    externalSessionId: "sess_ext",
    continuationToken: "tok_1",
    streamIndex: 0,
    status: "running",
    title: null,
    lastEventAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as PlaygroundSession;
}

/** Eve's session-stream response: one NDJSON line per event. */
function stubEveTail(events: Array<{ type: string; data?: Record<string, unknown> }>) {
  const body =
    events.map((e) => JSON.stringify({ data: {}, ...e })).join("\n") + "\n";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status: 200 })),
  );
}

const askEvent = {
  type: "input.requested",
  data: {
    turnId: "turn_1",
    requests: [{ requestId: "r1", prompt: "Which account?", display: "select" }],
  },
};

/** The pendingInputAt writes among the captured update payloads. */
function pendingWrites(): Array<Record<string, unknown>> {
  return dbState.updates.filter((values) =>
    Object.hasOwn(values, "pendingInputAt"),
  );
}

beforeEach(() => {
  dbState.updates.length = 0;
  dbState.inserts.length = 0;
  vi.clearAllMocks();
  inbox.unansweredInboxRequests.mockImplementation(
    async (_sessionId: string, requests: unknown[]) => requests,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reconcilePlaygroundSessionFromEve — FOH needs-you recovery", () => {
  it("parks a foh session whose tail ends on an unanswered ask", async () => {
    stubEveTail([askEvent, { type: "session.waiting" }]);

    const out = await reconcilePlaygroundSessionFromEve({
      session: session(),
      target: TARGET,
    });

    const writes = pendingWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0].pendingInputAt).toBeInstanceOf(Date);
    expect(inbox.openInboxQuestion).toHaveBeenCalledWith({
      projectId: "proj_1",
      sessionId: "ps_1",
      agentId: "agent_1",
      userId: "user_1",
      delegationId: null,
      request: expect.objectContaining({
        requestId: "r1",
        prompt: "Which account?",
      }),
    });
    expect(inbox.resolveInboxForSession).not.toHaveBeenCalled();
    expect(out.status).toBe("waiting");
    expect(out.pendingInputAt).toBeInstanceOf(Date);
  });

  it("keeps the original park time when the flag was already set", async () => {
    stubEveTail([askEvent, { type: "session.waiting" }]);
    const parkedAt = new Date("2026-07-01T10:00:00Z");

    const out = await reconcilePlaygroundSessionFromEve({
      session: session({ pendingInputAt: parkedAt }),
      target: TARGET,
    });

    expect(pendingWrites()[0].pendingInputAt).toEqual(parkedAt);
    expect(out.pendingInputAt).toEqual(parkedAt);
  });

  it("does not resurrect a request whose inbox identity is already resolved", async () => {
    stubEveTail([askEvent, { type: "session.waiting" }]);
    inbox.unansweredInboxRequests.mockResolvedValueOnce([]);

    const out = await reconcilePlaygroundSessionFromEve({
      session: session({ pendingInputAt: new Date() }),
      target: TARGET,
    });

    expect(out.pendingInputAt).toBeNull();
    expect(inbox.openInboxQuestion).not.toHaveBeenCalled();
    expect(inbox.resolveInboxForSession).toHaveBeenCalledWith("ps_1");
  });

  it("settles a park answered by a completed later turn", async () => {
    stubEveTail([
      { type: "message.received", data: { turnId: "turn_2", message: "blue" } },
      { type: "message.completed", data: { turnId: "turn_2", message: "Done." } },
      { type: "turn.completed", data: { turnId: "turn_2" } },
      { type: "session.waiting" },
    ]);

    const out = await reconcilePlaygroundSessionFromEve({
      session: session({ pendingInputAt: new Date() }),
      target: TARGET,
    });

    expect(pendingWrites()).toEqual([
      expect.objectContaining({ pendingInputAt: null }),
    ]);
    expect(inbox.resolveInboxForSession).toHaveBeenCalledWith("ps_1");
    expect(inbox.openInboxQuestion).not.toHaveBeenCalled();
    expect(out.pendingInputAt).toBeNull();
  });

  it("settles on terminal failure", async () => {
    stubEveTail([{ type: "turn.failed", data: { turnId: "turn_1" } }]);

    const out = await reconcilePlaygroundSessionFromEve({
      session: session({ pendingInputAt: new Date() }),
      target: TARGET,
    });

    expect(pendingWrites()).toEqual([
      expect.objectContaining({ pendingInputAt: null }),
    ]);
    expect(inbox.resolveInboxForSession).toHaveBeenCalledWith("ps_1");
    expect(out.status).toBe("failed");
    expect(out.pendingInputAt).toBeNull();
  });

  it("leaves a recorded park alone when the tail is just the waiting marker", async () => {
    stubEveTail([{ type: "session.waiting" }]);
    const parkedAt = new Date("2026-07-01T10:00:00Z");

    const out = await reconcilePlaygroundSessionFromEve({
      session: session({ pendingInputAt: parkedAt }),
      target: TARGET,
    });

    expect(pendingWrites()).toHaveLength(0);
    expect(inbox.openInboxQuestion).not.toHaveBeenCalled();
    expect(inbox.resolveInboxForSession).not.toHaveBeenCalled();
    expect(out.pendingInputAt).toEqual(parkedAt);
  });

  it("never touches needs-you state for a builder-surface session", async () => {
    stubEveTail([askEvent, { type: "session.waiting" }]);

    await reconcilePlaygroundSessionFromEve({
      session: session({ surface: "playground" }),
      target: TARGET,
    });

    expect(pendingWrites()).toHaveLength(0);
    expect(inbox.openInboxQuestion).not.toHaveBeenCalled();
    expect(inbox.resolveInboxForSession).not.toHaveBeenCalled();
    // The ordinary reconcile write still happens: the cursor is saved.
    expect(
      dbState.updates.filter((values) => Object.hasOwn(values, "status")),
    ).toHaveLength(1);
  });

  it("swallows inbox failures — the reconciled session still comes back", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    inbox.openInboxQuestion.mockRejectedValueOnce(new Error("db down"));
    stubEveTail([askEvent, { type: "session.waiting" }]);

    const out = await reconcilePlaygroundSessionFromEve({
      session: session(),
      target: TARGET,
    });

    expect(out.status).toBe("waiting");
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
