#!/usr/bin/env node
/**
 * worktree-reap.mjs
 *
 * Reconcile `.worktrees/_ports.json` against the worktrees git actually knows
 * about, and decommission the resources of any entry whose worktree is gone.
 *
 * Usage (from the main checkout or any worktree):
 *   node scripts/worktree-reap.mjs [--dry-run]
 *
 * Why this exists: t3code removes a worktree with a plain `git worktree
 * remove --force` when its last thread is deleted (and web/mobile deletes may
 * remove nothing at all) — it has no teardown hook, so the per-worktree
 * Postgres clone, tunnel hostname, and port registry entry it was set up
 * with would leak. clawd's `--remove` runs `worktree-teardown.mjs` itself,
 * but a `.worktrees/` dir deleted by hand leaks the same way.
 *
 * What it does:
 *   1. `git worktree prune` in the main checkout, then reads
 *      `git worktree list --porcelain` — the authoritative set of live
 *      worktrees, wherever they live on disk (`.worktrees/` or t3code's
 *      `~/.t3/worktrees/`).
 *   2. For each `_ports.json` entry, resolves its expected worktree path:
 *      the recorded `path` field (external/t3code worktrees) or
 *      `.worktrees/<key>` (clawd worktrees).
 *   3. Entries whose worktree no longer exists are purged: the cloned
 *      Postgres DB `<canonical>_<key with - → _>` is dropped (matching the
 *      derivation in worktree-setup.mjs / worktree-teardown.mjs) and the
 *      registry entry is deleted, freeing its port triple and tunnel host.
 *   4. If any entries were purged and the stable tunnel is provisioned, the
 *      ingress config is re-rendered and the managed Cloudflare connector is
 *      reloaded — same as worktree-teardown.mjs.
 *
 * A directory that still exists but is not registered with git is skipped
 * with a warning — that's a broken state to inspect, not to silently purge.
 *
 * Pass `--dry-run` to print what would be purged without touching anything.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  getMainCheckoutRoot,
  processIsManagedConnector,
  readJson,
  renderAndValidateConfig,
  replaceManagedConnector,
  tunnelPaths,
} from "./worktree-tunnel.mjs";

const PG_CONTAINER = "harnesst-postgres";
const WORKTREE_ROOT_DIR = process.env.AGENT_WORKTREE_DIR ?? ".worktrees";

function die(message) {
  console.error(`worktree-reap: ${message}`);
  process.exit(1);
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

/** Live worktree paths registered with git, after pruning stale registrations. */
function listLiveWorktreePaths(root) {
  run(["git", "-C", root, "worktree", "prune"]);
  const res = run(["git", "-C", root, "worktree", "list", "--porcelain"]);
  if (res.code !== 0) {
    die(`git worktree list failed: ${res.stderr.trim()}`);
  }
  const paths = new Set();
  for (const line of res.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      paths.add(resolve(line.slice("worktree ".length).trim()));
    }
  }
  return paths;
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

/**
 * Read the canonical Postgres connection from the main checkout's
 * `.env.local` DATABASE_URL, or undefined when it can't be read — reap then
 * still cleans the registry but warns that DBs were left behind.
 */
function readMainPgConn(root) {
  const mainEnvPath = join(root, ".env.local");
  if (!existsSync(mainEnvPath)) {
    console.warn("worktree-reap: main .env.local not found; skipping DB cleanup");
    return undefined;
  }
  const parsed = parseEnvFile(readFileSync(mainEnvPath, "utf8"));
  if (!parsed.DATABASE_URL) {
    console.warn(
      "worktree-reap: main .env.local missing DATABASE_URL; skipping DB cleanup",
    );
    return undefined;
  }
  let url;
  try {
    url = new URL(parsed.DATABASE_URL);
  } catch (err) {
    console.warn(
      `worktree-reap: invalid DATABASE_URL (${err.message}); skipping DB cleanup`,
    );
    return undefined;
  }
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const db = decodeURIComponent(
    url.pathname.replace(/^\//, "").split("/")[0] ?? "",
  );
  if (!user || !db) {
    console.warn(
      "worktree-reap: DATABASE_URL missing user or database name; skipping DB cleanup",
    );
    return undefined;
  }
  return { user, password, db };
}

/** Warns and returns false when the shared Postgres container is down. */
function pgContainerRunning() {
  const res = run(["docker", "inspect", "-f", "{{.State.Running}}", PG_CONTAINER]);
  if (res.code !== 0 || res.stdout.trim() !== "true") {
    const detail = res.stderr.trim() || res.stdout.trim() || "unknown error";
    console.warn(
      `worktree-reap: ${PG_CONTAINER} container is not running (${detail}); skipping DB cleanup. Start it with 'docker compose up -d postgres' and re-run to drop leftover DBs.`,
    );
    return false;
  }
  return true;
}

function dropDatabase(conn, target) {
  const res = run([
    "docker",
    "exec",
    "-e",
    `PGPASSWORD=${conn.password}`,
    PG_CONTAINER,
    "psql",
    "-U",
    conn.user,
    "-d",
    "postgres",
    "-c",
    `DROP DATABASE IF EXISTS "${target}" WITH (FORCE)`,
  ]);
  if (res.code !== 0) {
    console.warn(
      `worktree-reap: failed to drop database "${target}": ${res.stderr.trim()}`,
    );
    return;
  }
  console.log(`worktree-reap: dropped database "${target}"`);
}

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");

  let root;
  try {
    root = getMainCheckoutRoot();
  } catch (err) {
    die(err.message);
  }
  if (!existsSync(join(root, "package.json"))) {
    die(`resolved main root ${root} does not look like the repo root`);
  }
  const livePaths = listLiveWorktreePaths(root);

  const paths = tunnelPaths(root, WORKTREE_ROOT_DIR);
  const registryPath = paths.registry;
  if (!existsSync(registryPath)) {
    console.log(`worktree-reap: no registry at ${registryPath}; nothing to reap`);
    return;
  }
  const text = readFileSync(registryPath, "utf8");
  if (!text.trim()) {
    console.log("worktree-reap: registry is empty; nothing to reap");
    return;
  }
  let registry;
  try {
    registry = JSON.parse(text);
  } catch (err) {
    die(`failed to parse ${registryPath}: ${err.message}`);
  }

  const stale = [];
  for (const [key, entry] of Object.entries(registry)) {
    const expected = entry.path
      ? resolve(entry.path)
      : repoPath(root, WORKTREE_ROOT_DIR, key);
    if (livePaths.has(expected)) continue;
    if (existsSync(expected)) {
      console.warn(
        `worktree-reap: ${expected} exists on disk but is not a registered worktree; skipping "${key}" — inspect it manually (git worktree repair?)`,
      );
      continue;
    }
    stale.push(key);
  }

  if (stale.length === 0) {
    console.log(
      `worktree-reap: all ${Object.keys(registry).length} registry entries have live worktrees; nothing to reap`,
    );
    return;
  }

  if (dryRun) {
    for (const key of stale) {
      console.log(`worktree-reap: [dry-run] would purge "${key}" (worktree gone)`);
    }
    return;
  }

  const conn = readMainPgConn(root);
  const canDropDbs = conn !== undefined && pgContainerRunning();

  for (const key of stale) {
    if (conn && canDropDbs) {
      // Same derivation as worktree-setup.mjs / worktree-teardown.mjs:
      // the registry key is the kebab dir name, DB suffix swaps - for _.
      dropDatabase(conn, `${conn.db}_${key.replace(/-/g, "_")}`);
    }
    delete registry[key];
    console.log(`worktree-reap: purged "${key}" (freed ports + tunnel host)`);
  }

  const tmp = `${registryPath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`);
  renameSync(tmp, registryPath);

  // Re-render the tunnel ingress config from the shrunken registry and reload
  // the managed connector if it's ours — same idiom as worktree-teardown.mjs.
  const metadata = readJson(paths.metadata, null);
  if (metadata) {
    try {
      renderAndValidateConfig(paths, metadata, registry);
      const oldPid = Number.parseInt(
        existsSync(paths.pid) ? readFileSync(paths.pid, "utf8").trim() : "",
        10,
      );
      if (processIsManagedConnector(paths, oldPid)) {
        await replaceManagedConnector(paths, metadata);
        console.log("worktree-reap: reloaded the managed Cloudflare connector");
      }
    } catch (err) {
      console.warn(`worktree-reap: tunnel cleanup failed: ${err.message}`);
    }
  }

  console.log(
    `worktree-reap: done — purged ${stale.length} stale ${stale.length === 1 ? "entry" : "entries"}, ${Object.keys(registry).length} remain`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((err) => die(err.stack || err.message));
}
