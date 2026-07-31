import { describe, expect, it, vi } from "vitest";

import {
  homeVolumeName,
  retireLegacySessionSandboxes,
} from "~/seams/oss/deploy.localdocker.server";

describe("session workspace isolation cutover", () => {
  it("removes a legacy whole-volume sandbox but preserves an isolated one", async () => {
    const volume = homeVolumeName("env_1");
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === "ps") return "legacy\nisolated\n";
      if (args.at(-1) === "legacy") return "null";
      if (args.at(-1) === "isolated") {
        return JSON.stringify([
          {
            Source: volume,
            Target: "/workspace/home",
            VolumeOptions: { Subpath: "sessions/eve-sbx-isolated" },
          },
        ]);
      }
      if (args[0] === "rm") return "";
      throw new Error(`unexpected docker call: ${args.join(" ")}`);
    });

    await retireLegacySessionSandboxes("env_1", run);

    expect(run).toHaveBeenCalledWith([
      "ps",
      "-aq",
      "--filter",
      "label=eve.sandbox.role=session",
      "--filter",
      `volume=${volume}`,
    ]);
    expect(run).toHaveBeenCalledWith(["rm", "-f", "legacy"]);
  });

  it("fails closed by retiring a sandbox whose mount metadata cannot be read", async () => {
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === "ps") return "unknown\n";
      if (args[0] === "inspect") throw new Error("daemon race");
      if (args[0] === "rm") return "";
      throw new Error(`unexpected docker call: ${args.join(" ")}`);
    });

    await retireLegacySessionSandboxes("env_1", run);

    expect(run).toHaveBeenCalledWith(["rm", "-f", "unknown"]);
  });
});
