// Assistant checkout sidecar.
//
// A tiny HTTP listener the assistant INSTANCE runs alongside `eve start`, on a second port
// (AUX_PORT, default 3100), loopback-bound. It owns the per-conversation git checkouts on the
// shared home volume (/workspace/home/checkouts/<conversationId>) that both the instance and the
// model's bash sandbox see. The control plane drives it:
//
//   POST /ensure {conversationId}          → clone/fetch + checkout harnesst/conv-<id>; report base moves
//   GET  /tree?conversationId=<id>         → full working-tree snapshot vs the merge-base with base
//
// GitHub credentials NEVER live here at rest: on each clone/fetch the sidecar asks the control
// plane (HARNESST_API_URL + HARNESST_ASSISTANT_TOKEN, both instance-only env) for a short-lived token
// NARROWED to this one repo with contents:read, and passes it to git via a per-invocation
// http.extraheader — never the remote URL, never git config on the shared volume. The edna token
// and the read token stay in this instance process; they are never exposed in any response. The
// sandbox can reach this port over the network, but the eval mutation requires the instance-only
// assistant token and the remaining unauthenticated operations only prepare/read its own checkout.
import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, realpath, stat, readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const exec = promisify(execFile);

const AUX_PORT = Number(process.env.HARNESST_AUX_PORT ?? 3100);
const API_URL = (process.env.HARNESST_API_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.HARNESST_ASSISTANT_TOKEN ?? "";
const CHECKOUT_ROOT =
  process.env.HARNESST_CHECKOUT_ROOT ?? "/workspace/home/checkouts";
const HOME_VOLUME = process.env.HARNESST_HOME_VOLUME ?? "";
const EVAL_RUNNER_IMAGE = process.env.HARNESST_EVAL_RUNNER_IMAGE ?? "node:24";
const MAX_FILE_BYTES = Number(
  process.env.HARNESST_SYNC_MAX_BYTES ?? 1024 * 1024,
);
const MAX_EVAL_OUTPUT_BYTES = Number(
  process.env.HARNESST_EVAL_OUTPUT_MAX_BYTES ?? 4 * 1024 * 1024,
);

// This trusted wrapper runs inside the disposable eval container. It first copies the checkout's
// read-only mount into the container's writable layer, then captures Eve's machine-readable output
// and the durable artifact set before Docker removes the container. Repo code cannot forge the
// envelope because its stdout/stderr are captured by this parent process rather than inherited.
export const EVAL_CONTAINER_SCRIPT = String.raw`
const { cpSync, existsSync, lstatSync, readFileSync, readdirSync, rmSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { basename, join, relative } = require("node:path");

const source = "/workspace/source";
const work = "/workspace/work";
const packageRoot = process.argv[1];
const maxConcurrency = process.argv[2];
const outputLimit = 512 * 1024;
const structuredLimit = 1024 * 1024;

function capturedText(value) {
  const full = String(value ?? "");
  return { value: full.slice(0, outputLimit), truncated: full.length > outputLimit };
}

function parseJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

function collectArtifacts(runDir) {
  const artifacts = [];
  const details = [];
  let structuredBytes = 0;
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      const info = lstatSync(absolute);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) { visit(absolute); continue; }
      if (!info.isFile()) continue;
      const body = readFileSync(absolute);
      const artifactPath = relative(runDir, absolute);
      artifacts.push({
        path: artifactPath,
        sizeBytes: body.length,
        sha256: createHash("sha256").update(body).digest("hex"),
      });
      if (
        artifactPath.startsWith("evals/") &&
        artifactPath.endsWith(".json") &&
        structuredBytes + body.length <= structuredLimit
      ) {
        try {
          details.push({ path: artifactPath, value: JSON.parse(body.toString("utf8")) });
          structuredBytes += body.length;
        } catch {}
      }
    }
  }
  visit(runDir);
  return { artifacts, details };
}

const envelope = {
  runnerExitCode: null,
  runnerSignal: null,
  runnerError: null,
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  artifactRunId: null,
  summary: null,
  results: [],
  details: [],
  artifacts: [],
};

try {
  cpSync(source, work, {
    recursive: true,
    dereference: false,
    // Keep relative node_modules/.bin links relative. Node otherwise rewrites their targets to the
    // read-only source mount, which would execute Eve outside the disposable copy.
    verbatimSymlinks: true,
  });
  const cwd = packageRoot === "." ? work : join(work, packageRoot);
  // Build caches can embed checkout paths. Drop all copied Eve state so the disposable location is
  // authoritative and the artifact directory below can only belong to this run.
  rmSync(join(cwd, ".eve"), { recursive: true, force: true });
  const result = spawnSync(
    "npx",
    [
      "--no-install", "eve", "eval", "--json", "--strict",
      "--max-concurrency", maxConcurrency,
    ],
    { cwd, env: process.env, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  envelope.runnerExitCode = result.status;
  envelope.runnerSignal = result.signal;
  envelope.runnerError = result.error?.message ?? null;
  const stdout = capturedText(result.stdout);
  const stderr = capturedText(result.stderr);
  envelope.stdout = stdout.value;
  envelope.stderr = stderr.value;
  envelope.stdoutTruncated = stdout.truncated;
  envelope.stderrTruncated = stderr.truncated;

  const evalRoot = join(cwd, ".eve", "evals");
  if (existsSync(evalRoot)) {
    const runIds = readdirSync(evalRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const runId = runIds.at(-1);
    if (runId) {
      const runDir = join(evalRoot, runId);
      envelope.artifactRunId = basename(runDir);
      envelope.summary = parseJson(join(runDir, "summary.json"));
      const resultsPath = join(runDir, "results.jsonl");
      if (existsSync(resultsPath)) {
        envelope.results = readFileSync(resultsPath, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => { try { return JSON.parse(line); } catch { return null; } })
          .filter(Boolean);
      }
      const collected = collectArtifacts(runDir);
      envelope.artifacts = collected.artifacts;
      envelope.details = collected.details;
    }
  }
} catch (error) {
  envelope.runnerError = error instanceof Error ? error.message : String(error);
}

process.stdout.write(JSON.stringify(envelope));
process.exitCode = Number.isInteger(envelope.runnerExitCode)
  ? envelope.runnerExitCode
  : 2;
`;

const checkoutDir = (id) =>
  join(CHECKOUT_ROOT, id.replace(/[^A-Za-z0-9_-]/g, ""));
const convBranch = (id) => `harnesst/conv-${id}`;

/**
 * Narrowed read token + repo coordinates, cached in-process until ~5 minutes before the token
 * expires (GitHub installation tokens live ~1h). One mint serves many ensure/tree calls instead of
 * two mints per turn; /tree paths that only need coordinates reuse the cache without forcing a mint.
 */
let credsCache = null; // { creds, expiresAtMs }
const CREDS_SLACK_MS = 5 * 60_000;

async function repoCreds() {
  if (credsCache && Date.now() < credsCache.expiresAtMs - CREDS_SLACK_MS) {
    return credsCache.creds;
  }
  if (!API_URL || !TOKEN)
    throw new Error(
      "checkout sidecar: HARNESST_API_URL / HARNESST_ASSISTANT_TOKEN unset",
    );
  const res = await fetch(`${API_URL}/api/assistant/read-token`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const errorBody = await res.json().catch(() => null);
    throw new Error(
      `read-token failed (${res.status}): ${errorBody?.error ?? "no token"}`,
    );
  }
  const body = await res.json().catch(() => null);
  if (!body || body.ok === false || !body.token) {
    throw new Error(
      `read-token failed (${res.status}): ${body?.error ?? "no token"}`,
    );
  }
  const creds = {
    token: body.token,
    owner: body.owner,
    repo: body.repo,
    defaultBranch: body.defaultBranch ?? "main",
    cloneUrl: `https://github.com/${body.owner}/${body.repo}.git`,
  };
  const expiresAtMs =
    Date.parse(body.expiresAt ?? "") || Date.now() + 50 * 60_000;
  credsCache = { creds, expiresAtMs };
  return creds;
}

/** Repo coordinates only (no token needed) — the cached copy when present, else one mint fills it. */
async function repoCoords() {
  if (credsCache) return credsCache.creds; // coordinates never change; ok past token expiry
  return repoCreds();
}

/** git with a per-invocation Authorization header (token never persisted to the volume). */
function authHeaderArgs(token) {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return ["-c", `http.extraheader=AUTHORIZATION: basic ${basic}`];
}

async function git(dir, args, token) {
  const auth = token ? authHeaderArgs(token) : [];
  const { stdout } = await exec("git", ["-C", dir, ...auth, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  return stdout;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Ensure the conversation checkout exists on its branch; fetch base; report if base advanced. */
async function ensure(conversationId) {
  const creds = await repoCreds();
  const dir = checkoutDir(conversationId);
  const branch = convBranch(conversationId);
  const base = creds.defaultBranch;
  await mkdir(CHECKOUT_ROOT, { recursive: true });

  const auth = authHeaderArgs(creds.token);
  if (!(await exists(join(dir, ".git")))) {
    // Fresh (or recovered after volume/instance loss): shallow-clone and check out the branch,
    // creating it from the remote copy if it exists, else from the base branch.
    await rm(dir, { recursive: true, force: true });
    await exec(
      "git",
      [
        ...auth,
        "clone",
        "--depth",
        "50",
        "--no-single-branch",
        creds.cloneUrl,
        dir,
      ],
      {
        maxBuffer: 64 * 1024 * 1024,
        timeout: 300_000,
      },
    );
    const remoteHasBranch = await hasRemoteBranch(dir, branch, creds.token);
    if (remoteHasBranch) {
      await git(dir, ["fetch", "--depth", "50", "origin", branch], creds.token);
      await git(dir, ["checkout", "-B", branch, `origin/${branch}`]);
    } else {
      await git(dir, ["checkout", "-B", branch, `origin/${base}`]);
    }
  } else {
    // Existing checkout: refresh origin so we can see whether the base branch advanced.
    await git(dir, ["fetch", "--depth", "50", "origin", base], creds.token);
  }

  const baseTip = (await git(dir, ["rev-parse", `origin/${base}`])).trim();
  const mergeBase = (
    await git(dir, ["merge-base", "HEAD", `origin/${base}`]).catch(
      () => baseTip,
    )
  ).trim();
  let advanced = 0;
  try {
    advanced =
      Number(
        (
          await git(dir, ["rev-list", "--count", `${mergeBase}..${baseTip}`])
        ).trim(),
      ) || 0;
  } catch {
    advanced = 0;
  }
  return {
    checkoutPath: dir,
    branch,
    baseBranch: base,
    baseTip,
    mergeBase,
    advanced,
  };
}

async function hasRemoteBranch(dir, branch, token) {
  try {
    const out = await git(
      dir,
      ["ls-remote", "--heads", "origin", branch],
      token,
    );
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Full snapshot of the checkout vs the merge-base with the base branch — committed AND uncommitted
 * (including untracked). Computed with a THROWAWAY index (GIT_INDEX_FILE) so the model's own index
 * is never mutated: stage the entire working tree into the temp index, then diff it against the
 * merge-base with `--raw` so each entry carries git's own MODE (100644/100755/120000/160000).
 * Binary files and files over the size cap are reported with a flag but no body.
 *
 * SECURITY: entries whose mode is not a regular file — symlinks (120000), submodules (160000) —
 * are NEVER read. The model controls the checkout and could `ln -s /proc/1/environ leak`; this
 * process runs in the INSTANCE (whose env holds HARNESST_ASSISTANT_TOKEN), so following a link here
 * would exfiltrate instance secrets into the mirrored branch. Such paths get `notFile: true` and
 * no body. An `lstat` isFile() re-check before every read is the second line of defense (a path
 * swapped for a symlink between `git add` and the read still won't be followed).
 */
async function tree(conversationId) {
  const coords = await repoCoords().catch(() => null);
  const base = coords?.defaultBranch ?? "main";
  const dir = checkoutDir(conversationId);
  const branch = convBranch(conversationId);
  if (!(await exists(join(dir, ".git")))) {
    return { branch, baseSha: "", dirty: [], missing: true };
  }
  const mergeBase = (
    await git(dir, ["merge-base", "HEAD", `origin/${base}`]).catch(async () =>
      (await git(dir, ["rev-parse", "HEAD"])).trim(),
    )
  ).trim();

  const tmpIndex = join(
    tmpdir(),
    `harnesst-idx-${randomBytes(6).toString("hex")}`,
  );
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  try {
    await exec("git", ["-C", dir, "add", "-A"], {
      env,
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const { stdout } = await exec(
      "git",
      ["-C", dir, "diff", "--cached", "--raw", "-z", "--no-renames", mergeBase],
      { env, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
    );
    const dirty = await parseRawDiff(stdout, dir);
    return { branch, baseSha: mergeBase, dirty };
  } finally {
    await rm(tmpIndex, { force: true }).catch(() => {});
  }
}

/** Constant-time authentication for control-plane-only sidecar mutations. */
function authorizedSidecarRequest(req) {
  if (!TOKEN) return false;
  const supplied = Buffer.from(
    String(req.headers["x-harnesst-sidecar-token"] ?? ""),
  );
  const expected = Buffer.from(TOKEN);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

/**
 * Run Eve's full eval suite in one member package. Untrusted repo/eval code must not execute in this
 * credential-bearing INSTANCE: clearing a child env alone would still let it read another process's
 * `/proc/.../environ`. Instead, launch a disposable sibling container mounted only to this
 * conversation checkout, with no Docker socket and an explicit minimal env. Its only model
 * credential is the short-lived, project/member/model/budget-scoped grant minted by harnesst.
 */
async function runEval(input) {
  const conversationId =
    typeof input?.conversationId === "string" ? input.conversationId : "";
  const packageRoot =
    typeof input?.packageRoot === "string" ? input.packageRoot : "";
  const gatewayUrl =
    typeof input?.gatewayUrl === "string" ? input.gatewayUrl : "";
  const gatewayToken =
    typeof input?.gatewayToken === "string" ? input.gatewayToken : "";
  const timeoutMs = Math.min(
    Math.max(Number(input?.timeoutMs) || 480_000, 1_000),
    480_000,
  );
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(conversationId))
    throw new Error("invalid conversation id");
  if (packageRoot !== "." && !/^agents\/[A-Za-z0-9_-]+$/.test(packageRoot)) {
    throw new Error("invalid member package root");
  }
  if (!gatewayUrl || !gatewayToken.startsWith("edne_")) {
    throw new Error("scoped eval gateway coordinates are required");
  }
  if (!HOME_VOLUME) {
    throw new Error(
      "credential-safe eval isolation is unavailable: HARNESST_HOME_VOLUME is unset",
    );
  }

  const checkout = await realpath(checkoutDir(conversationId));
  const cwd = await realpath(join(checkout, packageRoot));
  if (cwd !== checkout && !cwd.startsWith(checkout + "/")) {
    throw new Error("member package root escapes the conversation checkout");
  }
  await stat(join(cwd, "package.json"));

  const snapshot = await tree(conversationId);
  const headSha = (await git(checkout, ["rev-parse", "HEAD"])).trim();
  const checkoutIdentity = createHash("sha256")
    .update(
      JSON.stringify({
        headSha,
        baseSha: snapshot.baseSha,
        dirty: snapshot.dirty,
      }),
    )
    .digest("hex");
  const startedAt = Date.now();
  const maxConcurrency = Math.min(
    Math.max(Math.trunc(Number(input?.maxConcurrency) || 1), 1),
    16,
  );
  const execution = await spawnEval({
    conversationId,
    packageRoot,
    maxConcurrency,
    timeoutMs,
    env: {
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: "/tmp/harnesst-eval-home",
      TMPDIR: "/tmp",
      CI: "1",
      NO_COLOR: "1",
      HARNESST_MODEL_GATEWAY_URL: gatewayUrl,
      HARNESST_MODEL_GATEWAY_TOKEN: gatewayToken,
    },
  });
  const envelope = parseEvalEnvelope(
    execution.stdout,
    execution.stdoutTruncated,
  );
  const exitCode = envelope?.runnerExitCode ?? execution.exitCode;
  const summary = envelope?.summary ?? null;
  const classification = classifyEvalEvidence({
    exitCode,
    timedOut: execution.timedOut,
    runnerError: envelope?.runnerError,
    summary,
  });
  return {
    ...classification,
    command:
      "npx --no-install eve eval --json --strict --max-concurrency " +
      maxConcurrency,
    exitCode,
    signal: envelope?.runnerSignal ?? execution.signal,
    timedOut: execution.timedOut,
    durationMs: Date.now() - startedAt,
    stdout: envelope?.stdout ?? execution.stdout,
    stderr: envelope?.stderr ?? execution.stderr,
    stdoutTruncated: envelope?.stdoutTruncated ?? execution.stdoutTruncated,
    stderrTruncated: envelope?.stderrTruncated ?? execution.stderrTruncated,
    evidence: envelope
      ? {
          artifactRunId: envelope.artifactRunId,
          summary,
          results: envelope.results,
          details: envelope.details,
          artifacts: envelope.artifacts,
        }
      : null,
    isolation: {
      sourceMount: "read-only",
      executionCopy: "disposable-container-layer",
      cleanup: "container-removed",
    },
    sourceIdentity: {
      kind: "unpublished-checkout",
      headSha,
      baseSha: snapshot.baseSha,
      workingTreeSha256: checkoutIdentity,
    },
  };
}

function parseEvalEnvelope(stdout, truncated) {
  if (truncated) return null;
  try {
    const parsed = JSON.parse(stdout);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** Pure verdict classification kept exported so regression tests can cover false-success cases. */
export function classifyEvalEvidence({
  exitCode,
  timedOut,
  runnerError,
  summary,
}) {
  if (timedOut) {
    return {
      ok: false,
      outcome: "timed-out",
      error: "The behavioral eval timed out.",
    };
  }
  if (runnerError) {
    return {
      ok: false,
      outcome: "runner-error",
      error: `The eval runner failed: ${runnerError}`,
    };
  }
  if (!summary || !Array.isArray(summary.evals)) {
    return {
      ok: false,
      outcome: "runner-error",
      error: "Eve did not produce a structured eval artifact summary.",
    };
  }
  if (Number(summary.skipped) > 0) {
    const reasons = summary.evals
      .filter((item) => item?.verdict === "skipped")
      .map((item) => item?.skipReason)
      .filter(Boolean)
      .slice(0, 3)
      .join("; ");
    return {
      ok: false,
      outcome: "incomplete",
      error:
        `${summary.skipped} eval(s) skipped, so the behavioral evidence is incomplete.` +
        (reasons ? ` ${reasons}` : ""),
    };
  }
  if (Number(summary.failed) > 0) {
    return {
      ok: false,
      outcome: "failed",
      error: `${Number(summary.failed) || 0} eval(s) failed behavioral validation.`,
    };
  }
  if (Number(summary.scored) > 0) {
    return {
      ok: false,
      outcome: "below-threshold",
      error: `${summary.scored} eval(s) scored below the configured judge threshold.`,
    };
  }
  if (exitCode !== 0) {
    return {
      ok: false,
      outcome: "runner-error",
      error: `Eve exited with status ${exitCode} despite reporting no failed evals.`,
    };
  }
  return { ok: true, outcome: "passed" };
}

function spawnEval({
  conversationId,
  packageRoot,
  maxConcurrency,
  env,
  timeoutMs,
}) {
  return new Promise((resolve, reject) => {
    const containerName = `harnesst-eval-${conversationId}-${randomBytes(4).toString("hex")}`;
    const volumeSubpath = `checkouts/${conversationId}`;
    const envArgs = Object.entries(env).flatMap(([name, value]) => [
      "-e",
      `${name}=${value}`,
    ]);
    const child = spawn(
      "docker",
      [
        "run",
        "--rm",
        "--init",
        "--name",
        containerName,
        "--label",
        "dev.harnesst.assistant-eval=1",
        "--add-host",
        "host.docker.internal:host-gateway",
        "--security-opt",
        "no-new-privileges",
        "--cap-drop",
        "ALL",
        "--pids-limit",
        "512",
        "--tmpfs",
        "/tmp:rw,nosuid,size=1073741824",
        "--mount",
        `type=volume,src=${HOME_VOLUME},dst=/workspace/source,volume-subpath=${volumeSubpath},readonly`,
        "--workdir",
        "/workspace",
        ...envArgs,
        EVAL_RUNNER_IMAGE,
        "timeout",
        "--signal=TERM",
        "--kill-after=5s",
        `${Math.ceil(timeoutMs / 1000)}s`,
        "node",
        "--eval",
        EVAL_CONTAINER_SCRIPT,
        packageRoot,
        String(maxConcurrency),
      ],
      {
        // This is the trusted Docker CLI in the assistant instance. It needs the instance env to
        // reach the daemon, but Docker passes ONLY envArgs into the untrusted runner container.
        env: process.env,
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdout = limitedOutput();
    const stderr = limitedOutput();
    child.stdout.on("data", stdout.push);
    child.stderr.on("data", stderr.push);
    let timedOut = false;
    let killTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      void removeEvalContainer(containerName);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      void removeEvalContainer(containerName).finally(() =>
        resolve({
          exitCode,
          signal,
          timedOut,
          stdout: stdout.text(),
          stderr: stderr.text(),
          stdoutTruncated: stdout.truncated(),
          stderrTruncated: stderr.truncated(),
        }),
      );
    });
  });
}

async function removeEvalContainer(name) {
  await exec("docker", ["rm", "-f", name], { timeout: 30_000 }).catch(() => {});
}

function limitedOutput() {
  const chunks = [];
  let bytes = 0;
  let wasTruncated = false;
  return {
    push(chunk) {
      const buffer = Buffer.from(chunk);
      const remaining = Math.max(0, MAX_EVAL_OUTPUT_BYTES - bytes);
      if (remaining > 0) {
        chunks.push(buffer.subarray(0, remaining));
        bytes += Math.min(buffer.length, remaining);
      }
      if (buffer.length > remaining) wasTruncated = true;
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
    truncated: () => wasTruncated,
  };
}

/**
 * Classify one `git diff --raw -z` record meta (":oldmode newmode oldsha newsha status") into the
 * dirty-entry skeleton. Pure (exported for tests): mode comes straight from git — 100755 →
 * executable flag; anything that isn't a regular file (120000 symlink, 160000 submodule, …) →
 * notFile, meaning the body must never be read. Returns null for a non-record line.
 */
export function classifyRawRecord(meta, path) {
  if (!meta.startsWith(":")) return null;
  const fields = meta.slice(1).split(/\s+/); // [oldMode, newMode, oldSha, newSha, status]
  const newMode = fields[1] ?? "";
  const code = (fields[4] ?? "")[0];
  if (code === "D") return { path, status: "deleted" };
  const info = { path, status: code === "A" ? "added" : "modified" };
  if (newMode === "100755") info.executable = true;
  if (newMode !== "100644" && newMode !== "100755") info.notFile = true;
  return info;
}

/**
 * Parse `git diff --raw -z` output (meta\0path\0…) and attach bodies for regular-file adds/mods
 * only — notFile entries are reported but their bodies are NEVER read (see `tree`'s security note).
 */
async function parseRawDiff(z, dir) {
  const parts = z.split("\0").filter((p) => p.length > 0);
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const info = classifyRawRecord(parts[i], parts[i + 1]);
    if (!info) continue;
    if (info.status === "deleted" || info.notFile) {
      out.push(info);
      continue;
    }
    const { path } = info;
    const abs = join(dir, path);
    try {
      // lstat (never follows links) + isFile(): a path that became a symlink after `git add`
      // still must not be read through.
      const st = await lstat(abs);
      if (!st.isFile()) {
        info.notFile = true;
      } else if (st.size > MAX_FILE_BYTES) {
        info.oversize = true;
      } else {
        const buf = await readFile(abs);
        if (buf.includes(0)) info.binary = true;
        else info.content = buf.toString("utf8");
      }
    } catch {
      // File vanished between diff and read — treat as no body.
      info.oversize = true;
    }
    out.push(info);
  }
  return out;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

const server = createServer((req, res) => {
  void (async () => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method === "POST" && url.pathname === "/ensure") {
        const body = await readBody(req);
        const conversationId = body?.conversationId;
        if (!conversationId)
          return sendJson(res, 400, {
            ok: false,
            error: "conversationId required",
          });
        return sendJson(res, 200, {
          ok: true,
          ...(await ensure(conversationId)),
        });
      }
      if (req.method === "GET" && url.pathname === "/tree") {
        const conversationId = url.searchParams.get("conversationId");
        if (!conversationId)
          return sendJson(res, 400, {
            ok: false,
            error: "conversationId required",
          });
        return sendJson(res, 200, {
          ok: true,
          ...(await tree(conversationId)),
        });
      }
      if (req.method === "POST" && url.pathname === "/eval") {
        if (!authorizedSidecarRequest(req)) {
          return sendJson(res, 401, { ok: false, error: "unauthorized" });
        }
        const body = await readBody(req);
        return sendJson(res, 200, await runEval(body));
      }
      if (url.pathname === "/health") return sendJson(res, 200, { ok: true });
      sendJson(res, 404, { ok: false, error: "not found" });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error?.message ?? String(error) });
    }
  })();
});

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

// Listen only when run as the entrypoint's process (node checkout-sidecar.mjs) — importing this
// module (harnesst's unit tests import classifyRawRecord) must not bind a port.
if (process.argv[1] && process.argv[1].endsWith("checkout-sidecar.mjs")) {
  server.listen(AUX_PORT, "0.0.0.0", () => {
    console.log(`[assistant] checkout sidecar listening on :${AUX_PORT}`);
  });
}
