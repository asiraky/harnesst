/**
 * removeInstance — tearing down an instance also removes the sandbox template builds it started
 * (labelled by the eve-docker shim), and a problem with those builds never fails the teardown.
 */
import { describe, expect, it, vi } from "vitest";

import { removeInstance } from "~/seams/oss/deploy.localdocker.server";

const BUILDS_FILTER = [
  "ps",
  "-aq",
  "--filter",
  "label=eve.sandbox.role=template-build",
  "--filter",
  "label=harnesst.instance=harnesst-inst-dep1",
];

describe("removeInstance", () => {
  it("removes the instance, then the template builds it left behind", async () => {
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === "ps") return "build-a\nbuild-b\n";
      if (args[0] === "rm") return "";
      throw new Error(`unexpected docker call: ${args.join(" ")}`);
    });

    await removeInstance("harnesst-inst-dep1", run);

    expect(run.mock.calls.map(([args]) => args)).toEqual([
      ["rm", "-f", "harnesst-inst-dep1"],
      BUILDS_FILTER,
      ["rm", "-f", "build-a", "build-b"],
    ]);
  });

  it("still reaps builds when the instance container is already gone", async () => {
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === "rm" && args[2] === "harnesst-inst-dep1") {
        throw new Error("Error response from daemon: No such container: harnesst-inst-dep1");
      }
      if (args[0] === "ps") return "build-a\n";
      if (args[0] === "rm") return "";
      throw new Error(`unexpected docker call: ${args.join(" ")}`);
    });

    await removeInstance("harnesst-inst-dep1", run);

    expect(run).toHaveBeenCalledWith(["rm", "-f", "build-a"]);
  });

  it("issues no second rm when the instance left no builds", async () => {
    const run = vi.fn(async (args: string[]) => (args[0] === "ps" ? "\n" : ""));

    await removeInstance("harnesst-inst-dep1", run);

    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not fail the teardown when the builds can't be listed or removed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === "ps") throw new Error("daemon hiccup");
      return "";
    });

    await expect(removeInstance("harnesst-inst-dep1", run)).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it("still fails when the instance itself can't be removed", async () => {
    const run = vi.fn(async () => {
      throw new Error("permission denied");
    });

    await expect(removeInstance("harnesst-inst-dep1", run)).rejects.toThrow("permission denied");
  });
});
