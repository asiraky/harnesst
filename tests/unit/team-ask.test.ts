/**
 * Teammate delegation relay flow (Team delegation — D1/§2) against in-memory fakes: no DB, no eve
 * instance. Pins caller resolution, default-allow authorization (+ a disabled override), self-ask
 * rejection, the same-env-name target resolution, live-deployment requirement, the per-edge and
 * per-project concurrency caps, a successful delegation (prefix + recording + linked run path +
 * finalized row), a parked-on-input turn (now a structured waiting result — deep parking
 * assertions live in team-ask-parking.test.ts), and an unreachable peer.
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { TurnResult } from "~/agent/talk.server";
import type { PlaygroundSession } from "~/playground/sessions.server";
import type { AskDeps } from "~/team/ask.server";
import { runAsk } from "~/team/ask.server";
import { makeFakeStore, type FakeStore } from "../fakes/store";

let store: FakeStore;

const PROJECT = "proj_1";
const NOW = new Date(1_000_000_000);

function turnResult(over: Partial<TurnResult> = {}): TurnResult {
  return {
    ok: true,
    sessionId: "sess_1",
    continuationToken: "tok_1",
    streamIndex: 3,
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

/** A caller deployment (the token's subject): its env decides the caller agent + env name. */
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

/** A live target deployment in the deployer's production env. */
async function seedTargetLive(): Promise<string> {
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
  return dep.id;
}

function makeDeps(over: Partial<AskDeps> = {}): AskDeps {
  return {
    store,
    sendTurn: async () => turnResult(),
    recordStart: async () => true,
    recordFinish: async () => {},
    resolveRunId: async () => "run_1",
    ensureLiveDeployment: async () => null,
    createSession: async (input) =>
      ({ id: "ps_1", ...input }) as unknown as PlaygroundSession,
    backfillSession: async () => {},
    scheduleReattach: async () => {},
    now: () => NOW,
    timeoutMs: 600_000,
    ...over,
  };
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

describe("runAsk — success", () => {
  it("delegates (default-allow), prefixes provenance, records the run, links, and finalizes", async () => {
    const deploymentId = await seedCallerDeployment();
    await seedTargetLive();

    let sentMessage = "";
    let sentUrl = "";
    let finishChannel = "";
    let finishMeta: Record<string, unknown> | undefined;
    const deps = makeDeps({
      sendTurn: async (input) => {
        sentMessage = input.message;
        sentUrl = input.baseUrl;
        return turnResult();
      },
      recordFinish: async (input) => {
        finishChannel = input.channel ?? "";
        finishMeta = input.metadata;
      },
    });

    const res = await runAsk(
      { deploymentId, teammate: "deployer", message: "Deploy build 42" },
      deps,
    );

    expect(res).toEqual({
      ok: true,
      reply: "Build 42 is live.",
      teammate: "deployer",
      sessionId: "sess_1",
      runId: "run_1",
      runPath: "/repos/proj_1/agents/deployer/runs/run_1",
    });
    expect(sentUrl).toBe("http://deployer.local");
    expect(sentMessage).toBe('From your teammate "pm": Deploy build 42');
    expect(finishChannel).toBe("teammate");
    expect(finishMeta).toMatchObject({
      fromAgentId: "pm",
      fromAgentName: "pm",
    });
  });

  it("allows an explicitly enabled override too", async () => {
    const deploymentId = await seedCallerDeployment();
    await seedTargetLive();
    await store.agentLinks.set({
      projectId: PROJECT,
      fromAgentId: "pm",
      toAgentId: "deployer",
      enabled: true,
    });
    const res = await runAsk(
      { deploymentId, teammate: "deployer", message: "go" },
      makeDeps(),
    );
    expect(res.ok).toBe(true);
  });
});

describe("runAsk — rejections", () => {
  it("rejects a self-ask", async () => {
    const deploymentId = await seedCallerDeployment();
    const res = await runAsk(
      { deploymentId, teammate: "pm", message: "hi" },
      makeDeps(),
    );
    expect(res).toEqual({
      ok: false,
      error: expect.stringContaining("yourself"),
    });
  });

  it("rejects an unknown teammate", async () => {
    const deploymentId = await seedCallerDeployment();
    const res = await runAsk(
      { deploymentId, teammate: "ghost", message: "hi" },
      makeDeps(),
    );
    expect(res.ok).toBe(false);
  });

  it("denies when a disabled override row exists (default-allow overridden off)", async () => {
    const deploymentId = await seedCallerDeployment();
    await seedTargetLive();
    await store.agentLinks.set({
      projectId: PROJECT,
      fromAgentId: "pm",
      toAgentId: "deployer",
      enabled: false,
    });
    const res = await runAsk(
      { deploymentId, teammate: "deployer", message: "hi" },
      makeDeps(),
    );
    expect(res).toEqual({
      ok: false,
      error: expect.stringContaining("not permitted"),
    });
  });

  it("errors when the target has no matching env name", async () => {
    const deploymentId = await seedCallerDeployment();
    // deployer only has a 'preview' env — no 'production' to match the caller's.
    await store.environments.rename("env_dep_prod", "preview");
    const res = await runAsk(
      { deploymentId, teammate: "deployer", message: "hi" },
      makeDeps(),
    );
    expect(res).toEqual({
      ok: false,
      error: expect.stringContaining("production"),
    });
  });

  it("errors when the target has never been deployed", async () => {
    const deploymentId = await seedCallerDeployment();
    const res = await runAsk(
      { deploymentId, teammate: "deployer", message: "hi" },
      makeDeps(),
    );
    expect(res).toEqual({
      ok: false,
      error: expect.stringContaining("never been deployed"),
    });
  });

  it("errors when the target has a deployment but none is live", async () => {
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
    const res = await runAsk(
      { deploymentId, teammate: "deployer", message: "hi" },
      makeDeps(),
    );
    expect(res).toEqual({
      ok: false,
      error: expect.stringContaining("no live deployment"),
    });
  });

  it("rejects an empty message", async () => {
    const deploymentId = await seedCallerDeployment();
    const res = await runAsk(
      { deploymentId, teammate: "deployer", message: "   " },
      makeDeps(),
    );
    expect(res).toEqual({ ok: false, error: expect.stringContaining("empty") });
  });
});

describe("runAsk — concurrency caps", () => {
  async function fillEdge(n: number, from: string, to: string) {
    for (let i = 0; i < n; i++) {
      await store.delegations.insert({
        projectId: PROJECT,
        fromAgentId: from,
        fromEnvironmentId: "env_pm_prod",
        toAgentId: to,
        toEnvironmentId: "env_dep_prod",
      });
    }
  }

  it("caps active delegations on one directed edge (3)", async () => {
    const deploymentId = await seedCallerDeployment();
    await seedTargetLive();
    await fillEdge(3, "pm", "deployer");
    const res = await runAsk(
      { deploymentId, teammate: "deployer", message: "hi" },
      makeDeps(),
    );
    expect(res).toEqual({
      ok: false,
      error: expect.stringContaining("in-flight"),
    });
  });

  it("caps active delegations across the project (10)", async () => {
    const deploymentId = await seedCallerDeployment();
    await seedTargetLive();
    // 10 on the REVERSE edge — the pm→deployer edge is clear, but the project is saturated.
    await fillEdge(10, "deployer", "pm");
    const res = await runAsk(
      { deploymentId, teammate: "deployer", message: "hi" },
      makeDeps(),
    );
    expect(res).toEqual({
      ok: false,
      error: expect.stringContaining("too many delegations"),
    });
  });
});

describe("runAsk — peer outcomes", () => {
  it("parks a parked-on-input turn as a structured waiting result (§5 relay parking)", async () => {
    const deploymentId = await seedCallerDeployment();
    await seedTargetLive();
    const parked = turnResult({
      reply: null,
      inputRequests: [
        {
          requestId: "r1",
          prompt: "Which environment?",
          display: null,
          allowFreeform: null,
          options: undefined,
        },
      ],
    });
    const res = await runAsk(
      { deploymentId, teammate: "deployer", message: "hi" },
      makeDeps({ sendTurn: async () => parked }),
    );
    expect(res).toEqual({
      ok: true,
      status: "waiting_on_human",
      teammate: "deployer",
      question: "Which environment?",
      note: expect.stringContaining("resume"),
    });
  });

  it("treats an ok turn with no reply as a failure (nothing to hand back)", async () => {
    const deploymentId = await seedCallerDeployment();
    await seedTargetLive();
    const res = await runAsk(
      { deploymentId, teammate: "deployer", message: "hi" },
      makeDeps({
        sendTurn: async () => turnResult({ ok: true, reply: "   " }),
      }),
    );
    expect(res).toEqual({
      ok: false,
      error: '"deployer" finished without a reply.',
    });
  });

  it("returns an error when the peer is unreachable", async () => {
    const deploymentId = await seedCallerDeployment();
    await seedTargetLive();
    const res = await runAsk(
      { deploymentId, teammate: "deployer", message: "hi" },
      makeDeps({
        sendTurn: async () => {
          throw new Error("connect ECONNREFUSED");
        },
      }),
    );
    expect(res).toEqual({
      ok: false,
      error: expect.stringContaining("Couldn't reach"),
    });
  });

  it("propagates a failed peer turn", async () => {
    const deploymentId = await seedCallerDeployment();
    await seedTargetLive();
    const res = await runAsk(
      { deploymentId, teammate: "deployer", message: "hi" },
      makeDeps({
        sendTurn: async () =>
          turnResult({ ok: false, reply: null, error: "boom" }),
      }),
    );
    expect(res).toEqual({ ok: false, error: "boom" });
  });
});
