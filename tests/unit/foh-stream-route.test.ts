/**
 * FOH streaming route (app/routes/api.foh.stream.ts) — gate order and the FOH-specific
 * behaviors, with every collaborator mocked: auth → FOH scope guard → agent tenancy →
 * target/wake → supersede (beginFohTurn) → create-or-continue → streamTurnResponse with
 * channel "foh". Replaces the deleted portal-stream-route coverage as the "new surface over
 * the shared drain" proof.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionAuth: vi.fn(),
  requireFohProject: vi.fn(),
  liveTargets: vi.fn(),
  ensureLiveDeploymentForEnvironment: vi.fn(),
  listAgentEnvironments: vi.fn(),
  beginFohTurn: vi.fn(async () => {}),
  getFohSessionForViewer: vi.fn(),
  createPlaygroundSession: vi.fn(),
  setPlaygroundSessionModel: vi.fn(async () => true),
  claimPlaygroundSessionForTurn: vi.fn(),
  clearSessionHandles: vi.fn(),
  loadPlaygroundEntriesFromEve: vi.fn(),
  streamTurnResponse: vi.fn(() => new Response("ok")),
  findWorkspaceModel: vi.fn(async () => null),
  ownsWorkspaceModelReference: vi.fn(async () => true),
  signModelDirective: vi.fn(() => "[directive]"),
  agentsFindById: vi.fn(),
}));

vi.mock("~/auth/session.server", () => ({
  getSessionAuth: mocks.getSessionAuth,
}));
vi.mock("~/foh/guard.server", () => ({
  requireFohProject: mocks.requireFohProject,
}));
vi.mock("~/chat/playground.server", () => ({
  liveTargets: mocks.liveTargets,
}));
vi.mock("~/deploy/wake.server", () => ({
  ensureLiveDeploymentForEnvironment: mocks.ensureLiveDeploymentForEnvironment,
}));
vi.mock("~/db/queries.server", () => ({
  listAgentEnvironments: mocks.listAgentEnvironments,
}));
vi.mock("~/foh/inbox.server", () => ({
  beginFohTurn: mocks.beginFohTurn,
}));
vi.mock("~/playground/sessions.server", () => ({
  getFohSessionForViewer: mocks.getFohSessionForViewer,
  createPlaygroundSession: mocks.createPlaygroundSession,
  setPlaygroundSessionModel: mocks.setPlaygroundSessionModel,
  claimPlaygroundSessionForTurn: mocks.claimPlaygroundSessionForTurn,
  clearSessionHandles: mocks.clearSessionHandles,
  loadPlaygroundEntriesFromEve: mocks.loadPlaygroundEntriesFromEve,
  titleFromMessage: (message: string) => message.slice(0, 80),
}));
vi.mock("~/chat/turn-stream.server", () => ({
  streamTurnResponse: mocks.streamTurnResponse,
  TURN_IDLE_TIMEOUT_MS: 5 * 60_000,
  asString: (value: FormDataEntryValue | null) =>
    typeof value === "string" ? value : "",
}));
vi.mock("~/models/union.server", () => ({
  findWorkspaceModel: mocks.findWorkspaceModel,
  ownsWorkspaceModelReference: mocks.ownsWorkspaceModelReference,
}));
vi.mock("~/models/model-directive.server", () => ({
  signModelDirective: mocks.signModelDirective,
}));
vi.mock("~/seams/index.server", () => ({
  getRuntime: () => ({ data: { agents: { findById: mocks.agentsFindById } } }),
}));

import { action } from "~/routes/api.foh.stream";

const AUTH = { user: { id: "user_1" } };
const PROJECT = { id: "proj_1", orgId: "org_1", name: "repo" };
const AGENT = { id: "agent_1", projectId: "proj_1", name: "ivy", kind: "member" };
const TARGET = {
  deploymentId: "dep_1",
  environmentId: "env_1",
  releaseId: "rel_1",
  url: "http://inst",
  version: "v1",
  environmentName: "production",
  gitSha: "abc",
};

function sessionRow(over: Record<string, unknown> = {}) {
  return {
    id: "ps_1",
    projectId: "proj_1",
    agentId: "agent_1",
    createdBy: "user_1",
    surface: "foh",
    environmentId: "env_1",
    externalSessionId: "eve_1",
    continuationToken: "tok",
    streamIndex: 4,
    status: "waiting",
    title: "Fix the 404",
    modelId: null,
    effort: null,
    pendingInputAt: null,
    ...over,
  };
}

function args(form: Record<string, string>) {
  const body = new URLSearchParams(form);
  return {
    request: new Request("http://localhost/api/foh/proj_1/stream", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    }),
    params: { projectId: "proj_1" },
    context: {},
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionAuth.mockResolvedValue(AUTH);
  mocks.requireFohProject.mockResolvedValue({
    project: PROJECT,
    active: { org: { id: "org_1" }, member: { role: "owner" } },
    backOfHouse: true,
  });
  mocks.agentsFindById.mockResolvedValue(AGENT);
  mocks.liveTargets.mockResolvedValue([TARGET]);
  mocks.getFohSessionForViewer.mockResolvedValue(sessionRow());
  mocks.createPlaygroundSession.mockResolvedValue(sessionRow({ id: "ps_new" }));
  // The claim wins by default, echoing the row it flipped to running (fenced by claimId).
  mocks.claimPlaygroundSessionForTurn.mockImplementation(
    async (input: { id: string; claimId: string }) =>
      sessionRow({ id: input.id, status: "running", turnClaimId: input.claimId }),
  );
  mocks.clearSessionHandles.mockResolvedValue(undefined);
  mocks.loadPlaygroundEntriesFromEve.mockResolvedValue([]);
  mocks.streamTurnResponse.mockReturnValue(new Response("ok"));
});

describe("FOH stream route", () => {
  it("continues an existing session: guard → supersede → run with channel foh", async () => {
    const res = await action(
      args({ agentId: "agent_1", playgroundSessionId: "ps_1", message: "go" }),
    );
    expect(res).toBeInstanceOf(Response);

    expect(mocks.requireFohProject).toHaveBeenCalledWith(AUTH, "proj_1");
    expect(mocks.getFohSessionForViewer).toHaveBeenCalledWith({
      id: "ps_1",
      projectId: "proj_1",
      agentId: "agent_1",
      viewerId: "user_1",
      includeAll: true,
    });
    // Supersede (D13) runs before the turn, never a create.
    expect(mocks.beginFohTurn).toHaveBeenCalledWith("ps_1");
    expect(mocks.createPlaygroundSession).not.toHaveBeenCalled();
    expect(mocks.claimPlaygroundSessionForTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "ps_1",
        target: TARGET,
        claimId: expect.any(String),
        staleAfterMs: 5 * 60_000,
      }),
    );
    // Claim ordering (issue #221 finding 5): the atomic claim decides BEFORE the supersede
    // clears the park — a losing request must not resolve inbox items.
    expect(
      mocks.claimPlaygroundSessionForTurn.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.beginFohTurn.mock.invocationCallOrder[0]);
    expect(mocks.streamTurnResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "foh",
        projectId: "proj_1",
        message: "go",
        target: TARGET,
      }),
    );
    // The fencing token threads from the claim into the drain's saves.
    const [claimInput] = mocks.claimPlaygroundSessionForTurn.mock
      .calls[0] as unknown as [{ claimId: string }];
    expect(mocks.streamTurnResponse).toHaveBeenCalledWith(
      expect.objectContaining({ claimId: claimInput.claimId }),
    );
    // Guard precedes work: no wake needed with a live target.
    expect(mocks.ensureLiveDeploymentForEnvironment).not.toHaveBeenCalled();
  });

  it("409s when another turn holds the claim — no supersede, no stream", async () => {
    mocks.claimPlaygroundSessionForTurn.mockResolvedValue(null);
    await expect(
      action(
        args({ agentId: "agent_1", playgroundSessionId: "ps_1", message: "go" }),
      ),
    ).rejects.toMatchObject({ init: { status: 409 } });
    // A losing request must not clear the park/inbox items or start a drain.
    expect(mocks.beginFohTurn).not.toHaveBeenCalled();
    expect(mocks.streamTurnResponse).not.toHaveBeenCalled();
  });

  it("creates the FOH session (surface foh, auto-title) when none is passed", async () => {
    await action(args({ agentId: "agent_1", message: "Fix the portal 404" }));
    expect(mocks.createPlaygroundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj_1",
        agentId: "agent_1",
        userId: "user_1",
        surface: "foh",
        title: "Fix the portal 404",
      }),
    );
    // A brand-new session has nothing to supersede.
    expect(mocks.beginFohTurn).not.toHaveBeenCalled();
    // The fresh row goes through the same claim path (uniform code, cannot lose).
    expect(mocks.claimPlaygroundSessionForTurn).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ps_new" }),
    );
  });

  it("wakes a stopped agent before the turn (bound session: home env only) and proceeds", async () => {
    mocks.liveTargets
      .mockResolvedValueOnce([]) // before the wake
      .mockResolvedValueOnce([TARGET]); // after the wake
    mocks.ensureLiveDeploymentForEnvironment.mockResolvedValue({ id: "dep_1" });

    await action(
      args({ agentId: "agent_1", playgroundSessionId: "ps_1", message: "go" }),
    );
    // A bound session wakes ONLY its own environment — no other env could serve it.
    expect(mocks.ensureLiveDeploymentForEnvironment).toHaveBeenCalledTimes(1);
    expect(mocks.ensureLiveDeploymentForEnvironment).toHaveBeenCalledWith("env_1");
    expect(mocks.streamTurnResponse).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "foh", target: TARGET }),
    );
  });

  it("wakes a bound session's home environment even while another environment is live (#288)", async () => {
    // Session homed on env_1 (asleep), env_2 live: the old "wake only when nothing is live"
    // gate skipped the wake and fell back to env_2, whose eve never saw the session — the
    // turn failed and the claim rebound the row to the wrong environment permanently.
    const OTHER = { ...TARGET, deploymentId: "dep_2", environmentId: "env_2" };
    mocks.liveTargets
      .mockResolvedValueOnce([OTHER]) // home env asleep, sibling live
      .mockResolvedValueOnce([OTHER, TARGET]); // after the home wake
    mocks.ensureLiveDeploymentForEnvironment.mockResolvedValue({ id: "dep_1" });

    await action(
      args({ agentId: "agent_1", playgroundSessionId: "ps_1", message: "go" }),
    );
    expect(mocks.ensureLiveDeploymentForEnvironment).toHaveBeenCalledTimes(1);
    expect(mocks.ensureLiveDeploymentForEnvironment).toHaveBeenCalledWith("env_1");
    // Home target, never the foreign fallback — and the claim carries the home env, so the
    // row is not rebound.
    expect(mocks.claimPlaygroundSessionForTurn).toHaveBeenCalledWith(
      expect.objectContaining({ target: TARGET }),
    );
    expect(mocks.streamTurnResponse).toHaveBeenCalledWith(
      expect.objectContaining({ target: TARGET }),
    );
  });

  it("refuses a bound session's send when its home environment can't wake — no foreign fallback, no mutation", async () => {
    const OTHER = { ...TARGET, deploymentId: "dep_2", environmentId: "env_2" };
    mocks.liveTargets.mockResolvedValue([OTHER]);
    mocks.ensureLiveDeploymentForEnvironment.mockResolvedValue(null);

    await expect(
      action(
        args({ agentId: "agent_1", playgroundSessionId: "ps_1", message: "go" }),
      ),
    ).rejects.toMatchObject({ init: { status: 409 } });
    expect(mocks.ensureLiveDeploymentForEnvironment).toHaveBeenCalledWith("env_1");
    // The row must be left exactly as it was: no claim (no env rebind), no park clear.
    expect(mocks.claimPlaygroundSessionForTurn).not.toHaveBeenCalled();
    expect(mocks.beginFohTurn).not.toHaveBeenCalled();
    expect(mocks.clearSessionHandles).not.toHaveBeenCalled();
    expect(mocks.streamTurnResponse).not.toHaveBeenCalled();
  });

  it("lets an unbound session use any live target (no eve session to pin it)", async () => {
    const OTHER = { ...TARGET, deploymentId: "dep_2", environmentId: "env_2" };
    mocks.liveTargets.mockResolvedValue([OTHER]);
    mocks.getFohSessionForViewer.mockResolvedValue(
      sessionRow({ externalSessionId: null, continuationToken: null }),
    );
    mocks.claimPlaygroundSessionForTurn.mockResolvedValue(
      sessionRow({
        externalSessionId: null,
        continuationToken: null,
        status: "running",
      }),
    );

    await action(
      args({ agentId: "agent_1", playgroundSessionId: "ps_1", message: "go" }),
    );
    expect(mocks.ensureLiveDeploymentForEnvironment).not.toHaveBeenCalled();
    expect(mocks.streamTurnResponse).toHaveBeenCalledWith(
      expect.objectContaining({ target: OTHER }),
    );
  });

  it("rejects with a clean error when nothing is live and nothing wakes", async () => {
    mocks.liveTargets.mockResolvedValue([]);
    mocks.listAgentEnvironments.mockResolvedValue([{ id: "env_1" }]);
    mocks.ensureLiveDeploymentForEnvironment.mockResolvedValue(null);

    await expect(
      action(args({ agentId: "agent_1", message: "go" })),
    ).rejects.toMatchObject({ init: { status: 400 } });
    expect(mocks.streamTurnResponse).not.toHaveBeenCalled();
  });

  it("propagates the FOH scope guard before any work", async () => {
    mocks.requireFohProject.mockRejectedValue(
      Object.assign(new Error("nope"), { status: 404 }),
    );
    await expect(
      action(args({ agentId: "agent_1", message: "go" })),
    ).rejects.toMatchObject({ status: 404 });
    expect(mocks.liveTargets).not.toHaveBeenCalled();
    expect(mocks.streamTurnResponse).not.toHaveBeenCalled();
  });

  it("404s a session outside the viewer's scope (builder surfaces invisible by query)", async () => {
    mocks.getFohSessionForViewer.mockResolvedValue(null);
    await expect(
      action(
        args({ agentId: "agent_1", playgroundSessionId: "ps_hidden", message: "go" }),
      ),
    ).rejects.toMatchObject({ init: { status: 404 } });
    expect(mocks.beginFohTurn).not.toHaveBeenCalled();
    expect(mocks.streamTurnResponse).not.toHaveBeenCalled();
  });

  it("forwards a request-correlated answer on a continuation send", async () => {
    // Answers only survive the post-claim gate when the CLAIMED row still holds the park.
    mocks.claimPlaygroundSessionForTurn.mockResolvedValue(
      sessionRow({ status: "running", pendingInputAt: new Date() }),
    );
    await action(
      args({
        agentId: "agent_1",
        playgroundSessionId: "ps_1",
        message: "Approve",
        inputResponses: JSON.stringify([
          { requestId: "req_1", optionId: "approve" },
        ]),
      }),
    );
    expect(mocks.streamTurnResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        inputResponses: [{ requestId: "req_1", optionId: "approve" }],
      }),
    );
  });

  it("answers exactly one request of a two-approval batch", async () => {
    // The regression this guards (issue #221 finding 2): eve's text resolver matches a bare
    // "Approve" against EVERY pending confirmation. The correlated payload must carry only
    // the clicked card's requestId.
    mocks.claimPlaygroundSessionForTurn.mockResolvedValue(
      sessionRow({ status: "running", pendingInputAt: new Date() }),
    );
    await action(
      args({
        agentId: "agent_1",
        playgroundSessionId: "ps_1",
        message: "Approve",
        inputResponses: JSON.stringify([
          { requestId: "req_2", optionId: "approve" },
        ]),
      }),
    );
    const [forwarded] = mocks.streamTurnResponse.mock.calls[0] as unknown as [
      { inputResponses: Array<{ requestId: string }> },
    ];
    expect(forwarded.inputResponses).toHaveLength(1);
    expect(forwarded.inputResponses[0].requestId).toBe("req_2");
  });

  it("drops answers when the session has no eve continuation (fresh row)", async () => {
    mocks.getFohSessionForViewer.mockResolvedValue(
      sessionRow({ externalSessionId: null, continuationToken: null }),
    );
    // The claimed row (RETURNING) is what the route reads the continuation from. The park
    // is live, so the drop below is the continuation gate, not the stale-answer gate.
    mocks.claimPlaygroundSessionForTurn.mockResolvedValue(
      sessionRow({
        externalSessionId: null,
        continuationToken: null,
        status: "running",
        pendingInputAt: new Date(),
      }),
    );
    await action(
      args({
        agentId: "agent_1",
        playgroundSessionId: "ps_1",
        message: "Approve",
        inputResponses: JSON.stringify([
          { requestId: "req_1", optionId: "approve" },
        ]),
      }),
    );
    expect(mocks.streamTurnResponse).toHaveBeenCalledWith(
      expect.objectContaining({ inputResponses: null }),
    );
  });

  it("succeeds a channel-homed row on free text: prologue seed, handles untouched, succession send (#288 3b)", async () => {
    const via = {
      channel: "github",
      routePath: "/eve/v1/github/harnesst/answer",
      rawToken: "repo:1:issue:2",
      state: {},
    };
    mocks.getFohSessionForViewer.mockResolvedValue(
      sessionRow({ resumeVia: via, pendingInputAt: new Date() }),
    );
    mocks.claimPlaygroundSessionForTurn.mockResolvedValue(
      sessionRow({ resumeVia: via, status: "running" }),
    );
    mocks.loadPlaygroundEntriesFromEve.mockResolvedValue([
      { id: "e1", role: "user", text: "Issue #2: pricing page 404s" },
      {
        id: "e2",
        role: "assistant",
        text: "",
        inputRequests: [{ requestId: "req_1", prompt: "Which branch?" }],
      },
    ]);

    const res = await action(
      args({ agentId: "agent_1", playgroundSessionId: "ps_1", message: "hi" }),
    );
    expect(res).toBeInstanceOf(Response);

    // The prologue is read from the OLD session's stream at its trusted cursor.
    expect(mocks.loadPlaygroundEntriesFromEve).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          externalSessionId: "eve_1",
          streamIndex: 4,
        }),
        target: TARGET,
        limit: undefined,
      }),
    );
    // Atomicity (#288): the route touches NO handles — the drain rebinds the row only once
    // the successor's `session` event proves it exists.
    expect(mocks.clearSessionHandles).not.toHaveBeenCalled();
    // The park survives until delivery is proven: the drain's deferred begin clears it on
    // the first streamed event, exactly like a channel answer.
    expect(mocks.beginFohTurn).not.toHaveBeenCalled();
    const [forwarded] = mocks.streamTurnResponse.mock.calls[0] as unknown as [
      {
        session: {
          externalSessionId: string | null;
          continuationToken: string | null;
          resumeVia: unknown;
          streamIndex: number;
        };
        messagePrefix: string | null;
        inputResponses: unknown;
        succession: boolean;
      },
    ];
    // The row still holds the predecessor's handles; the succession flag (not a mutation)
    // makes the drain run a first-turn HTTP send and rebind on the session event.
    expect(forwarded.succession).toBe(true);
    expect(forwarded.session.externalSessionId).toBe("eve_1");
    expect(forwarded.session.continuationToken).toBe("tok");
    expect(forwarded.session.resumeVia).toEqual(via);
    // The transcript rides as the strippable seed block on the successor's first message,
    // and a successor's first send never forwards inputResponses (nothing pending on it).
    expect(forwarded.messagePrefix).toContain("harnesst:context-start");
    expect(forwarded.messagePrefix).toContain(
      "User: Issue #2: pricing page 404s",
    );
    expect(forwarded.messagePrefix).toContain("Assistant (asked): Which branch?");
    expect(forwarded.inputResponses).toBeNull();
  });

  it("reads the succession prologue under a fixed cap when the cursor heal never ran (streamIndex 0)", async () => {
    const via = {
      channel: "github",
      routePath: "/eve/v1/github/harnesst/answer",
      rawToken: "repo:1:issue:2",
      state: {},
    };
    mocks.getFohSessionForViewer.mockResolvedValue(
      sessionRow({ resumeVia: via, streamIndex: 0 }),
    );
    mocks.claimPlaygroundSessionForTurn.mockResolvedValue(
      sessionRow({ resumeVia: via, streamIndex: 0, status: "running" }),
    );

    await action(
      args({ agentId: "agent_1", playgroundSessionId: "ps_1", message: "hi" }),
    );

    // A zero cursor means "nobody counted yet", not "the old session is empty" — the read
    // must not silently return [] and lose the prologue.
    expect(mocks.loadPlaygroundEntriesFromEve).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1_000 }),
    );
  });

  it("falls through to a plain continuation when the CLAIMED row was already succeeded (double-racer)", async () => {
    const via = {
      channel: "github",
      routePath: "/eve/v1/github/harnesst/answer",
      rawToken: "repo:1:issue:2",
      state: {},
    };
    // The pre-claim snapshot says channel-homed (this racer read the row before another
    // tab's succession), but the claim RETURNING shows the successor already bound.
    mocks.getFohSessionForViewer.mockResolvedValue(
      sessionRow({ resumeVia: via }),
    );
    mocks.claimPlaygroundSessionForTurn.mockResolvedValue(
      sessionRow({
        resumeVia: null,
        externalSessionId: "eve_2",
        continuationToken: "tok_2",
        status: "running",
      }),
    );

    await action(
      args({ agentId: "agent_1", playgroundSessionId: "ps_1", message: "hi" }),
    );

    // No second succession: no prologue read, no succession flag — the send continues the
    // successor session like any ordinary follow-up.
    expect(mocks.loadPlaygroundEntriesFromEve).not.toHaveBeenCalled();
    expect(mocks.streamTurnResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        succession: false,
        messagePrefix: null,
        session: expect.objectContaining({ externalSessionId: "eve_2" }),
      }),
    );
    // An ordinary HTTP continuation supersedes pre-stream as usual.
    expect(mocks.beginFohTurn).toHaveBeenCalledWith("ps_1");
  });

  it("drops stale inputResponses when the claimed row has no pending ask", async () => {
    // Tab B answers a question card that another turn (or a succession) already resolved:
    // the claimed row's park is gone, so the requestIds reference asks the row's current
    // eve session never issued — forward nothing, send the text as a plain message.
    mocks.claimPlaygroundSessionForTurn.mockResolvedValue(
      sessionRow({ status: "running", pendingInputAt: null }),
    );

    await action(
      args({
        agentId: "agent_1",
        playgroundSessionId: "ps_1",
        message: "Approve",
        inputResponses: JSON.stringify([
          { requestId: "req_stale", optionId: "approve" },
        ]),
      }),
    );

    expect(mocks.streamTurnResponse).toHaveBeenCalledWith(
      expect.objectContaining({ inputResponses: null, succession: false }),
    );
  });

  it("refuses the succession dispatch when a Stop landed after the claim", async () => {
    const via = {
      channel: "github",
      routePath: "/eve/v1/github/harnesst/answer",
      rawToken: "repo:1:issue:2",
      state: {},
    };
    // First read resolves the row; the stop-fence re-read just before dispatch sees the
    // Stop that raced in between (it saw no local controller and marked the row stopped).
    mocks.getFohSessionForViewer
      .mockResolvedValueOnce(sessionRow({ resumeVia: via }))
      .mockResolvedValueOnce(sessionRow({ resumeVia: via, status: "stopped" }));
    mocks.claimPlaygroundSessionForTurn.mockResolvedValue(
      sessionRow({ resumeVia: via, status: "running" }),
    );

    await expect(
      action(
        args({ agentId: "agent_1", playgroundSessionId: "ps_1", message: "hi" }),
      ),
    ).rejects.toMatchObject({ init: { status: 409 } });
    expect(mocks.streamTurnResponse).not.toHaveBeenCalled();
  });

  it("succession proceeds with an empty prologue when the old stream is unreadable (session_gone)", async () => {
    const via = {
      channel: "github",
      routePath: "/eve/v1/github/harnesst/answer",
      rawToken: "repo:1:issue:2",
      state: {},
    };
    mocks.getFohSessionForViewer.mockResolvedValue(
      sessionRow({ resumeVia: via }),
    );
    mocks.claimPlaygroundSessionForTurn.mockResolvedValue(
      sessionRow({ resumeVia: via, status: "running" }),
    );
    mocks.loadPlaygroundEntriesFromEve.mockRejectedValue(
      new Error("Eve stream returned 500"),
    );

    const res = await action(
      args({ agentId: "agent_1", playgroundSessionId: "ps_1", message: "hi" }),
    );
    expect(res).toBeInstanceOf(Response);
    // The read failure never fails the send — the successor just starts without history.
    // The handles stay untouched either way; only the drain's rebind moves them.
    expect(mocks.clearSessionHandles).not.toHaveBeenCalled();
    expect(mocks.streamTurnResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        messagePrefix: null,
        inputResponses: null,
        succession: true,
      }),
    );
  });

  it("does not succeed a channel-homed row when the claim is lost", async () => {
    const via = {
      channel: "github",
      routePath: "/eve/v1/github/harnesst/answer",
      rawToken: "repo:1:issue:2",
      state: {},
    };
    mocks.getFohSessionForViewer.mockResolvedValue(
      sessionRow({ resumeVia: via }),
    );
    mocks.claimPlaygroundSessionForTurn.mockResolvedValue(null);
    await expect(
      action(
        args({ agentId: "agent_1", playgroundSessionId: "ps_1", message: "hi" }),
      ),
    ).rejects.toMatchObject({ init: { status: 409 } });
    // A losing racer must leave the channel binding (and the park) untouched.
    expect(mocks.clearSessionHandles).not.toHaveBeenCalled();
    expect(mocks.loadPlaygroundEntriesFromEve).not.toHaveBeenCalled();
    expect(mocks.beginFohTurn).not.toHaveBeenCalled();
    expect(mocks.streamTurnResponse).not.toHaveBeenCalled();
  });

  it("channel-homed answer: claims, defers the supersede to the drain, threads preClaimStatus", async () => {
    const via = {
      channel: "github",
      routePath: "/eve/v1/github/harnesst/answer",
      rawToken: "repo:1:issue:2",
      state: {},
    };
    mocks.getFohSessionForViewer.mockResolvedValue(
      sessionRow({ resumeVia: via, pendingInputAt: new Date() }),
    );
    mocks.claimPlaygroundSessionForTurn.mockResolvedValue(
      sessionRow({
        resumeVia: via,
        status: "running",
        pendingInputAt: new Date(),
      }),
    );
    await action(
      args({
        agentId: "agent_1",
        playgroundSessionId: "ps_1",
        message: "1. /pricing shows old tiers",
        inputResponses: JSON.stringify([
          { requestId: "req_1", text: "1. /pricing shows old tiers" },
        ]),
      }),
    );
    expect(mocks.claimPlaygroundSessionForTurn).toHaveBeenCalled();
    // The pre-delivery supersede is skipped for channel-homed rows (a refusal must not
    // have cleared the park) — the drain clears it on the first delivered event instead.
    expect(mocks.beginFohTurn).not.toHaveBeenCalled();
    // An answer is NOT a succession: the channel binding stays for the answer route.
    expect(mocks.clearSessionHandles).not.toHaveBeenCalled();
    expect(mocks.loadPlaygroundEntriesFromEve).not.toHaveBeenCalled();
    expect(mocks.streamTurnResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        inputResponses: [
          { requestId: "req_1", text: "1. /pricing shows old tiers" },
        ],
        // The row's status before the claim, for the refusal path's exact restore.
        preClaimStatus: "waiting",
      }),
    );
  });

  it("400s malformed input responses instead of falling back to text matching", async () => {
    await expect(
      action(
        args({
          agentId: "agent_1",
          playgroundSessionId: "ps_1",
          message: "Approve",
          inputResponses: "not json",
        }),
      ),
    ).rejects.toMatchObject({ init: { status: 400 } });
    await expect(
      action(
        args({
          agentId: "agent_1",
          playgroundSessionId: "ps_1",
          message: "Approve",
          inputResponses: JSON.stringify([{ optionId: "approve" }]),
        }),
      ),
    ).rejects.toMatchObject({ init: { status: 400 } });
    expect(mocks.streamTurnResponse).not.toHaveBeenCalled();
  });

  it("continues on the session's environment when several targets are live (#288)", async () => {
    // The eve session lives in its environment's world store, so the env-matched live target
    // serves the continuation — never a cross-environment one, whose eve never saw the session.
    const OTHER = { ...TARGET, deploymentId: "dep_2", environmentId: "env_2" };
    mocks.liveTargets.mockResolvedValue([OTHER, TARGET]);

    await action(
      args({ agentId: "agent_1", playgroundSessionId: "ps_1", message: "go" }),
    );

    expect(mocks.streamTurnResponse).toHaveBeenCalledWith(
      expect.objectContaining({ target: TARGET }),
    );
  });

  it("delivers a channel-homed answer on the CURRENT deployment without touching the binding", async () => {
    // A park can sit in the inbox for hours, so a redeploy between the question and the answer
    // is the LIKELY timing. The session survives it (durable world store); the answer goes to
    // the channel route on whatever deployment is live now, and only a proven-dead session
    // clears the row's handles (in the drain, after the 409).
    const via = {
      channel: "github",
      routePath: "/eve/v1/github/harnesst/answer",
      rawToken: "repo:1:issue:7",
      state: { owner: "acme", repo: "widgets", issueNumber: 7 },
    };
    mocks.getFohSessionForViewer.mockResolvedValue(
      sessionRow({ resumeVia: via, pendingInputAt: new Date() }),
    );
    mocks.claimPlaygroundSessionForTurn.mockResolvedValue(
      sessionRow({
        resumeVia: via,
        status: "running",
        pendingInputAt: new Date(),
      }),
    );

    await action(
      args({
        agentId: "agent_1",
        playgroundSessionId: "ps_1",
        message: "main",
        inputResponses: JSON.stringify([{ requestId: "req_1", optionId: "main" }]),
      }),
    );

    expect(mocks.streamTurnResponse).toHaveBeenCalledWith(
      expect.objectContaining({ target: TARGET, messagePrefix: null }),
    );
  });

  it("404s an agent from another project", async () => {
    mocks.agentsFindById.mockResolvedValue({ ...AGENT, projectId: "proj_2" });
    await expect(
      action(args({ agentId: "agent_1", message: "go" })),
    ).rejects.toMatchObject({ init: { status: 404 } });
  });
});
