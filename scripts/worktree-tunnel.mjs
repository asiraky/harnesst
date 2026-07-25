import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export const DEFAULT_TUNNEL_NAME = "harnesst-dev";
export const DEFAULT_TUNNEL_DOMAIN = "dev.zero8.ai";
export const TUNNEL_SHORT_ID_LENGTH = 8;

export function tunnelSettings(env = process.env) {
  return {
    name: env.HARNESST_TUNNEL_NAME || DEFAULT_TUNNEL_NAME,
    domain: (env.HARNESST_TUNNEL_DOMAIN || DEFAULT_TUNNEL_DOMAIN).toLowerCase(),
    cloudflaredBin: env.HARNESST_CLOUDFLARED_BIN || "cloudflared",
  };
}

export function generateTunnelShortId() {
  return randomBytes(TUNNEL_SHORT_ID_LENGTH / 2).toString("hex");
}

export function sanitizeDnsLabel(value) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "worktree"
  );
}

export function deriveTunnelHost(
  session,
  shortId,
  domain = DEFAULT_TUNNEL_DOMAIN,
) {
  if (!/^[a-f0-9]{8}$/.test(shortId)) {
    throw new Error(
      `invalid tunnel short id "${shortId}"; expected 8 lowercase hex characters`,
    );
  }
  const suffix = `-${shortId}`;
  const label = sanitizeDnsLabel(session)
    .slice(0, 63 - suffix.length)
    .replace(/-$/g, "");
  const normalizedDomain = domain.toLowerCase().replace(/^\.+|\.+$/g, "");
  const host = `${label || "worktree"}${suffix}.${normalizedDomain}`;
  if (host.length > 253 || !isSafeHostname(host)) {
    throw new Error(`derived invalid tunnel hostname "${host}"`);
  }
  return host;
}

export function resolveTunnelDomain(metadata, env = process.env) {
  const hasPersistedDomain =
    metadata != null && Object.hasOwn(metadata, "domain");
  const source = hasPersistedDomain
    ? "persisted tunnel metadata"
    : env.HARNESST_TUNNEL_DOMAIN
      ? "HARNESST_TUNNEL_DOMAIN"
      : "default tunnel configuration";
  const domain = hasPersistedDomain
    ? metadata.domain
    : tunnelSettings(env).domain;
  try {
    // Reuse the hostname derivation validation so every configured domain is
    // guaranteed to produce a DNS-safe worktree hostname.
    deriveTunnelHost("worktree", "00000000", domain);
  } catch (err) {
    throw new Error(`invalid domain from ${source}: ${err.message}`);
  }
  return domain.toLowerCase().replace(/^\.+|\.+$/g, "");
}

export function enrichPortEntry(
  entry,
  session,
  domain = DEFAULT_TUNNEL_DOMAIN,
) {
  if (
    !entry ||
    ![entry.dev, entry.splitter, entry.instance].every(Number.isInteger)
  ) {
    throw new Error(
      "cannot enrich an entry without integer dev, splitter, and instance ports",
    );
  }
  if (entry.tunnelShortId || entry.tunnelHost) {
    if (!entry.tunnelShortId || !entry.tunnelHost) {
      throw new Error(
        "tunnel identity is incomplete; tunnelShortId and tunnelHost must be stored together",
      );
    }
    if (
      !/^[a-f0-9]{8}$/.test(entry.tunnelShortId) ||
      !isSafeHostname(entry.tunnelHost)
    ) {
      throw new Error("stored tunnel identity is invalid");
    }
    return entry;
  }
  const tunnelShortId = generateTunnelShortId();
  return {
    ...entry,
    tunnelShortId,
    tunnelHost: deriveTunnelHost(session, tunnelShortId, domain),
  };
}

export function isSafeHostname(host) {
  if (
    typeof host !== "string" ||
    host.length > 253 ||
    host.includes(":") ||
    host.includes("/")
  )
    return false;
  return host
    .split(".")
    .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function yamlString(value) {
  return JSON.stringify(value);
}

export function renderTunnelConfig(metadata, registry) {
  if (!metadata?.tunnelId || !metadata?.credentialsFile) {
    throw new Error(
      "tunnel metadata must include tunnelId and credentialsFile",
    );
  }
  const seen = new Set();
  const routes = [];
  for (const entry of Object.values(registry || {})) {
    if (!entry?.tunnelHost || !Number.isInteger(entry.dev)) continue;
    if (!isSafeHostname(entry.tunnelHost))
      throw new Error(`invalid tunnel hostname "${entry.tunnelHost}"`);
    if (seen.has(entry.tunnelHost))
      throw new Error(`duplicate tunnel hostname "${entry.tunnelHost}"`);
    seen.add(entry.tunnelHost);
    routes.push({ host: entry.tunnelHost, port: entry.dev });
  }
  routes.sort((a, b) => a.host.localeCompare(b.host));
  return [
    `tunnel: ${yamlString(metadata.tunnelId)}`,
    `credentials-file: ${yamlString(metadata.credentialsFile)}`,
    "ingress:",
    ...routes.flatMap(({ host, port }) => [
      `  - hostname: ${yamlString(host)}`,
      `    service: ${yamlString(`http://localhost:${port}`)}`,
    ]),
    "  - service: http_status:404",
    "",
  ].join("\n");
}

export function parseQuickTunnelUrl(output) {
  const matches =
    String(output).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/gi) || [];
  for (const candidate of matches) {
    try {
      const url = new URL(candidate);
      if (
        url.protocol === "https:" &&
        url.username === "" &&
        url.password === "" &&
        /^[a-z0-9-]+\.trycloudflare\.com$/.test(url.hostname)
      )
        return url.origin;
    } catch {
      // Continue looking through mixed cloudflared output.
    }
  }
  throw new Error(
    "cloudflared did not report a safe https://*.trycloudflare.com URL",
  );
}

export function atomicWrite(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, path);
}

export function readJson(path, fallback = undefined) {
  if (!existsSync(path)) return fallback;
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return parsed;
}

export function writeJson(path, value) {
  atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function getMainCheckoutRoot(cwd = process.cwd()) {
  const result = runSync(
    ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd },
  );
  if (result.code !== 0)
    throw new Error(`not inside a git repository: ${result.stderr.trim()}`);
  return resolve(dirname(result.stdout.trim()));
}

export function tunnelPaths(
  mainRoot,
  worktreeRootDir = process.env.AGENT_WORKTREE_DIR || ".worktrees",
) {
  const dir = join(
    mainRoot,
    ...worktreeRootDir.split(/[\\/]+/).filter(Boolean),
  );
  return {
    dir,
    registry: join(dir, "_ports.json"),
    metadata: join(dir, "_tunnel.json"),
    config: join(dir, "_tunnel.yml"),
    pid: join(dir, "_tunnel.pid"),
    log: join(dir, "_tunnel.log"),
  };
}

export function runSync(argv, options = {}) {
  const [bin, ...args] = argv;
  const result = spawnSync(bin, args, { encoding: "utf8", ...options });
  return {
    code: result.error ? 1 : (result.status ?? 1),
    stdout: result.stdout || "",
    stderr: result.error?.message || result.stderr || "",
  };
}

export function subprocessBaseEnv(env = process.env) {
  const result = {};
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ]) {
    if (env[key] !== undefined) result[key] = env[key];
  }
  return result;
}

export function cloudflaredEnvironment(env = process.env) {
  const result = subprocessBaseEnv(env);
  if (env.TUNNEL_ORIGIN_CERT)
    result.TUNNEL_ORIGIN_CERT = env.TUNNEL_ORIGIN_CERT;
  return result;
}

export function validateTunnelConfig(configPath, env = process.env) {
  const { cloudflaredBin } = tunnelSettings(env);
  const result = runSync(
    [cloudflaredBin, "tunnel", "--config", configPath, "ingress", "validate"],
    { env: cloudflaredEnvironment(env) },
  );
  if (result.code !== 0)
    throw new Error(
      `cloudflared rejected ${configPath}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
}

export function renderAndValidateConfig(
  paths,
  metadata,
  registry,
  env = process.env,
) {
  atomicWrite(paths.config, renderTunnelConfig(metadata, registry));
  validateTunnelConfig(paths.config, env);
}

export function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function processIsManagedConnector(paths, pid) {
  if (!processIsRunning(pid)) return false;
  const command = runSync(["ps", "-p", String(pid), "-o", "command="]);
  return (
    command.code === 0 &&
    /(?:^|\/)cloudflared\b/.test(command.stdout) &&
    command.stdout.includes(paths.config) &&
    /\btunnel\b/.test(command.stdout)
  );
}

export async function replaceManagedConnector(
  paths,
  metadata,
  env = process.env,
) {
  validateTunnelConfig(paths.config, env);
  const oldPid = Number.parseInt(
    existsSync(paths.pid) ? readFileSync(paths.pid, "utf8").trim() : "",
    10,
  );
  mkdirSync(dirname(paths.log), { recursive: true });
  const logFd = openSync(paths.log, "a", 0o600);
  const { cloudflaredBin } = tunnelSettings(env);
  const child = spawn(
    cloudflaredBin,
    ["tunnel", "--config", paths.config, "run", metadata.tunnelId],
    {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: cloudflaredEnvironment(env),
    },
  );
  let spawnError;
  child.on("error", (err) => {
    spawnError = err;
  });
  child.unref();
  closeSync(logFd);
  await new Promise((resolvePromise) =>
    setTimeout(resolvePromise, Number(env.HARNESST_TUNNEL_START_DELAY_MS || 1200)),
  );
  if (spawnError || !processIsManagedConnector(paths, child.pid)) {
    throw new Error(
      `managed cloudflared connector failed during startup${spawnError ? `: ${spawnError.message}` : `; inspect ${paths.log}`}`,
    );
  }
  atomicWrite(paths.pid, `${child.pid}\n`);
  if (processIsManagedConnector(paths, oldPid) && oldPid !== child.pid) {
    try {
      process.kill(oldPid, "SIGTERM");
    } catch {
      /* It exited after the probe. */
    }
  }
  return child.pid;
}

export function stopManagedConnector(paths) {
  const pid = Number.parseInt(
    existsSync(paths.pid) ? readFileSync(paths.pid, "utf8").trim() : "",
    10,
  );
  if (processIsManagedConnector(paths, pid)) process.kill(pid, "SIGTERM");
  if (existsSync(paths.pid)) unlinkSync(paths.pid);
}

export function configDigest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}
