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

    await runWorldMigrations("harnesst/proj-x:abc", "postgres://world", runDocker);

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

    await runWorldMigrations("harnesst/proj-x:abc", "postgres://world", runDocker);

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
