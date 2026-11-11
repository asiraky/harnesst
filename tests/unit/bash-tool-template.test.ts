/**
 * The generated `bash` tool is a source string baked into agent images. Evaluate it with a
 * sandbox that runs the wrapped command in a real local shell, so quoting, the timeout kill and
 * the result shape are exercised end to end rather than by inspecting the command text.
 */
import { execFile } from "node:child_process";

import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import { BASH_TOOL_SOURCE } from "~/deploy/bash-tool-template";

interface BashResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut?: boolean;
}
interface RunOptions {
  command: string;
  abortSignal?: AbortSignal;
}
type Run = (options: RunOptions) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

function loadTool(): {
  execute: (input: { command: string; timeout_seconds?: number }, ctx: unknown) => Promise<BashResult>;
} {
  const body = ts
    .transpileModule(BASH_TOOL_SOURCE, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    })
    .outputText.replace(/^import .*$/gm, "")
    .replace("export default defineTool(", "return defineTool(");
  return new Function("defineTool", body)((config: unknown) => config);
}

/** Runs the command the way the sandbox does: a shell, killed as a tree when the signal aborts. */
const shell: Run = ({ command, abortSignal }) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      "bash",
      ["-c", command],
      { signal: abortSignal, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && (error as { name?: string }).name === "AbortError") return reject(error);
        const code = (error as { code?: unknown } | null)?.code;
        resolve({ exitCode: typeof code === "number" ? code : 0, stdout, stderr });
      },
    );
    void child;
  });

const ctxWith = (run: Run) => ({ getSandbox: async () => ({ run }) });
const tool = loadTool();

describe("generated bash tool", () => {
  it("runs a command with quotes and pipes exactly as written", async () => {
    const result = await tool.execute(
      { command: `printf '%s\\n' "it's" 'a "test"' | tr a-z A-Z; echo oops >&2; exit 3` },
      ctxWith(shell),
    );
    expect(result).toEqual({
      exitCode: 3,
      stdout: `IT'S\nA "TEST"\n`,
      stderr: "oops\n",
      truncated: false,
    });
  });

  it("kills a command that outlives its timeout, background children included", async () => {
    const started = Date.now();
    const result = await tool.execute(
      { command: "echo started; (sleep 30 & sleep 30 & wait); echo never", timeout_seconds: 1 },
      ctxWith(shell),
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    expect(result.stdout).toBe("started\n");
    expect(result.stderr).toMatch(/still running after 1 seconds and was killed/);
  }, 20_000);

  it("does not call a fast exit 124 a timeout", async () => {
    const result = await tool.execute({ command: "exit 124" }, ctxWith(shell));
    expect(result.exitCode).toBe(124);
    expect(result.timedOut).toBeUndefined();
    expect(result.stderr).toBe("");
  });

  it("uses the default limit, and clamps a requested one to the maximum", async () => {
    const seen: string[] = [];
    const record: Run = async ({ command }) => {
      seen.push(command);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    // The limit is the number timeout receives; read it back from the shell it would run.
    const limitOf = (command: string) => Number(/timeout -k \d+ (\d+) /.exec(command)?.[1]);
    await tool.execute({ command: "true" }, ctxWith(record));
    await tool.execute({ command: "true", timeout_seconds: 99_999 }, ctxWith(record));
    await tool.execute({ command: "true", timeout_seconds: -5 }, ctxWith(record));
    await tool.execute({ command: "true", timeout_seconds: 90.2 }, ctxWith(record));
    expect(seen.map(limitOf)).toEqual([600, 3600, 600, 91]);
  });

  it("reports a backstop abort past the limit as a timeout, and other sandbox errors as failures", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const aborted: Run = async () => {
        vi.setSystemTime(Date.now() + 700_000);
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      };
      const late = await tool.execute({ command: "x" }, ctxWith(aborted));
      expect(late).toMatchObject({ exitCode: 124, timedOut: true });

      const broken: Run = async () => {
        throw new Error("sandbox unavailable");
      };
      const failed = await tool.execute({ command: "x" }, ctxWith(broken));
      expect(failed).toMatchObject({ exitCode: 1, truncated: false });
      expect(failed.stderr).toMatch(/sandbox unavailable/);
      expect(failed.timedOut).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the end of long output and says so", async () => {
    const result = await tool.execute({ command: "seq 1 5000" }, ctxWith(shell));
    expect(result.truncated).toBe(true);
    const lines = result.stdout.split("\n");
    expect(lines[0]).toBe("[stdout truncated: showing last 2000 of 5000 lines]");
    expect(lines[1]).toBe("3001");
    expect(lines.at(-2)).toBe("5000");
    expect(lines.at(-1)).toBe("");
  });

  it("caps a single huge line", async () => {
    const result = await tool.execute({ command: "head -c 9000 /dev/zero | tr '\\0' x; echo" }, ctxWith(shell));
    expect(result.truncated).toBe(true);
    expect(result.stdout).toBe("x".repeat(2000) + " [truncated]\n");
  });
});
