#!/usr/bin/env node
/**
 * worktree-setup.mjs
 *
 * Per-worktree environment wiring for harnesst.
 *
 * Usage (from main repo root):
 *   node scripts/worktree-setup.mjs [--skip-validate] <prefix>/<kebab-name>
 *
 * Or, for a worktree that already exists at an arbitrary location (t3code's
 * `runOnWorktreeCreate` script; see t3.json — T3CODE_WORKTREE_PATH is used
 * when the flag and feature name are absent):
 *   node scripts/worktree-setup.mjs --worktree-path <abs-path>
 *
 * In `--worktree-path` mode all derived names (registry key, tunnel label,
 * DB name) come from the worktree directory's basename — stable even when
 * t3code later renames the branch — and the entry in `_ports.json` records
 * the worktree's absolute path so `worktree-reap.mjs` can reconcile it.
 *
 * Called by the global `clawd -w <prefix>/<kebab-name>` launcher (~/.claude/clawd.sh) after
 * `git worktree add` has created the worktree at
 * `.worktrees/<prefix>-<kebab-name>`.
 *
 * Prefix enforces branch-type hygiene (feature, bugfix, hotfix, etc.) and
 * maps to names like so for `feature/tanga-integration`:
 *   - branch        : feature/tanga-integration
 *   - worktree dir  : .worktrees/feature-tanga-integration
 *   - session name  : tanga-integration
 *   - postgres db   : harnesst_feature_tanga_integration
 *
 * Pass `--skip-validate` to bypass the prefix convention (e.g. for one-off
 * non-conforming names). Derivation still works:
 *   - branch/dir    : regen
 *   - session name  : regen
 *   - postgres db   : harnesst_regen
 *
 * The db prefix is not hardcoded: it is whatever database the main checkout's
 * `.env.local` DATABASE_URL points at, suffixed with the worktree slug. Rename
 * that database and every subsequent worktree clone follows it automatically.
 *
 * What it does:
 *   1. Allocates a unique (dev, splitter, instance) port triple for the
 *      worktree, tracked in `.worktrees/_ports.json`. Starts at dev=5273,
 *      splitter=8887, instance=3100 (main uses 5173 / 8787 / 3000).
 *      Allocation and the tunnel-config render happen under a cross-process
 *      lock (`.worktrees/_setup.lock`) so concurrent setups — e.g. an
 *      orchestrator launching several `clawd -w` worktrees at once — can't
 *      double-allocate ports or render the config from a stale registry.
 *   2. Copies the main checkout's `.env.local` into the worktree, overriding
 *      PORT + BETTER_AUTH_URL + DATABASE_URL + the port vars above. Each
 *      worktree gets a stable, independently generated BETTER_AUTH_SECRET.
 *      All other keys (API keys, deploy target) are shared with main. The
 *      shared `.env` (dev SMTP_URL + FROM_EMAIL) is also copied verbatim so
 *      Better Auth's transactional email works in the worktree.
 *   3. Writes a `WORKTREE.md` at the worktree root so humans can inspect the
 *      worktree URL and ports (gitignored), and appends the same context plus
 *      a git-safety section to the worktree's `AGENTS.md` so every agent
 *      harness loads the instructions automatically. `AGENTS.md` is then
 *      marked `skip-worktree` in the worktree's index so the appendix never
 *      dirties `git status` or lands in commits (the `rebase` skill knows how
 *      to un-set/re-set this around merges that touch `AGENTS.md`).
 *   4. Clones the canonical Postgres dev DB into a per-worktree copy so
 *      destructive `db:push` in the worktree doesn't affect main. All Postgres
 *      operations run inside the `harnesst-postgres` docker container via
 *      `docker exec`; no host-side psql / pg_dump / createdb is required.
 *
 * Idempotent: running twice on the same feature reuses the allocated ports
 * and overwrites the generated files.
 *
 * No dependencies outside the Node stdlib.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  enrichPortEntry,
  getMainCheckoutRoot,
  processIsRunning,
  readJson,
  renderAndValidateConfig,
  resolveTunnelDomain,
  tunnelPaths,
} from "./worktree-tunnel.mjs";

const PREFIXES = [
  "feature",
  "feat",
  "bugfix",
  "hotfix",
  "chore",
  "refactor",
  "docs",
  "experiment",
  "issue",
];
const FEATURE_RE = new RegExp(
  `^(?:${PREFIXES.join("|")})\\/[a-z0-9]+(?:-[a-z0-9]+)*$`,
);

const DEV_PORT_START = 5273; // main dev server uses vite's default 5173
const SPLITTER_PORT_START = 8887; // main splitter uses 8787
const INSTANCE_PORT_START = 3100; // main deployed instances allocate from 3000
const PG_CONTAINER = "harnesst-postgres";
const WORKTREE_ROOT_DIR = process.env.AGENT_WORKTREE_DIR ?? ".worktrees";

function die(message) {
  console.error(`worktree-setup: ${message}`);
  process.exit(1);
}

/**
 * Parse a feature argument into its derived names. Derivation is agnostic —
 * it works whether or not the input follows the `<prefix>/<short>` convention,
 * so the same function handles `feature/tanga-integration` or any bare name
 * you pass through `--skip-validate`.
 *
 * - `full`     : input as-is — used as the git branch name
 * - `short`    : everything after the last `/` (or the whole string if no `/`) —
 *                passed to `claude --name` + terminal title
 * - `dir`      : input with `/` → `-` — worktree directory + registry key
 * - `dbSuffix` : input with `/` and `-` both → `_` — suffix appended to the
 *                canonical DB name (e.g. `feature_tanga_integration`)
 */
function parseFeature(input, skipValidate) {
  if (!skipValidate && !FEATURE_RE.test(input)) {
    die(
      `invalid feature name "${input}". expected <prefix>/<kebab-name> where prefix is one of: ${PREFIXES.join(", ")}. Pass --skip-validate to bypass.`,
    );
  }
  const lastSlash = input.lastIndexOf("/");
  const short = lastSlash === -1 ? input : input.slice(lastSlash + 1);
  const dir = input.replace(/\//g, "-");
  const dbSuffix = input.replace(/[-/]/g, "_");
  return { full: input, short, dir, dbSuffix };
}

/**
 * Derive names for an externally-managed worktree (`--worktree-path` mode,
 * e.g. one created by t3code under `~/.t3/worktrees/<repo>/<dir>`).
 *
 * Names key off the worktree directory's basename, not the branch: t3code
 * renames the branch after the first turn (auto-generated from the prompt),
 * so the directory name is the only identity that stays stable for the
 * worktree's whole life. The basename is sanitized to the same kebab shape
 * clawd-derived dirs have, keeping DB names, tunnel labels, and registry
 * keys consistent.
 *
 * `full` (used for display and the AGENTS.md git-safety notes) is the
 * worktree's current branch when available, falling back to the dir name on
 * a detached HEAD.
 */
function parseExternalFeature(worktreePath, branch) {
  const name = basename(worktreePath)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!name) {
    die(`cannot derive a name from worktree path "${worktreePath}"`);
  }
  const full = branch ?? name;
  const lastSlash = full.lastIndexOf("/");
  const short = lastSlash === -1 ? full : full.slice(lastSlash + 1);
  return { full, short, dir: name, dbSuffix: name.replace(/-/g, "_") };
}

/**
 * Branch checked out in the given worktree, or undefined on a detached HEAD.
 * Unlike getCurrentBranch this never dies on detachment — external worktrees
 * (t3code) may legitimately sit on a placeholder state and the caller has a
 * fallback name.
 */
function getWorktreeBranch(cwd) {
  const res = run(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (res.code !== 0)
    die(`failed to read branch of worktree ${cwd}: ${res.stderr.trim()}`);
  const branch = res.stdout.trim();
  return branch === "HEAD" || !branch ? undefined : branch;
}

function repoPath(root, relPath, ...parts) {
  return join(root, ...relPath.split(/[\\/]+/).filter(Boolean), ...parts);
}

function run(cmd, opts = {}) {
  const [bin, ...args] = cmd;
  const result = spawnSync(bin, args, { encoding: "utf8", ...opts });
  if (result.error) {
    return { code: 1, stdout: "", stderr: result.error.message };
  }
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function getRepoRoot() {
  const res = run(["git", "rev-parse", "--show-toplevel"]);
  if (res.code !== 0) die(`not inside a git repository: ${res.stderr.trim()}`);
  return res.stdout.trim();
}

/**
 * Return the symbolic branch name that HEAD points to in the given git
 * directory. Used to capture the base branch the worktree was created from —
 * whatever the main checkout has checked out when this script runs is, by
 * definition, what `git worktree add -b <feature> HEAD` branched from.
 *
 * Dies if HEAD is detached; we need a branch name to target with `gh pr create`.
 */
function getCurrentBranch(cwd) {
  const res = run(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (res.code !== 0)
    die(`failed to read current branch in ${cwd}: ${res.stderr.trim()}`);
  const branch = res.stdout.trim();
  if (branch === "HEAD" || !branch) {
    die(
      `main checkout at ${cwd} is on a detached HEAD; cannot record a base branch for the worktree. ` +
        `Check out the intended base branch (e.g. \`main\`) and re-run.`,
    );
  }
  return branch;
}

function loadRegistry(path) {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  if (!text.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    die(`failed to parse ${path}: ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    die(`registry at ${path} is not a JSON object`);
  }
  return parsed;
}

function saveRegistry(path, registry) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * Mutual exclusion for the shared-state section of setup: the ports-registry
 * read-modify-write and the tunnel ingress config rendered from it. Parallel
 * `clawd -w` invocations (e.g. an orchestrator launching several worktrees at
 * once) would otherwise double-allocate ports or render the config from a
 * stale registry.
 *
 * mkdir is atomic, so the directory is the lock; the holder's pid inside lets
 * a later run steal a lock whose holder died (die() exits without cleanup).
 * Throws (rather than dies) on timeout so callers and tests can handle it.
 */
export function acquireSetupLock(
  lockDir,
  { timeoutMs = 120_000, pollMs = 250, pid = process.pid } = {},
) {
  const pidFile = join(lockDir, "pid");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(pidFile, String(pid));
      return;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    let holder = NaN;
    try {
      holder = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
    } catch {
      // pid file not written yet — the holder is mid-acquire; treat as live.
    }
    if (Number.isInteger(holder) && !processIsRunning(holder)) {
      rmSync(lockDir, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out waiting for the setup lock at ${lockDir}` +
          (Number.isInteger(holder) ? ` (held by pid ${holder})` : "") +
          `; if no other worktree setup is running, remove that directory and retry`,
      );
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pollMs);
  }
}

export function releaseSetupLock(lockDir) {
  rmSync(lockDir, { recursive: true, force: true });
}

/**
 * Allocate (dev, splitter, instance) ports for a worktree.
 *
 * - If the feature already has an entry with all three fields set, reuse it.
 * - Otherwise all three start at their *_PORT_START and increment in lockstep
 *   until none collides with another registry entry.
 */
export function allocatePorts(registry, feature) {
  const existing = registry[feature];
  if (
    existing &&
    typeof existing.dev === "number" &&
    typeof existing.splitter === "number" &&
    typeof existing.instance === "number"
  ) {
    return existing;
  }

  const usedDev = new Set();
  const usedSplitter = new Set();
  const usedInstance = new Set();
  for (const [name, entry] of Object.entries(registry)) {
    if (name === feature) continue;
    if (typeof entry.dev === "number") usedDev.add(entry.dev);
    if (typeof entry.splitter === "number") usedSplitter.add(entry.splitter);
    if (typeof entry.instance === "number") usedInstance.add(entry.instance);
  }

  let dev = DEV_PORT_START;
  let splitter = SPLITTER_PORT_START;
  // Deployed instances allocate upward from their base, so space worktree
  // bases 100 apart to leave each worktree room for multiple instances.
  let instance = INSTANCE_PORT_START;
  while (
    usedDev.has(dev) ||
    usedSplitter.has(splitter) ||
    usedInstance.has(instance)
  ) {
    dev += 1;
    splitter += 1;
    instance += 100;
  }
  return { dev, splitter, instance };
}

/**
 * Return a new postgres:// URL with the database (first path segment)
 * replaced by `db`. Auth, host, port, and query string are preserved.
 */
export function withDatabaseName(url, db) {
  if (!/^[a-z0-9_]+$/.test(db)) {
    throw new Error(`withDatabaseName: unexpected database name "${db}"`);
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw new Error(`withDatabaseName: invalid URL "${url}": ${err.message}`);
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(
      `withDatabaseName: expected postgres:// or postgresql:// URL, got "${parsed.protocol}"`,
    );
  }
  parsed.pathname = `/${db}`;
  return parsed.toString();
}

/**
 * Extract the pieces of DATABASE_URL needed to run createdb/psql/pg_dump
 * inside the shared Postgres container.
 */
export function parseDatabaseUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw new Error(`parseDatabaseUrl: invalid URL "${url}": ${err.message}`);
  }
  const user = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  const db = decodeURIComponent(
    parsed.pathname.replace(/^\//, "").split("/")[0] ?? "",
  );
  if (!user || !db) {
    throw new Error(
      `parseDatabaseUrl: URL "${url}" is missing a user or database name`,
    );
  }
  return { user, password, db };
}

/**
 * Apply overrides to an env file text block. For each key in `overrides`:
 *   - if the file already has a line starting with `KEY=`, replace that line
 *   - otherwise append `KEY=value` at the end
 * Preserves original ordering and comments.
 *
 * Multi-line quoted values (e.g. GITHUB_APP_PRIVATE_KEY's PEM block) are
 * passed through untouched: their continuation lines contain no `=` or don't
 * match an override key, so the line-mapper leaves them alone.
 *
 * The output is always newline-terminated so any later append lands on its
 * own line rather than being glued onto the last `KEY=value`.
 */
export function applyEnvOverrides(original, overrides) {
  const lines = original.split("\n");
  const applied = new Set();

  const result = lines.map((line) => {
    // Skip comments and blank lines
    const trimmed = line.trimStart();
    if (trimmed.startsWith("#") || trimmed === "") return line;
    const eq = line.indexOf("=");
    if (eq === -1) return line;
    const key = line.slice(0, eq).trim();
    if (key in overrides && !applied.has(key)) {
      applied.add(key);
      return `${key}=${overrides[key]}`;
    }
    return line;
  });

  const toAppend = [];
  for (const [key, value] of Object.entries(overrides)) {
    if (!applied.has(key)) toAppend.push(`${key}=${value}`);
  }

  if (toAppend.length > 0) {
    // Ensure there's a newline separating appended keys
    const needsBlank =
      result.length > 0 && result[result.length - 1].trim() !== "";
    if (needsBlank) result.push("");
    result.push(...toAppend);
  }

  const joined = result.join("\n");
  return joined.endsWith("\n") ? joined : `${joined}\n`;
}

/**
 * Minimal env-file reader for looking up single keys (DATABASE_URL). Ignores
 * comments, blank lines, and multi-line continuation lines.
 */
export function parseEnvFile(text) {
  const out = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Reuse a valid worktree Better Auth secret across setup reruns, otherwise
 * create 256 bits of URL-safe entropy. Keeping this in the worktree's ignored
 * `.env.local` prevents one worktree from sharing auth cookies with another.
 */
export function resolveBetterAuthSecret(existing) {
  if (typeof existing === "string" && existing.trim().length >= 32) {
    return existing.trim();
  }
  return randomBytes(32).toString("base64url");
}

function worktreeMdTemplate(
  feat,
  ports,
  targetDb,
  canonicalDb,
  baseBranch,
  dirLabel,
  tunnelActive,
) {
  return `# Worktree: ${feat.full}

You are inside a git worktree at \`${dirLabel}\`, not the main checkout. Use the URL and ports below when starting the dev server or driving the app via browser automation.

## Identity

- **Branch**: \`${feat.full}\`
- **Worktree dir**: \`${dirLabel}\`
- **Session name**: \`${feat.short}\` (terminal title / agent session name)
- **DB**: \`${targetDb}\`

## Base branch

\`${baseBranch}\`

This worktree's branch was created from \`${baseBranch}\`. Any PR opened from this worktree MUST target \`${baseBranch}\` as the base — not whatever the GitHub default branch happens to be.

## URL & ports

- **Local app**: http://localhost:${ports.dev}
- **Public app**: https://${ports.tunnelHost}${tunnelActive ? "" : " (reserved; run `npm run tunnel:init` once from the main checkout to activate)"}
- Dev server port: \`${ports.dev}\` (via \`PORT\` in this worktree's \`.env.local\`)
- Traffic splitter port: \`${ports.splitter}\` (\`HARNESST_SPLITTER_PORT\`)
- Deployed-instance base port: \`${ports.instance}\` (\`HARNESST_INSTANCE_PORT\`)

## How to start the dev server

From the worktree root:
\`\`\`
npm run dev
\`\`\`
This uses the worktree's \`.env.local\` overrides; the server binds to port ${ports.dev}.

For public testing through Cloudflare, run:
\`\`\`
npm run dev:tunnel
\`\`\`
This publishes the server at https://${ports.tunnelHost} and starts the child server with that origin as \`BETTER_AUTH_URL\`. Ordinary \`npm run dev\` remains localhost-only. For an ephemeral fallback, use \`npm run dev:tunnel -- --quick\`.

The public endpoint exposes this development server to the internet. Do not put production data or credentials into it.

Dependencies are already installed by \`scripts/worktree-setup.mjs\` (a local \`node_modules\` exists in the worktree) — no need to run \`npm install\` again.

## Notes for agents

- Do NOT edit \`.env.local\` in this worktree; it is generated by \`scripts/worktree-setup.mjs\` from the main checkout.
- The Postgres database for this worktree is \`${targetDb}\` — a clone of \`${canonicalDb}\` taken at setup time. Destructive \`db:push\` here is safe; it does NOT affect main or other worktrees. When preparing a PR, remember migrations are diffed against the canonical \`${canonicalDb}\` DB, not this clone.
- \`npm run dev\` uses \`BETTER_AUTH_URL=http://localhost:${ports.dev}\`. Tunnel mode overrides it only for the child process; Better Auth remains same-origin under \`/api/auth\`.
`;
}

function gitSafetySection(feat) {
  return `
## Git safety

- You are on branch \`${feat.full}\`, not \`main\`. \`git log\`, \`git status\`, and \`git diff\` refer to this branch only — they will NOT show work from main or other worktrees.
- Do NOT \`git checkout\` a different branch inside this worktree — it breaks the sibling checkout that owns this working directory. If you need to inspect another branch, ask the user.
- The Postgres database is per-worktree (a clone); deployed local-docker instances and other external services may still be shared — confirm with the user before running destructive ops against them.
- \`WORKTREE.md\` and \`.env.local\` are generated per-worktree and gitignored. Do not stage or commit them.
- This worktree's \`AGENTS.md\` has worktree-specific instructions (the section above this one) appended by \`scripts/worktree-setup.mjs\` and is marked \`skip-worktree\` in the local index, so \`git status\` ignores it and normal commits won't include it. Do not unset \`skip-worktree\` or stage \`AGENTS.md\` manually — the \`rebase\` skill handles the one case (a merge aborting on \`AGENTS.md\`) where it must be temporarily unset.
`;
}

/**
 * Return the worktree's AGENTS.md content with the generated appendix
 * replaced/appended. Any prior appendix is stripped first so re-running the
 * script doesn't double-append; the appendix always begins with the
 * `# Worktree: <full>` header emitted by worktreeMdTemplate.
 */
export function withWorktreeAppendix(rawAgentsMd, appendixMarker, appendix) {
  const markerIdx = rawAgentsMd.indexOf(appendixMarker);
  const base = markerIdx === -1 ? rawAgentsMd : rawAgentsMd.slice(0, markerIdx);
  return `${base.replace(/\s*$/, "")}\n\n${appendix}`;
}

/**
 * Verify the shared Postgres container is running before issuing any DB ops.
 * All DB commands in this script are executed via `docker exec`, so the
 * container must be up. Fails hard (via die) with a clear remediation message.
 */
function ensurePgContainerRunning() {
  const res = run([
    "docker",
    "inspect",
    "-f",
    "{{.State.Running}}",
    PG_CONTAINER,
  ]);
  if (res.code !== 0 || res.stdout.trim() !== "true") {
    const detail = res.stderr.trim() || res.stdout.trim() || "unknown error";
    die(
      `${PG_CONTAINER} container is not running (${detail}). Start it with 'docker compose up -d postgres' and try again.`,
    );
  }
}

/**
 * Build the argv for a `docker exec` invocation that runs a Postgres CLI tool
 * inside the shared container with PGPASSWORD injected via `-e`.
 */
function dockerExecArgs(conn, cmd) {
  return [
    "docker",
    "exec",
    "-e",
    `PGPASSWORD=${conn.password}`,
    PG_CONTAINER,
    ...cmd,
  ];
}

function quoteArgv(argv) {
  return argv
    .map((a) =>
      /[^A-Za-z0-9_\-./=]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a,
    )
    .join(" ");
}

function databaseExists(conn, name) {
  // `name` is derived from a kebab-case feature (regex-validated) with
  // hyphens swapped for underscores, so it matches [a-z0-9_]+ and is safe
  // to inline into the SQL literal below.
  const argv = dockerExecArgs(conn, [
    "psql",
    "-U",
    conn.user,
    "-d",
    "postgres",
    "-tAc",
    `SELECT 1 FROM pg_database WHERE datname = '${name}'`,
  ]);
  const res = run(argv);
  if (res.code !== 0) {
    die(
      `psql (via docker exec) failed checking for database ${name}: ${res.stderr.trim()} [cmd: ${quoteArgv(argv)}]`,
    );
  }
  return res.stdout.trim() === "1";
}

function cloneDatabase(conn, canonical, target) {
  console.log(
    `worktree-setup: cloning ${canonical} → ${target} (via docker exec ${PG_CONTAINER}) ...`,
  );

  const createArgv = dockerExecArgs(conn, [
    "createdb",
    "-U",
    conn.user,
    target,
  ]);
  const create = run(createArgv);
  if (create.code !== 0) {
    die(
      `createdb ${target} (via docker exec) failed: ${create.stderr.trim()} [cmd: ${quoteArgv(createArgv)}]`,
    );
  }

  // `docker exec` doesn't pipe between two separate exec calls, so run the
  // entire `pg_dump | psql` pipeline in a single bash invocation inside the
  // container. This also keeps the dump on the container's unix socket —
  // faster than round-tripping bytes through the host.
  const pipeCmd = `set -o pipefail; pg_dump -U ${conn.user} ${canonical} | psql -U ${conn.user} -d ${target}`;
  const dumpArgv = dockerExecArgs(conn, ["bash", "-c", pipeCmd]);
  const dump = run(dumpArgv);
  if (dump.code !== 0) {
    const dropArgv = dockerExecArgs(conn, [
      "dropdb",
      "--if-exists",
      "-U",
      conn.user,
      target,
    ]);
    run(dropArgv);
    die(
      `pg_dump | psql (via docker exec) failed cloning ${canonical} to ${target}: ${dump.stderr.trim()} [cmd: ${quoteArgv(dumpArgv)}]`,
    );
  }
}

function main() {
  // Bare invocation inside a t3code setup terminal: the runner exports
  // T3CODE_WORKTREE_PATH, so `node scripts/worktree-setup.mjs` with no args
  // is equivalent to passing --worktree-path explicitly.
  let argv = process.argv.slice(2);
  if (argv.length === 0 && process.env.T3CODE_WORKTREE_PATH) {
    argv = ["--worktree-path", process.env.T3CODE_WORKTREE_PATH];
  }

  let skipValidate = false;
  let input = "";
  let externalPath;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--skip-validate") {
      skipValidate = true;
      continue;
    }
    if (arg === "--worktree-path") {
      if (externalPath !== undefined) {
        die("--worktree-path may only be provided once");
      }
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        die("missing path after --worktree-path");
      }
      externalPath = value;
      index += 1;
      continue;
    }
    if (!input) {
      input = arg;
      continue;
    }
    die(`unexpected argument "${arg}"`);
  }
  if (input && externalPath !== undefined) {
    die("pass either a feature name or --worktree-path, not both");
  }
  if (!input && externalPath === undefined) {
    die(
      "missing feature name. usage: node scripts/worktree-setup.mjs [--skip-validate] <prefix>/<kebab-name> | --worktree-path <path>",
    );
  }

  let root;
  let worktreePath;
  let feat;
  let dirLabel;
  if (externalPath !== undefined) {
    worktreePath = resolve(externalPath);
    if (!existsSync(worktreePath)) {
      die(
        `worktree not found at ${worktreePath}. create it first via \`git worktree add\`.`,
      );
    }
    feat = parseExternalFeature(worktreePath, getWorktreeBranch(worktreePath));
    try {
      root = getMainCheckoutRoot(worktreePath);
    } catch (err) {
      die(`failed to resolve main repo root from ${worktreePath}: ${err.message}`);
    }
    if (!existsSync(join(root, "package.json"))) {
      die(`resolved main root ${root} does not look like the repo root`);
    }
    dirLabel = worktreePath;
  } else {
    feat = parseFeature(input, skipValidate);
    root = getRepoRoot();
    worktreePath = repoPath(root, WORKTREE_ROOT_DIR, feat.dir);
    if (!existsSync(worktreePath)) {
      die(
        `worktree not found at ${worktreePath}. create it first via \`git worktree add\`.`,
      );
    }
    dirLabel = `${WORKTREE_ROOT_DIR}/${feat.dir}`;
  }

  // Capture the main checkout's current branch as the base the worktree
  // branched from. Must happen before the main checkout moves for any reason;
  // `clawd -w` invokes us immediately after `git worktree add`, so HEAD still
  // points at the intended base.
  const baseBranch = getCurrentBranch(root);

  // Preflight: all subsequent DB operations run via `docker exec`, so the
  // container must be up before we get deep into the setup.
  ensurePgContainerRunning();

  const registryPath = repoPath(root, WORKTREE_ROOT_DIR, "_ports.json");
  const paths = tunnelPaths(root, WORKTREE_ROOT_DIR);
  const tunnelMetadata = readJson(paths.metadata, null);

  // The ports registry and the tunnel config rendered from it are shared
  // across worktrees, so parallel setups must serialize from registry read
  // through config render. Everything after (env files, npm install, DB
  // clone) is per-worktree and runs unlocked. The exit hook releases the
  // lock on the die() paths inside the section; the lockHeld flag keeps it
  // from deleting a lock some later process has since acquired.
  const lockDir = repoPath(root, WORKTREE_ROOT_DIR, "_setup.lock");
  try {
    acquireSetupLock(lockDir);
  } catch (err) {
    die(err.message);
  }
  let lockHeld = true;
  const releaseLock = () => {
    if (!lockHeld) return;
    lockHeld = false;
    releaseSetupLock(lockDir);
  };
  process.on("exit", releaseLock);

  const registry = loadRegistry(registryPath);
  const allocated = allocatePorts(registry, feat.dir);
  let ports;
  try {
    const tunnelDomain = resolveTunnelDomain(tunnelMetadata);
    ports = enrichPortEntry(allocated, feat.short, tunnelDomain);
  } catch (err) {
    die(`failed to assign tunnel identity: ${err.message}`);
  }
  // Record the absolute path for externally-managed worktrees (t3code) so
  // worktree-reap.mjs can reconcile the entry; clawd entries omit it and
  // imply `.worktrees/<key>`.
  registry[feat.dir] =
    externalPath !== undefined ? { ...ports, path: worktreePath } : ports;
  saveRegistry(registryPath, registry);
  if (tunnelMetadata) {
    try {
      renderAndValidateConfig(paths, tunnelMetadata, registry);
    } catch (err) {
      die(`stable tunnel provisioning failed: ${err.message}`);
    }
  }
  releaseLock();

  const mainEnvPath = join(root, ".env.local");
  if (!existsSync(mainEnvPath))
    die(`main .env.local not found at ${mainEnvPath}`);
  const mainEnv = readFileSync(mainEnvPath, "utf8");
  const mainEnvParsed = parseEnvFile(mainEnv);

  const mainDbUrl = mainEnvParsed.DATABASE_URL;
  if (!mainDbUrl) die("main .env.local is missing DATABASE_URL");
  let conn;
  try {
    conn = parseDatabaseUrl(mainDbUrl);
  } catch (err) {
    die(err.message);
  }
  const canonicalDb = conn.db;
  const targetDb = `${canonicalDb}_${feat.dbSuffix}`;

  const priorWorktreeEnvPath = join(worktreePath, ".env.local");
  const priorWorktreeEnv = existsSync(priorWorktreeEnvPath)
    ? parseEnvFile(readFileSync(priorWorktreeEnvPath, "utf8"))
    : {};
  const betterAuthSecret = resolveBetterAuthSecret(
    priorWorktreeEnv.BETTER_AUTH_SECRET,
  );

  const worktreeEnv = applyEnvOverrides(mainEnv, {
    PORT: String(ports.dev),
    BETTER_AUTH_URL: `http://localhost:${ports.dev}`,
    BETTER_AUTH_SECRET: betterAuthSecret,
    DATABASE_URL: withDatabaseName(mainDbUrl, targetDb),
    HARNESST_SPLITTER_PORT: String(ports.splitter),
    HARNESST_INSTANCE_PORT: String(ports.instance),
    HARNESST_TUNNEL_URL: `https://${ports.tunnelHost}`,
  });

  const worktreeMd = worktreeMdTemplate(
    feat,
    ports,
    targetDb,
    canonicalDb,
    baseBranch,
    dirLabel,
    Boolean(tunnelMetadata),
  );

  writeFileSync(join(worktreePath, ".env.local"), worktreeEnv);

  // Propagate the shared dev `.env` (SMTP_URL + FROM_EMAIL) verbatim. Better Auth's
  // transactional email — invitations, password reset, verification — reads these,
  // and they're environment-agnostic (one Mailtrap sandbox for every worktree), so
  // no per-worktree overrides apply. Without this a fresh worktree silently drops
  // every auth email.
  const mainSharedEnvPath = join(root, ".env");
  if (existsSync(mainSharedEnvPath)) {
    writeFileSync(
      join(worktreePath, ".env"),
      readFileSync(mainSharedEnvPath, "utf8"),
    );
  }

  writeFileSync(join(worktreePath, "WORKTREE.md"), worktreeMd);

  // Append the worktree context + git safety rules to AGENTS.md so every
  // agent harness (Claude Code loads it via the CLAUDE.md symlink) picks them
  // up automatically, then mark the file skip-worktree so the appendix never
  // dirties `git status` or sneaks into commits. Idempotent: re-running
  // strips any prior appendix, and re-applying the bit is a no-op.
  const agentsMdPath = join(worktreePath, "AGENTS.md");
  const rawAgentsMd = existsSync(agentsMdPath)
    ? readFileSync(agentsMdPath, "utf8")
    : "";
  writeFileSync(
    agentsMdPath,
    // Marker is the header prefix, not the full `# Worktree: <branch>` line:
    // external worktrees (t3code) rename their branch after the first turn,
    // so a re-run's full header wouldn't match the one already appended.
    withWorktreeAppendix(
      rawAgentsMd,
      "# Worktree: ",
      `${worktreeMd}${gitSafetySection(feat)}`,
    ),
  );
  const skipWorktree = run(
    ["git", "update-index", "--skip-worktree", "AGENTS.md"],
    { cwd: worktreePath },
  );
  if (skipWorktree.code !== 0) {
    die(
      `git update-index --skip-worktree AGENTS.md failed in ${worktreePath}: ${skipWorktree.stderr.trim()}`,
    );
  }
  // Older setups generated a CLAUDE.local.md with the same content; remove it
  // so upgraded worktrees don't load the instructions twice.
  rmSync(join(worktreePath, "CLAUDE.local.md"), { force: true });

  console.log(`worktree-setup: Installing dependencies in ${worktreePath}...`);
  const install = spawnSync("npm", ["install"], {
    cwd: worktreePath,
    stdio: "inherit",
  });
  if (install.status !== 0) {
    die(`npm install failed in ${worktreePath}`);
  }

  if (databaseExists(conn, targetDb)) {
    console.log(
      `worktree-setup: database ${targetDb} already exists, skipping clone`,
    );
  } else {
    cloneDatabase(conn, canonicalDb, targetDb);
  }

  console.log(`worktree-setup: ${feat.full}`);
  console.log(`  branch:    ${feat.full}`);
  console.log(`  dir:       ${feat.dir}`);
  console.log(`  session:   ${feat.short}`);
  console.log(`  base:      ${baseBranch}`);
  console.log(`  dev port:  ${ports.dev}`);
  console.log(`  app url:   http://localhost:${ports.dev}`);
  console.log(
    `  public:    https://${ports.tunnelHost}${tunnelMetadata ? "" : " (reserved; run npm run tunnel:init)"}`,
  );
  console.log(`  splitter:  ${ports.splitter}`);
  console.log(`  instances: ${ports.instance}+`);
  console.log(`  db:        ${targetDb}`);
  console.log(`  guide:     ${join(worktreePath, "WORKTREE.md")}`);
  console.log(
    "  warning:   public tunnel mode exposes the development server to the internet",
  );
}

// Only run main() when executed directly, not when imported for tests.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
