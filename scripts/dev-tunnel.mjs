#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  getMainCheckoutRoot,
  cloudflaredEnvironment,
  parseQuickTunnelUrl,
  readJson,
  replaceManagedConnector,
  tunnelPaths,
  tunnelSettings,
} from "./worktree-tunnel.mjs";

function die(message) {
  console.error(`dev-tunnel: ${message}`);
  process.exit(1);
}

function parseEnv(text) {
  const result = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at < 1) continue;
    let value = line.slice(at + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    result[line.slice(0, at).trim()] = value;
  }
  return result;
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
      if (response.status < 500) return response.status;
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

async function main() {
  const args = process.argv.slice(2);
  const quickIndex = args.indexOf("--quick");
  const quick = quickIndex !== -1;
  if (quick) args.splice(quickIndex, 1);
  if (args[0] === "--") args.shift();

  const envPath = new URL("../.env.local", import.meta.url);
  if (!existsSync(envPath))
    die(".env.local is missing; run the worktree setup script first");
  const fileEnv = parseEnv(readFileSync(envPath, "utf8"));
  const port = Number(fileEnv.PORT);
  if (!Number.isInteger(port)) die(".env.local does not contain a valid PORT");
  let root;
  try {
    root = getMainCheckoutRoot();
  } catch (err) {
    die(err.message);
  }
  const paths = tunnelPaths(root);
  const registry = readJson(paths.registry, {});
  const branch = await new Promise((resolvePromise) => {
    const child = spawn("git", ["branch", "--show-current"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (c) => {
      out += c;
    });
    child.on("close", () => resolvePromise(out.trim()));
  });
  const key = branch.replace(/\//g, "-") || basename(process.cwd());
  const entry =
    registry[key] ||
    Object.values(registry).find((candidate) => candidate.dev === port);
  if (!entry?.tunnelHost)
    die("this worktree has no stable tunnel identity; rerun worktree setup");

  const childEnv = { ...process.env, ...fileEnv };
  let tunnelChild = null;
  let publicUrl;
  if (quick) {
    const quickTunnel = startQuickTunnel(port, childEnv);
    tunnelChild = quickTunnel.child;
    try {
      publicUrl = await quickTunnel.url;
    } catch (err) {
      die(err.message);
    }
  } else {
    const metadata = readJson(paths.metadata, null);
    if (!metadata)
      die(
        "stable tunnel is not initialized; run `npm run tunnel:init` first (or use `npm run dev:tunnel -- --quick`)",
      );
    if (!existsSync(paths.config))
      die(
        `managed tunnel config is missing at ${paths.config}; rerun worktree setup`,
      );
    try {
      await replaceManagedConnector(paths, metadata, childEnv);
    } catch (err) {
      die(err.message);
    }
    publicUrl = `https://${entry.tunnelHost}`;
  }

  // Better Auth is served by this app under /api/auth, so a tunnel only needs the
  // public same-origin base URL. There is no third-party callback registry to mutate.
  childEnv.BETTER_AUTH_URL = publicUrl;
  childEnv.HARNESST_TUNNEL_URL = publicUrl;
  console.log(`dev-tunnel: public URL ${publicUrl}`);
  console.log(`dev-tunnel: Better Auth URL ${publicUrl}`);
  console.log(
    "dev-tunnel: WARNING: this development server is publicly reachable",
  );

  const dev = spawn(
    "npm",
    ["run", "dev", ...(args.length ? ["--", ...args] : [])],
    { env: childEnv, stdio: "inherit" },
  );
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
