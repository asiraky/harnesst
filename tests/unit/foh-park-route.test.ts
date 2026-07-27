/**
 * WS1 — the park endpoint's transport shell (app/routes/api.foh.park.ts).
 *
 * The division of labour mirrors `api.team.ask.ts`: the bearer is the ONLY thing that decides
 * who the caller is, a bad or absent token is the only 401, a malformed body is a 400, and every
 * business outcome the agent should be able to read comes back 200 `{ ok:false, error }` so the
 * container can log something useful instead of retrying a hopeless request forever.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mintDelegationToken } from "~/team/token.server";

const parkChannelQuestion = vi.hoisted(() =>
  vi.fn(async (_input: Record<string, unknown>, _deps: unknown) => ({
    ok: true,
    sessionId: "ps_1",
    inboxItemIds: ["ib_1"],
  })),
);

vi.mock("~/foh/park.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/foh/park.server")>()),
  parkChannelQuestion,
  defaultParkDeps: () => ({ marker: "deps" }),
}));

const { action } = await import("~/routes/api.foh.park");

const KEY = "1f8b16e6a46dd3ac12ef7a328f1ce35c67b5bc8f1acdd76280e3674c3a4f19b2";

function body(over: Record<string, unknown> = {}) {
  return {
    channel: "github",
    routePath: "/eve/v1/github/harnesst/answer",
    eveSessionId: "sess_eve_1",
    continuationToken: "github:repo:1:issue:7",
    state: { owner: "acme", repo: "widgets", issueNumber: 7 },
    title: "acme/widgets#7",
    requests: [{ requestId: "req_1", prompt: "Which branch?" }],
    ...over,
  };
}

function post(init: { token?: string; raw?: string; json?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  return {
    request: new Request("http://localhost/api/foh/park", {
      method: "POST",
      headers,
      body: init.raw ?? JSON.stringify(init.json ?? body()),
    }),
    params: {},
    context: {},
  } as never;
}

/** The route throws `data(...)`; unwrap whatever React Router hands back into a Response. */
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
  parkChannelQuestion.mockClear();
  process.env.HARNESST_SECRETS_KEY = KEY;
});

describe("POST /api/foh/park", () => {
  it("401s with no Authorization header, without touching the business logic", async () => {
    const result = await run(post());

    expect(result.status).toBe(401);
    expect(parkChannelQuestion).not.toHaveBeenCalled();
  });

  it("401s on a token signed with a different key — the id alone is not enough", async () => {
    const forged = `ednt_dep_1.${"A".repeat(43)}`;

    const result = await run(post({ token: forged }));

    expect(result.status).toBe(401);
    expect(parkChannelQuestion).not.toHaveBeenCalled();
  });

  it("passes the deployment id the SIGNATURE names, never one from the body", async () => {
    const token = mintDelegationToken("dep_real");

    const result = await run(
      post({ token, json: body({ deploymentId: "dep_someone_else" }) }),
    );

    expect(result.status).toBe(200);
    expect(result.json).toEqual({
      ok: true,
      sessionId: "ps_1",
      inboxItemIds: ["ib_1"],
    });
    expect(parkChannelQuestion.mock.calls[0][0]).toMatchObject({
      deploymentId: "dep_real",
      channel: "github",
      eveSessionId: "sess_eve_1",
      continuationToken: "github:repo:1:issue:7",
    });
  });

  it("400s on a malformed JSON body", async () => {
    const token = mintDelegationToken("dep_real");

    const result = await run(post({ token, raw: "{not json" }));

    expect(result.status).toBe(400);
    expect(parkChannelQuestion).not.toHaveBeenCalled();
  });

  for (const [name, over] of [
    ["no channel", { channel: undefined }],
    ["no routePath", { routePath: undefined }],
    ["no eve session id", { eveSessionId: undefined }],
    ["no continuation token", { continuationToken: undefined }],
    ["a non-object state", { state: "nope" }],
    ["an empty requests array", { requests: [] }],
    ["a request with no prompt", { requests: [{ requestId: "req_1" }] }],
    ["a request with no requestId", { requests: [{ prompt: "hi" }] }],
  ] as const) {
    it(`400s on ${name}`, async () => {
      const token = mintDelegationToken("dep_real");

      const result = await run(post({ token, json: body(over) }));

      expect(result.status).toBe(400);
      expect(parkChannelQuestion).not.toHaveBeenCalled();
    });
  }

  it("returns a business refusal as 200 {ok:false} — a retry would not help", async () => {
    parkChannelQuestion.mockResolvedValueOnce({
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
