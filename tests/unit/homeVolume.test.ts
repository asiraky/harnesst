/**
 * homeVolume — the environment-keyed agent-home Docker volume (M6.2). Verifies the naming contract
 * (stability / legal charset / collision-safety, mirroring worldDbName) and that the shim the
 * runtime image embeds survives the base64 round-trip the Dockerfile does it through. The shim's
 * runtime behaviour is proven in eve-docker-shim.test.ts, which executes it.
 */
import { describe, expect, it } from "vitest";

import { HARNESST_EVE_DOCKERFILE, EVE_DOCKER_SHIM } from "~/deploy/eve-image.server";
import { homeVolumeName } from "~/seams/oss/deploy.localdocker.server";

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
  it("embeds the shim as base64 that round-trips to EVE_DOCKER_SHIM exactly", () => {
    // Guards the JS-template + Dockerfile quoting: `echo '<b64>' | base64 -d` must reproduce the
    // shim byte-for-byte inside the image (the live smoke exercises the decoded script end-to-end).
    const m = HARNESST_EVE_DOCKERFILE.match(/echo '([A-Za-z0-9+/=]+)' \| base64 -d/);
    expect(m).not.toBeNull();
    expect(Buffer.from(m![1], "base64").toString("utf8")).toBe(EVE_DOCKER_SHIM);
  });
});
