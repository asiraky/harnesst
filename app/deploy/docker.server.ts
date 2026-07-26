import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const DOCKER_PREFLIGHT_TIMEOUT_MS = Number(
  process.env.HARNESST_DOCKER_PREFLIGHT_TIMEOUT_MS ?? 10_000,
);

export class DockerUnavailableError extends Error {
  override name = "DockerUnavailableError";
}

export function commandErrorText(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const e = error as {
      stderr?: unknown;
      stdout?: unknown;
      message?: unknown;
      code?: unknown;
      signal?: unknown;
      killed?: unknown;
    };
    // stderr + stdout only while either exists: an execFile error's message is the command
    // line plus a COPY of stderr, and that duplicate tail crowded the real failure (often on
    // stdout — legacy docker builder steps, tsc, eslint) out of callers' last-N-lines views.
    const streams = [e.stderr, e.stdout]
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .filter(Boolean)
      .join("\n");
    if (streams) return streams;
    if (typeof e.message === "string" && e.message.trim()) return e.message.trim();
  }
  return String(error);
}

function compactErrorText(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join(" ");
}

function wasKilledByTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { killed?: unknown; signal?: unknown };
  return e.killed === true || e.signal === "SIGTERM" || e.signal === "SIGKILL";
}

export function isDockerUnavailableError(error: unknown): boolean {
  if (error instanceof DockerUnavailableError) return true;
  const raw = commandErrorText(error);
  return (
    wasKilledByTimeout(error) ||
    /spawn docker ENOENT/i.test(raw) ||
    (/ENOENT/i.test(raw) && /docker/i.test(raw)) ||
    /Cannot connect to the Docker daemon/i.test(raw) ||
    /docker daemon.*not.*running/i.test(raw) ||
    /request returned 500 Internal Server Error.*\/_ping/i.test(raw) ||
    /context deadline exceeded/i.test(raw) ||
    /connection refused/i.test(raw) ||
    /connection reset by peer/i.test(raw) ||
    /operation timed out/i.test(raw) ||
    /Client\.Timeout exceeded/i.test(raw)
  );
}

export function normalizeDockerCliError(error: unknown, action: string): Error {
  if (!isDockerUnavailableError(error)) {
    return error instanceof Error ? error : new Error(String(error));
  }

  const raw = compactErrorText(commandErrorText(error));
  const timeoutNote = wasKilledByTimeout(error)
    ? `docker did not answer within ${DOCKER_PREFLIGHT_TIMEOUT_MS / 1000}s`
    : raw;
  return new DockerUnavailableError(
    [
      `Docker is not responding, so harnesst cannot ${action}.`,
      "Install or restart Docker Desktop, Colima, or OrbStack, wait until `docker version` or `docker info` completes, then redeploy.",
      timeoutNote ? `Original Docker error: ${timeoutNote}` : null,
    ]
      .filter(Boolean)
      .join(" "),
  );
}

export async function assertDockerDaemonReady(action: string): Promise<void> {
  try {
    await exec("docker", ["version", "--format", "{{.Server.Version}}"], {
      maxBuffer: 1024 * 1024,
      timeout: DOCKER_PREFLIGHT_TIMEOUT_MS,
    });
  } catch (error) {
    throw normalizeDockerCliError(error, action);
  }
}
