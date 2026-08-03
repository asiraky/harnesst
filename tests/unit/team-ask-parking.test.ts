/**
 * WP4 — relay parking + wake-on-delegation (Front of House §5), against in-memory fakes.
 * Pins: a stopped peer is woken through the injected wake dep (and a failed wake denies
 * cleanly); a parked peer flips the delegation `waiting` (exiting the caps — D7), opens the
 * agent-opened FOH session with the peer's REAL eve handles + a question-derived title (D6),
 * files team-wide inbox items (D5/D19), and returns the
 * structured `waiting_on_human` result; parking-machinery failures fall back to the M7 deny;
 * and `ensureLiveDeploymentForEnvironment` itself (fresh-url discipline, no stale reuse).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TurnResult } from "~/agent/talk.server";
import type { ChatInputRequest } from "~/chat/types";
import type { DeploymentWithRelease } from "~/data/ports";
import { ensureLiveDeploymentForEnvironment } from "~/deploy/wake.server";
import { titleFromMessage } from "~/foh/session-title";
import type { PlaygroundSession } from "~/playground/sessions.server";
import type { AskDeps } from "~/team/ask.server";
import { runAsk } from "~/team/ask.server";
import { DELEGATION_REATTACH_CEILING_MS } from "~/team/reattach.server";
import { finalizeDelegationOnResume } from "~/team/resume.server";
import type { DeployTarget } from "~/seams/types";
import { makeFakeStore, type FakeStore } from "../fakes/store";

let store: FakeStore;

const PROJECT = "proj_1";
const NOW = new Date(1_000_000_000);

function request(over: Partial<ChatInputRequest> = {}): ChatInputRequest {
  return {
    requestId: "r1",
    prompt: "Which environment should I target?",
    ...over,
  };
}

function turnResult(over: Partial<TurnResult> = {}): TurnResult {
  return {
    ok: true,
    sessionId: "sess_peer",
    continuationToken: "tok_peer",
    streamIndex: 7,
    reply: "Build 42 is live.",
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

async function seedCallerDeployment(): Promise<string> {
  const rel = await store.releases.insert({
    projectId: PROJECT,
    agentId: "pm",
    version: "v1",
    gitSha: "a".repeat(40),
  });
  const dep = await store.deployments.insert({
    environmentId: "env_pm_prod",
    releaseId: rel.id,
    status: "live",
    trafficWeight: 100,
  });
  return dep.id;
}

async function seedTarget(status: "live" | "stopped", url: string | null) {
  const rel = await store.releases.insert({
    projectId: PROJECT,
    agentId: "deployer",
    version: "v1",
    gitSha: "b".repeat(40),
  });
  const dep = await store.deployments.insert({
    environmentId: "env_dep_prod",
    releaseId: rel.id,
    status,
    trafficWeight: 100,
  });
  if (url) await store.deployments.update(dep.id, { url });
  return dep;
}

/** A deps bundle whose parking collaborators capture their inputs. */
function makeDeps(over: Partial<AskDeps> = {}): AskDeps & {
  createdSessions: Array<Parameters<AskDeps["createSession"]>[0]>;
  reattaches: Array<Parameters<AskDeps["scheduleReattach"]>[1]>;
} {
  const createdSessions: Array<Parameters<AskDeps["createSession"]>[0]> = [];
  const reattaches: Array<Parameters<AskDeps["scheduleReattach"]>[1]> = [];
  return {
    store,
    sendTurn: async () => turnResult(),
    dispatchTurn: async () => ({
      sessionId: "sess_1",
      continuationToken: "tok_1",
      turnId: "turn_1",
      streamIndex: 0,
      error: null,
    }),
    recordStart: async () => true,
    recordFinish: async () => {},
    resolveRunId: async () => "run_9",
    ensureLiveDeployment: async (environmentId) => {
      const rows = await store.deployments.listByEnvironment(environmentId);
      return rows.find((d) => d.status === "live" && d.url) ?? null;
    },
    createSession: async (input) => {
      createdSessions.push(input);
      return {
        id: "ps_agent_opened",
        ...input,
      } as unknown as PlaygroundSession;
    },
    inferTitle: async ({ message }) => titleFromMessage(message),
    scheduleReattach: async (_store, payload) => {
      reattaches.push(payload);
    },
    now: () => NOW,
    timeoutMs: 600_000,
    createdSessions,
    reattaches,
    ...over,
  };
}

/** Capture the delegation id the relay inserts (the fake store has no list surface). */
function captureDelegationId(): { id: () => string } {
  const insert = store.delegations.insert.bind(store.delegations);
  let captured = "";
  store.delegations.insert = async (input) => {
    const row = await insert(input);
    captured = row.id;
    return row;
  };
  return { id: () => captured };
}

beforeEach(() => {
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
    id: "env_pm_prod",
    projectId: PROJECT,
    agentId: "pm",
    name: "production",
  });
  store.seedEnvironment({
    id: "env_dep_prod",
    projectId: PROJECT,
    agentId: "deployer",
    name: "production",
  });
});

describe("runAsk — wake-on-delegation", () => {
  it("verifies a persisted live peer through the liveness-aware resolver", async () => {
    const deploymentId = await seedCallerDeployment();
    const live = await seedTarget("live", "http://live.local");
    const ensure = vi.fn(
      async () =>
        (await store.deployments.listByEnvironment("env_dep_prod")).find(
          (d) => d.id === live.id,
        ) ?? null,
    );

    const result = await runAsk(
      { deploymentId, teammate: "deployer", message: "go" },
      makeDeps({ ensureLiveDeployment: ensure }),
    );

    expect(ensure).toHaveBeenCalledWith("env_dep_prod");
    expect(result).toMatchObject({ ok: true });
  });

  it("wakes a stopped peer through the injected dep and proceeds", async () => {
    const deploymentId = await seedCallerDeployment();
    const stopped = await seedTarget("stopped", "http://stale.local");

    let sentUrl = "";
    const wake = vi.fn(async (): Promise<DeploymentWithRelease | null> => ({
      id: stopped.id,
      status: "live",
      envRevision: 0,
      trafficWeight: 100,
      url: "http://woken.local",
      errorDetail: null,
      createdAt: stopped.createdAt,
      releaseId: stopped.releaseId,
      version: "v1",
      gitSha: "b".repeat(40),
    }));
    const deps = makeDeps({
      ensureLiveDeployment: wake,
      sendTurn: async (input) => {
        sentUrl = input.baseUrl;
        return turnResult();
      },
    });

    const res = await runAsk(
      { deploymentId, teammate: "deployer", message: "go" },
      deps,
    );

    expect(wake).toHaveBeenCalledWith("env_dep_prod");
    expect(sentUrl).toBe("http://woken.local");
    expect(res).toMatchObject({ ok: true, reply: "Build 42 is live." });
  });

  it("denies cleanly when the wake fails (returns null)", async () => {
    const deploymentId = await seedCallerDeployment();
    await seedTarget("stopped", null);
    const res = await runAsk(
      { deploymentId, teammate: "deployer", message: "go" },
      makeDeps({ ensureLiveDeployment: async () => null }),
    );
    expect(res).toEqual({
      ok: false,
      error: expect.stringContaining("couldn't be woken"),
    });
  });

  it("denies cleanly when the wake throws", async () => {
    const deploymentId = await seedCallerDeployment();
    await seedTarget("stopped", null);
    const res = await runAsk(
      { deploymentId, teammate: "deployer", message: "go" },
      makeDeps({
        ensureLiveDeployment: async () => {
          throw new Error("docker exploded");
        },
      }),
    );
    expect(res).toEqual({
      ok: false,
      error: expect.stringContaining("couldn't be woken"),
    });
  });

  it("keeps the never-deployed denial (nothing to wake, dep never called)", async () => {
    const deploymentId = await seedCallerDeployment();
    const wake = vi.fn(async () => null);
    const res = await runAsk(
      { deploymentId, teammate: "deployer", message: "go" },
      makeDeps({ ensureLiveDeployment: wake }),
    );
    expect(res).toEqual({
      ok: false,
      error: expect.stringContaining("never been deployed"),
    });
    expect(wake).not.toHaveBeenCalled();
  });

  it("keeps the no-live denial for failed-only rows (nothing stopped to wake)", async () => {
    const deploymentId = await seedCallerDeployment();
    const rel = await store.releases.insert({
      projectId: PROJECT,
      agentId: "deployer",
      version: "v1",
      gitSha: "c".repeat(40),
    });
    await store.deployments.insert({
      environmentId: "env_dep_prod",
      releaseId: rel.id,
      status: "failed",
      trafficWeight: 0,
    });
    const wake = vi.fn(async () => null);
    const res = await runAsk(
      { deploymentId, teammate: "deployer", message: "go" },
      makeDeps({ ensureLiveDeployment: wake }),
    );
    expect(res).toEqual({
      ok: false,
      error: expect.stringContaining("no live deployment"),
    });
    expect(wake).not.toHaveBeenCalled();
  });
});

describe("ensureLiveDeploymentForEnvironment", () => {
  const startTarget = (
    start: DeployTarget["start"],
    health: DeployTarget["health"] = async () => ({ status: "pending" }),
  ): DeployTarget => ({ start, health }) as unknown as DeployTarget;

  it("returns a live row when the deploy target gives no definite negative", async () => {
    const dep = await seedTarget("live", "http://live.local");
    const start = vi.fn();
    const health = vi.fn(async () => ({ status: "pending" as const }));
    const row = await ensureLiveDeploymentForEnvironment("env_dep_prod", {
      store,
      deployTarget: startTarget(start, health),
    });
    expect(row).toMatchObject({ id: dep.id, url: "http://live.local" });
    expect(health).toHaveBeenCalledWith(dep.id);
    expect(start).not.toHaveBeenCalled();
  });

  it("wakes a stopped row and flips it live with the FRESH url, never the stale one", async () => {
    const dep = await seedTarget("stopped", "http://stale.local");
    const start = vi.fn(async () => ({
      status: "live" as const,
      url: "http://fresh.local",
    }));
    const row = await ensureLiveDeploymentForEnvironment("env_dep_prod", {
      store,
      deployTarget: startTarget(start),
    });
    expect(start).toHaveBeenCalledWith(dep.id);
    expect(row).toMatchObject({
      id: dep.id,
      status: "live",
      url: "http://fresh.local",
    });
    const [stored] = await store.deployments.listByEnvironment("env_dep_prod");
    expect(stored).toMatchObject({ status: "live", url: "http://fresh.local" });
  });

  it("returns null (row untouched) when the wake health is not live", async () => {
    const dep = await seedTarget("stopped", null);
    const row = await ensureLiveDeploymentForEnvironment("env_dep_prod", {
      store,
      deployTarget: startTarget(async () => ({
        status: "failed",
        detail: "no boot",
      })),
    });
    expect(row).toBeNull();
    expect(await store.deployments.findById(dep.id)).toMatchObject({
      status: "stopped",
    });
  });

  it("returns null when the start throws", async () => {
    await seedTarget("stopped", null);
    const row = await ensureLiveDeploymentForEnvironment("env_dep_prod", {
      store,
      deployTarget: startTarget(async () => {
        throw new Error("dockerd down");
      }),
    });
    expect(row).toBeNull();
  });

  it("returns null when the environment has no live or stopped rows", async () => {
    const row = await ensureLiveDeploymentForEnvironment("env_dep_prod", {
      store,
      deployTarget: startTarget(vi.fn()),
    });
    expect(row).toBeNull();
  });
});

describe("runAsk — relay parking", () => {
  it("parks: delegation waiting, agent-opened session with real handles, inbox, structured result", async () => {
    const deploymentId = await seedCallerDeployment();
    const live = await seedTarget("live", "http://deployer.local");
    const deleg = captureDelegationId();

    const requests = [
      request(),
      request({
        requestId: "r2",
        prompt: "Proceed with the merge?",
        display: "confirmation",
      }),
    ];
    const inferTitle = vi.fn(async () => "Choose deployment environment");
    const deps = makeDeps({
      sendTurn: async () =>
        turnResult({ reply: null, inputRequests: requests }),
      inferTitle,
    });

    const res = await runAsk(
      { deploymentId, teammate: "deployer", message: "Ship the release" },
      deps,
    );

    expect(res).toEqual({
      ok: true,
      status: "waiting_on_human",
      teammate: "deployer",
      question: "Which environment should I target?",
      note: expect.stringContaining("do not re-ask"),
    });

    // Delegation flipped waiting with the peer handles — and it exits the caps (D7).
    const delegation = await store.delegations.findById(deleg.id());
    expect(delegation).toMatchObject({
      status: "waiting",
      externalSessionId: "sess_peer",
      runId: "run_9",
    });
    expect(
      await store.delegations.countActiveEdge("pm", "deployer", new Date(0)),
    ).toBe(0);
    expect(
      await store.delegations.countActiveProject(PROJECT, new Date(0)),
    ).toBe(0);
    expect(inferTitle).toHaveBeenCalledWith({
      message: "Which environment should I target?",
      project: expect.objectContaining({ id: PROJECT }),
    });

    // Agent-opened session row: FOH surface, no creator, question-derived title, REAL handles.
    expect(deps.createdSessions).toEqual([
      {
        projectId: PROJECT,
        agentId: "deployer",
        userId: null,
        surface: "foh",
        environmentId: "env_dep_prod",
        version: "v1",
        title: "Choose deployment environment",
        openedByAgentId: "deployer",
        delegationId: deleg.id(),
        externalSessionId: "sess_peer",
        continuationToken: "tok_peer",
        streamIndex: 7,
        status: "waiting",
        pendingInputAt: NOW,
        lastEventAt: NOW,
      },
    ]);

    // Inbox: one team-wide item per request, D19 kind mapping, delegation + run refs.
    const pending =
      await store.inboxItems.findPendingBySession("ps_agent_opened");
    expect(pending).toMatchObject([
      {
        kind: "question",
        prompt: "Which environment should I target?",
        requestId: "r1",
        userId: null,
        agentId: "deployer",
        delegationId: deleg.id(),
        runId: "run_9",
        projectId: PROJECT,
      },
      { kind: "approval", requestId: "r2", userId: null },
    ]);
  });

  it("parks even when assistant text preceded the ask (settleFohTurn semantics)", async () => {
    const deploymentId = await seedCallerDeployment();
    await seedTarget("live", "http://deployer.local");
    const res = await runAsk(
      { deploymentId, teammate: "deployer", message: "hi" },
      makeDeps({
        sendTurn: async () =>
          turnResult({
            reply: "One thing before I continue —",
            inputRequests: [request()],
          }),
      }),
    );
    expect(res).toMatchObject({ ok: true, status: "waiting_on_human" });
  });

  it("fails the old way when the parked turn has no session handle to resume on", async () => {
    const deploymentId = await seedCallerDeployment();
    await seedTarget("live", "http://deployer.local");
    const deleg = captureDelegationId();
    const deps = makeDeps({
      sendTurn: async () =>
        turnResult({
          reply: null,
          sessionId: null,
          inputRequests: [request()],
        }),
    });
    const res = await runAsk(
      { deploymentId, teammate: "deployer", message: "hi" },
      deps,
    );
    expect(res).toEqual({
      ok: false,
      error: expect.stringContaining("needs input to continue"),
    });
    expect(await store.delegations.findById(deleg.id())).toMatchObject({
      status: "failed",
    });
    expect(deps.createdSessions).toHaveLength(0);
  });

  it("falls back to the deny path when the parking machinery fails (no dangling waiting row)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const deploymentId = await seedCallerDeployment();
    await seedTarget("live", "http://deployer.local");
    const deleg = captureDelegationId();
    const res = await runAsk(
      { deploymentId, teammate: "deployer", message: "hi" },
      makeDeps({
        sendTurn: async () =>
          turnResult({ reply: null, inputRequests: [request()] }),
        createSession: async () => {
          throw new Error("insert failed");
        },
      }),
    );
    expect(res).toEqual({
      ok: false,
      error: expect.stringContaining("needs input to continue"),
    });
    expect(await store.delegations.findById(deleg.id())).toMatchObject({
      status: "failed",
    });
    error.mockRestore();
  });

  it("leaves the completed and empty-reply paths unchanged", async () => {
    const deploymentId = await seedCallerDeployment();
    await seedTarget("live", "http://deployer.local");
    const deleg = captureDelegationId();

    const ok = await runAsk(
      { deploymentId, teammate: "deployer", message: "hi" },
      makeDeps(),
    );
    expect(ok).toMatchObject({ ok: true, reply: "Build 42 is live." });
    expect(await store.delegations.findById(deleg.id())).toMatchObject({
      status: "completed",
    });

    const empty = await runAsk(
      { deploymentId, teammate: "deployer", message: "hi" },
      makeDeps({ sendTurn: async () => turnResult({ reply: "   " }) }),
    );
    expect(empty).toEqual({
      ok: false,
      error: '"deployer" finished without a reply.',
    });
  });
});

/**
 * #267 — a severed reply stream is a hand-off, not a failure. Pins the three defects: the
 * delegation is NOT finalized, the peer session is adopted so a later question has a surface,
 * the run row is left `running` for the watcher to settle, and the calling model is told the
 * truth instead of "failed".
 */
describe("runAsk — severed stream hand-off", () => {
  const lost = (over: Partial<TurnResult> = {}) =>
    turnResult({
      ok: false,
      reply: null,
      error: "Couldn't read the reply stream: terminated",
      streamLost: true,
      ...over,
    });

  it("hands the turn off: delegation stays running, session adopted, watcher scheduled", async () => {
    const deploymentId = await seedCallerDeployment();
    await seedTarget("live", "http://deployer.local");
    const deleg = captureDelegationId();
    const finishes: unknown[] = [];
    // A stepping clock: the turn started at NOW and streamed for 40 minutes before its stream
    // dropped — longer than the reattach ceiling itself.
    const HANDOFF = new Date(NOW.getTime() + 40 * 60_000);
    let streamed = false;
    const deps = makeDeps({
      sendTurn: async () => {
        streamed = true;
        return lost();
      },
      recordFinish: async (input) => {
        finishes.push(input);
      },
      now: () => (streamed ? HANDOFF : NOW),
    });
    const res = await runAsk(
      { deploymentId, teammate: "deployer", message: "Ship build 42" },
      deps,
    );

    expect(res).toMatchObject({
      ok: true,
      status: "handed_off",
      teammate: "deployer",
      runId: "run_9",
    });
    // Defect 1: the delegation is still open — nothing was finalized.
    expect(await store.delegations.findById(deleg.id())).toMatchObject({
      status: "running",
    });
    // The peer session is adopted with its REAL eve handles, so the ordinary FOH resume works.
    expect(deps.createdSessions).toHaveLength(1);
    expect(deps.createdSessions[0]).toMatchObject({
      surface: "foh",
      userId: null,
      openedByAgentId: "deployer",
      externalSessionId: "sess_peer",
      continuationToken: "tok_peer",
      streamIndex: 7,
      status: "running",
    });
    // D6: the title never carries the caller's ask text.
    expect(deps.createdSessions[0].title).toBe('Delegated task from "pm"');
    expect(deps.createdSessions[0].title).not.toContain("build 42");
    expect(deps.reattaches).toEqual([
      expect.objectContaining({
        sessionId: "ps_agent_opened",
        delegationId: deleg.id(),
        projectId: PROJECT,
        turnId: "turn_1",
        userMessage: 'From your teammate "pm": Ship build 42',
        startedAt: NOW.toISOString(),
        // The ceiling is anchored at the HAND-OFF, not the turn's start — otherwise a turn that
        // streamed happily for longer than the ceiling would be born already expired.
        deadlineAt: new Date(
          HANDOFF.getTime() + DELEGATION_REATTACH_CEILING_MS,
        ).toISOString(),
      }),
    ]);
    // Defect 3: the run is left `running` — the watcher settles it with the real outcome.
    expect(finishes).toHaveLength(0);
  });

  it("still fails immediately when the AGENT failed (no streamLost discriminator)", async () => {
    const deploymentId = await seedCallerDeployment();
    await seedTarget("live", "http://deployer.local");
    const deleg = captureDelegationId();
    const deps = makeDeps({
      sendTurn: async () =>
        turnResult({ ok: false, reply: null, error: "The model refused." }),
    });
    const res = await runAsk(
      { deploymentId, teammate: "deployer", message: "hi" },
      deps,
    );
    expect(res).toEqual({ ok: false, error: "The model refused." });
    expect(await store.delegations.findById(deleg.id())).toMatchObject({
      status: "failed",
    });
    expect(deps.createdSessions).toHaveLength(0);
    expect(deps.reattaches).toHaveLength(0);
  });

  it("falls back to the old failure when there is no session handle to resume", async () => {
    const deploymentId = await seedCallerDeployment();
    await seedTarget("live", "http://deployer.local");
    const deleg = captureDelegationId();
    const deps = makeDeps({
      sendTurn: async () => lost({ sessionId: null, turnId: null }),
    });
    const res = await runAsk(
      { deploymentId, teammate: "deployer", message: "hi" },
      deps,
    );
    expect(res).toMatchObject({ ok: false });
    expect(await store.delegations.findById(deleg.id())).toMatchObject({
      status: "failed",
    });
    expect(deps.reattaches).toHaveLength(0);
  });

  it("settles the run when the hand-off machinery itself fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const deploymentId = await seedCallerDeployment();
    await seedTarget("live", "http://deployer.local");
    const deleg = captureDelegationId();
    const finishes: unknown[] = [];
    const res = await runAsk(
      { deploymentId, teammate: "deployer", message: "hi" },
      makeDeps({
        sendTurn: async () => lost(),
        createSession: async () => {
          throw new Error("insert failed");
        },
        recordFinish: async (input) => {
          finishes.push(input);
        },
      }),
    );
    expect(res).toMatchObject({ ok: false });
    expect(await store.delegations.findById(deleg.id())).toMatchObject({
      status: "failed",
    });
    // No watcher is coming, so the deferred run finish must run here instead.
    expect(finishes).toHaveLength(1);
    error.mockRestore();
  });

  /**
   * The hand-off promises the calling model that harnesst is watching the turn. If the watcher
   * could not be scheduled that promise is a lie AND nothing will ever settle the two rows, so the
   * relay must fall back to reporting the failure rather than swallow it.
   */
  it("does not claim a watcher it failed to schedule", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const deploymentId = await seedCallerDeployment();
    await seedTarget("live", "http://deployer.local");
    const deleg = captureDelegationId();
    const finishes: unknown[] = [];
    const res = await runAsk(
      { deploymentId, teammate: "deployer", message: "hi" },
      makeDeps({
        sendTurn: async () => lost(),
        scheduleReattach: async () => {
          throw new Error("queue down");
        },
        recordFinish: async (input) => {
          finishes.push(input);
        },
      }),
    );
    expect(res).toMatchObject({ ok: false });
    expect(await store.delegations.findById(deleg.id())).toMatchObject({
      status: "failed",
    });
    expect(finishes).toHaveLength(1);
    error.mockRestore();
  });
});

describe("finalizeDelegationOnResume", () => {
  async function seedWaiting(): Promise<string> {
    const row = await store.delegations.insert({
      projectId: PROJECT,
      fromAgentId: "pm",
      fromEnvironmentId: "env_pm_prod",
      toAgentId: "deployer",
      toEnvironmentId: "env_dep_prod",
    });
    await store.delegations.finalize(row.id, {
      status: "waiting",
      externalSessionId: "sess_peer",
      runId: "run_9",
    });
    return row.id;
  }

  it("completes a waiting delegation on a completed resume", async () => {
    const id = await seedWaiting();
    await finalizeDelegationOnResume(
      { delegationId: id, outcome: "completed" },
      store,
    );
    expect(await store.delegations.findById(id)).toMatchObject({
      status: "completed",
      externalSessionId: "sess_peer",
      runId: "run_9",
    });
  });

  it("fails a waiting delegation with the turn error on a failed resume", async () => {
    const id = await seedWaiting();
    await finalizeDelegationOnResume(
      { delegationId: id, outcome: "failed", error: "boom" },
      store,
    );
    expect(await store.delegations.findById(id)).toMatchObject({
      status: "failed",
      error: "boom",
    });
  });

  it("keeps a re-parked delegation waiting", async () => {
    const id = await seedWaiting();
    await finalizeDelegationOnResume(
      { delegationId: id, outcome: "parked" },
      store,
    );
    expect(await store.delegations.findById(id)).toMatchObject({
      status: "waiting",
    });
  });

  it("never touches running/settled rows (the relay owns those) or missing ids", async () => {
    const running = await store.delegations.insert({
      projectId: PROJECT,
      fromAgentId: "pm",
      fromEnvironmentId: "env_pm_prod",
      toAgentId: "deployer",
      toEnvironmentId: "env_dep_prod",
    });
    await finalizeDelegationOnResume(
      { delegationId: running.id, outcome: "completed" },
      store,
    );
    expect(await store.delegations.findById(running.id)).toMatchObject({
      status: "running",
    });
    await expect(
      finalizeDelegationOnResume(
        { delegationId: "deleg_missing", outcome: "completed" },
        store,
      ),
    ).resolves.toBeUndefined();
  });
});
