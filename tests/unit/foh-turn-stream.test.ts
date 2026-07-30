/**
 * FOH needs-you chokepoint #1 in the shared drain (app/chat/turn-stream.server.ts), driven by
 * a scripted `streamTurn` with NO reader attached to the NDJSON response until after the fact —
 * the §6 "even with no client connected" guarantee. Asserts the park/settle/inbox writes fire
 * for FOH sessions, never for the builder surfaces, and that inbox failures can't break the
 * drain or the cursor save.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

import type { TalkEvent, TurnResult } from "~/agent/talk.server";
import type { Target } from "~/chat/playground.server";
import type { ChatInputRequest } from "~/chat/types";
import type { PlaygroundSession } from "~/playground/sessions.server";

const mocks = vi.hoisted(() => ({
  streamTurn: vi.fn(),
  savePlaygroundSessionProgress: vi.fn(async () => {}),
  savePlaygroundSessionCursor: vi.fn(async () => {}),
  markSessionPendingInput: vi.fn(async () => true),
  clearSessionPendingInput: vi.fn(async () => {}),
  releaseRefusedTurnClaim: vi.fn(async () => {}),
  beginFohTurn: vi.fn(async () => {}),
  openInboxQuestion: vi.fn(async () => ({ id: "inb_1" })),
  resolveInboxForSession: vi.fn(async () => {}),
  recordInboxFinished: vi.fn(async () => ({ id: "inb_fin" })),
  recordTurnStart: vi.fn(async () => {}),
  recordTurnFinish: vi.fn(async () => {}),
  finalizeDelegationOnResume: vi.fn(async () => {}),
  clearSessionHandles: vi.fn(async () => {}),
  bindSuccessorSessionHandles: vi.fn(async () => {}),
}));

vi.mock("~/agent/talk.server", () => ({
  streamTurn: mocks.streamTurn,
}));
vi.mock("~/playground/sessions.server", () => ({
  savePlaygroundSessionProgress: mocks.savePlaygroundSessionProgress,
  savePlaygroundSessionCursor: mocks.savePlaygroundSessionCursor,
  markSessionPendingInput: mocks.markSessionPendingInput,
  clearSessionPendingInput: mocks.clearSessionPendingInput,
  releaseRefusedTurnClaim: mocks.releaseRefusedTurnClaim,
  clearSessionHandles: mocks.clearSessionHandles,
  bindSuccessorSessionHandles: mocks.bindSuccessorSessionHandles,
}));
vi.mock("~/foh/inbox.server", () => ({
  beginFohTurn: mocks.beginFohTurn,
  openInboxQuestion: mocks.openInboxQuestion,
  resolveInboxForSession: mocks.resolveInboxForSession,
  recordInboxFinished: mocks.recordInboxFinished,
}));
vi.mock("~/observability/record.server", () => ({
  externalRunId: (sessionId: string, turnId: string) => `${sessionId}:${turnId}`,
  recordTurnStart: mocks.recordTurnStart,
  recordTurnFinish: mocks.recordTurnFinish,
}));
vi.mock("~/assistant/checkout-sync.server", () => ({
  syncConversationCheckout: vi.fn(async () => ({
    synced: false,
    kind: "noop",
    reason: "checkouts unsupported on this deploy target",
    stagedCount: 0,
  })),
  recordSyncFailure: vi.fn(async () => {}),
}));
vi.mock("~/team/resume.server", () => ({
  finalizeDelegationOnResume: mocks.finalizeDelegationOnResume,
}));

import { streamTurnResponse } from "~/chat/turn-stream.server";

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
    environmentId: "env_1",
    worldKey: "env_1",
    createdBy: "user_1",
    surface: "foh",
    pendingInputAt: null,
    openedByAgentId: null,
    delegationId: null,
    externalSessionId: null,
    continuationToken: null,
    streamIndex: 0,
    title: null,
    status: "running",
    lastVersion: null,
    modelId: null,
    effort: null,
    lastEventAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as PlaygroundSession;
}

function request(requestId = "r1"): ChatInputRequest {
  return { requestId, prompt: "Merge now or wait?" };
}

function result(over: Partial<TurnResult> = {}): TurnResult {
  return {
    ok: true,
    sessionId: "sess_ext",
    continuationToken: "tok_1",
    streamIndex: 3,
    reply: null,
    replyIsStructured: false,
    inputRequests: [],
    modelId: null,
    turnId: "turn_1",
    steps: [],
    messages: [],
    error: null,
    ...over,
  };
}

/** Script the drained turn: streamTurn yields these events, then the generator ends. */
function script(events: TalkEvent[]) {
  mocks.streamTurn.mockImplementation(async function* () {
    for (const event of events) yield event;
  });
}

/** A parked turn: session opens, the agent asks, eve settles waiting. */
function parkedTurn(requests: ChatInputRequest[]): TalkEvent[] {
  return [
    { kind: "session", sessionId: "sess_ext", continuationToken: "tok_1" },
    { kind: "turn", turnId: "turn_1" },
    { kind: "input", requests },
    { kind: "done", result: result({ inputRequests: requests, reply: "One thing —" }) },
  ];
}

/** Drain the NDJSON response to completion — this awaits the detached consume loop. */
async function readAll(res: Response): Promise<Array<Record<string, unknown>>> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function run(input: { session: PlaygroundSession; channel: string }) {
  return readAll(
    streamTurnResponse({
      projectId: "proj_1",
      target: TARGET,
      session: input.session,
      message: "do the thing",
      channel: input.channel,
      title: null,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("streamTurnResponse — FOH needs-you chokepoint", () => {
  it("records the park + inbox items for a foh session with no watcher", async () => {
    const requests = [request("r1"), request("r2")];
    script(parkedTurn(requests));

    await run({ session: session(), channel: "foh" });

    expect(mocks.markSessionPendingInput).toHaveBeenCalledWith("ps_1");
    expect(mocks.openInboxQuestion).toHaveBeenCalledTimes(2);
    expect(mocks.openInboxQuestion).toHaveBeenCalledWith({
      projectId: "proj_1",
      sessionId: "ps_1",
      agentId: "agent_1",
      userId: "user_1",
      delegationId: null,
      request: requests[0],
    });
    // Parked turn: the pending flag and items survive the terminal settle.
    expect(mocks.clearSessionPendingInput).not.toHaveBeenCalled();
    expect(mocks.resolveInboxForSession).not.toHaveBeenCalled();
    expect(mocks.recordInboxFinished).not.toHaveBeenCalled();
    // The ordinary cursor save is untouched by the park.
    expect(mocks.savePlaygroundSessionCursor).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ps_1", status: "waiting" }),
    );
  });

  it("carries the agent-opened recipient: userId null, delegation ref threaded", async () => {
    script(parkedTurn([request()]));

    await run({
      session: session({ createdBy: null, delegationId: "deleg_1" }),
      channel: "foh",
    });

    expect(mocks.openInboxQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ userId: null, delegationId: "deleg_1" }),
    );
  });

  it("clears the park, resolves asks, and files finished on normal completion", async () => {
    script([
      { kind: "session", sessionId: "sess_ext", continuationToken: "tok_1" },
      { kind: "turn", turnId: "turn_1" },
      { kind: "done", result: result({ reply: "All done." }) },
    ]);

    await run({ session: session(), channel: "foh" });

    expect(mocks.markSessionPendingInput).not.toHaveBeenCalled();
    expect(mocks.clearSessionPendingInput).toHaveBeenCalledWith("ps_1");
    expect(mocks.resolveInboxForSession).toHaveBeenCalledWith("ps_1");
    expect(mocks.recordInboxFinished).toHaveBeenCalledWith({
      projectId: "proj_1",
      sessionId: "ps_1",
      agentId: "agent_1",
      userId: "user_1",
      prompt: "All done.",
    });
  });

  it("clears the park and resolves asks on failure, without a finished item", async () => {
    script([
      { kind: "session", sessionId: "sess_ext", continuationToken: "tok_1" },
      { kind: "done", result: result({ ok: false, error: "boom" }) },
    ]);

    await run({ session: session(), channel: "foh" });

    expect(mocks.clearSessionPendingInput).toHaveBeenCalledWith("ps_1");
    expect(mocks.resolveInboxForSession).toHaveBeenCalledWith("ps_1");
    expect(mocks.recordInboxFinished).not.toHaveBeenCalled();
  });

  it("never touches needs-you state for the playground channel", async () => {
    script(parkedTurn([request()]));

    const events = await run({
      session: session({ surface: "playground" }),
      channel: "playground",
    });

    expect(mocks.markSessionPendingInput).not.toHaveBeenCalled();
    expect(mocks.openInboxQuestion).not.toHaveBeenCalled();
    expect(mocks.clearSessionPendingInput).not.toHaveBeenCalled();
    expect(mocks.resolveInboxForSession).not.toHaveBeenCalled();
    expect(mocks.recordInboxFinished).not.toHaveBeenCalled();
    expect(mocks.finalizeDelegationOnResume).not.toHaveBeenCalled();
    // The browser still gets the input event exactly as before.
    expect(events.find((e) => e.type === "input")).toMatchObject({
      requests: [{ requestId: "r1" }],
    });
    expect(mocks.savePlaygroundSessionCursor).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ps_1", status: "waiting" }),
    );
  });

  it("never touches needs-you state for the assistant surface", async () => {
    script(parkedTurn([request()]));

    await run({
      session: session({ surface: "assistant" }),
      channel: "assistant",
    });

    expect(mocks.markSessionPendingInput).not.toHaveBeenCalled();
    expect(mocks.openInboxQuestion).not.toHaveBeenCalled();
  });

  it("skips the inbox insert when the park claim reports a lost race (stop won)", async () => {
    // markSessionPendingInput's stop-wins guard updated zero rows — the session was stopped
    // between the input event and the park write. Filing an inbox item anyway would
    // resurrect the stopped session into the inbox (issue #221 finding 4).
    mocks.markSessionPendingInput.mockResolvedValueOnce(false);
    script(parkedTurn([request()]));

    const events = await run({ session: session(), channel: "foh" });

    expect(mocks.markSessionPendingInput).toHaveBeenCalledWith("ps_1");
    expect(mocks.openInboxQuestion).not.toHaveBeenCalled();
    // The drain itself is unaffected.
    expect(events.at(-1)).toMatchObject({ type: "done", ok: true });
  });

  it("keeps draining when the park write fails (inbox never breaks the drain)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.openInboxQuestion.mockRejectedValueOnce(new Error("db down"));
    script(parkedTurn([request()]));

    const events = await run({ session: session(), channel: "foh" });

    // The stream still ends with done and the cursor save still lands.
    expect(events.at(-1)).toMatchObject({ type: "done", ok: true });
    expect(mocks.savePlaygroundSessionCursor).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ps_1", status: "waiting" }),
    );
    error.mockRestore();
  });

  it("keeps the terminal settle failure out of the drain too", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.clearSessionPendingInput.mockRejectedValueOnce(new Error("db down"));
    script([
      { kind: "session", sessionId: "sess_ext", continuationToken: "tok_1" },
      { kind: "done", result: result({ reply: "ok" }) },
    ]);

    const events = await run({ session: session(), channel: "foh" });

    expect(events.at(-1)).toMatchObject({ type: "done", ok: true });
    // The run recorder still fires after the swallowed inbox failure.
    expect(mocks.recordTurnFinish).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("streamTurnResponse — delegation wake-on-answer (WP4)", () => {
  const delegated = () =>
    session({ createdBy: null, delegationId: "deleg_1", openedByAgentId: "agent_1" });

  it("finalizes a waiting delegation as completed when the resumed turn completes", async () => {
    script([
      { kind: "session", sessionId: "sess_ext", continuationToken: "tok_1" },
      { kind: "turn", turnId: "turn_2" },
      { kind: "done", result: result({ reply: "Answered and finished." }) },
    ]);

    await run({ session: delegated(), channel: "foh" });

    expect(mocks.finalizeDelegationOnResume).toHaveBeenCalledWith({
      delegationId: "deleg_1",
      outcome: "completed",
      error: null,
    });
  });

  it("finalizes as failed with the turn error when the resumed turn fails", async () => {
    script([
      { kind: "session", sessionId: "sess_ext", continuationToken: "tok_1" },
      { kind: "done", result: result({ ok: false, error: "boom" }) },
    ]);

    await run({ session: delegated(), channel: "foh" });

    expect(mocks.finalizeDelegationOnResume).toHaveBeenCalledWith({
      delegationId: "deleg_1",
      outcome: "failed",
      error: "boom",
    });
  });

  it("reports a re-park (outcome parked) so the delegation stays waiting", async () => {
    script(parkedTurn([request("r3")]));

    await run({ session: delegated(), channel: "foh" });

    expect(mocks.finalizeDelegationOnResume).toHaveBeenCalledWith({
      delegationId: "deleg_1",
      outcome: "parked",
      error: null,
    });
    // And the re-park filed its fresh inbox item through the ordinary chokepoint.
    expect(mocks.openInboxQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ delegationId: "deleg_1", userId: null }),
    );
  });

  it("never runs for a foh session without a delegation link", async () => {
    script([
      { kind: "session", sessionId: "sess_ext", continuationToken: "tok_1" },
      { kind: "done", result: result({ reply: "done" }) },
    ]);

    await run({ session: session(), channel: "foh" });

    expect(mocks.finalizeDelegationOnResume).not.toHaveBeenCalled();
  });

  it("swallows a finalize failure — the drain and run recorder still finish", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.finalizeDelegationOnResume.mockRejectedValueOnce(new Error("db down"));
    script([
      { kind: "session", sessionId: "sess_ext", continuationToken: "tok_1" },
      { kind: "turn", turnId: "turn_2" },
      { kind: "done", result: result({ reply: "ok" }) },
    ]);

    const events = await run({ session: delegated(), channel: "foh" });

    expect(events.at(-1)).toMatchObject({ type: "done", ok: true });
    expect(mocks.recordTurnFinish).toHaveBeenCalled();
    error.mockRestore();
  });

  it("still resolves inbox state when the finalize AND settle interleave (separate trys)", async () => {
    mocks.resolveInboxForSession.mockRejectedValueOnce(new Error("db down"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    script([
      { kind: "session", sessionId: "sess_ext", continuationToken: "tok_1" },
      { kind: "done", result: result({ reply: "ok" }) },
    ]);

    await run({ session: delegated(), channel: "foh" });

    // The inbox settle blew up, but the delegation finalize still ran.
    expect(mocks.finalizeDelegationOnResume).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "completed" }),
    );
    error.mockRestore();
  });
});

/**
 * WS1 — the drain is where "which channel homes this session" turns into "how do we deliver".
 * The row carries the descriptor; the drain adds only the bearer, minted for the deployment
 * resolved for THIS turn (a redeploy rotates the container's baked token).
 */
describe("streamTurnResponse — channel-homed delivery", () => {
  const RESUME_VIA = {
    channel: "github",
    routePath: "/eve/v1/github/harnesst/answer",
    rawToken: "repo:1310524517:issue:7",
    state: { owner: "acme", repo: "widgets", issueNumber: 7 },
  };

  beforeEach(() => {
    process.env.HARNESST_SECRETS_KEY =
      "1f8b16e6a46dd3ac12ef7a328f1ce35c67b5bc8f1acdd76280e3674c3a4f19b2";
  });

  it("hands streamTurn the channel route, the stripped token and a live bearer", async () => {
    script([
      { kind: "session", sessionId: "sess_ext", continuationToken: "tok_1" },
      { kind: "done", result: result({ reply: "ok" }) },
    ]);

    await run({
      session: session({
        externalSessionId: "sess_ext",
        continuationToken: "github:repo:1310524517:issue:7",
        resumeVia: RESUME_VIA,
      } as Partial<PlaygroundSession>),
      channel: "foh",
    });

    const { mintDelegationToken } = await import("~/team/token.server");
    expect(mocks.streamTurn.mock.calls[0][0]).toMatchObject({
      deliverVia: {
        routePath: "/eve/v1/github/harnesst/answer",
        rawToken: "repo:1310524517:issue:7",
        state: RESUME_VIA.state,
        // Minted for the target of this turn, not for whatever deployment parked the question.
        bearer: mintDelegationToken("dep_1"),
      },
    });
  });

  it("leaves an ordinary session on the unchanged HTTP path", async () => {
    script([
      { kind: "session", sessionId: "sess_ext", continuationToken: "tok_1" },
      { kind: "done", result: result({ reply: "ok" }) },
    ]);

    await run({ session: session(), channel: "foh" });

    expect(mocks.streamTurn.mock.calls[0][0].deliverVia).toBeNull();
    // HTTP-homed rows keep the route-level supersede — the drain never re-begins the turn.
    expect(mocks.beginFohTurn).not.toHaveBeenCalled();
  });

  it("resolves the park only when the first event proves delivery (issue #282 deferred begin)", async () => {
    script([
      { kind: "session", sessionId: "sess_ext", continuationToken: "tok_1" },
      { kind: "done", result: result({ reply: "ok" }) },
    ]);

    await run({
      session: session({
        externalSessionId: "sess_ext",
        continuationToken: "github:repo:1310524517:issue:7",
        pendingInputAt: new Date(),
        resumeVia: RESUME_VIA,
      } as Partial<PlaygroundSession>),
      channel: "foh",
    });

    // The route no longer clears the park pre-delivery for channel-homed rows; the drain
    // does it exactly once, on the first streamed event from the agent.
    expect(mocks.beginFohTurn).toHaveBeenCalledTimes(1);
    expect(mocks.beginFohTurn).toHaveBeenCalledWith("ps_1");
  });

  it("fails the turn instead of falling back to HTTP when the bearer cannot be minted", async () => {
    // The HTTP session route CANNOT resolve a channel-homed continuation token — it answers 500
    // "the target session was not found via continuation token". Quietly degrading to it turned a
    // missing server key into an unexplained agent error, so the drain now stops and says so.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.HARNESST_SECRETS_KEY;
    script([
      { kind: "session", sessionId: "sess_ext", continuationToken: "tok_1" },
      { kind: "done", result: result({ reply: "ok" }) },
    ]);

    const events = await run({
      session: session({ resumeVia: RESUME_VIA } as Partial<PlaygroundSession>),
      channel: "foh",
    });

    // Nothing was sent anywhere.
    expect(mocks.streamTurn).not.toHaveBeenCalled();
    const done = events.at(-1) as Record<string, unknown>;
    expect(done).toMatchObject({ type: "done", ok: false });
    expect(String(done.error)).toContain("HARNESST_SECRETS_KEY");
    // The row is left bound — the thread is still alive, only this server is misconfigured.
    expect(mocks.clearSessionHandles).not.toHaveBeenCalled();
    // Issue #282: nothing was sent, so nothing settles — the claim is released (status put
    // back, no cursor movement, no lastEventAt bump) and the park state stays untouched.
    expect(mocks.releaseRefusedTurnClaim).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ps_1", status: "waiting" }),
    );
    expect(mocks.savePlaygroundSessionCursor).not.toHaveBeenCalled();
    expect(mocks.clearSessionPendingInput).not.toHaveBeenCalled();
    expect(mocks.resolveInboxForSession).not.toHaveBeenCalled();
    expect(mocks.beginFohTurn).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("clears the handles when the channel reports the resume handle is spent", async () => {
    // A 409 `session_gone` means the eve session this row resumes into is gone. Leaving the
    // descriptor in place would fail every future message the same way; clearing the handles
    // lets the NEXT one start a fresh HTTP-homed session.
    script([
      {
        kind: "done",
        result: result({ ok: false, error: "redeployed", resumeExpired: true }),
      },
    ]);

    const row = session({
      externalSessionId: "sess_ext",
      continuationToken: "github:repo:1310524517:issue:7",
      resumeVia: RESUME_VIA,
    } as Partial<PlaygroundSession>);
    await run({ session: row, channel: "foh" });

    expect(mocks.clearSessionHandles).toHaveBeenCalledWith("ps_1");
  });

  it("keeps the descriptor for an ordinary channel delivery failure", async () => {
    script([
      { kind: "done", result: result({ ok: false, error: "github 502" }) },
    ]);

    await run({
      session: session({
        externalSessionId: "sess_ext",
        continuationToken: "github:repo:1310524517:issue:7",
        resumeVia: RESUME_VIA,
      } as Partial<PlaygroundSession>),
      channel: "foh",
    });

    expect(mocks.clearSessionHandles).not.toHaveBeenCalled();
  });

  it("a refused send leaves session status, cursor, and pending flag unchanged (issue #282)", async () => {
    // The `talk.server.ts` guard refused the send before contacting the agent (`notDelivered`).
    // Eve is still parked on its question, so the drain must not settle anything: no `failed`
    // status, no cursor/handle movement, no needs-you clear, no inbox resolve, no run recording.
    // The one write releases the claim back to the caller's pre-claim status.
    const row = session({
      externalSessionId: "sess_ext",
      continuationToken: "github:repo:1310524517:issue:7",
      streamIndex: 12,
      pendingInputAt: new Date(),
      resumeVia: RESUME_VIA,
    } as Partial<PlaygroundSession>);
    script([
      {
        kind: "done",
        result: result({
          ok: false,
          error: "refused before delivery",
          turnId: null,
          continuationToken: "github:repo:1310524517:issue:7",
          streamIndex: 12,
          notDelivered: true,
        }),
      },
    ]);

    const events = await readAll(
      streamTurnResponse({
        projectId: "proj_1",
        target: TARGET,
        session: row,
        message: "actually, use develop",
        channel: "foh",
        title: null,
        claimId: "claim_1",
        preClaimStatus: "waiting",
      }),
    );

    // The client is still told what happened.
    expect(events.at(-1)).toMatchObject({ type: "done", ok: false });
    // Exactly one row write: the claim release, restoring the caller's pre-claim status.
    expect(mocks.releaseRefusedTurnClaim).toHaveBeenCalledTimes(1);
    expect(mocks.releaseRefusedTurnClaim).toHaveBeenCalledWith({
      id: "ps_1",
      claimId: "claim_1",
      status: "waiting",
    });
    expect(mocks.savePlaygroundSessionCursor).not.toHaveBeenCalled();
    // The park state, inbox, transcript cache, recorder, and resume binding are untouched —
    // and the deferred channel-homed turn-begin never fired (no event proved delivery).
    expect(mocks.beginFohTurn).not.toHaveBeenCalled();
    expect(mocks.clearSessionPendingInput).not.toHaveBeenCalled();
    expect(mocks.markSessionPendingInput).not.toHaveBeenCalled();
    expect(mocks.resolveInboxForSession).not.toHaveBeenCalled();
    expect(mocks.recordInboxFinished).not.toHaveBeenCalled();
    expect(mocks.savePlaygroundSessionProgress).not.toHaveBeenCalled();
    expect(mocks.recordTurnStart).not.toHaveBeenCalled();
    expect(mocks.recordTurnFinish).not.toHaveBeenCalled();
    expect(mocks.clearSessionHandles).not.toHaveBeenCalled();
  });

  it("a refused send never finalizes a waiting delegation (issue #282)", async () => {
    script([
      {
        kind: "done",
        result: result({
          ok: false,
          error: "refused before delivery",
          turnId: null,
          notDelivered: true,
        }),
      },
    ]);

    await run({
      session: session({
        createdBy: null,
        delegationId: "deleg_1",
        openedByAgentId: "agent_1",
        externalSessionId: "sess_ext",
        continuationToken: "github:repo:1310524517:issue:7",
        resumeVia: RESUME_VIA,
      } as Partial<PlaygroundSession>),
      channel: "foh",
    });

    expect(mocks.finalizeDelegationOnResume).not.toHaveBeenCalled();
  });

  it("an ordinary failed turn still settles as failed (the #282 carve-out is narrow)", async () => {
    script([
      { kind: "session", sessionId: "sess_ext", continuationToken: "tok_1" },
      { kind: "done", result: result({ ok: false, error: "boom" }) },
    ]);

    await run({ session: session(), channel: "foh" });

    expect(mocks.savePlaygroundSessionCursor).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ps_1", status: "failed" }),
    );
    expect(mocks.clearSessionPendingInput).toHaveBeenCalledWith("ps_1");
    expect(mocks.resolveInboxForSession).toHaveBeenCalledWith("ps_1");
  });

  it("succession runs as a first-turn HTTP send and rebinds atomically on the session event (#288 3b)", async () => {
    // The row is still channel-homed with the PREDECESSOR's handles; the succession flag —
    // not a pre-cleared row — is what makes the drain start a fresh eve session. No bearer
    // is minted for it, so a missing key must not refuse the send (delete it to prove so).
    delete process.env.HARNESST_SECRETS_KEY;
    const row = session({
      externalSessionId: "sess_old",
      continuationToken: "github:repo:1310524517:issue:7",
      streamIndex: 6,
      resumeVia: RESUME_VIA,
    } as Partial<PlaygroundSession>);
    script([
      { kind: "session", sessionId: "sess_new", continuationToken: "tok_new" },
      { kind: "turn", turnId: "turn_0" },
      {
        kind: "done",
        result: result({
          sessionId: "sess_new",
          continuationToken: "tok_new",
          streamIndex: 3,
          turnId: "turn_0",
          reply: "Picking this up here.",
        }),
      },
    ]);

    await readAll(
      streamTurnResponse({
        projectId: "proj_1",
        target: TARGET,
        session: row,
        message: "let's continue here",
        channel: "foh",
        title: null,
        claimId: "claim_1",
        succession: true,
      }),
    );

    // First-turn POST: no session id, no continuation token, no channel delivery, cursor 0 —
    // and no bearer was ever needed (HARNESST_SECRETS_KEY is irrelevant to a succession).
    expect(mocks.streamTurn.mock.calls[0][0]).toMatchObject({
      sessionId: null,
      continuationToken: null,
      deliverVia: null,
      streamIndex: 0,
    });
    // The one atomic rebind: predecessor pointer + successor handles + descriptor drop +
    // cursor reset, fenced by the route's claim.
    expect(mocks.bindSuccessorSessionHandles).toHaveBeenCalledTimes(1);
    expect(mocks.bindSuccessorSessionHandles).toHaveBeenCalledWith({
      id: "ps_1",
      target: TARGET,
      externalSessionId: "sess_new",
      continuationToken: "tok_new",
      claimId: "claim_1",
    });
    expect(mocks.clearSessionHandles).not.toHaveBeenCalled();
    // The terminal save carries the SUCCESSOR's cursor, never the predecessor's.
    expect(mocks.savePlaygroundSessionCursor).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "ps_1",
        externalSessionId: "sess_new",
        continuationToken: "tok_new",
        streamIndex: 3,
        status: "waiting",
        claimId: "claim_1",
      }),
    );
  });

  it("a succession that fails before the session event leaves the predecessor fully bound", async () => {
    const row = session({
      externalSessionId: "sess_old",
      continuationToken: "github:repo:1310524517:issue:7",
      streamIndex: 6,
      resumeVia: RESUME_VIA,
    } as Partial<PlaygroundSession>);
    // The successor's first POST died before eve created anything: no session event, no ids.
    script([
      {
        kind: "done",
        result: result({
          ok: false,
          sessionId: null,
          continuationToken: null,
          streamIndex: 0,
          turnId: null,
          error: "fetch failed: connect ECONNREFUSED",
        }),
      },
    ]);

    await readAll(
      streamTurnResponse({
        projectId: "proj_1",
        target: TARGET,
        session: row,
        message: "let's continue here",
        channel: "foh",
        title: null,
        claimId: "claim_1",
        succession: true,
      }),
    );

    // Nothing rebound, nothing cleared: the row keeps the predecessor's handles, descriptor,
    // and cursor — a retry re-runs the succession with the prologue intact.
    expect(mocks.bindSuccessorSessionHandles).not.toHaveBeenCalled();
    expect(mocks.clearSessionHandles).not.toHaveBeenCalled();
    expect(mocks.savePlaygroundSessionProgress).not.toHaveBeenCalled();
    expect(mocks.savePlaygroundSessionCursor).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "ps_1",
        externalSessionId: "sess_old",
        continuationToken: "github:repo:1310524517:issue:7",
        streamIndex: 6,
        status: "failed",
      }),
    );
  });

  it("suppresses every successor-handle write when the rebind itself fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.bindSuccessorSessionHandles.mockRejectedValueOnce(
      new Error("db down") as never,
    );
    const row = session({
      externalSessionId: "sess_old",
      continuationToken: "github:repo:1310524517:issue:7",
      streamIndex: 6,
      resumeVia: RESUME_VIA,
    } as Partial<PlaygroundSession>);
    script([
      { kind: "session", sessionId: "sess_new", continuationToken: "tok_new" },
      { kind: "turn", turnId: "turn_0" },
      {
        kind: "done",
        result: result({
          sessionId: "sess_new",
          continuationToken: "tok_new",
          streamIndex: 3,
          turnId: "turn_0",
          reply: "ok",
        }),
      },
    ]);

    await readAll(
      streamTurnResponse({
        projectId: "proj_1",
        target: TARGET,
        session: row,
        message: "let's continue here",
        channel: "foh",
        title: null,
        claimId: "claim_1",
        succession: true,
      }),
    );

    // Half-moved rows are the failure mode this guards: with the rebind lost, no progress
    // or cursor write may leak the successor's handles — the row stays on the predecessor.
    expect(mocks.savePlaygroundSessionProgress).not.toHaveBeenCalled();
    expect(mocks.savePlaygroundSessionCursor).toHaveBeenCalledWith(
      expect.objectContaining({
        externalSessionId: "sess_old",
        continuationToken: "github:repo:1310524517:issue:7",
        streamIndex: 6,
      }),
    );
    error.mockRestore();
  });

  it("survives a handle clear that throws — the cursor save has already happened", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.clearSessionHandles.mockRejectedValueOnce(
      new Error("db down") as never,
    );
    script([
      {
        kind: "done",
        result: result({ ok: false, error: "redeployed", resumeExpired: true }),
      },
    ]);

    const events = await run({
      session: session({
        externalSessionId: "sess_ext",
        continuationToken: "github:repo:1310524517:issue:7",
        resumeVia: RESUME_VIA,
      } as Partial<PlaygroundSession>),
      channel: "foh",
    });

    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(mocks.savePlaygroundSessionCursor).toHaveBeenCalled();
    error.mockRestore();
  });
});
