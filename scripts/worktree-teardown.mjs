#!/usr/bin/env node
/**
 * worktree-teardown.mjs
 *
 * Remove a per-feature worktree created by `worktree-setup.mjs`.
 *
 * Usage (from main repo root):
 *   node scripts/worktree-teardown.mjs <name>
 *
 * Called by the global `clawd -r <name>` launcher (~/.claude/clawd.sh). The name is NOT
 * validated — removal must work on bare names and convention-following ones
 * (`feature/tanga-integration`) alike. Derivation of dir / DB matches
 * `worktree-setup.mjs` exactly.
 *
 * What it does:
 *   1. `git worktree remove --force <root>/.worktrees/<dir>`
 *   2. Drops the worktree's Postgres database inside the shared
 *      `harnesst-postgres` docker container via `docker exec` (no host-side
 *      psql required). Warns and continues if the container is down or the
 *      drop fails — never blocks port registry cleanup.
 *   3. Removes the feature's entry from `.worktrees/_ports.json`,
 *      freeing its port slot for future worktrees.
 *
 * The local branch is intentionally preserved — removing the worktree
 * shouldn't discard the branch ref or its commits.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  processIsManagedConnector,
  readJson,
  renderAndValidateConfig,
  replaceManagedConnector,
  tunnelPaths,
} from "./worktree-tunnel.mjs";

const PG_CONTAINER = "harnesst-postgres";
const WORKTREE_ROOT_DIR = process.env.AGENT_WORKTREE_DIR ?? ".worktrees";

function die(message) {
  console.error(`worktree-teardown: ${message}`);
  process.exit(1);
}

function repoPath(root, relPath, ...parts) {
  return join(root, ...relPath.split(/[\\/]+/).filter(Boolean), ...parts);
}

/**
 * Parse a feature argument for teardown. No validation — removal must work on
 * whatever worktree/branch/DB was created, regardless of naming convention.
 * Derivation matches `worktree-setup.mjs`:
 *   - dir      : input with `/` → `-`  (worktree directory + registry key)
 *   - dbSuffix : input with `/` and `-` → `_`  (suffix on canonical DB name)
 */
function parseFeature(input) {
  const dir = input.replace(/\//g, "-");
  const dbSuffix = input.replace(/[-/]/g, "_");
  return { full: input, dir, dbSuffix };
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

function parseEnvFile(text) {
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

function quoteArgv(argv) {
  return argv
    .map((a) =>
      /[^A-Za-z0-9_\-./=]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a,
    )
    .join(" ");
}

/**
 * Preflight: confirm the shared Postgres container is running. Teardown must
 * not abort on a stopped container (the user may have already removed their
 * docker stack) — so this warns and returns false instead of dying.
 */
function pgContainerRunning() {
  const res = run([
    "docker",
    "inspect",
    "-f",
    "{{.State.Running}}",
    PG_CONTAINER,
  ]);
  if (res.code !== 0 || res.stdout.trim() !== "true") {
    const detail = res.stderr.trim() || res.stdout.trim() || "unknown error";
    console.warn(
      `worktree-teardown: ${PG_CONTAINER} container is not running (${detail}); skipping DB cleanup. Start it with 'docker compose up -d postgres' and re-run if you want the DB dropped.`,
    );
    return false;
  }
  return true;
}

function dropWorktreeDb(root, feat) {
  const mainEnvPath = join(root, ".env.local");
  if (!existsSync(mainEnvPath)) {
    console.warn(
      `worktree-teardown: main .env.local not found at ${mainEnvPath}; skipping DB cleanup`,
    );
    return;
  }
  const parsed = parseEnvFile(readFileSync(mainEnvPath, "utf8"));
  if (!parsed.DATABASE_URL) {
    console.warn(
      "worktree-teardown: main .env.local missing DATABASE_URL; skipping DB cleanup",
    );
    return;
  }
  let url;
  try {
    url = new URL(parsed.DATABASE_URL);
  } catch (err) {
    console.warn(
      `worktree-teardown: invalid DATABASE_URL (${err.message}); skipping DB cleanup`,
    );
    return;
  }
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const canonical = decodeURIComponent(
    url.pathname.replace(/^\//, "").split("/")[0] ?? "",
  );
  if (!user || !canonical) {
    console.warn(
      "worktree-teardown: DATABASE_URL missing user or database name; skipping DB cleanup",
    );
    return;
  }

  if (!pgContainerRunning()) return;

  const target = `${canonical}_${feat.dbSuffix}`;

  // Drop via `docker exec` so we don't need host-side psql. `feat.dbSuffix` is
  // produced by replacing `/` and `-` with `_` in the user-supplied name, so
  // it only contains characters from the original input with those swaps.
  // The quoted SQL identifier below handles arbitrary characters safely, but
  // the typical shape is `[a-z0-9_]+`.
  const argv = [
    "docker",
    "exec",
    "-e",
    `PGPASSWORD=${password}`,
    PG_CONTAINER,
    "psql",
    "-U",
    user,
    "-d",
    "postgres",
    "-c",
    `DROP DATABASE IF EXISTS "${target}" WITH (FORCE)`,
  ];
  const res = run(argv);
  if (res.code !== 0) {
    console.warn(
      `worktree-teardown: failed to drop database "${target}" (via docker exec): ${res.stderr.trim()} [cmd: ${quoteArgv(argv)}]`,
    );
    return;
  }
  console.log(`worktree-teardown: dropped database "${target}"`);
}

async function main() {
  const input = process.argv[2];
  if (!input) {
    die(
      "missing feature name. usage: node scripts/worktree-teardown.mjs <name>",
    );
  }
  const feat = parseFeature(input);

  const root = getRepoRoot();
  const worktreePath = repoPath(root, WORKTREE_ROOT_DIR, feat.dir);
  if (!existsSync(worktreePath)) die(`worktree not found at ${worktreePath}`);

  const paths = tunnelPaths(root, WORKTREE_ROOT_DIR);

  const removeResult = run([
    "git",
    "worktree",
    "remove",
    "--force",
    worktreePath,
  ]);
  if (removeResult.code !== 0) {
    die(
      `git worktree remove failed: ${removeResult.stderr.trim() || removeResult.stdout.trim()}`,
    );
  }

  dropWorktreeDb(root, feat);

  const registryPath = paths.registry;
  if (existsSync(registryPath)) {
    const text = readFileSync(registryPath, "utf8");
    if (text.trim()) {
      try {
        const registry = JSON.parse(text);
        if (feat.dir in registry) {
          delete registry[feat.dir];
          const tmp = `${registryPath}.tmp`;
          writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`);
          renameSync(tmp, registryPath);

          const metadata = readJson(paths.metadata, null);
          if (metadata) {
            try {
              renderAndValidateConfig(paths, metadata, registry);
              const oldPid = Number.parseInt(
                existsSync(paths.pid)
                  ? readFileSync(paths.pid, "utf8").trim()
                  : "",
                10,
              );
              if (processIsManagedConnector(paths, oldPid)) {
                await replaceManagedConnector(paths, metadata);
                console.log(
                  "worktree-teardown: reloaded the managed Cloudflare connector",
                );
              }
            } catch (err) {
              console.warn(
                `worktree-teardown: tunnel cleanup failed: ${err.message}`,
              );
            }
          }
        }
      } catch (err) {
        console.warn(
          `worktree-teardown: failed to update ${registryPath}: ${err.message}`,
        );
      }
    }
  }

  console.log(
    `worktree-teardown: removed worktree "${feat.full}" (dir: ${feat.dir})`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((err) => die(err.stack || err.message));
}
