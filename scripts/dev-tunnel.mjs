#!/usr/bin/env node
/**
 * `npm run tunnel` — publish this worktree's dev server at its stable public
 * hostname (<worktree>.<tunnel domain>). Safe to rerun; every step converges:
 *
 *   1. Initializes the shared named tunnel on first use (needs a prior
 *      `cloudflared tunnel login`, which writes ~/.cloudflared/cert.pem).
 *   2. Moves registry hosts onto the tunnel domain if it changed, and
 *      re-renders the shared ingress config from the registry.
 *   3. Creates this host's DNS record (refusing when the login cert is for a
 *      different zone, where cloudflared would mint a junk record).
 *   4. (Re)starts the shared connector only if its config changed.
 *   5. Frees this worktree's own dev + splitter ports, then starts the dev
 *      server with --strictPort so it can never drift to another port.
 *   6. Checks localhost and the public URL answer from the app itself.
 *
 * `--quick` instead uses an ephemeral *.trycloudflare.com URL.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { acquireSetupLock, releaseSetupLock } from "./worktree-setup.mjs";
import {
  cloudflaredEnvironment,
  ensureManagedConnector,
  findWorktreeEntry,
  getMainCheckoutRoot,
  hostInZone,
  originCertPath,
  originCertZone,
  parseQuickTunnelUrl,
  parseRouteDnsHost,
  readJson,
  rehomeRegistry,
  renderAndValidateConfig,
  runSync,
  tunnelPaths,
  tunnelSettings,
  writeJson,
} from "./worktree-tunnel.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));

function die(message) {
  console.error(`dev-tunnel: ${message}`);
  process.exit(1);
}

async function waitForHttp(url, label, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
      });
      // A 4xx is not healthy: Vite's blocked-host 403 and cloudflared's
      // catch-all 404 both mean the request never reached this app.
      if (response.status < 400) return response.status;
      last = `HTTP ${response.status}`;
    } catch (err) {
      last = err.message;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 750));
  }
  throw new Error(`${label} health check timed out (${last})`);
}

function startQuickTunnel(port, env) {
  const { cloudflaredBin } = tunnelSettings(env);
  const child = spawn(
    cloudflaredBin,
    ["tunnel", "--url", `http://localhost:${port}`, "--no-autoupdate"],
    {
      env: cloudflaredEnvironment(env),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  let settled = false;
  const url = new Promise((resolvePromise, reject) => {
    const fail = (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    const inspect = (chunk) => {
      const text = chunk.toString();
      output = `${output}${text}`.slice(-32_000);
      process.stderr.write(text);
      try {
        const parsed = parseQuickTunnelUrl(output);
        if (!settled) {
          settled = true;
          resolvePromise(parsed);
        }
      } catch {
        /* URL has not arrived yet. */
      }
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.on("exit", (code) => {
      fail(
        new Error(
          `cloudflared quick tunnel exited with code ${code} before assigning a URL`,
        ),
      );
    });
    child.on("error", (err) =>
      fail(new Error(`failed to launch cloudflared: ${err.message}`)),
    );
    setTimeout(() => {
      fail(
        new Error(
          "timed out waiting for cloudflared to assign a quick-tunnel URL",
        ),
      );
    }, 30_000).unref();
  });
  return { child, url };
}

function listeningPids(port) {
  const result = runSync([
    "lsof",
    "-nP",
    `-iTCP:${port}`,
    "-sTCP:LISTEN",
    "-t",
  ]);
  return result.stdout
    .split(/\s+/)
    .map((pid) => Number.parseInt(pid, 10))
    .filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid);
}

/** Kill whatever listens on this worktree's own ports (and nothing else). */
async function freePorts(ports) {
  const pids = new Set(ports.flatMap(listeningPids));
  if (pids.size === 0) return;
  console.log(
    `dev-tunnel: stopping pid(s) ${[...pids].join(", ")} on port(s) ${ports.join(", ")}`,
  );
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  for (let i = 0; i < 20 && ports.some((p) => listeningPids(p).length); i++)
    await new Promise((r) => setTimeout(r, 250));
  for (const pid of new Set(ports.flatMap(listeningPids))) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  await new Promise((r) => setTimeout(r, 250));
  const stuck = ports.filter((p) => listeningPids(p).length);
  if (stuck.length) die(`could not free port(s) ${stuck.join(", ")}`);
}

function withLock(paths, fn) {
  acquireSetupLock(paths.lock);
  try {
    return fn();
  } finally {
    releaseSetupLock(paths.lock);
  }
}

async function withLockAsync(paths, fn) {
  acquireSetupLock(paths.lock);
  try {
    return await fn();
  } finally {
    releaseSetupLock(paths.lock);
  }
}

function initializeTunnel(env) {
  console.log("dev-tunnel: stable tunnel not initialized; running tunnel-init");
  const result = spawnSync(
    process.execPath,
    [join(scriptsDir, "tunnel-init.mjs")],
    { stdio: "inherit", env },
  );
  if (result.status !== 0) die("tunnel-init failed (see above)");
}

async function routeDns(metadata, host, env) {
  const certPath = originCertPath(env);
  if (!existsSync(certPath))
    die(
      `no Cloudflare login at ${certPath}. Run \`cloudflared tunnel login\` and authorize the ${metadata.domain} zone, then rerun.`,
    );
  const zone = await originCertZone(certPath);
  if (zone && !hostInZone(host, zone))
    die(
      `the Cloudflare login (${certPath}) is for zone ${zone}, but this tunnel serves ${metadata.domain}. Run \`cloudflared tunnel login\` and authorize ${metadata.domain}, then rerun.`,
    );
  const { cloudflaredBin } = tunnelSettings(env);
  const result = runSync(
    [cloudflaredBin, "tunnel", "route", "dns", metadata.tunnelId, host],
    { env: { ...cloudflaredEnvironment(env), TUNNEL_ORIGIN_CERT: certPath } },
  );
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.code !== 0)
    die(`creating the DNS record for ${host} failed: ${output.trim()}`);
  const routed = parseRouteDnsHost(output);
  if (routed && routed !== host)
    die(
      `cloudflared routed ${routed} instead of ${host}: the login cert is for another zone. Delete that record in Cloudflare, run \`cloudflared tunnel login\` for ${metadata.domain}, and rerun.`,
    );
}

async function main() {
  const args = process.argv.slice(2);
  const quickIndex = args.indexOf("--quick");
  const quick = quickIndex !== -1;
  if (quick) args.splice(quickIndex, 1);
  if (args[0] === "--") args.shift();

  const envPath = new URL("../.env.local", import.meta.url);
  if (!existsSync(envPath))
    die(".env.local is missing; run the worktree setup script first");
  // node:util parseEnv handles multi-line quoted values (the GitHub App PEM);
  // a line-by-line parse truncates them, and the truncated value in
  // process.env shadows Vite's own .env.local load.
  const fileEnv = parseEnv(readFileSync(envPath, "utf8"));
  const port = Number(fileEnv.PORT);
  if (!Number.isInteger(port))
    die(
      ".env.local does not contain a valid PORT; run this from a worktree, not the main checkout",
    );
  const splitterPort = Number(fileEnv.HARNESST_SPLITTER_PORT);
  let root;
  try {
    root = getMainCheckoutRoot();
  } catch (err) {
    die(err.message);
  }
  const paths = tunnelPaths(root);
  const branch = runSync(["git", "branch", "--show-current"]).stdout.trim();
  const key = branch.replace(/\//g, "-") || basename(process.cwd());

  const childEnv = { ...process.env, ...fileEnv };
  const { cloudflaredBin } = tunnelSettings(childEnv);
  if (runSync([cloudflaredBin, "--version"]).code !== 0)
    die(
      "cloudflared was not found (PATH, ~/.local/bin, /usr/local/bin). Install it, or set HARNESST_CLOUDFLARED_BIN.",
    );
  childEnv.HARNESST_CLOUDFLARED_BIN = cloudflaredBin;

  let tunnelChild = null;
  let publicUrl;
  if (quick) {
    await freePorts([port, splitterPort].filter(Number.isInteger));
    const quickTunnel = startQuickTunnel(port, childEnv);
    tunnelChild = quickTunnel.child;
    try {
      publicUrl = await quickTunnel.url;
    } catch (err) {
      die(err.message);
    }
  } else {
    if (!readJson(paths.metadata, null)) initializeTunnel(childEnv);
    const metadata = readJson(paths.metadata, null);
    if (!metadata) die("tunnel metadata is still missing after tunnel-init");

    let host;
    try {
      host = withLock(paths, () => {
        const registry = readJson(paths.registry, {});
        const moved = rehomeRegistry(registry, metadata.domain);
        if (moved !== registry) writeJson(paths.registry, moved);
        const found = findWorktreeEntry(moved, key, port);
        if (!found?.entry?.tunnelHost)
          throw new Error(
            "this worktree has no tunnel host in the ports registry; rerun worktree setup",
          );
        renderAndValidateConfig(paths, metadata, moved, childEnv);
        return found.entry.tunnelHost;
      });
    } catch (err) {
      die(err.message);
    }
    await routeDns(metadata, host, childEnv);
    try {
      const { pid, restarted } = await withLockAsync(paths, () =>
        ensureManagedConnector(paths, metadata, childEnv),
      );
      console.log(
        `dev-tunnel: connector pid ${pid} ${restarted ? "(re)started" : "already serving the current config"}`,
      );
    } catch (err) {
      die(err.message);
    }
    publicUrl = `https://${host}`;
    await freePorts([port, splitterPort].filter(Number.isInteger));
  }

  // Better Auth is served by this app under /api/auth, so a tunnel only needs the
  // public same-origin base URL. There is no third-party callback registry to mutate.
  childEnv.BETTER_AUTH_URL = publicUrl;
  childEnv.HARNESST_TUNNEL_URL = publicUrl;
  childEnv.HARNESST_PUBLIC_ORIGIN = publicUrl;
  console.log(`dev-tunnel: public URL ${publicUrl}`);
  console.log(
    "dev-tunnel: WARNING: this development server is publicly reachable",
  );

  // --strictPort: a stale server on PORT must fail loudly, not push Vite onto
  // PORT+1 where the tunnel does not point.
  const dev = spawn("npm", ["run", "dev", "--", "--strictPort", ...args], {
    env: childEnv,
    stdio: "inherit",
  });
  let shuttingDown = false;
  const shutdown = (signal = "SIGTERM") => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (dev.exitCode === null) dev.kill(signal);
    if (tunnelChild?.exitCode === null) tunnelChild.kill(signal);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    await waitForHttp(`http://localhost:${port}`, "localhost");
    console.log(`dev-tunnel: PASS localhost http://localhost:${port}`);
    await waitForHttp(publicUrl, "public tunnel", 60_000);
    console.log(`dev-tunnel: PASS public ${publicUrl}`);
  } catch (err) {
    console.error(`dev-tunnel: FAIL ${err.message}`);
    console.error(
      "dev-tunnel: An HTTP 502/Bad Gateway usually means cloudflared cannot reach the local origin; inspect the dev server and tunnel log.",
    );
    shutdown();
    process.exitCode = 1;
  }
  const exitCode = await new Promise((resolvePromise) =>
    dev.on("exit", (code) => resolvePromise(code ?? 1)),
  );
  if (tunnelChild?.exitCode === null) tunnelChild.kill("SIGTERM");
  process.exitCode ||= exitCode;
}

main().catch((err) => die(err.stack || err.message));
