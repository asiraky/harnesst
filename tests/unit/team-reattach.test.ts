/**
 * #267 — the reattach watcher, against in-memory fakes and a scripted eve stream.
 * Pins the behaviour the severed relay owed: a question asked AFTER the stream died lands in
 * the inbox and the delegation goes `waiting`; a turn that actually succeeded finalizes
 * `completed` with a real run row (not the old "success reported as failure"); a still-running
 * turn re-enqueues its own successor under one shared deadline; the ceiling always settles the
 * row; and a delegation somebody else already settled is left alone.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TalkEvent, TurnResult } from "~/agent/talk.server";
import type { PlaygroundSession } from "~/playground/sessions.server";
import type { ReattachDeps, ReattachPayload } from "~/team/reattach.server";
import { reattachDelegation } from "~/team/reattach.server";
import { makeFakeStore, type FakeStore } from "../fakes/store";

let store: FakeStore;

const PROJECT = "proj_1";
const NOW = new Date(2_000_000_000);
const SESSION_ID = "ps_handed_off";

/** The peer deployment the fake store minted for this test run. */
let DEPLOYMENT_ID = "";

function turnResult(over: Partial<TurnResult> = {}): TurnResult {
  return {
    ok: true,
    sessionId: "sess_peer",
    continuationToken: "tok_peer",
    streamIndex: 42,
    reply: "PR opened: #20.",
    replyIsStructured: false,
    inputRequests: [],
    modelId: "m/x",
    turnId: "turn_1",
    steps: [],
    messages: [],
    error: null,
    ...over,
  };
}

/** A session row standing in for the agent-opened FOH row the relay adopted at hand-off. */
function session(over: Partial<PlaygroundSession> = {}): PlaygroundSession {
  return {
    id: SESSION_ID,
    projectId: PROJECT,
    agentId: "deployer",
    createdBy: null,
    surface: "foh",
    environmentId: "env_dep_prod",
    externalSessionId: "sess_peer",
    continuationToken: "tok_peer",
    streamIndex: 7,
    status: "running",
    pendingInputAt: null,
    delegationId: "",
    ...over,
  } as unknown as PlaygroundSession;
}

/** A scripted `resumeTurnStream`: the events it shows, then the result it settles with. */
function scriptedResume(result: TurnResult, events: number[] = []) {
  return async function* (): AsyncGenerator<TalkEvent> {
    for (const streamIndex of events) {
      yield {
        kind: "progress",
        sessionId: "sess_peer",
        continuationToken: "tok_peer",
        streamIndex,
        rawEvent: { type: "message.appended", data: {} },
      };
    }
    yield { kind: "done", result };
  } as unknown as ReattachDeps["resume"];
}

interface Captured {
  cursors: Array<Parameters<ReattachDeps["saveCursor"]>[0]>;
  enqueued: Array<{ kind: string; payload: Record<string, unknown> }>;
  finishes: Array<Parameters<ReattachDeps["recordFinish"]>[0]>;
  questions: Array<Parameters<ReattachDeps["openQuestion"]>[0]>;
  finished: Array<Parameters<ReattachDeps["recordFinished"]>[0]>;
  cleared: string[];
  failed: string[];
}

function makeDeps(
  over: Partial<ReattachDeps> & { sessionRow?: PlaygroundSession } = {},
): ReattachDeps & Captured {
  const cap: Captured = {
    cursors: [],
    enqueued: [],
    finishes: [],
    questions: [],
    finished: [],
    cleared: [],
    failed: [],
  };
  const row = over.sessionRow ?? session();
  const { sessionRow: _row, ...rest } = over;
  return {
    store,
    resume: scriptedResume(turnResult()),
    loadSession: async () => row,
    saveCursor: async (input) => {
      cap.cursors.push(input);
    },
    failSession: async (s) => {
      cap.failed.push(s.id);
      return s;
    },
    markPending: async () => true,
    clearPending: async (id) => {
      cap.cleared.push(id);
    },
    openQuestion: async (input) => {
      cap.questions.push(input);
      return { id: "inbox_1" } as never;
    },
    resolveAsks: async () => {},
    recordFinished: async (input) => {
      cap.finished.push(input);
      return { id: "inbox_2" } as never;
    },
    recordFinish: async (input) => {
      cap.finishes.push(input);
    },
    resolveRunId: async () => "run_9",
    enqueueJob: async (kind, payload) => {
      cap.enqueued.push({ kind, payload });
      return "job_1";
    },
    now: () => NOW,
    ...rest,
    ...cap,
  };
}

async function seedDelegation(): Promise<string> {
  const row = await store.delegations.insert({
    projectId: PROJECT,
    fromAgentId: "pm",
    fromEnvironmentId: "env_pm_prod",
    toAgentId: "deployer",
    toEnvironmentId: "env_dep_prod",
  });
  return row.id;
}

function payloadFor(
  delegationId: string,
  over: Partial<ReattachPayload> = {},
): ReattachPayload {
  return {
    sessionId: SESSION_ID,
    delegationId,
    projectId: PROJECT,
    turnId: "turn_1",
    userMessage: 'From your teammate "pm": Ship build 42',
    metadata: { delegationId, fromAgentId: "pm", fromAgentName: "pm" },
    startedAt: new Date(NOW.getTime() - 60_000).toISOString(),
    deadlineAt: new Date(NOW.getTime() + 600_000).toISOString(),
    ...over,
  };
}

beforeEach(async () => {
  store = makeFakeStore();
  store.seedProject({
    id: PROJECT,
    orgId: "org_1",
    repoOwner: "acme",
    repoName: "team",
  });
  store.seedAgent({
    id: "pm",
    projectId: PROJECT,
    name: "pm",
    root: "agents/pm/agent",
  });
  store.seedAgent({
    id: "deployer",
    projectId: PROJECT,
    name: "deployer",
    root: "agents/deployer/agent",
  });
  store.seedEnvironment({
    id: "env_dep_prod",
    projectId: PROJECT,
    agentId: "deployer",
    name: "production",
  });
  const rel = await store.releases.insert({
    projectId: PROJECT,
    agentId: "deployer",
    version: "v1",
    gitSha: "b".repeat(40),
  });
  const dep = await store.deployments.insert({
    environmentId: "env_dep_prod",
    releaseId: rel.id,
    status: "live",
    trafficWeight: 100,
  });
  await store.deployments.update(dep.id, { url: "http://deployer.local" });
  DEPLOYMENT_ID = dep.id;
});

describe("reattachDelegation", () => {
  it("files a question asked after the stream died and parks the delegation", async () => {
    const delegationId = await seedDelegation();
    const deps = makeDeps({
      resume: scriptedResume(
        turnResult({
          reply: null,
          inputRequests: [
            { requestId: "req_1", prompt: "OK to merge the PR?" },
          ],
        }),
        [8, 9],
      ),
    });
    const res = await reattachDelegation(payloadFor(delegationId), deps);

    expect(res).toEqual({ status: "settled", outcome: "parked" });
    expect(deps.questions).toEqual([
      expect.objectContaining({
        sessionId: SESSION_ID,
        projectId: PROJECT,
        userId: null,
        delegationId,
        runId: "run_9",
        request: { requestId: "req_1", prompt: "OK to merge the PR?" },
      }),
    ]);
    // `waiting`, exactly as relay parking produces — so the human's answer settles it through
    // the ordinary FOH resume path.
    expect(await store.delegations.findById(delegationId)).toMatchObject({
      status: "waiting",
      runId: "run_9",
      externalSessionId: "sess_peer",
    });
    expect(deps.cursors.at(-1)).toMatchObject({
      status: "waiting",
      streamIndex: 42,
    });
    expect(deps.cleared).toHaveLength(0);
  });

  it("finalizes a turn that actually succeeded as completed, with its run", async () => {
    const delegationId = await seedDelegation();
    const deps = makeDeps({ resume: scriptedResume(turnResult()) });
    const res = await reattachDelegation(payloadFor(delegationId), deps);

    expect(res).toEqual({ status: "settled", outcome: "completed" });
    expect(await store.delegations.findById(delegationId)).toMatchObject({
      status: "completed",
      runId: "run_9",
    });
    expect(deps.finishes).toEqual([
      expect.objectContaining({
        projectId: PROJECT,
        externalRunId: "sess_peer:turn_1",
        channel: "teammate",
        releaseId: expect.any(String),
        deploymentId: DEPLOYMENT_ID,
      }),
    ]);
    expect(deps.finishes[0].result).toMatchObject({
      ok: true,
      reply: "PR opened: #20.",
    });
    expect(deps.cleared).toEqual([SESSION_ID]);
    expect(deps.finished).toHaveLength(1);
    expect(deps.questions).toHaveLength(0);
  });

  it("keeps polling while the turn is still running, under one shared deadline", async () => {
    const delegationId = await seedDelegation();
    const payload = payloadFor(delegationId);
    const deps = makeDeps({
      resume: scriptedResume(
        turnResult({
          ok: false,
          reply: null,
          error: "Couldn't read the reply stream: terminated",
          streamLost: true,
          streamIndex: 20,
        }),
        [8],
      ),
    });
    const res = await reattachDelegation(payload, deps);

    expect(res).toEqual({ status: "waiting", streamIndex: 20 });
    expect(deps.enqueued).toEqual([
      {
        kind: "reattach_delegation",
        // Same deadline: the ceiling is anchored at hand-off, not at each tick.
        payload: expect.objectContaining({ deadlineAt: payload.deadlineAt }),
      },
    ]);
    // The row is bumped so the abandoned-session sweep doesn't fail a long silent tool call.
    expect(deps.cursors).toEqual([
      expect.objectContaining({ status: "running" }),
    ]);
    expect(await store.delegations.findById(delegationId)).toMatchObject({
      status: "running",
    });
  });

  /**
   * The slice's idle budget only bounds SILENCE. A turn chattering every few seconds would hold it
   * open forever — and with the worker at concurrency 1, block every deploy and publish behind it.
   */
  it("cuts a chatty slice off at its wall clock and re-enqueues", async () => {
    const delegationId = await seedDelegation();
    // A stream that never settles, and a clock that advances a second per event.
    let clock = NOW.getTime();
    const endless = (async function* () {
      for (let i = 1; ; i++) {
        yield {
          kind: "progress",
          sessionId: "sess_peer",
          continuationToken: "tok_peer",
          streamIndex: i,
          rawEvent: { type: "message.appended", data: {} },
        };
      }
    })();
    const deps = makeDeps({
      resume: (() => endless) as unknown as ReattachDeps["resume"],
      now: () => {
        clock += 1_000;
        return new Date(clock);
      },
    });
    const res = await reattachDelegation(payloadFor(delegationId), deps);

    expect(res.status).toBe("waiting");
    // It gave up well before the endless stream did, and scheduled its own successor.
    expect(deps.enqueued).toHaveLength(1);
    expect(await store.delegations.findById(delegationId)).toMatchObject({
      status: "running",
    });
  });

  it("settles the rows once the ceiling passes", async () => {
    const delegationId = await seedDelegation();
    const deps = makeDeps({
      resume: scriptedResume(
        turnResult({
          ok: false,
          reply: null,
          error: "Timed out after 15s with no Eve stream events.",
          streamLost: true,
        }),
      ),
    });
    const res = await reattachDelegation(
      payloadFor(delegationId, {
        deadlineAt: new Date(NOW.getTime() - 1).toISOString(),
      }),
      deps,
    );

    expect(res).toEqual({ status: "expired" });
    expect(deps.enqueued).toHaveLength(0);
    const delegation = await store.delegations.findById(delegationId);
    expect(delegation).toMatchObject({ status: "failed" });
    expect(delegation?.error).toContain("stopped waiting");
    expect(deps.cursors.at(-1)).toMatchObject({ status: "failed" });
    expect(deps.cleared).toEqual([SESSION_ID]);
  });

  it("fails the row when the peer's deployment is gone", async () => {
    const delegationId = await seedDelegation();
    const deps = makeDeps({
      sessionRow: session({ environmentId: "env_missing" }),
    });
    const res = await reattachDelegation(payloadFor(delegationId), deps);

    expect(res).toEqual({ status: "settled", outcome: "failed" });
    expect(deps.failed).toEqual([SESSION_ID]);
    expect(await store.delegations.findById(delegationId)).toMatchObject({
      status: "failed",
    });
    expect(deps.finishes).toHaveLength(0);
  });

  it("stands down when something else already owns the delegation or session", async () => {
    const delegationId = await seedDelegation();
    await store.delegations.finalize(delegationId, { status: "waiting" });
    const resWaiting = await reattachDelegation(
      payloadFor(delegationId),
      makeDeps(),
    );
    expect(resWaiting).toEqual({
      status: "skipped",
      reason: "delegation is waiting",
    });
  });

  /**
   * The adopted session can vanish under the watcher — removing the peer agent from the roster
   * takes its sessions with it. There is nothing left to reattach to, but the delegation is still
   * ours to close: standing down is what would leave it `running` with no successor and no ceiling.
   */
  it("closes the delegation when the adopted session is gone", async () => {
    const delegationId = await seedDelegation();
    const res = await reattachDelegation(
      payloadFor(delegationId),
      makeDeps({ loadSession: async () => null }),
    );
    expect(res).toEqual({ status: "settled", outcome: "failed" });
    expect(await store.delegations.findById(delegationId)).toMatchObject({
      status: "failed",
    });
  });

  /**
   * A human hit /stop on the adopted conversation. The stop route settles the session row and the
   * inbox but knows nothing about delegations or runs — if the watcher just stood down, both would
   * sit `running` forever and the edge cap would keep counting a turn nobody is running.
   */
  it("settles the delegation when the adopted conversation was stopped", async () => {
    const delegationId = await seedDelegation();
    const deps = makeDeps({
      sessionRow: session({ status: "stopped" }),
      // A stopped turn has nothing left to drain — reading the peer's stream would be wrong.
      resume: (() => {
        throw new Error("must not drain a stopped session");
      }) as unknown as ReattachDeps["resume"],
    });
    const res = await reattachDelegation(payloadFor(delegationId), deps);

    expect(res).toEqual({ status: "settled", outcome: "failed" });
    expect(await store.delegations.findById(delegationId)).toMatchObject({
      status: "failed",
    });
    // The stopped session row is left exactly as /stop settled it...
    expect(deps.cursors).toHaveLength(0);
    expect(deps.failed).toHaveLength(0);
    // ...but the run still has to stop claiming to be running.
    expect(deps.finishes).toHaveLength(1);
    expect(deps.finishes[0]).toMatchObject({
      externalRunId: "sess_peer:turn_1",
      result: { ok: false },
    });
  });

  it("finalizes the delegation even when the other bookkeeping fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const delegationId = await seedDelegation();
    const deps = makeDeps({
      saveCursor: async () => {
        throw new Error("db down");
      },
      clearPending: async () => {
        throw new Error("inbox down");
      },
    });
    const res = await reattachDelegation(payloadFor(delegationId), deps);
    expect(res).toEqual({ status: "settled", outcome: "completed" });
    expect(await store.delegations.findById(delegationId)).toMatchObject({
      status: "completed",
    });
    error.mockRestore();
  });

  /**
   * The writes that OWN the turn's fate get a retry instead of a log line: nothing else is coming
   * for these rows, and re-running a tick is idempotent (it replays the peer's log from 0). The
   * delegation must be left OPEN when one of them fails — closing it is what disarms the retry, and
   * a retry that skips can never repair the run row it left behind.
   */
  it("fails the job with the delegation still open, so the retry is not skipped", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const delegationId = await seedDelegation();
    const deps = makeDeps({
      recordFinish: async () => {
        throw new Error("ingest down");
      },
    });
    await expect(
      reattachDelegation(payloadFor(delegationId), deps),
    ).rejects.toThrow("ingest down");
    expect(await store.delegations.findById(delegationId)).toMatchObject({
      status: "running",
    });
    // ...and nothing downstream ran, so the retry cannot double-post the finish notice.
    expect(deps.finished).toHaveLength(0);
    error.mockRestore();
  });

  /**
   * A /stop that wins the race between the status check and the settle: the row refuses the park
   * flag, so calling the delegation "waiting for a human" would park it on a conversation nobody
   * can answer.
   */
  it("does not park the delegation on a session that refused the needs-you flag", async () => {
    const delegationId = await seedDelegation();
    const deps = makeDeps({
      resume: scriptedResume(
        turnResult({
          reply: null,
          inputRequests: [{ requestId: "req_1", prompt: "Merge it?" }],
        }),
      ),
      markPending: async () => false,
    });
    const res = await reattachDelegation(payloadFor(delegationId), deps);

    expect(res).toEqual({ status: "settled", outcome: "parked" });
    expect(await store.delegations.findById(delegationId)).toMatchObject({
      status: "failed",
    });
    // No question is filed against a row that cannot show one.
    expect(deps.questions).toHaveLength(0);
  });
});
