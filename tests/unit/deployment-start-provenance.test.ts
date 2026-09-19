import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactProvenance } from "~/deploy/artifact-provenance.server";

const mocks = vi.hoisted(() => ({ run: vi.fn(), verify: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFile: Object.assign(() => {}, {
    [Symbol.for("nodejs.util.promisify.custom")]: mocks.run,
  }),
}));
vi.mock("~/deploy/artifact-provenance.server", async (original) => ({
  ...(await original<object>()),
  verifyArtifactContainer: mocks.verify,
}));

import { localDockerTarget } from "~/seams/oss/deploy.localdocker.server";

const provenance: ArtifactProvenance = {
  version: 1,
  gitSha: "a".repeat(40),
  agentRoot: "agent",
  sourceDigest: "sha256:source",
  contextDigest: "sha256:context",
  files: {},
  platformFiles: [],
  runtimeDigest: "sha256:runtime",
  buildDigest: "sha256:build",
};

beforeEach(() => {
  mocks.run.mockReset().mockResolvedValue({ stdout: "3500", stderr: "" });
  mocks.verify.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("healthy")));
});
afterEach(() => vi.unstubAllGlobals());

describe("local Docker deployment restart", () => {
  it("verifies the restarted container against its deployment snapshot before returning live", async () => {
    const result = await localDockerTarget.start("deployment123", provenance);
    expect(mocks.verify).toHaveBeenCalledWith(expect.stringContaining("deployment123"), provenance);
    expect(result.status).toBe("live");
  });

  it("rejects a healthy restarted container whose artifact no longer matches", async () => {
    mocks.verify.mockRejectedValue(new Error("Artifact verification failed: changed runtime source"));
    await expect(localDockerTarget.start("deployment123", provenance)).rejects.toThrow("Artifact verification failed");
    expect(mocks.run).toHaveBeenCalledWith("docker", ["stop", expect.stringContaining("deployment123")], expect.any(Object));
  });

  it("keeps the separate assistant lifecycle compatible when no source manifest exists", async () => {
    const result = await localDockerTarget.start("assistant123");
    expect(result.status).toBe("live");
    expect(mocks.verify).not.toHaveBeenCalled();
  });
});
