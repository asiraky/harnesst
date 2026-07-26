#!/usr/bin/env node
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  cloudflaredEnvironment,
  getMainCheckoutRoot,
  readJson,
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

function main() {
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

  const registry = readJson(paths.registry, {});
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
    console.log(`  domain: *.${existing.domain}`);
    return;
  }

  const originCert =
    process.env.HARNESST_CLOUDFLARED_ORIGIN_CERT ||
    process.env.TUNNEL_ORIGIN_CERT ||
    join(homedir(), ".cloudflared", "cert.pem");
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

  const wildcard = `*.${settings.domain}`;
  const dns = runSync(
    [settings.cloudflaredBin, "tunnel", "route", "dns", tunnelId, wildcard],
    { env: cfEnv },
  );
  const dnsOutput = `${dns.stdout}\n${dns.stderr}`;
  if (dns.code !== 0 && !/already exists|record.*exists/i.test(dnsOutput)) {
    cloudflareFailure(
      `provisioning DNS route ${wildcard} failed: ${dns.stderr.trim() || dns.stdout.trim()}`,
    );
  }
  const metadata = {
    tunnelId,
    tunnelName: settings.name,
    credentialsFile,
    domain: settings.domain,
  };
  try {
    renderAndValidateConfig(paths, metadata, registry, cfEnv);
  } catch (err) {
    die(err.message);
  }
  writeJson(paths.metadata, metadata);

  console.log(`tunnel-init: initialized ${settings.name} (${tunnelId})`);
  console.log(`  wildcard: ${wildcard}`);
  console.log(`  config:   ${paths.config}`);
  console.log(
    `  metadata: ${paths.metadata} (non-secret; credentials remain at ${credentialsFile})`,
  );
  console.log(
    "  warning: worktree tunnel hosts expose development servers to the public internet",
  );
}

main();
