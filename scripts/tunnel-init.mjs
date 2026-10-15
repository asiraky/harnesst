#!/usr/bin/env node
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  cloudflaredEnvironment,
  getMainCheckoutRoot,
  originCertPath,
  originCertZone,
  readJson,
  rehomeRegistry,
  renderAndValidateConfig,
  runSync,
  tunnelPaths,
  tunnelSettings,
  writeJson,
} from "./worktree-tunnel.mjs";

function die(message) {
  console.error(`tunnel-init: ${message}`);
  process.exit(1);
}

function cloudflareFailure(detail) {
  die(
    `${detail}\nAuthenticate this machine first with \`cloudflared tunnel login\`, then rerun \`npm run tunnel:init\`.`,
  );
}

function parseJsonOutput(result, operation) {
  if (result.code !== 0)
    cloudflareFailure(
      `${operation} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    die(`${operation} returned invalid JSON: ${err.message}`);
  }
}

async function main() {
  let root;
  try {
    root = getMainCheckoutRoot();
  } catch (err) {
    die(err.message);
  }
  const paths = tunnelPaths(root);
  const settings = tunnelSettings();
  const version = runSync([settings.cloudflaredBin, "--version"], {
    env: cloudflaredEnvironment(),
  });
  if (version.code !== 0)
    die(
      `cloudflared is required but was not found (${version.stderr.trim()}). Install it and retry.`,
    );

  let registry = readJson(paths.registry, {});
  const existing = readJson(paths.metadata, null);
  if (existing) {
    if (!existsSync(existing.credentialsFile)) {
      die(
        `stored credentials file is missing at ${existing.credentialsFile}; run \`cloudflared tunnel login\` and repair or remove ${paths.metadata}`,
      );
    }
    try {
      renderAndValidateConfig(paths, existing, registry);
    } catch (err) {
      die(err.message);
    }
    console.log(
      `tunnel-init: ${existing.tunnelName} (${existing.tunnelId}) is already initialized`,
    );
    console.log(`  config: ${paths.config}`);
    console.log(`  domain: <worktree>.${existing.domain}`);
    return;
  }

  const originCert = originCertPath();
  if (!existsSync(originCert)) {
    cloudflareFailure(
      `Cloudflare origin certificate was not found at ${originCert}. No account resources were changed.`,
    );
  }
  const cfEnv = cloudflaredEnvironment({
    ...process.env,
    TUNNEL_ORIGIN_CERT: originCert,
  });
  const listed = parseJsonOutput(
    runSync([settings.cloudflaredBin, "tunnel", "list", "-o", "json"], {
      env: cfEnv,
    }),
    "listing Cloudflare tunnels",
  );
  const matches = (Array.isArray(listed) ? listed : []).filter(
    (item) => item.name === settings.name,
  );
  if (matches.length > 1)
    die(
      `found multiple tunnels named ${settings.name}; remove duplicates before retrying`,
    );

  let tunnel = matches[0];
  if (!tunnel) {
    tunnel = parseJsonOutput(
      runSync(
        [
          settings.cloudflaredBin,
          "tunnel",
          "create",
          "-o",
          "json",
          settings.name,
        ],
        { env: cfEnv },
      ),
      `creating tunnel ${settings.name}`,
    );
  }
  const tunnelId = tunnel.id || tunnel.uuid;
  if (!tunnelId) die("cloudflared did not return a tunnel UUID");
  const credentialsFile = resolve(
    process.env.HARNESST_TUNNEL_CREDENTIALS_FILE ||
      tunnel.credentials_file ||
      tunnel.credentialsFile ||
      join(homedir(), ".cloudflared", `${tunnelId}.json`),
  );
  if (!existsSync(credentialsFile)) {
    die(
      `tunnel credentials were not found at ${credentialsFile}; Cloudflare login/create did not complete successfully`,
    );
  }

  // Worktree hosts go directly under the zone `cloudflared tunnel login`
  // authorized, unless HARNESST_TUNNEL_DOMAIN pins one. DNS records are made
  // per host by `npm run tunnel`, never as a wildcard: the zone may also host
  // real services.
  const domain = process.env.HARNESST_TUNNEL_DOMAIN
    ? settings.domain
    : (await originCertZone(originCert)) || settings.domain;
  const metadata = {
    tunnelId,
    tunnelName: settings.name,
    credentialsFile,
    domain,
  };
  try {
    const moved = rehomeRegistry(registry, domain);
    if (moved !== registry) writeJson(paths.registry, moved);
    registry = moved;
    renderAndValidateConfig(paths, metadata, registry, cfEnv);
  } catch (err) {
    die(err.message);
  }
  writeJson(paths.metadata, metadata);

  console.log(`tunnel-init: initialized ${settings.name} (${tunnelId})`);
  console.log(`  hosts:    <worktree>.${domain} (DNS added per host by npm run tunnel)`);
  console.log(`  config:   ${paths.config}`);
  console.log(
    `  metadata: ${paths.metadata} (non-secret; credentials remain at ${credentialsFile})`,
  );
  console.log(
    "  warning: worktree tunnel hosts expose development servers to the public internet",
  );
}

main().catch((err) => die(err.stack || err.message));
