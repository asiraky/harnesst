/**
 * The dev server's public origin on the tailnet.
 *
 * `harnesst.test` resolves to the dev box over the tailnet (dnsmasq `address=/harnesst.test/…`,
 * which answers for every subdomain too). The app origin (`BETTER_AUTH_URL`) is what harnesst
 * puts in share links, preview `frame-ancestors`, invitation emails and Better Auth's own
 * redirects, so a dev server left on `localhost` hands the phone or laptop a link that points at
 * itself and frames that refuse to load. `npm run dev` upgrades a loopback `BETTER_AUTH_URL` to
 * the tailnet host instead, so a fresh checkout works from any tailnet device with no env edits.
 *
 * Hosts follow the shared `.test` convention: the main checkout is `app.harnesst.test:<port>`,
 * a worktree is `app--<worktree-dir>.harnesst.test:<port>`. Cookies ignore the port, so a
 * per-worktree hostname is what keeps each checkout's session cookie apart (each worktree has
 * its own database and auth secret, and sharing one cookie jar signs you out of the others).
 *
 * Development only: vite.config.ts calls this for `vite serve` in development mode. Production
 * runs the built server (`npm start`), which never loads the Vite config.
 */
import { lookup } from "node:dns/promises";
import { statSync } from "node:fs";
import { basename, join } from "node:path";

export const DEV_DOMAIN = "harnesst.test";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);
// A DNS label is at most 63 characters; `app--` takes five.
const MAX_SLUG = 63 - "app--".length;

export function isLoopbackHost(hostname) {
  const host = hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost");
}

/** The worktree directory name as a DNS label fragment, or "" when nothing usable is left. */
export function worktreeSlug(dirName) {
  return dirName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, MAX_SLUG)
    .replace(/^-+|-+$/g, "");
}

/** `app.harnesst.test` for the main checkout, `app--<slug>.harnesst.test` for a worktree. */
export function devHostname({ cwd, isWorktree }) {
  const slug = isWorktree ? worktreeSlug(basename(cwd)) : "";
  return slug ? `app--${slug}.${DEV_DOMAIN}` : `app.${DEV_DOMAIN}`;
}

/** True when `cwd` is a linked git worktree: its `.git` is a file pointing at the main repo. */
export function isGitWorktree(cwd) {
  try {
    return statSync(join(cwd, ".git")).isFile();
  } catch {
    return false;
  }
}

/**
 * Decide the dev app origin.
 *
 * - A non-loopback `BETTER_AUTH_URL` is a deliberate choice (the Cloudflare dev tunnel sets
 *   one per process) and is kept.
 * - `HARNESST_DEV_HOST` names the host outright; `localhost` keeps the loopback origin.
 * - Otherwise the tailnet host is used when it resolves, and the loopback origin when it does
 *   not (a machine off the tailnet, or one without the `harnesst.test` DNS entry).
 *
 * `resolves(hostname)` is injected so the decision is testable without DNS.
 *
 * @returns {Promise<{ origin: string, upgraded: boolean, note?: string }>}
 */
export async function resolveDevOrigin({
  env,
  port,
  cwd,
  isWorktree,
  resolves,
}) {
  const fallback = `http://localhost:${port}`;
  const configured = env.BETTER_AUTH_URL?.trim();
  let current;
  try {
    current = new URL(configured || fallback);
  } catch {
    return { origin: configured, upgraded: false };
  }
  if (!isLoopbackHost(current.hostname)) {
    return { origin: current.origin, upgraded: false };
  }

  const loopbackPort = current.port || String(port);
  const keep = { origin: current.origin, upgraded: false };
  const override = env.HARNESST_DEV_HOST?.trim().toLowerCase();
  if (override) {
    if (isLoopbackHost(override)) return keep;
    if (!/^[a-z0-9.-]+$/.test(override)) {
      return {
        ...keep,
        note: `HARNESST_DEV_HOST must be a bare hostname; ignoring ${override}`,
      };
    }
    return { origin: `http://${override}:${loopbackPort}`, upgraded: true };
  }

  const host = devHostname({ cwd, isWorktree });
  if (!(await resolves(host))) {
    return {
      ...keep,
      note: `${host} does not resolve, so the dev server stays on ${current.origin}`,
    };
  }
  return { origin: `http://${host}:${loopbackPort}`, upgraded: true };
}

/** DNS check for `resolveDevOrigin`, bounded so a dead resolver cannot stall startup. */
export async function hostResolves(hostname, timeoutMs = 1500) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([
      lookup(hostname).then(
        () => true,
        () => false,
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
