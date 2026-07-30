/**
 * WS1 — `parkChannelQuestion` against in-memory fakes (the `runAsk` deps pattern: zero I/O).
 *
 * What matters here: identity comes ONLY from the token's deployment id, the channel/route pair
 * is allowlisted before anything is written, the namespaced continuation token is stored both
 * ways round (namespaced on the row, stripped in the descriptor), and the whole endpoint is
 * idempotent — the agent's park fetch is best-effort with a timeout, so retries are expected,
 * and a retry must not open a second conversation or a second inbox item.
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { ChatInputRequest } from "~/chat/types";
import { CHANNEL_ANSWER_ROUTES } from "~/foh/channel-resume";
import { openInboxQuestion } from "~/foh/inbox.server";
import { parkChannelQuestion, type ParkDeps } from "~/foh/park.server";
import type { PlaygroundSession } from "~/playground/sessions.server";
import { makeFakeStore, type FakeStore } from "../fakes/store";

const GITHUB_ROUTE = CHANNEL_ANSWER_ROUTES.github;
const PROJECT = "proj_1";
const NOW = new Date(1_700_000_000_000);
const STATE = {
  owner: "acme",
  repo: "widgets",
  issueNumber: 7,
  repositoryId: 1310524517,
  conversationKind: "issue",
};

let store: FakeStore;

/** Seed project → agent → environment → live deployment, and return the deployment id. */
async function seedDeployment(over: { agentId?: string } = {}): Promise<string> {
  store.seedProject({ id: PROJECT, orgId: "org_1" });
  store.seedAgent({ id: "agent_1", projectId: PROJECT, name: "dev" });
  store.seedEnvironment({
    id: "env_1",
    projectId: PROJECT,
    // The environment can outlive its agent (a delete that half-cascaded, an older row); the
    // park must refuse rather than file the question under a project it cannot resolve.
    agentId: over.agentId ?? "agent_1",
    name: "production",
  });
  const release = await store.releases.insert({
    projectId: PROJECT,
    agentId: "agent_1",
    version: "v1",
    gitSha: "a".repeat(40),
  });
  const dep = await store.deployments.insert({
    environmentId: "env_1",
    releaseId: release.id,
    status: "live",
    trafficWeight: 100,
  });
  await store.deployments.update(dep.id, { url: "http://inst:4000" });
  return dep.id;
}

/**
 * Deps whose session upsert is a real in-memory map keyed on (projectId, externalSessionId) —
 * the same key as the `playground_sessions_external_uq` index the production path upserts on. A
 * park naming an eve session ANOTHER agent already owns collides on that key and is refused,
 * exactly as the real adopt's `agent_id` predicate refuses it.
 */
function makeDeps(): ParkDeps & {
  sessions: Map<string, PlaygroundSession>;
  adopts: Array<Parameters<ParkDeps["adoptSession"]>[0]>;
  cursorAdvances: Array<Parameters<ParkDeps["advanceCursor"]>[0]>;
} {
  const sessions = new Map<string, PlaygroundSession>();
  const adopts: Array<Parameters<ParkDeps["adoptSession"]>[0]> = [];
  const cursorAdvances: Array<Parameters<ParkDeps["advanceCursor"]>[0]> = [];
  let seq = 0;
  return {
    store,
    sessions,
    adopts,
    cursorAdvances,
    adoptSession: async (input) => {
      adopts.push(input);
      const owner = [...sessions.values()].find(
        (s) =>
          s.projectId === input.projectId &&
          s.externalSessionId === input.externalSessionId,
      );
      if (owner && owner.agentId !== input.agentId) {
        return { ok: false, reason: "session_not_owned" };
      }
      const key = `${input.projectId}|${input.externalSessionId}`;
      const existing = sessions.get(key);
      const row = {
        ...(existing ?? { id: `ps_${++seq}`, streamIndex: 0 }),
        projectId: input.projectId,
        agentId: input.agentId,
        createdBy: null,
        surface: "foh",
        environmentId: input.environmentId,
        externalSessionId: input.externalSessionId,
        continuationToken: input.continuationToken,
        resumeVia: input.resumeVia,
        title: input.title ?? existing?.title ?? null,
        status: "waiting",
        pendingInputAt: input.now,
        lastEventAt: input.now,
      } as unknown as PlaygroundSession;
      sessions.set(key, row);
      return { ok: true, session: row, parkDeferred: false };
    },
    advanceCursor: async (input) => {
      cursorAdvances.push(input);
    },
    openQuestion: openInboxQuestion,
    staleAfterMs: 300_000,
    now: () => NOW,
  };
}

function request(over: Partial<ChatInputRequest> = {}): ChatInputRequest {
  return { requestId: "req_1", prompt: "Which branch should I target?", ...over };
}

function input(over: Record<string, unknown> = {}) {
  return {
    deploymentId: "",
    channel: "github",
    routePath: GITHUB_ROUTE,
    eveSessionId: "sess_eve_1",
    continuationToken: "github:repo:1310524517:issue:7",
    state: STATE,
    title: "acme/widgets#7",
    requests: [request()],
    ...over,
  } as Parameters<typeof parkChannelQuestion>[0];
}

beforeEach(() => {
  store = makeFakeStore();
});

describe("parkChannelQuestion", () => {
  it("opens a team-wide FOH session parked on the question", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps();

    const result = await parkChannelQuestion(input({ deploymentId }), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const session = deps.sessions.get(`${PROJECT}|sess_eve_1`)!;
    expect(session.surface).toBe("foh");
    // `created_by IS NULL` is what makes the row visible to every FOH member, not just its
    // opener — a question raised on a public issue belongs to whoever can answer it.
    expect(session.createdBy).toBeNull();
    expect(session.status).toBe("waiting");
    expect(session.pendingInputAt).toEqual(NOW);
    expect(session.title).toBe("acme/widgets#7");
    expect(result.inboxItemIds).toHaveLength(1);
    const item = store.getInboxItem(result.inboxItemIds[0])!;
    expect(item).toMatchObject({
      projectId: PROJECT,
      sessionId: session.id,
      agentId: "agent_1",
      userId: null,
      kind: "question",
      requestId: "req_1",
      prompt: "Which branch should I target?",
    });
  });

  it("stores the namespaced token on the row and the STRIPPED token in the descriptor", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps();

    await parkChannelQuestion(input({ deploymentId }), deps);

    const session = deps.sessions.get(`${PROJECT}|sess_eve_1`)!;
    expect(session.continuationToken).toBe("github:repo:1310524517:issue:7");
    expect(session.resumeVia).toEqual({
      channel: "github",
      routePath: GITHUB_ROUTE,
      // Stripped exactly once — handing the namespaced form back to eve's `send()` yields
      // `github:github:…` and the resume silently misses.
      rawToken: "repo:1310524517:issue:7",
      state: STATE,
    });
  });

  it("round-trips the channel state byte-identically", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps();

    await parkChannelQuestion(input({ deploymentId }), deps);

    expect(JSON.stringify(deps.adopts[0].resumeVia.state)).toBe(
      JSON.stringify(STATE),
    );
  });

  it("is idempotent: a redelivered park updates the row and reuses the inbox item", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps();

    const first = await parkChannelQuestion(input({ deploymentId }), deps);
    const second = await parkChannelQuestion(input({ deploymentId }), deps);

    expect(first).toEqual(second);
    expect(deps.sessions.size).toBe(1);
    expect(
      (await store.inboxItems.findPendingBySession(
        first.ok ? first.sessionId : "",
      )).length,
    ).toBe(1);
  });

  it("opens one inbox item per distinct requestId on the same session", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps();

    const result = await parkChannelQuestion(
      input({
        deploymentId,
        requests: [
          request(),
          request({ requestId: "req_2", prompt: "Deploy after merging?" }),
        ],
      }),
      deps,
    );

    expect(result.ok && result.inboxItemIds).toHaveLength(2);
    expect(deps.sessions.size).toBe(1);
  });

  it("files an approval when eve renders the request as a confirmation", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps();

    const result = await parkChannelQuestion(
      input({ deploymentId, requests: [request({ display: "confirmation" })] }),
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(store.getInboxItem(result.inboxItemIds[0])!.kind).toBe("approval");
  });

  it("titles the session from the question when the agent sends none", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps();

    await parkChannelQuestion(input({ deploymentId, title: "   " }), deps);

    expect(deps.sessions.get(`${PROJECT}|sess_eve_1`)!.title).toBe(
      "Which branch should I target?",
    );
  });

  it("advances the cursor against the deployment's own url", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps();

    await parkChannelQuestion(input({ deploymentId }), deps);

    expect(deps.cursorAdvances).toHaveLength(1);
    expect(deps.cursorAdvances[0].target.url).toBe("http://inst:4000");
  });

  it("still parks when the cursor advance throws — the inbox item is the point", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps();
    deps.advanceCursor = async () => {
      throw new Error("instance unreachable");
    };

    const result = await parkChannelQuestion(input({ deploymentId }), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inboxItemIds).toHaveLength(1);
  });

  it("does not WAIT for the cursor advance — the agent's park fetch has a 10s timeout", async () => {
    // The advance reads the tail of the same eve session whose turn is still open, over the
    // network. Awaiting it put an unbounded read inside a request the container abandons after
    // 10s, and the abandoned retry then re-ran the whole park.
    const deploymentId = await seedDeployment();
    const deps = makeDeps();
    let release: () => void = () => {};
    deps.advanceCursor = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });

    const result = await parkChannelQuestion(input({ deploymentId }), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inboxItemIds).toHaveLength(1);
    release();
  });

  it("survives a cursor advance that throws SYNCHRONOUSLY, before it ever returns a promise", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps();
    deps.advanceCursor = () => {
      throw new Error("no target");
    };

    const result = await parkChannelQuestion(input({ deploymentId }), deps);

    expect(result.ok).toBe(true);
  });

  it("refuses to park onto an eve session another agent already owns", async () => {
    // The delegation token authenticates a DEPLOYMENT, and any container in the project can call
    // the park. Without an owner check, one agent could name another's live external_session_id
    // and overwrite its resume handles — redirecting the next human answer onto an issue thread
    // of the caller's choosing.
    const deploymentId = await seedDeployment();
    const deps = makeDeps();
    await parkChannelQuestion(input({ deploymentId }), deps);

    // A second agent, in the same project, parking the SAME eve session id.
    store.seedAgent({ id: "agent_2", projectId: PROJECT, name: "other" });
    store.seedEnvironment({
      id: "env_2",
      projectId: PROJECT,
      agentId: "agent_2",
      name: "production",
    });
    const release = await store.releases.insert({
      projectId: PROJECT,
      agentId: "agent_2",
      version: "v1",
      gitSha: "b".repeat(40),
    });
    const intruder = await store.deployments.insert({
      environmentId: "env_2",
      releaseId: release.id,
      status: "live",
      trafficWeight: 100,
    });
    await store.deployments.update(intruder.id, { url: "http://inst2:4000" });

    const result = await parkChannelQuestion(
      input({
        deploymentId: intruder.id,
        routePath: GITHUB_ROUTE,
        state: { ...STATE, owner: "attacker", repo: "elsewhere" },
      }),
      deps,
    );

    expect(result).toEqual({
      ok: false,
      error: "That eve session belongs to a different agent.",
    });
    // The victim's row is untouched: same descriptor, same thread.
    const victim = deps.sessions.get(`${PROJECT}|sess_eve_1`)!;
    expect(victim.resumeVia).toMatchObject({ state: STATE });
    expect(deps.sessions.size).toBe(1);
  });

  it("tells the adopt how stale a running row must be before its status may be moved", async () => {
    // The upsert only re-parks a row it can prove is not mid-turn; the drain's own needs-you
    // chokepoint owns the row for the turn it is running.
    const deploymentId = await seedDeployment();
    const deps = makeDeps();

    await parkChannelQuestion(input({ deploymentId }), deps);

    expect(deps.adopts[0].staleAfterMs).toBe(300_000);
  });

  it("refuses a channel outside the allowlist, writing nothing", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps();

    const result = await parkChannelQuestion(
      input({
        deploymentId,
        channel: "slack",
        routePath: "/eve/v1/slack/harnesst/answer",
      }),
      deps,
    );

    expect(result.ok).toBe(false);
    expect(deps.adopts).toHaveLength(0);
    expect(deps.sessions.size).toBe(0);
  });

  it("refuses a route path the agent made up, writing nothing", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps();

    const result = await parkChannelQuestion(
      input({ deploymentId, routePath: "/eve/v1/session/whatever" }),
      deps,
    );

    expect(result.ok).toBe(false);
    expect(deps.adopts).toHaveLength(0);
  });

  it("denies an unknown deployment — the token names something harnesst forgot", async () => {
    const deps = makeDeps();

    const result = await parkChannelQuestion(
      input({ deploymentId: "dep_missing" }),
      deps,
    );

    expect(result).toEqual({
      ok: false,
      error: "Your deployment is no longer known to harnesst.",
    });
  });

  it("denies when the agent behind the deployment is gone", async () => {
    const deploymentId = await seedDeployment({ agentId: "agent_gone" });
    const deps = makeDeps();

    const result = await parkChannelQuestion(input({ deploymentId }), deps);

    expect(result.ok).toBe(false);
    expect(deps.adopts).toHaveLength(0);
  });

  it("derives the project/agent from the token, never from the body", async () => {
    const deploymentId = await seedDeployment();
    // A second tenant the caller must not be able to name.
    store.seedProject({ id: "proj_other", orgId: "org_2" });
    store.seedAgent({ id: "agent_other", projectId: "proj_other" });
    const deps = makeDeps();

    await parkChannelQuestion(
      input({
        deploymentId,
        projectId: "proj_other",
        agentId: "agent_other",
      }),
      deps,
    );

    expect(deps.adopts[0]).toMatchObject({
      projectId: PROJECT,
      agentId: "agent_1",
    });
  });

  it("refuses an oversized channel state", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps();

    const result = await parkChannelQuestion(
      input({ deploymentId, state: { blob: "x".repeat(200_000) } }),
      deps,
    );

    expect(result.ok).toBe(false);
    expect(deps.adopts).toHaveLength(0);
  });
});
