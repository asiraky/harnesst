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
// and the read token stay in this instance process; they are never exposed in any response (the
// sandbox can reach this port over the network but can only read tree state, which is its own work).
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { lstat, mkdir, stat, readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const exec = promisify(execFile);

const AUX_PORT = Number(process.env.HARNESST_AUX_PORT ?? 3100);
const API_URL = (process.env.HARNESST_API_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.HARNESST_ASSISTANT_TOKEN ?? "";
const CHECKOUT_ROOT = process.env.HARNESST_CHECKOUT_ROOT ?? "/workspace/home/checkouts";
const MAX_FILE_BYTES = Number(process.env.HARNESST_SYNC_MAX_BYTES ?? 1024 * 1024);

const checkoutDir = (id) => join(CHECKOUT_ROOT, id.replace(/[^A-Za-z0-9_-]/g, ""));
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
  if (!API_URL || !TOKEN) throw new Error("checkout sidecar: HARNESST_API_URL / HARNESST_ASSISTANT_TOKEN unset");
  const res = await fetch(`${API_URL}/api/assistant/read-token`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.ok === false || !body.token) {
    throw new Error(`read-token failed (${res.status}): ${body?.error ?? "no token"}`);
  }
  const creds = {
    token: body.token,
    owner: body.owner,
    repo: body.repo,
    defaultBranch: body.defaultBranch ?? "main",
    cloneUrl: `https://github.com/${body.owner}/${body.repo}.git`,
  };
  const expiresAtMs = Date.parse(body.expiresAt ?? "") || Date.now() + 50 * 60_000;
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
    await exec("git", [...auth, "clone", "--depth", "50", "--no-single-branch", creds.cloneUrl, dir], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 300_000,
    });
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
  const mergeBase = (await git(dir, ["merge-base", "HEAD", `origin/${base}`]).catch(() => baseTip)).trim();
  let advanced = 0;
  try {
    advanced = Number((await git(dir, ["rev-list", "--count", `${mergeBase}..${baseTip}`])).trim()) || 0;
  } catch {
    advanced = 0;
  }
  return { checkoutPath: dir, branch, baseBranch: base, baseTip, mergeBase, advanced };
}

async function hasRemoteBranch(dir, branch, token) {
  try {
    const out = await git(dir, ["ls-remote", "--heads", "origin", branch], token);
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

  const tmpIndex = join(tmpdir(), `harnesst-idx-${randomBytes(6).toString("hex")}`);
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  try {
    await exec("git", ["-C", dir, "add", "-A"], { env, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
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
        if (!conversationId) return sendJson(res, 400, { ok: false, error: "conversationId required" });
        return sendJson(res, 200, { ok: true, ...(await ensure(conversationId)) });
      }
      if (req.method === "GET" && url.pathname === "/tree") {
        const conversationId = url.searchParams.get("conversationId");
        if (!conversationId) return sendJson(res, 400, { ok: false, error: "conversationId required" });
        return sendJson(res, 200, { ok: true, ...(await tree(conversationId)) });
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
