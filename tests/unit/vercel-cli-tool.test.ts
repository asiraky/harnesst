/**
 * The shipped `vercel-cli` tool template (issue #364), compiled and driven.
 *
 * The template is a catalog file — it imports `eve`, which is not a harnesst dependency, and is
 * excluded from tsconfig — so this suite compiles it with esbuild and runs it against stubs,
 * the github-channel pattern. What's pinned is the enforced-in-code security story:
 *
 *  - the credential-handling argv refusals (`tokens`/`login`/`logout` anywhere in the argv,
 *    `--token`/`--token=`/`-t` in any position) happen BEFORE any spawn;
 *  - a missing credential is a readable error, not a spawn;
 *  - the token reaches the child via env only, and the child env is minimal — no other secret
 *    from the tool process leaks into it;
 *  - stdout/stderr are redacted (exact token strings and vcp_-shaped strings) and capped;
 *  - the approval policy: gated by default, ungated only by the explicit "0" toggle, and ALWAYS
 *    gated while a master token is present — the issuer's gate is not a preference.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const TEMPLATE_PATH = join(
  __dirname,
  "../../catalog/templates/tools/vercel-cli/files/tools/vercel-cli.ts",
);

type ExecCall = {
  file: string;
  args: string[];
  options: { cwd?: string; env: Record<string, string | undefined> };
};

interface Harness {
  tool: {
    approval: () => string;
    execute: (input: {
      args: string[];
      justification: string;
      cwd?: string;
    }) => Promise<Record<string, unknown>>;
  };
  refuseArgs: (args: string[]) => string | null;
  redact: (text: string, secrets: Array<string | undefined>) => string;
  requiresApproval: (env?: Record<string, string | undefined>) => boolean;
  execCalls: ExecCall[];
}

interface Options {
  env?: Record<string, string | undefined>;
  exec?: (call: ExecCall) => { error?: Error & { code?: number }; stdout?: string; stderr?: string };
  resolveThrows?: boolean;
}

function loadTemplate(options: Options = {}): Harness {
  const source = readFileSync(TEMPLATE_PATH, "utf8");
  const compiled = transformSync(source, {
    format: "cjs",
    loader: "ts",
    target: "node20",
  }).code;

  const execCalls: ExecCall[] = [];
  const stubs: Record<string, unknown> = {
    "eve/tools": { defineTool: (config: unknown) => config },
    zod: { z },
    "node:child_process": {
      execFile: (
        file: string,
        args: string[],
        opts: ExecCall["options"],
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const call = { file, args, options: opts };
        execCalls.push(call);
        const result = options.exec?.(call) ?? {};
        callback(result.error ?? null, result.stdout ?? "", result.stderr ?? "");
      },
    },
    "node:module": {
      createRequire: () => ({
        resolve: (specifier: string) => {
          if (options.resolveThrows) throw new Error(`cannot resolve ${specifier}`);
          return "/repo/node_modules/vercel/dist/index.js";
        },
      }),
    },
  };

  const fakeProcess = {
    execPath: "/usr/bin/node",
    env: { PATH: "/usr/bin", HOME: "/home/agent", OTHER_SECRET: "hunter2", ...(options.env ?? {}) },
  };

  const moduleObject = { exports: {} as Record<string, unknown> };
  const requireStub = (specifier: string) => {
    if (specifier in stubs) return stubs[specifier];
    throw new Error(`the template must not import ${specifier}`);
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function("require", "module", "exports", "process", compiled)(
    requireStub,
    moduleObject,
    moduleObject.exports,
    fakeProcess,
  );

  return {
    tool: moduleObject.exports.default as Harness["tool"],
    refuseArgs: moduleObject.exports.refuseArgs as Harness["refuseArgs"],
    redact: moduleObject.exports.redact as Harness["redact"],
    requiresApproval: moduleObject.exports.requiresApproval as Harness["requiresApproval"],
    execCalls,
  };
}

const TOKEN = "vcp_live_1234567890abcdef";

describe("vercel-cli tool template", () => {
  it("refuses credential subcommands anywhere in the argv and --token in any spelling, without spawning", async () => {
    const harness = loadTemplate({ env: { VERCEL_TOKEN: TOKEN } });
    for (const args of [
      ["tokens", "add"],
      ["login"],
      ["logout"],
      ["--scope", "acme", "tokens", "add"],
      ["deploy", "--token", "abc"],
      ["deploy", "--token=abc"],
      ["deploy", "-t", "abc"],
    ]) {
      const result = await harness.tool.execute({ args, justification: "j" });
      expect(result.ok).toBe(false);
      expect(String(result.error)).toBeTruthy();
    }
    expect(harness.execCalls).toHaveLength(0);
  });

  it("refuses raw `api` access for the master-token holder, but allows it on a project token", async () => {
    const issuer = loadTemplate({
      env: { VERCEL_MASTER_TOKEN: "master_tok_9876543210" },
    });
    const refused = await issuer.tool.execute({
      args: ["api", "/v3/user/tokens", "-X", "POST"],
      justification: "j",
    });
    expect(refused.ok).toBe(false);
    expect(issuer.execCalls).toHaveLength(0);

    const scoped = loadTemplate({ env: { VERCEL_TOKEN: TOKEN }, exec: () => ({ stdout: "{}" }) });
    const allowed = await scoped.tool.execute({
      args: ["api", "/v9/projects/acme"],
      justification: "j",
    });
    expect(allowed.ok).toBe(true);
  });

  it("answers a readable error instead of spawning when no credential is configured", async () => {
    const harness = loadTemplate({ env: {} });
    const result = await harness.tool.execute({ args: ["whoami"], justification: "j" });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/credential/i);
    expect(harness.execCalls).toHaveLength(0);
  });

  it("spawns the resolved CLI entry via node with a minimal child env carrying only the token", async () => {
    const harness = loadTemplate({
      env: { VERCEL_TOKEN: TOKEN },
      exec: () => ({ stdout: "https://my-app-abc123.vercel.app\n" }),
    });
    const result = await harness.tool.execute({
      args: ["deploy", "--prod", "--yes"],
      justification: "ship it",
      cwd: "/work/app",
    });
    expect(result).toMatchObject({ ok: true, exitCode: 0 });
    expect(result.stdout).toContain("my-app-abc123.vercel.app");
    const call = harness.execCalls[0];
    expect(call.file).toBe("/usr/bin/node");
    expect(call.args).toEqual([
      "/repo/node_modules/vercel/dist/index.js",
      "deploy",
      "--prod",
      "--yes",
    ]);
    expect(call.options.cwd).toBe("/work/app");
    expect(call.options.env.VERCEL_TOKEN).toBe(TOKEN);
    expect(call.options.env.OTHER_SECRET).toBeUndefined();
  });

  it("falls back to the master token for the issuer and forwards it as VERCEL_TOKEN", async () => {
    const harness = loadTemplate({
      env: { VERCEL_MASTER_TOKEN: "master_tok_9876543210" },
      exec: () => ({ stdout: "ok" }),
    });
    const result = await harness.tool.execute({ args: ["whoami"], justification: "j" });
    expect(result.ok).toBe(true);
    expect(harness.execCalls[0].options.env.VERCEL_TOKEN).toBe("master_tok_9876543210");
  });

  it("redacts configured tokens and vcp_-shaped strings from output without mangling URLs", async () => {
    const harness = loadTemplate({
      env: { VERCEL_TOKEN: TOKEN },
      exec: () => ({
        error: Object.assign(new Error("exit 1"), { code: 1 }),
        stdout: `token is ${TOKEN} and also vcp_other9999999 leaked, {"bearerToken":"AbC123fullAccount"}`,
        stderr: `see https://my-app-abc123.vercel.app for ${TOKEN}`,
      }),
    });
    const result = await harness.tool.execute({ args: ["env", "ls"], justification: "j" });
    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    expect(String(result.stdout)).not.toContain(TOKEN);
    expect(String(result.stdout)).toContain("vcp_[redacted]");
    expect(String(result.stdout)).not.toContain("AbC123fullAccount");
    expect(String(result.stdout)).toContain('"bearerToken":"[redacted]"');
    expect(String(result.stderr)).not.toContain(TOKEN);
    expect(String(result.stderr)).toContain("https://my-app-abc123.vercel.app");
  });

  it("caps runaway output and reports a spawn-level failure that produced none", async () => {
    const big = "x".repeat(50_000);
    const harness = loadTemplate({
      env: { VERCEL_TOKEN: TOKEN },
      exec: (call) =>
        call.args.includes("logs")
          ? { stdout: big }
          : { error: Object.assign(new Error("spawn ENOENT /nope"), { code: 1 }) },
    });
    const capped = await harness.tool.execute({ args: ["logs"], justification: "j" });
    expect(String(capped.stdout).length).toBeLessThan(big.length);
    expect(String(capped.stdout)).toContain("truncated");
    const failed = await harness.tool.execute({
      args: ["deploy"],
      justification: "j",
      cwd: "/nope",
    });
    expect(failed.ok).toBe(false);
    expect(String(failed.error)).toContain("ENOENT");
  });

  it("reports a missing vercel dependency instead of throwing", async () => {
    const harness = loadTemplate({ env: { VERCEL_TOKEN: TOKEN }, resolveThrows: true });
    const result = await harness.tool.execute({ args: ["whoami"], justification: "j" });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/not installed/i);
    expect(harness.execCalls).toHaveLength(0);
  });

  it("gates by default, ungates only on the explicit '0' toggle, and always gates the master-token holder", () => {
    const { requiresApproval, tool } = loadTemplate({ env: { VERCEL_TOKEN: TOKEN } });
    expect(requiresApproval({})).toBe(true);
    expect(requiresApproval({ VERCEL_CLI_REQUIRE_APPROVAL: "1" })).toBe(true);
    expect(requiresApproval({ VERCEL_CLI_REQUIRE_APPROVAL: "0" })).toBe(false);
    expect(
      requiresApproval({ VERCEL_CLI_REQUIRE_APPROVAL: "0", VERCEL_MASTER_TOKEN: "m" }),
    ).toBe(true);
    // The tool's approval field is the policy function wired to that decision.
    expect(tool.approval()).toBe("user-approval");
  });
});
