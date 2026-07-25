/**
 * homeVolume — the environment-keyed agent-home Docker volume (M6.2) and the eve-docker shim that
 * mounts it. Verifies the naming contract (stability / legal charset / collision-safety, mirroring
 * worldDbName), that the generated runtime image actually installs the shim, and that the shim
 * source targets ONLY eve's session-role label — never template-build. Pure string assertions; the
 * shim's runtime behaviour is proven in eve-docker-shim.test.ts.
 */
import { describe, expect, it } from "vitest";

import { HARNESST_EVE_DOCKERFILE, EVE_DOCKER_SHIM } from "~/deploy/eve-image.server";
import {
  DEPLOY_HEALTH_TIMEOUT_MS,
  homeVolumeName,
  WAKE_HEALTH_TIMEOUT_MS,
} from "~/seams/oss/deploy.localdocker.server";

describe("homeVolumeName", () => {
  it("is stable for a given worldKey (a redeploy reuses the same home)", () => {
    expect(homeVolumeName("env_abc123")).toBe(homeVolumeName("env_abc123"));
  });

  it("produces a legal docker volume name prefixed harnesst-home-", () => {
    const name = homeVolumeName("Env-With/Weird*Chars");
    // Docker volume charset is [a-zA-Z0-9_.-]; we lowercase so only those, and separators.
    expect(name).toMatch(/^harnesst-home-[a-z0-9_.-]*-[0-9a-f]{8}$/);
    expect(name).toBe(name.toLowerCase());
    expect(name).not.toMatch(/[^a-z0-9_.-]/);
  });

  it("keeps keys that sanitize identically on DISTINCT volumes (sha1 of the raw key)", () => {
    // Both sanitize to "enva" — only the raw-key hash slug keeps them apart.
    expect(homeVolumeName("env*a")).not.toBe(homeVolumeName("env%a"));
  });
});

describe("runtime image installs the shim", () => {
  it("uses the build stage as runtime and starts through eve start", () => {
    expect(HARNESST_EVE_DOCKERFILE).toContain("FROM build");
    expect(HARNESST_EVE_DOCKERFILE).toContain(
      'CMD ["node_modules/.bin/eve", "start"]',
    );
    expect(HARNESST_EVE_DOCKERFILE).not.toContain(
      'CMD ["node", ".output/server/index.mjs"]',
    );
    expect(HARNESST_EVE_DOCKERFILE).not.toContain("COPY --from=build /app/.output");
  });

  it("writes /usr/local/bin/eve-docker and chmods it 0755", () => {
    expect(HARNESST_EVE_DOCKERFILE).toContain("/usr/local/bin/eve-docker");
    expect(HARNESST_EVE_DOCKERFILE).toContain("chmod 0755 /usr/local/bin/eve-docker");
    // base64-decoded into place, so the raw shell must NOT appear inline in the Dockerfile.
    expect(HARNESST_EVE_DOCKERFILE).toContain("base64 -d");
  });

  it("embeds the shim as base64 that round-trips to EVE_DOCKER_SHIM exactly", () => {
    // Guards the JS-template + Dockerfile quoting: `echo '<b64>' | base64 -d` must reproduce the
    // shim byte-for-byte inside the image (the live smoke exercises the decoded script end-to-end).
    const m = HARNESST_EVE_DOCKERFILE.match(/echo '([A-Za-z0-9+/=]+)' \| base64 -d/);
    expect(m).not.toBeNull();
    expect(Buffer.from(m![1], "base64").toString("utf8")).toBe(EVE_DOCKER_SHIM);
  });
});

describe("local docker health budgets", () => {
  it("allows minutes on deploy (first template prewarm) but stays tight on wake", () => {
    expect(DEPLOY_HEALTH_TIMEOUT_MS).toBe(600_000);
    expect(WAKE_HEALTH_TIMEOUT_MS).toBe(120_000);
  });
});

describe("EVE_DOCKER_SHIM targets only the session-role label", () => {
  it("matches eve's session label and mounts /workspace/home", () => {
    expect(EVE_DOCKER_SHIM).toContain("eve.sandbox.role=session");
    expect(EVE_DOCKER_SHIM).toContain("/workspace/home");
  });

  it("has no template-build branch (shared templates must not capture a home volume)", () => {
    expect(EVE_DOCKER_SHIM).not.toContain("template-build");
  });

  it("is a POSIX-sh exec shim overridable via EVE_DOCKER_REAL", () => {
    expect(EVE_DOCKER_SHIM.startsWith("#!/bin/sh")).toBe(true);
    expect(EVE_DOCKER_SHIM).toContain('REAL="${EVE_DOCKER_REAL:-/usr/local/bin/docker}"');
    expect(EVE_DOCKER_SHIM).toContain('exec "$REAL" "$@"');
  });
});
