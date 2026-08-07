import { execFile } from "node:child_process";
import { createRequire } from "node:module";

import { defineTool } from "eve/tools";
import { z } from "zod";

// The whole `vercel` CLI behind ONE gated tool (issue #364). The credential story is the point:
// the token lives in container env only — this tool process reads it and hands it to the child
// via env, so it never appears in the sandbox shell, the model's context, or a command line. The
// human approving a call sees the exact argv plus the agent's written justification.
//
// VERCEL_TOKEN is the ordinary (project-scoped, vcp_…) credential; VERCEL_MASTER_TOKEN is the
// fallback held only by the Vercel issuer agent — its presence forces the approval gate on
// regardless of VERCEL_CLI_REQUIRE_APPROVAL, so the full-account credential can never be driven
// unattended by flipping a toggle.

const OUTPUT_CAP = 20_000;

/** Subcommands that print or replace bearer credentials — never available through this tool. */
const FORBIDDEN_SUBCOMMANDS = new Set(["tokens", "login", "logout"]);

/**
 * Enforced in code, not prompt: the reason an argv is refused, or null when it may run.
 * Forbidden words are rejected ANYWHERE in the argv, not just first position — flag values can
 * shift what the CLI parses as the subcommand (`--scope x tokens add`), and a false positive on
 * a directory literally named "tokens" is a price worth paying.
 */
export function refuseArgs(args: string[]): string | null {
  const forbidden = args.find((arg) => FORBIDDEN_SUBCOMMANDS.has(arg));
  if (forbidden) {
    return `The \`vercel ${forbidden}\` subcommand is not available through this tool — it handles credentials, which the harness manages for you.`;
  }
  for (const arg of args) {
    if (arg === "--token" || arg.startsWith("--token=") || arg === "-t") {
      return "Authentication is handled by the harness; --token arguments are not accepted.";
    }
  }
  return null;
}

/**
 * Defense-in-depth output scrub: the literal configured token(s) plus anything token-shaped
 * (`vcp_…`). Exact-string replacement first so redaction can never mangle deployment URLs or ids
 * that merely resemble a secret.
 */
export function redact(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  return out.replace(/\bvcp_[A-Za-z0-9]{8,}/g, "vcp_[redacted]");
}

function truncate(text: string): string {
  if (text.length <= OUTPUT_CAP) return text;
  return `${text.slice(0, OUTPUT_CAP)}\n… [truncated ${text.length - OUTPUT_CAP} characters]`;
}

/** The gate: always on while the full-account token is present; otherwise a per-agent toggle. */
export function requiresApproval(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.VERCEL_MASTER_TOKEN) return true;
  return env.VERCEL_CLI_REQUIRE_APPROVAL !== "0";
}

export default defineTool({
  description:
    "Run a vercel CLI command (deploy, env, inspect, api, …) against this agent's Vercel project. Authentication is injected by the harness — never pass --token. Each call needs a one-sentence justification a human can approve.",
  inputSchema: z.object({
    args: z
      .array(z.string())
      .min(1)
      .describe(
        'The vercel CLI argv, e.g. ["deploy", "--prod", "--yes"]. Do not include the "vercel" word itself or any --token flag.',
      ),
    justification: z
      .string()
      .min(1)
      .max(500)
      .describe(
        "One or two sentences on why this command should run — shown verbatim to the human approving it.",
      ),
    cwd: z
      .string()
      .min(1)
      .optional()
      .describe("Working directory to run in; defaults to the tool process's own."),
  }),
  approval: () => (requiresApproval() ? "user-approval" : "not-applicable"),
  async execute({ args, cwd }) {
    const token = process.env.VERCEL_TOKEN ?? process.env.VERCEL_MASTER_TOKEN;
    if (!token) {
      return {
        ok: false,
        error:
          "No Vercel credential is configured for this agent yet. Ask the Vercel platform teammate to provision a project and token, then retry after the redeploy lands.",
      };
    }

    const refusal = refuseArgs(args);
    if (refusal) return { ok: false, error: refusal };

    let cliEntry: string;
    try {
      cliEntry = createRequire(import.meta.url).resolve("vercel/dist/index.js");
    } catch {
      return {
        ok: false,
        error: "The vercel CLI is not installed in this agent's runtime (missing `vercel` dependency).",
      };
    }

    // Minimal child env: the credential plus what the CLI needs to run. Deliberately NOT the
    // full process env — the tool process holds every other secret this agent owns.
    const childEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME ?? "/tmp",
      TMPDIR: process.env.TMPDIR,
      VERCEL_TOKEN: token,
      CI: "1",
      NO_COLOR: "1",
    };

    const result = await new Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
      failure?: string;
    }>((resolve) => {
      execFile(
        process.execPath,
        [cliEntry, ...args],
        {
          cwd,
          env: childEnv,
          timeout: 10 * 60_000,
          maxBuffer: 16 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          const exitCode =
            error && typeof (error as { code?: unknown }).code === "number"
              ? ((error as { code?: number }).code ?? 1)
              : error
                ? 1
                : 0;
          resolve({
            exitCode,
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
            // Spawn-level failures (bad cwd, killed on timeout) have no CLI stderr to explain them.
            failure:
              error && !stdout && !stderr ? String((error as Error).message ?? error) : undefined,
          });
        },
      );
    });

    const secrets = [token, process.env.VERCEL_TOKEN, process.env.VERCEL_MASTER_TOKEN];
    return {
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: truncate(redact(result.stdout, secrets)),
      stderr: truncate(redact(result.stderr, secrets)),
      ...(result.failure ? { error: redact(result.failure, secrets) } : {}),
    };
  },
});
