import { beforeEach, describe, expect, it, vi } from "vitest";

import { mintDelegationToken } from "~/team/token.server";

const runTeamArtifactOperation = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true, artifacts: [], truncated: false })),
);

vi.mock("~/foh/team-artifacts.server", () => ({ runTeamArtifactOperation }));

const { action } = await import("~/routes/api.foh.team-artifacts");

function args(input: { token?: string; raw: string }) {
  const headers = new Headers({ "content-type": "application/json" });
  if (input.token) headers.set("authorization", `Bearer ${input.token}`);
  return {
    request: new Request("http://localhost/api/foh/team-artifacts", {
      method: "POST",
      headers,
      body: input.raw,
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
  process.env.HARNESST_SECRETS_KEY = "1f".repeat(32);
  runTeamArtifactOperation.mockClear();
});

describe("POST /api/foh/team-artifacts", () => {
  it("401s without a valid bearer and never reaches the store", async () => {
    const list = JSON.stringify({ op: "list" });
    expect((await run(args({ raw: list }))).status).toBe(401);
    expect(
      (await run(args({ token: `ednt_dep.${"A".repeat(43)}`, raw: list })))
        .status,
    ).toBe(401);
    expect(runTeamArtifactOperation).not.toHaveBeenCalled();
  });

  it("takes the deployment from the bearer, not the body", async () => {
    await run(
      args({
        token: mintDelegationToken("deployment-real"),
        raw: JSON.stringify({ op: "list", deploymentId: "deployment-forged" }),
      }),
    );
    expect(runTeamArtifactOperation).toHaveBeenCalledWith("deployment-real", {
      op: "list",
      deploymentId: "deployment-forged",
    });
  });

  it("answers malformed and oversized bodies as readable failures", async () => {
    const token = mintDelegationToken("deployment-real");
    expect(await run(args({ token, raw: "{bad" }))).toMatchObject({
      status: 200,
      json: { ok: false },
    });
    expect(
      await run(
        args({ token, raw: JSON.stringify({ q: "x".repeat(70_000) }) }),
      ),
    ).toMatchObject({ status: 200, json: { ok: false } });
    expect(runTeamArtifactOperation).not.toHaveBeenCalled();
  });
});
