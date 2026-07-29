import { afterEach, describe, expect, it, vi } from "vitest";

import type { TurnResult } from "~/agent/talk.server";
import { resumeTurnStream, sendTurn } from "~/agent/talk.server";

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
