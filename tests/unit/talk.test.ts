import { afterEach, describe, expect, it, vi } from "vitest";

import type { TalkEvent, TurnResult } from "~/agent/talk.server";
import { resumeTurnStream, sendTurn, streamTurn } from "~/agent/talk.server";

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendTurn", () => {
  it("starts an isolated conversation through the private workspace route", async () => {
    const at = new Date().toISOString();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ continuationToken: "harnesst-workspace:tok_1" }),
          {
            status: 202,
            headers: {
              "content-type": "application/json",
              "x-eve-session-id": "sess_1",
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        streamResponse([
          {
            type: "message.received",
            data: { message: "hi", turnId: "turn_1" },
            meta: { at },
          },
          { type: "turn.completed", data: { turnId: "turn_1" }, meta: { at } },
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendTurn({
      baseUrl: "https://agent.example.test",
      message: "hi",
      workspace: { id: "ps_private", bearer: "deployment-token" },
    });

    expect(result.ok).toBe(true);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://agent.example.test/harnesst/v1/session",
    );
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      method: "POST",
      headers: {
        authorization: "Bearer deployment-token",
        "x-harnesst-workspace-id": "ps_private",
      },
    });
    expect(String(fetchMock.mock.calls[1]![0])).toBe(
      "https://agent.example.test/eve/v1/session/sess_1/stream",
    );
  });

  it("preserves provider failure details from failed steps", async () => {
    const at = new Date().toISOString();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ continuationToken: "tok_1" }), {
          status: 202,
          headers: {
            "content-type": "application/json",
            "x-eve-session-id": "sess_1",
          },
        }),
      )
      .mockResolvedValueOnce(
        streamResponse([
          {
            type: "session.started",
            data: { runtime: { modelId: "openrouter/z-ai/glm-5.2" } },
            meta: { at },
          },
          {
            type: "message.received",
            data: { message: "hi", turnId: "turn_1" },
            meta: { at },
          },
          {
            type: "step.started",
            data: { turnId: "turn_1", stepIndex: 0 },
            meta: { at },
          },
          {
            type: "step.failed",
            data: {
              turnId: "turn_1",
              stepIndex: 0,
              message: "Unable to make request: TypeError: fetch failed",
              code: "AI_APICallError",
              details: {
                cause: {
                  code: "ENOTFOUND",
                  hostname: "openrouter.ai",
                },
              },
            },
            meta: { at },
          },
          {
            type: "turn.failed",
            data: {
              turnId: "turn_1",
              message: "Unable to make request: TypeError: fetch failed",
            },
            meta: { at },
          },
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendTurn({
      baseUrl: "https://agent.example.test",
      message: "hi",
    });

    expect(result.ok).toBe(false);
    expect(result.modelId).toBe("openrouter/z-ai/glm-5.2");
    expect(result.error).toContain("Unable to make request");
    expect(result.error).toContain("Code: AI_APICallError");
    expect(result.error).toContain('"hostname": "openrouter.ai"');
    expect(result.steps).toMatchObject([
      {
        type: "step.failed",
        isError: true,
        code: "AI_APICallError",
        message: "Unable to make request: TypeError: fetch failed",
      },
    ]);
    expect(result.steps[0]?.details).toContain("ENOTFOUND");
  });

  /**
   * #267 defect 2: transport failure must be distinguishable from agent failure by a TYPE, not
   * by matching the free-text error message.
   */
  it("marks a stream that ends before the turn does as streamLost", async () => {
    const at = new Date().toISOString();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ continuationToken: "tok_1" }), {
          status: 202,
          headers: {
            "content-type": "application/json",
            "x-eve-session-id": "sess_1",
          },
        }),
      )
      .mockResolvedValueOnce(
        streamResponse([
          {
            type: "message.received",
            data: { message: "hi", turnId: "turn_1" },
            meta: { at },
          },
          {
            type: "step.started",
            data: { turnId: "turn_1", sequence: 0 },
            meta: { at },
          },
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendTurn({
      baseUrl: "https://agent.example.test",
      message: "hi",
    });

    expect(result.ok).toBe(false);
    expect(result.streamLost).toBe(true);
    expect(result.error).toContain("ended before the turn completed");
    // The handles the reattach needs to pick the turn back up.
    expect(result.sessionId).toBe("sess_1");
    expect(result.turnId).toBe("turn_1");
    expect(result.streamIndex).toBe(2);
  });

  /**
   * The subtle half of the same defect: a turn can complete an assistant message and then keep
   * working with tools. A partial reply plus no terminal event is still a lost stream — reading it
   * as a finished turn is how a delegation gets closed `completed` while the peer works on.
   */
  it("marks a stream that dropped after a partial reply as streamLost", async () => {
    const at = new Date().toISOString();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ continuationToken: "tok_1" }), {
          status: 202,
          headers: {
            "content-type": "application/json",
            "x-eve-session-id": "sess_1",
          },
        }),
      )
      .mockResolvedValueOnce(
        streamResponse([
          {
            type: "message.received",
            data: { message: "hi", turnId: "turn_1" },
            meta: { at },
          },
          {
            type: "message.completed",
            data: {
              turnId: "turn_1",
              message: "Working on it — opening a PR.",
            },
            meta: { at },
          },
          {
            type: "step.started",
            data: { turnId: "turn_1", sequence: 1 },
            meta: { at },
          },
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendTurn({
      baseUrl: "https://agent.example.test",
      message: "hi",
    });

    expect(result.streamLost).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.reply).toBe("Working on it — opening a PR.");
  });

  /**
   * A turn that already asked for input has parked itself — the outcome is known and complete, so a
   * socket dying afterwards costs nothing. Calling that a lost stream would hand the turn off to a
   * watcher that can only sit there until the ceiling fails it, with the question already in hand.
   */
  it("treats a socket death after a question as a park, not a lost stream", async () => {
    const at = new Date().toISOString();
    let delivered = false;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ continuationToken: "tok_1" }), {
          status: 202,
          headers: {
            "content-type": "application/json",
            "x-eve-session-id": "sess_1",
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            // Delivered on the first read, dead on the second — `controller.error()` in `start`
            // would discard the queued chunk and never hand the question over at all.
            pull(controller) {
              if (delivered) {
                // ...the socket resets before `session.waiting` arrives.
                controller.error(new Error("terminated"));
                return;
              }
              delivered = true;
              controller.enqueue(
                new TextEncoder().encode(
                  [
                    JSON.stringify({
                      type: "message.received",
                      data: { message: "hi", turnId: "turn_1" },
                      meta: { at },
                    }),
                    JSON.stringify({
                      type: "input.requested",
                      data: {
                        turnId: "turn_1",
                        requests: [{ requestId: "req_1", prompt: "Merge it?" }],
                      },
                      meta: { at },
                    }),
                  ].join("\n") + "\n",
                ),
              );
            },
          }),
          { status: 200, headers: { "content-type": "application/x-ndjson" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendTurn({
      baseUrl: "https://agent.example.test",
      message: "hi",
    });

    expect(result.streamLost).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.inputRequests).toMatchObject([
      { requestId: "req_1", prompt: "Merge it?" },
    ]);
  });

  it("does NOT mark a genuine agent failure as streamLost", async () => {
    const at = new Date().toISOString();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ continuationToken: "tok_1" }), {
          status: 202,
          headers: {
            "content-type": "application/json",
            "x-eve-session-id": "sess_1",
          },
        }),
      )
      .mockResolvedValueOnce(
        streamResponse([
          {
            type: "message.received",
            data: { message: "hi", turnId: "turn_1" },
            meta: { at },
          },
          {
            type: "turn.failed",
            data: { turnId: "turn_1", message: "The model refused." },
            meta: { at },
          },
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendTurn({
      baseUrl: "https://agent.example.test",
      message: "hi",
    });

    expect(result.ok).toBe(false);
    expect(result.streamLost).toBeUndefined();
  });
});

describe("resumeTurnStream", () => {
  it("picks a running turn back up from a cursor and settles it", async () => {
    const at = new Date().toISOString();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      streamResponse([
        {
          type: "input.requested",
          data: {
            turnId: "turn_1",
            requests: [{ requestId: "req_1", prompt: "Merge it?" }],
          },
          meta: { at },
        },
        { type: "session.waiting", data: { turnId: "turn_1" }, meta: { at } },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    let settled: TurnResult | null = null;
    for await (const event of resumeTurnStream({
      baseUrl: "https://agent.example.test/",
      sessionId: "sess_1",
      turnId: "turn_1",
      streamIndex: 12,
    })) {
      if (event.kind === "done") settled = event.result;
    }

    // Nothing is POSTed — the turn is already running; the stream resumes at the cursor.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://agent.example.test/eve/v1/session/sess_1/stream?startIndex=12",
    );
    expect(settled?.streamLost).toBeUndefined();
    expect(settled).toMatchObject({
      ok: true,
      inputRequests: [{ requestId: "req_1", prompt: "Merge it?" }],
      streamIndex: 14,
    });
  });

  it("adopts the turn it finds when the stream broke before the turn id was known", async () => {
    const at = new Date().toISOString();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(
        streamResponse([
          {
            type: "message.received",
            data: { message: "hi", turnId: "turn_7" },
            meta: { at },
          },
          {
            type: "message.completed",
            data: { turnId: "turn_7", message: "All done." },
            meta: { at },
          },
          { type: "turn.completed", data: { turnId: "turn_7" }, meta: { at } },
        ]),
      ),
    );

    let settled: TurnResult | null = null;
    for await (const event of resumeTurnStream({
      baseUrl: "https://agent.example.test",
      sessionId: "sess_1",
      turnId: null,
      streamIndex: 0,
    })) {
      if (event.kind === "done") settled = event.result;
    }

    expect(settled).toMatchObject({
      ok: true,
      turnId: "turn_7",
      reply: "All done.",
    });
  });
});

describe("structured connection recovery from runtime failures", () => {
  it.each(["connection_unavailable", "policy_refusal"])(
    "retains recovery context only for gateway connection failures (%s)",
    async (code) => {
      const model = "codex/abcdefghijkl/pinned";
      const at = new Date().toISOString();
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(
            new Response(JSON.stringify({ continuationToken: "tok_1" }), {
              status: 202,
              headers: {
                "content-type": "application/json",
                "x-eve-session-id": "sess_1",
              },
            }),
          )
          .mockResolvedValueOnce(
            streamResponse([
              {
                type: "message.received",
                data: { message: "hello", turnId: "turn_1" },
                meta: { at },
              },
              {
                type: "step.failed",
                data: {
                  turnId: "turn_1",
                  code: "MODEL_CALL_FAILED",
                  message: "Provider supplied failure",
                  details: {
                    cause: {
                      responseBodySnippet: JSON.stringify({
                        error: {
                          code,
                          model,
                          recoveryUrl: "https://untrusted.invalid",
                        },
                      }),
                    },
                  },
                },
                meta: { at },
              },
              {
                type: "turn.failed",
                data: {
                  turnId: "turn_1",
                  message: "Provider supplied failure",
                },
                meta: { at },
              },
            ]),
          ),
      );
      const result = await sendTurn({
        baseUrl: "https://agent.example.test",
        message: "hello",
      });
      expect(result.ok).toBe(false);
      expect(result.errorModelId).toBe(
        code === "connection_unavailable" ? model : null,
      );
      expect(result.modelId).toBeNull();
    },
  );
});

describe("streamTurn following a lost stream", () => {
  const BASE = "https://agent.example.test";

  /** Routes the turn's POST, stream reads and health probes to per-kind handlers. */
  function fakeEve(handlers: {
    stream: (startIndex: number) => Response | Promise<Response>;
    health?: () => Response | Promise<Response>;
  }) {
    const streamStarts: number[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = new URL(String(url));
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ continuationToken: "tok_1" }), {
          status: 202,
          headers: {
            "content-type": "application/json",
            "x-eve-session-id": "sess_1",
          },
        });
      }
      if (u.pathname.endsWith("/health")) {
        return handlers.health ? handlers.health() : new Response("ok");
      }
      const startIndex = Number(u.searchParams.get("startIndex") ?? 0);
      streamStarts.push(startIndex);
      return handlers.stream(startIndex);
    });
    vi.stubGlobal("fetch", fetchMock);
    return { fetchMock, streamStarts };
  }

  /** A fake clock whose sleeps advance it, so give-up deadlines pass instantly. */
  function fakeClock() {
    let t = 1_000_000;
    return {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
      advance: (ms: number) => {
        t += ms;
      },
    };
  }

  async function run(
    policy: Parameters<typeof streamTurn>[0]["follow"],
    signal?: AbortSignal,
    message = "hi",
  ) {
    const events: TalkEvent[] = [];
    for await (const event of streamTurn({
      baseUrl: BASE,
      message,
      follow: policy,
      signal,
    })) {
      events.push(event);
    }
    const done = events.at(-1);
    if (done?.kind !== "done") throw new Error("no done event");
    return { events, result: done.result };
  }

  it("reattaches at the cursor and settles the turn as one, with nothing from the first stream lost", async () => {
    const at = new Date().toISOString();
    const { streamStarts } = fakeEve({
      stream: (startIndex) =>
        startIndex === 0
          ? // The first stream drops mid-turn: a message done, a tool call requested, no end.
            streamResponse([
              {
                type: "message.received",
                data: { message: "hi", turnId: "t1" },
                meta: { at },
              },
              {
                type: "message.completed",
                data: { turnId: "t1", message: "Part one" },
                meta: { at },
              },
              {
                type: "step.started",
                data: { turnId: "t1", sequence: 1 },
                meta: { at },
              },
              {
                type: "actions.requested",
                data: {
                  turnId: "t1",
                  sequence: 1,
                  actions: [
                    {
                      toolName: "write_file",
                      callId: "c1",
                      input: { path: "a" },
                    },
                  ],
                },
                meta: { at },
              },
            ])
          : streamResponse([
              {
                type: "step.completed",
                data: { turnId: "t1", sequence: 1 },
                meta: { at },
              },
              {
                type: "message.appended",
                data: { turnId: "t1", messageSoFar: "Part t" },
                meta: { at },
              },
              {
                type: "message.completed",
                data: { turnId: "t1", message: "Part two" },
                meta: { at },
              },
              { type: "turn.completed", data: { turnId: "t1" }, meta: { at } },
            ]),
    });

    const clock = fakeClock();
    const { events, result } = await run({
      sliceMs: 1_000,
      maxSilenceMs: 60_000,
      unreachableMs: 60_000,
      ...clock,
    });

    expect(streamStarts).toEqual([0, 4]);
    expect(result.streamLost).toBeUndefined();
    expect(result).toMatchObject({
      ok: true,
      turnId: "t1",
      reply: "Part one\n\nPart two",
      streamIndex: 8,
      messages: [
        { afterStepIndex: 0, text: "Part one" },
        { afterStepIndex: 1, text: "Part two" },
      ],
    });
    // The step that started before the drop keeps the tool call it made.
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({ toolName: "write_file" });
    // Live text after the reconnect still carries the earlier message.
    const texts = events.flatMap((e) => (e.kind === "text" ? [e.text] : []));
    expect(texts).toContain("Part one\n\nPart t");
    expect(events.filter((e) => e.kind === "done")).toHaveLength(1);
  });

  it("without a follow policy, reports the lost stream as before", async () => {
    const at = new Date().toISOString();
    const { streamStarts } = fakeEve({
      stream: () =>
        streamResponse([
          {
            type: "message.received",
            data: { message: "hi", turnId: "t1" },
            meta: { at },
          },
        ]),
    });
    const { result } = await run(null);
    expect(streamStarts).toEqual([0]);
    expect(result).toMatchObject({ ok: false, streamLost: true, turnId: "t1" });
  });

  it("stops following when the stream moved on without ever showing our message", async () => {
    const at = new Date().toISOString();
    let reads = 0;
    const { streamStarts } = fakeEve({
      stream: () =>
        ++reads === 1
          ? // Someone else's turn, never ours: the echo didn't match.
            streamResponse([
              {
                type: "message.received",
                data: { message: "other", turnId: "t9" },
                meta: { at },
              },
            ])
          : reads > 2
            ? streamResponse([])
            : streamResponse([
                {
                  type: "message.completed",
                  data: { turnId: "t9", message: "Not yours" },
                  meta: { at },
                },
                {
                  type: "turn.completed",
                  data: { turnId: "t9" },
                  meta: { at },
                },
              ]),
    });
    const { result } = await run({
      sliceMs: 1_000,
      maxSilenceMs: 60_000,
      unreachableMs: 60_000,
      ...fakeClock(),
    });
    expect(streamStarts).toEqual([0]);
    expect(result).toMatchObject({ ok: false, streamLost: true, turnId: null });
    expect(result.reply ?? "").not.toContain("Not yours");
  });

  it("keeps matching our message across reconnects until it appears, without adopting another turn", async () => {
    const at = new Date().toISOString();
    let reads = 0;
    const { streamStarts } = fakeEve({
      stream: () =>
        ++reads !== 2
          ? streamResponse([]) // nothing yet (or, past the turn, nothing more)
          : streamResponse([
              {
                type: "message.received",
                data: { message: "other", turnId: "t9" },
                meta: { at },
              },
              {
                type: "message.completed",
                data: { turnId: "t9", message: "Not yours" },
                meta: { at },
              },
              {
                type: "message.received",
                data: { message: "hi", turnId: "t1" },
                meta: { at },
              },
              {
                type: "message.completed",
                data: { turnId: "t1", message: "Yours" },
                meta: { at },
              },
              { type: "turn.completed", data: { turnId: "t1" }, meta: { at } },
            ]),
    });
    const { result } = await run({
      sliceMs: 1_000,
      maxSilenceMs: 60_000,
      unreachableMs: 60_000,
      ...fakeClock(),
    });
    expect(streamStarts).toEqual([0, 0]);
    expect(result).toMatchObject({ ok: true, turnId: "t1", reply: "Yours" });
  });

  it("resolves a dynamic model from the sent message when session.started arrives after a reconnect", async () => {
    const at = new Date().toISOString();
    const message = "<!-- harnesst:model openai/gpt-5.1 -->\n\nhi";
    fakeEve({
      stream: (startIndex) =>
        startIndex === 0
          ? streamResponse([
              {
                type: "message.received",
                data: { message, turnId: "t1" },
                meta: { at },
              },
            ])
          : streamResponse([
              {
                type: "session.started",
                data: {
                  turnId: "t1",
                  runtime: { modelId: "dynamic:anthropic/claude-sonnet-5" },
                },
                meta: { at },
              },
              {
                type: "message.completed",
                data: { turnId: "t1", message: "ok" },
                meta: { at },
              },
              { type: "turn.completed", data: { turnId: "t1" }, meta: { at } },
            ]),
    });
    const { events, result } = await run(
      {
        sliceMs: 1_000,
        maxSilenceMs: 60_000,
        unreachableMs: 60_000,
        ...fakeClock(),
      },
      undefined,
      message,
    );
    expect(result.ok).toBe(true);
    expect(events).toContainEqual({ kind: "model", modelId: "openai/gpt-5.1" });
  });

  it("keeps waiting through silence while the instance answers, then gives up at the silence cap", async () => {
    const at = new Date().toISOString();
    const { streamStarts } = fakeEve({
      stream: (startIndex) =>
        startIndex === 0
          ? streamResponse([
              {
                type: "message.received",
                data: { message: "hi", turnId: "t1" },
                meta: { at },
              },
            ])
          : streamResponse([]),
    });
    const clock = fakeClock();
    const { result } = await run({
      sliceMs: 1_000,
      maxSilenceMs: 10 * 60_000,
      unreachableMs: 60_000,
      ...clock,
    });
    // Many silent reattaches, all at the same cursor, before giving up.
    expect(streamStarts.length).toBeGreaterThan(5);
    expect(new Set(streamStarts.slice(1))).toEqual(new Set([1]));
    expect(result.ok).toBe(false);
    expect(result.streamLost).toBe(true);
    expect(result.error).toMatch(/sent nothing for 10 minutes/);
  });

  it("gives up once the instance has been unreachable for the whole budget", async () => {
    const at = new Date().toISOString();
    fakeEve({
      stream: (startIndex) => {
        if (startIndex === 0)
          return streamResponse([
            {
              type: "message.received",
              data: { message: "hi", turnId: "t1" },
              meta: { at },
            },
          ]);
        throw new TypeError("fetch failed: ECONNREFUSED");
      },
      health: () => {
        throw new TypeError("fetch failed: ECONNREFUSED");
      },
    });
    const clock = fakeClock();
    const { result } = await run({
      sliceMs: 1_000,
      maxSilenceMs: 60 * 60_000,
      unreachableMs: 3 * 60_000,
      ...clock,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/stopped answering/);
  });

  it("a healthy check in between restarts the unreachable budget", async () => {
    const at = new Date().toISOString();
    /** Elapsed fake time until giving up, with health answering only on call `upOnCall`. */
    async function outage(upOnCall: number | null) {
      let healthCalls = 0;
      fakeEve({
        stream: (startIndex) => {
          if (startIndex === 0)
            return streamResponse([
              {
                type: "message.received",
                data: { message: "hi", turnId: "t1" },
                meta: { at },
              },
            ]);
          throw new TypeError("fetch failed");
        },
        health: () => {
          healthCalls += 1;
          if (healthCalls === upOnCall) return new Response("ok");
          throw new TypeError("fetch failed");
        },
      });
      const clock = fakeClock();
      const startedAt = clock.now();
      const { result } = await run({
        sliceMs: 1_000,
        maxSilenceMs: 60 * 60_000,
        unreachableMs: 3 * 60_000,
        ...clock,
      });
      expect(result.error).toMatch(/stopped answering/);
      return clock.now() - startedAt;
    }
    const uninterrupted = await outage(null);
    const interrupted = await outage(6);
    expect(interrupted).toBeGreaterThan(uninterrupted);
  });

  it("stops following when eve refuses the stream (the session is gone)", async () => {
    const at = new Date().toISOString();
    const { streamStarts } = fakeEve({
      stream: (startIndex) =>
        startIndex === 0
          ? streamResponse([
              {
                type: "message.received",
                data: { message: "hi", turnId: "t1" },
                meta: { at },
              },
            ])
          : new Response("not found", { status: 404 }),
    });
    const { result } = await run({
      sliceMs: 1_000,
      maxSilenceMs: 60 * 60_000,
      unreachableMs: 3 * 60_000,
      ...fakeClock(),
    });
    expect(streamStarts).toEqual([0, 1]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/404/);
  });

  it("a stop between reconnects ends the turn as stopped, not lost", async () => {
    const at = new Date().toISOString();
    fakeEve({
      stream: (startIndex) => {
        if (startIndex === 0)
          return streamResponse([
            {
              type: "message.received",
              data: { message: "hi", turnId: "t1" },
              meta: { at },
            },
          ]);
        throw new TypeError("fetch failed");
      },
    });
    const controller = new AbortController();
    const clock = fakeClock();
    const { result } = await run(
      {
        sliceMs: 1_000,
        maxSilenceMs: 60 * 60_000,
        unreachableMs: 3 * 60_000,
        now: clock.now,
        sleep: async (ms) => {
          clock.advance(ms);
          controller.abort();
        },
      },
      controller.signal,
    );
    expect(result.ok).toBe(false);
    expect(result.streamLost).toBeUndefined();
    expect(result.error).toMatch(/stopped/);
  });
});
