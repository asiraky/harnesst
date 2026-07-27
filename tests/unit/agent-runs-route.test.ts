/**
 * WS2 — the run-report endpoint's transport shell (app/routes/api.agent.runs.ts).
 *
 * Same division as `/api/foh/park`, and deliberately the same bearer: the delegation token names a
 * DEPLOYMENT and nothing else, so no field of the body can move a run onto someone else's project.
 * The caller is a fire-and-forget hook inside a container, so business outcomes come back 200
 * `{ ok }` — only an unusable request (bad token, unparseable or oversized body) gets a status.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_PUSHED_BODY_BYTES } from "~/observability/push-ingest.server";
import { mintDelegationToken } from "~/team/token.server";

const ingestPushedTurn = vi.hoisted(() =>
  vi.fn(async (_input: Record<string, unknown>, _deps: unknown) => ({
    ok: true,
    recorded: true,
  })),
);

vi.mock("~/observability/push-ingest.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/observability/push-ingest.server")>()),
  ingestPushedTurn,
  defaultPushIngestDeps: () => ({ marker: "deps" }),
}));

const { action } = await import("~/routes/api.agent.runs");

const KEY = "1f8b16e6a46dd3ac12ef7a328f1ce35c67b5bc8f1acdd76280e3674c3a4f19b2";

function body(over: Record<string, unknown> = {}) {
  return {
    sessionId: "wrun_1",
    turnId: "turn_0",
    turnSequence: 0,
    channelKind: "channel:github",
    modelId: "anthropic/x",
    agentName: "deputy",
    final: true,
    events: [
      { type: "turn.started", data: { turnId: "turn_0" }, meta: { at: "2026-07-27T00:00:00.000Z" } },
      { type: "turn.completed", data: { turnId: "turn_0" }, meta: { at: "2026-07-27T00:00:01.000Z" } },
    ],
    ...over,
  };
}

function post(
  init: { token?: string; raw?: string; json?: unknown; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(init.headers ?? {}),
  };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  return {
    request: new Request("http://localhost/api/agent/runs", {
      method: "POST",
      headers,
      body: init.raw ?? JSON.stringify(init.json ?? body()),
    }),
    params: {},
    context: {},
  } as never;
}

async function run(args: never): Promise<{ status: number; json: unknown }> {
  try {
    const result = await action(args);
    const response = result as unknown as { init?: { status?: number }; data: unknown };
    return { status: response.init?.status ?? 200, json: response.data };
  } catch (thrown) {
    const response = thrown as { init?: { status?: number }; data: unknown };
    return { status: response.init?.status ?? 500, json: response.data };
  }
}

beforeEach(() => {
  ingestPushedTurn.mockClear();
  process.env.HARNESST_SECRETS_KEY = KEY;
});

describe("POST /api/agent/runs", () => {
  it("401s with no Authorization header, without touching the ingest", async () => {
    const result = await run(post());

    expect(result.status).toBe(401);
    expect(ingestPushedTurn).not.toHaveBeenCalled();
  });

  for (const [name, token] of [
    ["a token signed with another key", `ednt_dep_1.${"A".repeat(43)}`],
    ["an unsigned deployment id", "dep_1"],
    ["an empty bearer", ""],
  ] as const) {
    it(`401s on ${name}`, async () => {
      const result = await run(post({ token: token || undefined }));

      expect(result.status).toBe(401);
      expect(ingestPushedTurn).not.toHaveBeenCalled();
    });
  }

  it("401s when the signature is tampered with after minting", async () => {
    const token = mintDelegationToken("dep_real");
    const forged = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");

    const result = await run(post({ token: forged }));

    expect(result.status).toBe(401);
    expect(ingestPushedTurn).not.toHaveBeenCalled();
  });

  it("records against the deployment the SIGNATURE names, never one from the body", async () => {
    const token = mintDelegationToken("dep_real");

    const result = await run(
      post({ token, json: body({ deploymentId: "dep_someone_else", projectId: "proj_evil" }) }),
    );

    expect(result.status).toBe(200);
    expect(result.json).toEqual({ ok: true, recorded: true });
    const [input] = ingestPushedTurn.mock.calls[0];
    expect(input.deploymentId).toBe("dep_real");
    expect(input.projectId).toBeUndefined();
    expect(input).toMatchObject({
      sessionId: "wrun_1",
      turnId: "turn_0",
      channelKind: "channel:github",
      modelId: "anthropic/x",
      agentName: "deputy",
      final: true,
    });
  });

  it("400s on a malformed JSON body", async () => {
    const token = mintDelegationToken("dep_real");

    const result = await run(post({ token, raw: "{not json" }));

    expect(result.status).toBe(400);
    expect(ingestPushedTurn).not.toHaveBeenCalled();
  });

  for (const [name, over] of [
    ["no sessionId", { sessionId: undefined }],
    ["no turnId", { turnId: undefined }],
    ["a non-array events field", { events: { type: "turn.started" } }],
    ["no events field at all", { events: undefined }],
  ] as const) {
    it(`400s on ${name}`, async () => {
      const token = mintDelegationToken("dep_real");

      const result = await run(post({ token, json: body(over) }));

      expect(result.status).toBe(400);
      expect(ingestPushedTurn).not.toHaveBeenCalled();
    });
  }

  it("413s on a declared content-length past the cap, before reading the body", async () => {
    const token = mintDelegationToken("dep_real");

    const result = await run(
      post({
        token,
        headers: { "content-length": String(MAX_PUSHED_BODY_BYTES + 1) },
      }),
    );

    expect(result.status).toBe(413);
    expect(ingestPushedTurn).not.toHaveBeenCalled();
  });

  it("413s on an oversized body that lies about its length", async () => {
    const token = mintDelegationToken("dep_real");
    const raw = JSON.stringify(
      body({ events: [{ type: "message.completed", data: { m: "x".repeat(MAX_PUSHED_BODY_BYTES) } }] }),
    );

    const result = await run(post({ token, raw, headers: { "content-length": "10" } }));

    // 413 and not the 400 the surrounding try/catch would otherwise turn it into.
    expect(result.status).toBe(413);
    expect(ingestPushedTurn).not.toHaveBeenCalled();
  });

  it("400s on a JSON body that is not an object", async () => {
    const token = mintDelegationToken("dep_real");

    for (const raw of ["[]", '"hello"', "null", "7"]) {
      const result = await run(post({ token, raw }));
      expect(result.status).toBe(400);
    }
    expect(ingestPushedTurn).not.toHaveBeenCalled();
  });

  it("returns a skip as 200 — the hook must not retry an http-homed turn", async () => {
    ingestPushedTurn.mockResolvedValueOnce({
      ok: true,
      recorded: false,
      reason: "channel-not-recorded",
    } as never);
    const token = mintDelegationToken("dep_real");

    const result = await run(post({ token, json: body({ channelKind: "http" }) }));

    expect(result.status).toBe(200);
    expect(result.json).toEqual({
      ok: true,
      recorded: false,
      reason: "channel-not-recorded",
    });
  });

  it("refuses a declared http turn from the header, without reading the body", async () => {
    // An http-homed turn is discarded by `ingestPushedTurn` anyway. Deciding from the header
    // means the control plane never buffers and JSON-parses a multi-megabyte transcript to reach
    // that conclusion — a body far past the size cap is answered 200 here, because it is never
    // measured at all.
    const token = mintDelegationToken("dep_real");

    const result = await run(
      post({
        token,
        raw: "{not json",
        headers: {
          "x-harnesst-channel-kind": "http",
          "content-length": String(MAX_PUSHED_BODY_BYTES + 1),
        },
      }),
    );

    expect(result.status).toBe(200);
    expect(result.json).toEqual({
      ok: true,
      recorded: false,
      reason: "channel-not-recorded",
    });
    expect(ingestPushedTurn).not.toHaveBeenCalled();
  });

  it("checks the token BEFORE the header — an unauthenticated caller still gets 401", async () => {
    const result = await run(post({ headers: { "x-harnesst-channel-kind": "http" } }));

    expect(result.status).toBe(401);
  });

  it("lets a channel-homed or unlabelled turn through the header check", async () => {
    const token = mintDelegationToken("dep_real");

    const cases: Record<string, string>[] = [
      { "x-harnesst-channel-kind": "channel:github" },
      // An older agent image sends no header at all: it must behave exactly as it did.
      {},
    ];
    for (const headers of cases) {
      ingestPushedTurn.mockClear();
      const result = await run(post({ token, headers }));
      expect(result.status).toBe(200);
      expect(ingestPushedTurn).toHaveBeenCalledTimes(1);
    }
  });

  it("refuses an EMPTY declared kind — the classifier reads it as unrecorded", async () => {
    // The hook sends `""` when eve gave it no channel, and `ingestPushedTurn` discards that too.
    const token = mintDelegationToken("dep_real");

    const result = await run(post({ token, headers: { "x-harnesst-channel-kind": "" } }));

    expect(result.status).toBe(200);
    expect(ingestPushedTurn).not.toHaveBeenCalled();
  });

  it("returns a business refusal as 200 {ok:false}, not a 5xx", async () => {
    ingestPushedTurn.mockResolvedValueOnce({
      ok: false,
      error: "Your deployment is no longer known to harnesst.",
    } as never);
    const token = mintDelegationToken("dep_real");

    const result = await run(post({ token }));

    expect(result.status).toBe(200);
    expect(result.json).toEqual({
      ok: false,
      error: "Your deployment is no longer known to harnesst.",
    });
  });
});
