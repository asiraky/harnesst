/**
 * The shipped `vercel-provision` tool template (issue #364), compiled and driven.
 *
 * This is the privileged half of the Vercel flow: full-account token in, project + scoped token
 * out, with the bearer token confined to the function body. Compiled with esbuild against stubs
 * (the github-channel pattern — `eve` is not a harnesst dependency). Pinned behaviour:
 *
 *  - the approval gate is hardcoded `always()` — not a toggle, not env-dependent;
 *  - missing master token / deposit wiring are readable errors before any Vercel call;
 *  - the happy path creates the project, mints the token with the requested TTL, deposits it
 *    sandbox-sealed for the named member, and the RESULT NEVER CONTAINS THE BEARER TOKEN;
 *  - an existing same-name project is adopted (conflict → lookup), so retries converge;
 *  - a failed deposit revokes the minted token and still never surfaces its value;
 *  - a configured team id scopes project calls but never the user-token mint.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const TEMPLATE_PATH = join(
  __dirname,
  "../../catalog/templates/agents/vercel-issuer/files/tools/vercel-provision.ts",
);

type FetchCall = { url: string; method: string; headers: Record<string, string>; body: unknown };

interface Options {
  env?: Record<string, string | undefined>;
  createProject?: { status: number; body: unknown };
  mint?: { status: number; body: unknown };
  deposit?: (call: FetchCall) => { status: number; body: unknown };
}

interface Harness {
  tool: {
    approval: unknown;
    execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  calls: FetchCall[];
}

const BEARER = "vcp_minted_secret_ABC123XYZ";

function loadTemplate(options: Options = {}): Harness {
  const source = readFileSync(TEMPLATE_PATH, "utf8");
  const compiled = transformSync(source, {
    format: "cjs",
    loader: "ts",
    target: "node20",
  }).code;

  const calls: FetchCall[] = [];
  const respond = (url: string, call: FetchCall): { status: number; body: unknown } => {
    if (url.includes("/v11/projects"))
      return options.createProject ?? { status: 200, body: { id: "prj_new" } };
    if (url.includes("/v9/projects/")) return { status: 200, body: { id: "prj_existing" } };
    if (url.includes("/v3/user/tokens") && call.method === "POST")
      return (
        options.mint ?? { status: 200, body: { token: { id: "tok_1" }, bearerToken: BEARER } }
      );
    if (url.includes("/v3/user/tokens/") && call.method === "DELETE")
      return { status: 200, body: {} };
    if (url.startsWith("https://harnesst.local/deposit"))
      return options.deposit?.(call) ?? { status: 200, body: { ok: true } };
    throw new Error(`unexpected fetch to ${url}`);
  };

  const fakeFetch = async (url: string, init?: RequestInit) => {
    const call: FetchCall = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const { status, body } = respond(call.url, call);
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return body;
      },
    };
  };

  const stubs: Record<string, unknown> = {
    "eve/tools": { defineTool: (config: unknown) => config },
    "eve/tools/approval": { always: () => "always-gate" },
    zod: { z },
  };
  const fakeProcess = {
    env: {
      VERCEL_MASTER_TOKEN: "master_tok",
      HARNESST_SECRETS_DEPOSIT_URL: "https://harnesst.local/deposit",
      HARNESST_TEAM_TOKEN: "team_tok",
      ...(options.env ?? {}),
    },
  };

  const moduleObject = { exports: {} as Record<string, unknown> };
  const requireStub = (specifier: string) => {
    if (specifier in stubs) return stubs[specifier];
    throw new Error(`the template must not import ${specifier}`);
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function("require", "module", "exports", "process", "fetch", compiled)(
    requireStub,
    moduleObject,
    moduleObject.exports,
    fakeProcess,
    fakeFetch,
  );

  return { tool: moduleObject.exports.default as Harness["tool"], calls };
}

const INPUT = {
  projectName: "acme-web",
  targetMember: "dev",
  framework: "nextjs",
  tokenTtlDays: 30,
  justification: "j",
};

describe("vercel-provision tool template", () => {
  it("hardcodes the always() approval gate", () => {
    const { tool } = loadTemplate();
    expect(tool.approval).toBe("always-gate");
  });

  it("errors readably when the master token or deposit wiring is missing, before any Vercel call", async () => {
    for (const env of [
      { VERCEL_MASTER_TOKEN: undefined },
      { HARNESST_SECRETS_DEPOSIT_URL: undefined },
      { HARNESST_TEAM_TOKEN: undefined },
    ]) {
      const harness = loadTemplate({ env });
      const result = await harness.tool.execute(INPUT);
      expect(result.ok).toBe(false);
      expect(harness.calls).toHaveLength(0);
    }
  });

  it("creates the project, mints with the requested TTL, deposits sandbox-sealed, and never returns the token", async () => {
    const before = Date.now();
    const harness = loadTemplate();
    const result = await harness.tool.execute(INPUT);
    expect(result).toMatchObject({
      ok: true,
      projectId: "prj_new",
      projectName: "acme-web",
      delivery: "queued",
    });
    expect(JSON.stringify(result)).not.toContain(BEARER);

    const [create, mint, tokenDeposit, idDeposit] = harness.calls;
    expect(create.method).toBe("POST");
    expect(create.body).toMatchObject({ name: "acme-web", framework: "nextjs" });
    expect(mint.url).toContain("/v3/user/tokens");
    const mintBody = mint.body as { projectId: string; expiresAt: number };
    expect(mintBody.projectId).toBe("prj_new");
    expect(mintBody.expiresAt).toBeGreaterThanOrEqual(before + 29 * 86_400_000);
    expect(mintBody.expiresAt).toBeLessThan(before + 31 * 86_400_000);
    expect(tokenDeposit.headers.authorization).toBe("Bearer team_tok");
    expect(tokenDeposit.body).toEqual({
      member: "dev",
      key: "VERCEL_TOKEN",
      value: BEARER,
      sandboxExposed: false,
    });
    expect(idDeposit.body).toMatchObject({ key: "VERCEL_PROJECT_ID", value: "prj_new" });
  });

  it("adopts an existing same-name project on conflict so retries converge", async () => {
    const harness = loadTemplate({
      createProject: { status: 409, body: { error: { code: "conflict", message: "exists" } } },
    });
    const result = await harness.tool.execute(INPUT);
    expect(result).toMatchObject({ ok: true, projectId: "prj_existing" });
    expect(harness.calls.some((c) => c.url.includes("/v9/projects/acme-web"))).toBe(true);
  });

  it("revokes the minted token when the deposit fails, and surfaces no token value", async () => {
    const harness = loadTemplate({
      deposit: () => ({ status: 200, body: { ok: false, error: "no such member" } }),
    });
    const result = await harness.tool.execute(INPUT);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("revoked");
    expect(JSON.stringify(result)).not.toContain(BEARER);
    const revoke = harness.calls.find((c) => c.method === "DELETE");
    expect(revoke?.url).toContain("/v3/user/tokens/tok_1");
  });

  it("scopes project calls to a configured team but never the user-token mint", async () => {
    const harness = loadTemplate({ env: { VERCEL_TEAM_ID: "team_9" } });
    await harness.tool.execute(INPUT);
    const create = harness.calls.find((c) => c.url.includes("/v11/projects"));
    const mint = harness.calls.find(
      (c) => c.url.includes("/v3/user/tokens") && c.method === "POST",
    );
    expect(create?.url).toContain("teamId=team_9");
    expect(mint?.url).not.toContain("teamId");
  });
});
