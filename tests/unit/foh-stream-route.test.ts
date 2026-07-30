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
  unbindPlaygroundSessionForReseed: vi.fn(),
  loadPlaygroundEntriesFromCache: vi.fn(async () => []),
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
  unbindPlaygroundSessionForReseed: mocks.unbindPlaygroundSessionForReseed,
  loadPlaygroundEntriesFromCache: mocks.loadPlaygroundEntriesFromCache,
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
    lastDeploymentId: "dep_1",
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

  it("wakes a stopped agent before the turn (session env first) and proceeds", async () => {
    mocks.liveTargets
      .mockResolvedValueOnce([]) // before the wake
      .mockResolvedValueOnce([TARGET]); // after the wake
    mocks.listAgentEnvironments.mockResolvedValue([
      { id: "env_other" },
      { id: "env_1" },
    ]);
    mocks.ensureLiveDeploymentForEnvironment.mockResolvedValue({ id: "dep_1" });

    await action(
      args({ agentId: "agent_1", playgroundSessionId: "ps_1", message: "go" }),
    );
    // The parked session's own environment is tried first.
    expect(mocks.ensureLiveDeploymentForEnvironment).toHaveBeenCalledWith("env_1");
    expect(mocks.streamTurnResponse).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "foh", target: TARGET }),
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

  it("drops answers when the session has no eve continuation (fresh/reseeded)", async () => {
    mocks.getFohSessionForViewer.mockResolvedValue(
      sessionRow({ externalSessionId: null, continuationToken: null }),
    );
    // The claimed row (RETURNING) is what the route reads the continuation from.
    mocks.claimPlaygroundSessionForTurn.mockResolvedValue(
      sessionRow({
        externalSessionId: null,
        continuationToken: null,
        status: "running",
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

  it("refuses a channel-homed send with no answer BEFORE any state mutates (issue #282)", async () => {
    const via = {
      channel: "github",
      routePath: "/eve/v1/github/harnesst/answer",
      rawToken: "repo:1:issue:2",
      state: {},
    };
    mocks.getFohSessionForViewer.mockResolvedValue(
      sessionRow({ resumeVia: via }),
    );
    await expect(
      action(
        args({ agentId: "agent_1", playgroundSessionId: "ps_1", message: "hi" }),
      ),
    ).rejects.toMatchObject({ init: { status: 409 } });
    // Nothing was claimed, superseded, or streamed — the park and inbox are untouched.
    expect(mocks.claimPlaygroundSessionForTurn).not.toHaveBeenCalled();
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
      sessionRow({ resumeVia: via }),
    );
    mocks.claimPlaygroundSessionForTurn.mockResolvedValue(
      sessionRow({ resumeVia: via, status: "running" }),
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

  it("reseeds an ordinary session whose deployment was replaced (#71)", async () => {
    mocks.getFohSessionForViewer.mockResolvedValue(
      sessionRow({ lastDeploymentId: "dep_old" }),
    );
    mocks.unbindPlaygroundSessionForReseed.mockResolvedValue(
      sessionRow({ externalSessionId: null, continuationToken: null }),
    );

    await action(args({ agentId: "agent_1", playgroundSessionId: "ps_1", message: "go" }));

    expect(mocks.unbindPlaygroundSessionForReseed).toHaveBeenCalled();
  });

  it("does NOT reseed a channel-homed session when the deployment was replaced", async () => {
    // A park can sit in the inbox for hours, so a redeploy between the question and the answer
    // is the LIKELY timing. Reseeding would clear resume_via and quietly turn the human's answer
    // into a brand-new HTTP conversation: they would read a plausible reply while the GitHub
    // thread went unanswered and the eve-side session stayed parked forever. The answer is
    // attempted on the channel route of the CURRENT deployment instead, and only a proven-dead
    // session unbinds the row (in the drain, after the 409).
    mocks.getFohSessionForViewer.mockResolvedValue(
      sessionRow({
        lastDeploymentId: "dep_old",
        resumeVia: {
          channel: "github",
          routePath: "/eve/v1/github/harnesst/answer",
          rawToken: "repo:1:issue:7",
          state: { owner: "acme", repo: "widgets", issueNumber: 7 },
        },
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

    expect(mocks.unbindPlaygroundSessionForReseed).not.toHaveBeenCalled();
    expect(mocks.loadPlaygroundEntriesFromCache).not.toHaveBeenCalled();
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
