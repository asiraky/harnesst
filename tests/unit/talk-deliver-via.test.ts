/**
 * WS1 — the delivery branch in `streamTurn`.
 *
 * A GitHub-homed eve session is owned by the channel that dispatched it. Posting its continuation
 * token to eve's built-in `POST /eve/v1/session/:id` with `inputResponses` fails at runtime with
 * "Cannot deliver inputResponses — the target session was not found via continuation token"
 * (observed as a 500 against a live production instance). So the answer has to go to the
 * channel's own route. These tests pin the three things that make that work and keep working:
 * where the POST goes, that the token is sent RAW (eve's `send()` re-prefixes the namespace),
 * and that the non-channel path is byte-for-byte what it was before.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { streamTurn, type TalkEvent } from "~/agent/talk.server";

const ANSWER_ROUTE = "/eve/v1/github/harnesst/answer";
const STATE = { owner: "acme", repo: "widgets", issueNumber: 7 };

const VIA = {
  routePath: ANSWER_ROUTE,
  rawToken: "repo:1310524517:issue:7",
  state: STATE,
  bearer: "ednt_dep_1.sig",
};

function streamResponse(events: unknown[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(events.map((e) => JSON.stringify(e)).join("\n") + "\n"),
        );
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "application/x-ndjson" } },
  );
}

/** A minimal settled turn, so the generator finishes instead of idling. */
function settledStream(): Response {
  const at = new Date().toISOString();
  return streamResponse([
    { type: "message.received", data: { message: "b", turnId: "t1" }, meta: { at } },
    { type: "message.sent", data: { turnId: "t1", message: "on it" }, meta: { at } },
    { type: "turn.completed", data: { turnId: "t1" }, meta: { at } },
  ]);
}

function accepted(): Response {
  return new Response(JSON.stringify({ ok: true, sessionId: "sess_1" }), {
    status: 200,
    headers: { "content-type": "application/json", "x-eve-session-id": "sess_1" },
  });
}

async function drain(gen: AsyncGenerator<TalkEvent>): Promise<TalkEvent[]> {
  const out: TalkEvent[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streamTurn delivery", () => {
  it("posts the answer to the channel's own route with the instance bearer", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(settledStream());
    vi.stubGlobal("fetch", fetchMock);

    await drain(
      streamTurn({
        baseUrl: "https://agent.example.test",
        message: "main, please",
        sessionId: "sess_1",
        continuationToken: "github:repo:1310524517:issue:7",
        inputResponses: [{ requestId: "req_1", text: "main" }],
        deliverVia: VIA,
        streamIndex: 12,
      }),
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://agent.example.test${ANSWER_ROUTE}`);
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer ednt_dep_1.sig",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      // RAW: `github:` already stripped. Sending the namespaced form makes eve build
      // `github:github:…` and the resume silently matches nothing.
      continuationToken: "repo:1310524517:issue:7",
      state: STATE,
      inputResponses: [{ requestId: "req_1", text: "main" }],
      message: "main, please",
    });
  });

  it("reads the resumed session from the same eve stream at the same cursor", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(settledStream());
    vi.stubGlobal("fetch", fetchMock);

    await drain(
      streamTurn({
        baseUrl: "https://agent.example.test",
        message: "main",
        sessionId: "sess_1",
        continuationToken: "github:repo:1310524517:issue:7",
        inputResponses: [{ requestId: "req_1", text: "main" }],
        deliverVia: VIA,
        streamIndex: 12,
      }),
    );

    // Delivery is the ONLY thing the channel changes — it is still one eve session.
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      "https://agent.example.test/eve/v1/session/sess_1/stream?startIndex=12",
    );
  });

  it("omits `message` when the human only picked an option", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(settledStream());
    vi.stubGlobal("fetch", fetchMock);

    await drain(
      streamTurn({
        baseUrl: "https://agent.example.test",
        message: "",
        sessionId: "sess_1",
        continuationToken: "github:repo:1:issue:7",
        inputResponses: [{ requestId: "req_1", optionId: "yes" }],
        deliverVia: VIA,
      }),
    );

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body).not.toHaveProperty("message");
    expect(body.inputResponses).toEqual([{ requestId: "req_1", optionId: "yes" }]);
  });

  it("ignores deliverVia on a first turn — there is no session to resume yet", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ continuationToken: "tok_1" }), {
          status: 202,
          headers: {
            "content-type": "application/json",
            "x-eve-session-id": "sess_new",
          },
        }),
      )
      .mockResolvedValueOnce(settledStream());
    vi.stubGlobal("fetch", fetchMock);

    await drain(
      streamTurn({
        baseUrl: "https://agent.example.test",
        message: "hello",
        deliverVia: VIA,
      }),
    );

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://agent.example.test/eve/v1/session",
    );
    expect(
      (fetchMock.mock.calls[0][1] as RequestInit).headers,
    ).not.toHaveProperty("authorization");
  });

  it("leaves an ordinary HTTP-homed follow-up exactly as it was", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(settledStream());
    vi.stubGlobal("fetch", fetchMock);

    await drain(
      streamTurn({
        baseUrl: "https://agent.example.test",
        message: "and then?",
        sessionId: "sess_1",
        continuationToken: "tok_1",
        inputResponses: [{ requestId: "req_1", text: "main" }],
        deliverVia: null,
      }),
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://agent.example.test/eve/v1/session/sess_1");
    expect(init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({
      message: "and then?",
      continuationToken: "tok_1",
      inputResponses: [{ requestId: "req_1", text: "main" }],
    });
  });

  it("refuses a channel-homed message that answers nothing, without touching the network", async () => {
    // eve's channel `send()` throws on a failed `deliver()` ONLY when `inputResponses` is
    // non-empty. With an empty array it silently falls back to `run()` and starts a brand-new
    // session from the supplied `state` — for the GitHub channel, a fresh comment on whatever
    // issue that state names. Refusing here is the only safe answer, and it must not degrade to
    // eve's HTTP session route either (that route 500s on a channel-homed token).
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const events = await drain(
      streamTurn({
        baseUrl: "https://agent.example.test",
        message: "actually, use develop",
        sessionId: "sess_1",
        continuationToken: "github:repo:1:issue:7",
        deliverVia: VIA,
      }),
    );

    const done = events.at(-1);
    if (done?.kind !== "done") throw new Error("no done event");
    expect(done.result.ok).toBe(false);
    expect(done.result.error).toContain("Send your message again");
    expect(fetchMock).not.toHaveBeenCalled();
    // The row is left exactly as it was — the session is still live on its thread.
    expect(done.result.sessionId).toBe("sess_1");
    expect(done.result.continuationToken).toBe("github:repo:1:issue:7");
    expect(done.result.resumeExpired).toBeUndefined();
    // Issue #282: the agent was never contacted, and the result says so — the drain reads
    // this to leave the session row (status, cursor, park state) completely untouched.
    expect(done.result.notDelivered).toBe(true);
    expect(done.result.turnId).toBeNull();
  });

  it("explains a 409 in human terms — the container was redeployed, nothing is broken", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, code: "session_gone", error: "no session" }), {
        status: 409,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const events = await drain(
      streamTurn({
        baseUrl: "https://agent.example.test",
        message: "main",
        sessionId: "sess_1",
        continuationToken: "github:repo:1:issue:7",
        inputResponses: [{ requestId: "req_1", text: "main" }],
        deliverVia: VIA,
      }),
    );

    const done = events.at(-1);
    expect(done?.kind).toBe("done");
    if (done?.kind !== "done") throw new Error("no done event");
    expect(done.result.ok).toBe(false);
    expect(done.result.error).toContain("redeployed");
    // The caller is told the resume handle is spent, so it can unbind the row and let the NEXT
    // message take the ordinary reseed path instead of failing forever.
    expect(done.result.resumeExpired).toBe(true);
    // The POST was attempted — this is a real failed turn, not an undelivered refusal.
    expect(done.result.notDelivered).toBeUndefined();
    // No stream was opened — the turn stopped at delivery.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("names the channel route in the error when delivery fails for another reason", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const events = await drain(
      streamTurn({
        baseUrl: "https://agent.example.test",
        message: "main",
        sessionId: "sess_1",
        continuationToken: "github:repo:1:issue:7",
        inputResponses: [{ requestId: "req_1", text: "main" }],
        deliverVia: VIA,
      }),
    );

    const done = events.at(-1);
    if (done?.kind !== "done") throw new Error("no done event");
    expect(done.result.error).toContain(ANSWER_ROUTE);
    expect(done.result.error).toContain("boom");
    // NOT a spent resume — a GitHub outage or a model error must leave the row bound so a retry
    // can still reach the same thread.
    expect(done.result.resumeExpired).toBeUndefined();
    // The delivery was attempted (the route answered) — not an undelivered refusal.
    expect(done.result.notDelivered).toBeUndefined();
  });

  it("keeps the row bound when the route reports its own send failure as a 409", async () => {
    // The template answers 409 for "this token resolves to nothing" and 500 for "send blew up",
    // but a `send_failed` code on a 409 is still a transient failure — it must not be read as a
    // dead session, or one flaky delivery would permanently detach a live thread.
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: false, code: "send_failed", error: "github 502" }),
        { status: 409 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const events = await drain(
      streamTurn({
        baseUrl: "https://agent.example.test",
        message: "main",
        sessionId: "sess_1",
        continuationToken: "github:repo:1:issue:7",
        inputResponses: [{ requestId: "req_1", text: "main" }],
        deliverVia: VIA,
      }),
    );

    const done = events.at(-1);
    if (done?.kind !== "done") throw new Error("no done event");
    expect(done.result.error).toContain("github 502");
    expect(done.result.resumeExpired).toBeUndefined();
  });
});
