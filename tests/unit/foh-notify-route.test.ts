/**
 * #288 3c — the notify endpoint's transport shell (app/routes/api.foh.notify.ts).
 *
 * Same division of labour as the park route: the bearer is the ONLY thing that decides who
 * the caller is, a bad or absent token is the only 401, a malformed body is a 400, and every
 * business outcome the agent should be able to read comes back 200 `{ ok:false, error }` so
 * the container can log something useful instead of retrying a hopeless request forever.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mintDelegationToken } from "~/team/token.server";

const notifyHumans = vi.hoisted(() =>
  vi.fn(async (_input: Record<string, unknown>, _deps: unknown) => ({
    ok: true,
    sessionId: "ps_1",
    inboxItemId: "ib_1",
  })),
);

vi.mock("~/foh/notify.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/foh/notify.server")>()),
  notifyHumans,
  defaultNotifyDeps: () => ({ marker: "deps" }),
}));

const { action } = await import("~/routes/api.foh.notify");

const KEY = "1f8b16e6a46dd3ac12ef7a328f1ce35c67b5bc8f1acdd76280e3674c3a4f19b2";

function post(init: { token?: string; raw?: string; json?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  return {
    request: new Request("http://localhost/api/foh/notify", {
      method: "POST",
      headers,
      body: init.raw ?? JSON.stringify(init.json ?? { message: "hello humans" }),
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
  notifyHumans.mockClear();
  process.env.HARNESST_SECRETS_KEY = KEY;
});

describe("POST /api/foh/notify", () => {
  it("401s with no Authorization header, without touching the business logic", async () => {
    const result = await run(post());

    expect(result.status).toBe(401);
    expect(notifyHumans).not.toHaveBeenCalled();
  });

  it("401s on a token signed with a different key — the id alone is not enough", async () => {
    const forged = `ednt_dep_1.${"A".repeat(43)}`;

    const result = await run(post({ token: forged }));

    expect(result.status).toBe(401);
    expect(notifyHumans).not.toHaveBeenCalled();
  });

  it("passes the deployment id the SIGNATURE names, never one from the body", async () => {
    const token = mintDelegationToken("dep_real");

    const result = await run(
      post({
        token,
        json: {
          message: "done!",
          title: "report",
          deploymentId: "dep_someone_else",
        },
      }),
    );

    expect(result.status).toBe(200);
    expect(result.json).toEqual({
      ok: true,
      sessionId: "ps_1",
      inboxItemId: "ib_1",
    });
    expect(notifyHumans.mock.calls[0][0]).toEqual({
      deploymentId: "dep_real",
      message: "done!",
      title: "report",
    });
  });

  it("400s on a malformed JSON body", async () => {
    const token = mintDelegationToken("dep_real");

    const result = await run(post({ token, raw: "{not json" }));

    expect(result.status).toBe(400);
    expect(notifyHumans).not.toHaveBeenCalled();
  });

  for (const [name, json] of [
    ["no message", { title: "just a title" }],
    ["a blank message", { message: "   " }],
    ["a non-string message", { message: 42 }],
  ] as const) {
    it(`400s on ${name}`, async () => {
      const token = mintDelegationToken("dep_real");

      const result = await run(post({ token, json }));

      expect(result.status).toBe(400);
      expect(notifyHumans).not.toHaveBeenCalled();
    });
  }

  it("drops a non-string title instead of failing the notification", async () => {
    const token = mintDelegationToken("dep_real");

    const result = await run(post({ token, json: { message: "hi", title: 7 } }));

    expect(result.status).toBe(200);
    expect(notifyHumans.mock.calls[0][0]).toEqual({
      deploymentId: "dep_real",
      message: "hi",
      title: null,
    });
  });

  it("lets an infrastructure failure propagate as a 500 — a retry IS the fix there", async () => {
    // Business refusals come back 200 {ok:false}; a thrown error (e.g. the notice insert died
    // and the bare session was reaped) must NOT be swallowed into one — the container's retry
    // is safe precisely because the compensation deleted the orphaned row.
    notifyHumans.mockRejectedValueOnce(new Error("inbox is down"));
    const token = mintDelegationToken("dep_real");

    const result = await run(post({ token }));

    expect(result.status).toBe(500);
  });

  it("returns a business refusal as 200 {ok:false} — a retry would not help", async () => {
    notifyHumans.mockResolvedValueOnce({
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
