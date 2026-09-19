import { describe, expect, it, vi } from "vitest";

import {
  runWorldMigrations,
  WORLD_POSTGRES_SETUP_SCRIPT,
} from "~/seams/oss/deploy.localdocker.server";

describe("runWorldMigrations", () => {
  it("skips when the build-stage image does not contain the Workflow setup script", async () => {
    const runDocker = vi.fn(async (args: string[]) => {
      if (args[0] === "image") return "";
      if (args.includes("test")) throw new Error("missing");
      throw new Error(`unexpected docker call: ${args.join(" ")}`);
    });

    await runWorldMigrations(
      "harnesst/proj-x:abc",
      "postgres://world",
      runDocker,
    );

    expect(runDocker).toHaveBeenCalledTimes(2);
    expect(runDocker).toHaveBeenLastCalledWith([
      "run",
      "--rm",
      "harnesst/proj-x:abc-build",
      "test",
      "-f",
      WORLD_POSTGRES_SETUP_SCRIPT,
    ]);
  });

  it("runs the Workflow setup script when it is present", async () => {
    const runDocker = vi.fn(async (_args: string[]) => "");

    await runWorldMigrations(
      "harnesst/proj-x:abc",
      "postgres://world",
      runDocker,
    );

    expect(runDocker).toHaveBeenCalledTimes(4);
    expect(runDocker.mock.calls[2]?.[0]).toEqual([
      "run",
      "--rm",
      "--add-host",
      "host.docker.internal:host-gateway",
      "-e",
      "WORKFLOW_POSTGRES_URL=postgres://world",
      "harnesst/proj-x:abc-build",
      "node",
      "-e",
      expect.stringContaining("createConnection"),
    ]);
    expect(runDocker.mock.calls[3]?.[0]).toEqual([
      "run",
      "--rm",
      "--add-host",
      "host.docker.internal:host-gateway",
      "-e",
      "WORKFLOW_POSTGRES_URL=postgres://world",
      "harnesst/proj-x:abc-build",
      "node",
      WORLD_POSTGRES_SETUP_SCRIPT,
    ]);
  });

  it("runs migrations using the recorded immutable build image rather than a mutable tag", async () => {
    const runDocker = vi.fn(async (_args: string[]) => "");
    await runWorldMigrations(
      "mutable:tag",
      "postgres://world",
      runDocker,
      "sha256:pinned",
    );
    expect(runDocker.mock.calls[0][0]).toEqual([
      "image",
      "inspect",
      "sha256:pinned",
    ]);
    for (const [args] of runDocker.mock.calls.slice(1)) {
      expect(args).toContain("sha256:pinned");
      expect(args).not.toContain("mutable:tag-build");
    }
  });

  it("fails if the recorded immutable build image is missing", async () => {
    const runDocker = vi.fn(async (_args: string[]) => {
      throw new Error("missing");
    });
    await expect(
      runWorldMigrations(
        "mutable:tag",
        "postgres://world",
        runDocker,
        "sha256:pinned",
      ),
    ).rejects.toThrow("Artifact verification failed");
    expect(runDocker).toHaveBeenCalledOnce();
  });

  it("fails before setup when Postgres is unreachable from the container", async () => {
    const unreachable = new Error("Postgres is unreachable");
    const runDocker = vi.fn(async (args: string[]) => {
      if (args.includes("-e")) throw unreachable;
      return "";
    });

    await expect(
      runWorldMigrations("harnesst/proj-x:abc", "postgres://world", runDocker),
    ).rejects.toBe(unreachable);

    expect(runDocker).toHaveBeenCalledTimes(3);
    expect(runDocker.mock.calls).not.toContainEqual([
      expect.arrayContaining(["node", WORLD_POSTGRES_SETUP_SCRIPT]),
    ]);
  });
});
