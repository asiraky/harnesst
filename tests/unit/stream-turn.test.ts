import { afterEach, describe, expect, it, vi } from "vitest";

import { dispatchTurn, streamTurn, type TalkEvent } from "~/agent/talk.server";

/** Emit the events as one NDJSON body (the eve stream shape). */
function streamResponse(events: unknown[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          events.map((event) => JSON.stringify(event)).join("\n") + "\n",
        ),
      );
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}

function sessionStart(): Response {
  return new Response(JSON.stringify({ continuationToken: "tok_1" }), {
    status: 202,
    headers: {
      "content-type": "application/json",
      "x-eve-session-id": "sess_1",
    },
  });
}

async function drain(events: unknown[], message = "hi"): Promise<TalkEvent[]> {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(sessionStart())
    .mockResolvedValueOnce(streamResponse(events));
  vi.stubGlobal("fetch", fetchMock);
  const out: TalkEvent[] = [];
  for await (const event of streamTurn({
    baseUrl: "https://agent.example.test",
    message,
  })) {
    out.push(event);
  }
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streamTurn", () => {
  it("emits events in order with cumulative reply text, ending in done", async () => {
    const at = new Date().toISOString();
    const out = await drain([
      {
        type: "session.started",
        data: { runtime: { modelId: "m/x" } },
        meta: { at },
      },
      {
        type: "message.received",
        data: { message: "hi", turnId: "turn_1" },
        meta: { at },
      },
      {
        type: "step.started",
        data: { turnId: "turn_1", sequence: 1, stepIndex: 0 },
        meta: { at },
      },
      {
        type: "message.appended",
        data: { turnId: "turn_1", messageSoFar: "Hel" },
        meta: { at },
      },
      {
        type: "message.appended",
        data: { turnId: "turn_1", messageSoFar: "Hello" },
        meta: { at },
      },
      {
        type: "message.completed",
        data: { turnId: "turn_1", message: "Hello" },
        meta: { at },
      },
      {
        type: "step.completed",
        data: {
          turnId: "turn_1",
          sequence: 1,
          stepIndex: 0,
          usage: { inputTokens: 5, outputTokens: 3 },
        },
        meta: { at },
      },
      { type: "turn.completed", data: { turnId: "turn_1" }, meta: { at } },
    ]);

    const kinds = out.map((e) => e.kind);
    expect(kinds[0]).toBe("session");
    expect(kinds).toContain("model");
    expect(kinds).toContain("turn");
    expect(kinds).toContain("thinking");
    expect(kinds).toContain("step");
    expect(kinds[kinds.length - 1]).toBe("done");

    const texts = out.flatMap((e) => (e.kind === "text" ? [e.text] : []));
    expect(texts).toEqual(["Hel", "Hello"]);

    const done = out.at(-1);
    expect(done?.kind === "done" && done.result.reply).toBe("Hello");
    expect(done?.kind === "done" && done.result.ok).toBe(true);
    expect(done?.kind === "done" && done.result.modelId).toBe("m/x");
  });

  it("emits durable cursor progress while consuming Eve events", async () => {
    const at = new Date().toISOString();
    const out = await drain([
      {
        type: "message.received",
        data: { message: "hi", turnId: "turn_1" },
        meta: { at },
      },
      {
        type: "message.completed",
        data: { turnId: "turn_1", message: "hi back" },
        meta: { at },
      },
      { type: "turn.completed", data: { turnId: "turn_1" }, meta: { at } },
    ]);

    const progress = out.flatMap((event) =>
      event.kind === "progress" ? [event] : [],
    );
    expect(progress).toMatchObject([
      { sessionId: "sess_1", continuationToken: "tok_1", streamIndex: 1 },
      { sessionId: "sess_1", continuationToken: "tok_1", streamIndex: 2 },
      { sessionId: "sess_1", continuationToken: "tok_1", streamIndex: 3 },
    ]);
  });

  it("keys step durations on sequence, not the always-zero stepIndex", async () => {
    const t0 = Date.now();
    const iso = (ms: number) => new Date(t0 + ms).toISOString();
    const out = await drain([
      {
        type: "message.received",
        data: { message: "hi", turnId: "turn_1" },
        meta: { at: iso(0) },
      },
      {
        type: "step.started",
        data: { turnId: "turn_1", sequence: 1, stepIndex: 0 },
        meta: { at: iso(0) },
      },
      {
        type: "step.completed",
        data: { turnId: "turn_1", sequence: 1, stepIndex: 0 },
        meta: { at: iso(1000) },
      },
      {
        type: "step.started",
        data: { turnId: "turn_1", sequence: 2, stepIndex: 0 },
        meta: { at: iso(2000) },
      },
      {
        type: "step.completed",
        data: { turnId: "turn_1", sequence: 2, stepIndex: 0 },
        meta: { at: iso(3000) },
      },
      {
        type: "message.completed",
        data: { turnId: "turn_1", message: "ok" },
        meta: { at: iso(3000) },
      },
      {
        type: "turn.completed",
        data: { turnId: "turn_1" },
        meta: { at: iso(3000) },
      },
    ]);

    const done = out.at(-1);
    const steps = done?.kind === "done" ? done.result.steps : [];
    expect(steps).toHaveLength(2);
    expect(steps[0].durationMs).toBe(1000);
    expect(steps[1].durationMs).toBe(1000);
  });

  it("correlates actions to their step, including a failed action", async () => {
    const at = new Date().toISOString();
    const out = await drain([
      {
        type: "message.received",
        data: { message: "hi", turnId: "turn_1" },
        meta: { at },
      },
      {
        type: "step.started",
        data: { turnId: "turn_1", sequence: 1 },
        meta: { at },
      },
      {
        type: "actions.requested",
        data: {
          turnId: "turn_1",
          sequence: 1,
          actions: [
            {
              callId: "c1",
              toolName: "bash",
              input: { command: "npm test" },
              kind: "tool-call",
            },
            {
              callId: "c2",
              toolName: "read_file",
              input: { path: "/etc/x" },
              kind: "tool-call",
            },
          ],
        },
        meta: { at },
      },
      {
        type: "action.result",
        data: {
          turnId: "turn_1",
          sequence: 1,
          status: "completed",
          result: { callId: "c1", output: { exitCode: 0, stdout: "ok" } },
        },
        meta: { at },
      },
      {
        type: "action.result",
        data: {
          turnId: "turn_1",
          sequence: 1,
          status: "failed",
          result: { callId: "c2", output: "boom" },
        },
        meta: { at },
      },
      {
        type: "step.completed",
        data: { turnId: "turn_1", sequence: 1 },
        meta: { at },
      },
      {
        type: "message.completed",
        data: { turnId: "turn_1", message: "done" },
        meta: { at },
      },
      { type: "turn.completed", data: { turnId: "turn_1" }, meta: { at } },
    ]);

    const done = out.at(-1);
    const step = done?.kind === "done" ? done.result.steps[0] : undefined;
    expect(step?.toolName).toBe("bash");
    expect(step?.summary).toBe("npm test");
    expect(step?.actions).toMatchObject([
      { toolName: "bash", summary: "npm test", exitCode: 0, isError: false },
      { toolName: "read_file", summary: "/etc/x", isError: true },
    ]);

    // The live activity stream carries each requested action.
    const actions = out.flatMap((e) =>
      e.kind === "action" ? [`${e.toolName}:${e.summary}`] : [],
    );
    expect(actions).toEqual(["bash:npm test", "read_file:/etc/x"]);
  });

  it("keeps every assistant message of the turn and surfaces ask_question prompts", async () => {
    const at = new Date().toISOString();
    const out = await drain([
      {
        type: "message.received",
        data: { message: "hi", turnId: "turn_1" },
        meta: { at },
      },
      {
        type: "message.completed",
        data: { turnId: "turn_1", message: "Checking access." },
        meta: { at },
      },
      {
        type: "step.started",
        data: { turnId: "turn_1", sequence: 1 },
        meta: { at },
      },
      {
        type: "step.completed",
        data: { turnId: "turn_1", sequence: 1 },
        meta: { at },
      },
      {
        type: "message.appended",
        data: { turnId: "turn_1", messageSoFar: "One decision for you:" },
        meta: { at },
      },
      {
        type: "message.completed",
        data: { turnId: "turn_1", message: "One decision for you:" },
        meta: { at },
      },
      {
        type: "input.requested",
        data: {
          turnId: "turn_1",
          requests: [
            {
              requestId: "r1",
              display: "select",
              prompt: "Merge now or wait for review?",
              options: [
                { id: "merge", label: "Merge now", style: "primary" },
                { id: "wait", label: "Wait for review" },
              ],
              allowFreeform: true,
              action: {
                callId: "r1",
                kind: "tool-call",
                toolName: "ask_question",
                input: { prompt: "Merge now or wait for review?" },
              },
            },
          ],
        },
        meta: { at },
      },
      { type: "turn.completed", data: { turnId: "turn_1" }, meta: { at } },
    ]);

    // Later messages never clobber earlier ones — the live text is cumulative across
    // the turn's messages.
    const texts = out.flatMap((e) => (e.kind === "text" ? [e.text] : []));
    expect(texts.at(-1)).toBe("Checking access.\n\nOne decision for you:");

    const inputEvent = out.find((e) => e.kind === "input");
    expect(inputEvent?.kind === "input" && inputEvent.requests).toMatchObject([
      {
        requestId: "r1",
        prompt: "Merge now or wait for review?",
        display: "select",
        allowFreeform: true,
        options: [
          { id: "merge", label: "Merge now", style: "primary" },
          { id: "wait", label: "Wait for review" },
        ],
      },
    ]);

    const done = out.at(-1);
    expect(done?.kind === "done" && done.result.reply).toBe(
      "Checking access.\n\nOne decision for you:",
    );
    expect(done?.kind === "done" && done.result.inputRequests).toMatchObject([
      { requestId: "r1", display: "select" },
    ]);
    expect(done?.kind === "done" && done.result.ok).toBe(true);
  });

  it("surfaces the eve turnId on the turn event and the result", async () => {
    const at = new Date().toISOString();
    const out = await drain([
      {
        type: "message.received",
        data: { message: "hi", turnId: "turn_1" },
        meta: { at },
      },
      {
        type: "message.completed",
        data: { turnId: "turn_1", message: "hi back" },
        meta: { at },
      },
      { type: "turn.completed", data: { turnId: "turn_1" }, meta: { at } },
    ]);
    const turn = out.find((e) => e.kind === "turn");
    expect(turn?.kind === "turn" && turn.turnId).toBe("turn_1");
    const done = out.at(-1);
    expect(done?.kind === "done" && done.result.turnId).toBe("turn_1");
  });

  it("skips replayed history and attributes only our turn", async () => {
    const now = Date.now();
    const old = new Date(now - 5 * 60_000).toISOString(); // well before postedAt
    const fresh = new Date(now).toISOString();
    const out = await drain([
      // Replayed previous turn — same text, but old, and a different turnId.
      {
        type: "message.received",
        data: { message: "hi", turnId: "turn_0" },
        meta: { at: old },
      },
      {
        type: "step.completed",
        data: { turnId: "turn_0", sequence: 1 },
        meta: { at: old },
      },
      { type: "turn.completed", data: { turnId: "turn_0" }, meta: { at: old } },
      // Our turn.
      {
        type: "message.received",
        data: { message: "hi", turnId: "turn_1" },
        meta: { at: fresh },
      },
      {
        type: "step.completed",
        data: { turnId: "turn_1", sequence: 1 },
        meta: { at: fresh },
      },
      {
        type: "message.completed",
        data: { turnId: "turn_1", message: "our reply" },
        meta: { at: fresh },
      },
      {
        type: "turn.completed",
        data: { turnId: "turn_1" },
        meta: { at: fresh },
      },
    ]);

    const done = out.at(-1);
    expect(done?.kind === "done" && done.result.turnId).toBe("turn_1");
    expect(done?.kind === "done" && done.result.reply).toBe("our reply");
    // Only our turn's single step counts — the replayed turn_0 step is ignored.
    expect(done?.kind === "done" && done.result.steps).toHaveLength(1);
  });

  it("resolves a dynamic-model agent's modelId to the fallback when no directive is sent", async () => {
    const at = new Date().toISOString();
    const out = await drain([
      {
        type: "session.started",
        data: { runtime: { modelId: "dynamic:anthropic/claude-sonnet-5" } },
        meta: { at },
      },
      {
        type: "message.received",
        data: { message: "hi", turnId: "turn_1" },
        meta: { at },
      },
      {
        type: "message.completed",
        data: { turnId: "turn_1", message: "Hello" },
        meta: { at },
      },
      { type: "turn.completed", data: { turnId: "turn_1" }, meta: { at } },
    ]);

    const model = out.find((e) => e.kind === "model");
    expect(model?.kind === "model" && model.modelId).toBe(
      "anthropic/claude-sonnet-5",
    );
    const done = out.at(-1);
    expect(done?.kind === "done" && done.result.modelId).toBe(
      "anthropic/claude-sonnet-5",
    );
  });

  it("resolves a dynamic-model agent's modelId to the sent model directive", async () => {
    const at = new Date().toISOString();
    const sent = "<!-- harnesst:model openai/gpt-5.1 ctx=400000 -->\n\nwhat model are you?";
    const out = await drain(
      [
        {
          type: "session.started",
          data: { runtime: { modelId: "dynamic:anthropic/claude-sonnet-5" } },
          meta: { at },
        },
        {
          // Eve echoes the full SENT message — directive included — and matching still works.
          type: "message.received",
          data: { message: sent, turnId: "turn_1" },
          meta: { at },
        },
        {
          type: "message.completed",
          data: { turnId: "turn_1", message: "gpt-5.1 here" },
          meta: { at },
        },
        { type: "turn.completed", data: { turnId: "turn_1" }, meta: { at } },
      ],
      sent,
    );

    const model = out.find((e) => e.kind === "model");
    expect(model?.kind === "model" && model.modelId).toBe("openai/gpt-5.1");
    const done = out.at(-1);
    expect(done?.kind === "done" && done.result.reply).toBe("gpt-5.1 here");
    expect(done?.kind === "done" && done.result.modelId).toBe("openai/gpt-5.1");
  });

  it("ships inputResponses in the follow-up POST body (and never on a first turn)", async () => {
    const responses = [{ requestId: "req_1", optionId: "approve" }];

    // Follow-up: session + continuation token present → the body carries the responses.
    let fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionStart())
      .mockResolvedValueOnce(streamResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    for await (const _ of streamTurn({
      baseUrl: "https://agent.example.test",
      message: "Approve",
      sessionId: "sess_1",
      continuationToken: "tok_1",
      inputResponses: responses,
    })) {
      // drain
    }
    let body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.inputResponses).toEqual(responses);
    expect(body.continuationToken).toBe("tok_1");

    // First turn: nothing pending can exist — responses must not be sent.
    fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionStart())
      .mockResolvedValueOnce(streamResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    for await (const _ of streamTurn({
      baseUrl: "https://agent.example.test",
      message: "Approve",
      inputResponses: responses,
    })) {
      // drain
    }
    body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.inputResponses).toBeUndefined();
  });

  it("marks an HTTP answer batch undelivered when eve rejects it before acceptance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(
        new Response("unavailable", { status: 503 }),
      ),
    );

    const events = [];
    for await (const event of streamTurn({
      baseUrl: "https://agent.example.test",
      message: "Approve",
      sessionId: "sess_1",
      continuationToken: "tok_1",
      inputResponses: [{ requestId: "req_1", optionId: "approve" }],
    })) {
      events.push(event);
    }

    const done = events.at(-1);
    expect(done?.kind).toBe("done");
    if (done?.kind !== "done") throw new Error("no done event");
    expect(done.result.notDelivered).toBe(true);
    expect(done.result.sessionId).toBe("sess_1");
  });
});

describe("dispatchTurn (#269 fire-and-forget)", () => {
  const at = new Date().toISOString();

  it("returns the session and turn ids as soon as the turn is identified", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionStart())
      .mockResolvedValueOnce(
        streamResponse([
          { type: "session.started", data: {}, meta: { at } },
          {
            type: "message.received",
            data: { message: "go", turnId: "turn_0" },
            meta: { at },
          },
          // Everything past the turn id must be irrelevant — the watch stops there.
          { type: "step.started", data: { turnId: "turn_0" }, meta: { at } },
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const out = await dispatchTurn({
      baseUrl: "https://agent.example.test",
      message: "go",
    });
    expect(out).toEqual({
      sessionId: "sess_1",
      continuationToken: "tok_1",
      turnId: "turn_0",
      streamIndex: 2,
      error: null,
    });
  });

  it("fails with an error when the POST is refused (nothing is running)", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response("nope", { status: 503 })),
    );
    const out = await dispatchTurn({
      baseUrl: "https://agent.example.test",
      message: "go",
    });
    expect(out.sessionId).toBeNull();
    expect(out.error).toContain("503");
  });

  it("still counts as dispatched when the stream dies after the POST was accepted", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionStart())
      .mockRejectedValueOnce(new Error("socket hang up"));
    vi.stubGlobal("fetch", fetchMock);
    const out = await dispatchTurn({
      baseUrl: "https://agent.example.test",
      message: "go",
    });
    // The POST landed — the turn is running; only the short turn-id watch failed.
    expect(out.sessionId).toBe("sess_1");
    expect(out.turnId).toBeNull();
    expect(out.error).toBeNull();
  });
});
