/**
 * homeVolume — the environment-keyed Docker volumes (agent home, M6.2; eve world data, #288).
 * Verifies the naming contract (stability / legal charset / collision-safety, mirroring
 * worldDbName) and that the shim the runtime image embeds survives the base64 round-trip the
 * Dockerfile does it through. The shim's runtime behaviour is proven in eve-docker-shim.test.ts,
 * which executes it.
 */
import { describe, expect, it } from "vitest";

import {
  HARNESST_EVE_DOCKERFILE,
  EVE_DOCKER_SHIM,
} from "~/deploy/eve-image.server";
import {
  homeVolumeName,
  supportsVolumeSubpath,
  worldDataVolumeName,
} from "~/seams/oss/deploy.localdocker.server";

describe("supportsVolumeSubpath", () => {
  it("accepts Docker Engine 26+ and refuses older or malformed daemon versions", () => {
    expect(supportsVolumeSubpath("26.0.0")).toBe(true);
    expect(supportsVolumeSubpath("29.1.3")).toBe(true);
    expect(supportsVolumeSubpath("25.0.5")).toBe(false);
    expect(supportsVolumeSubpath("unknown")).toBe(false);
  });
});

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

describe("worldDataVolumeName", () => {
  it("is stable for a given worldKey (a redeploy reattaches the same world store)", () => {
    expect(worldDataVolumeName("env_abc123")).toBe(
      worldDataVolumeName("env_abc123"),
    );
  });

  it("produces a legal docker volume name prefixed harnesst-world-", () => {
    const name = worldDataVolumeName("Env-With/Weird*Chars");
    expect(name).toMatch(/^harnesst-world-[a-z0-9_.-]*-[0-9a-f]{8}$/);
    expect(name).toBe(name.toLowerCase());
    expect(name).not.toMatch(/[^a-z0-9_.-]/);
  });

  it("keeps keys that sanitize identically on DISTINCT volumes (sha1 of the raw key)", () => {
    expect(worldDataVolumeName("env*a")).not.toBe(worldDataVolumeName("env%a"));
  });

  it("never collides with the same environment's home volume", () => {
    expect(worldDataVolumeName("env_abc123")).not.toBe(
      homeVolumeName("env_abc123"),
    );
  });
});

describe("runtime image installs the shim", () => {
  it("embeds the shim as base64 that round-trips to EVE_DOCKER_SHIM exactly", () => {
    // Guards the JS-template + Dockerfile quoting: `echo '<b64>' | base64 -d` must reproduce the
    // shim byte-for-byte inside the image (the live smoke exercises the decoded script end-to-end).
    const m = HARNESST_EVE_DOCKERFILE.match(
      /echo '([A-Za-z0-9+/=]+)' \| base64 -d/,
    );
    expect(m).not.toBeNull();
    expect(Buffer.from(m![1], "base64").toString("utf8")).toBe(EVE_DOCKER_SHIM);
  });
});
