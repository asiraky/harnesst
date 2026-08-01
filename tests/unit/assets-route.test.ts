import { beforeEach, describe, expect, it, vi } from "vitest";

import { mintDelegationToken } from "~/team/token.server";

const runAssetOperation = vi.hoisted(() =>
  vi.fn(async (deploymentId: string, body: unknown) => ({
    ok: true,
    deploymentId,
    body,
  })),
);

vi.mock("~/assets/store.server", () => ({ runAssetOperation }));

const { action, ASSET_ROUTE_MAX_BODY_BYTES } =
  await import("~/routes/api.assets");

const KEY = "1f8b16e6a46dd3ac12ef7a328f1ce35c67b5bc8f1acdd76280e3674c3a4f19b2";

function args(
  input: { token?: string; raw?: string; contentLength?: number } = {},
) {
  const headers = new Headers({ "content-type": "application/json" });
  if (input.token) headers.set("authorization", `Bearer ${input.token}`);
  if (input.contentLength !== undefined) {
    headers.set("content-length", String(input.contentLength));
  }
  return {
    request: new Request("http://localhost/api/assets", {
      method: "POST",
      headers,
      body: input.raw ?? JSON.stringify({ op: "list" }),
    }),
    params: {},
    context: {},
  } as never;
}

async function run(input: never): Promise<{ status: number; json: unknown }> {
  try {
    const result = (await action(input)) as unknown as {
      init?: { status?: number };
      data: unknown;
    };
    return { status: result.init?.status ?? 200, json: result.data };
  } catch (thrown) {
    const result = thrown as { init?: { status?: number }; data: unknown };
    return { status: result.init?.status ?? 500, json: result.data };
  }
}

beforeEach(() => {
  process.env.HARNESST_SECRETS_KEY = KEY;
  runAssetOperation.mockClear();
});

describe("POST /api/assets", () => {
  it("401s unless the signed bearer authenticates a deployment", async () => {
    expect((await run(args())).status).toBe(401);
    expect(
      (await run(args({ token: `ednt_dep.${"A".repeat(43)}` }))).status,
    ).toBe(401);
    expect(runAssetOperation).not.toHaveBeenCalled();
  });

  it("derives the deployment id only from the bearer", async () => {
    const result = await run(
      args({
        token: mintDelegationToken("deployment-real"),
        raw: JSON.stringify({ op: "list", deploymentId: "deployment-forged" }),
      }),
    );
    expect(result.status).toBe(200);
    expect(runAssetOperation).toHaveBeenCalledWith("deployment-real", {
      op: "list",
      deploymentId: "deployment-forged",
    });
  });

  it("returns malformed and oversized requests as readable 200 business failures", async () => {
    const token = mintDelegationToken("deployment-real");
    const malformed = await run(args({ token, raw: "{bad" }));
    expect(malformed).toMatchObject({ status: 200, json: { ok: false } });

    const oversized = await run(
      args({ token, contentLength: ASSET_ROUTE_MAX_BODY_BYTES + 1 }),
    );
    expect(oversized).toMatchObject({
      status: 200,
      json: { ok: false, error: expect.stringMatching(/36 MB/) },
    });
    expect(runAssetOperation).not.toHaveBeenCalled();
  });
});
