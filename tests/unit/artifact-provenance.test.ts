import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { execFile } = vi.hoisted(() => {
  const execFile = vi.fn();
  Object.assign(execFile, {
    [Symbol.for("nodejs.util.promisify.custom")]: (...args: unknown[]) =>
      new Promise((resolve, reject) =>
        execFile(
          ...args,
          (error: Error | null, stdout: string, stderr: string) =>
            error ? reject(error) : resolve({ stdout, stderr }),
        ),
      ),
  });
  return { execFile };
});
vi.mock("node:child_process", () => ({ execFile }));
import {
  type ArtifactProvenance,
  manifestDigest,
  sourceManifest,
  verifyArtifactContainer,
  verifyArtifactImage,
} from "~/deploy/artifact-provenance.server";
const digest = `sha256:${"a".repeat(64)}`;
const provenance: ArtifactProvenance = {
  version: 1,
  gitSha: "commit",
  agentRoot: "agent",
  sourceDigest: "source",
  contextDigest: "context",
  files: {
    "agent/agent.ts":
      "sha256:" + createHash("sha256").update("new").digest("hex"),
  },
  platformFiles: [],
  runtimeDigest: digest,
  buildDigest: digest,
};
let source = "new";
let extra = false;
let actualDigest = digest;
beforeEach(() => {
  source = "new";
  extra = false;
  actualDigest = digest;
  execFile.mockReset();
  execFile.mockImplementation(
    (
      _cmd: string,
      args: string[],
      options: unknown,
      cb?: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const callback = (
        typeof options === "function" ? options : cb
      ) as NonNullable<typeof cb>;
      if (args.includes("inspect")) return callback(null, actualDigest, "");
      try {
        const script = args[args.indexOf("-e") + 1];
        const fakeFs = {
          lstatSync: () => ({ isSymbolicLink: () => false }),
          readFileSync: () => source,
          existsSync: () => true,
          readdirSync: () =>
            ["agent.ts", ...(extra ? ["deleted.ts"] : [])].map((name) => ({
              name,
              isDirectory: () => false,
            })),
        };
        vm.runInNewContext(script, {
          Buffer,
          process: { argv: ["node", args.at(-1)] },
          require: (name: string) =>
            name === "node:fs"
              ? fakeFs
              : name === "node:crypto"
                ? { createHash }
                : path,
        });
        callback(null, "", "");
      } catch (error) {
        callback(error as Error, "", "");
      }
    },
  );
});

describe("artifact verification", () => {
  it("rejects a mutable image tag or container referencing a different image", async () => {
    actualDigest = `sha256:${"b".repeat(64)}`;
    await expect(verifyArtifactImage("tag", provenance)).rejects.toThrow(
      "image digest differs",
    );
    await expect(
      verifyArtifactContainer("container", provenance),
    ).rejects.toThrow("container image differs");
  });
  it("checks source bytes in both a built image and live container", async () => {
    await verifyArtifactImage(digest, provenance);
    await verifyArtifactContainer("container", provenance);
    source = "old";
    await expect(verifyArtifactImage(digest, provenance)).rejects.toThrow(
      "source mismatch at agent/agent.ts",
    );
    await expect(
      verifyArtifactContainer("container", provenance),
    ).rejects.toThrow("source mismatch at agent/agent.ts");
  });
  it("rejects a deleted configuration file retained in the runtime", async () => {
    extra = true;
    await expect(
      verifyArtifactContainer("container", provenance),
    ).rejects.toThrow("source mismatch at agent/deleted.ts");
  });
  it("hashes changed bytes and symlink targets without depending on traversal order", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "provenance-test-"));
    try {
      await mkdir(path.join(dir, "agent"));
      await writeFile(path.join(dir, "agent/a.ts"), "old");
      await symlink("missing", path.join(dir, "agent/link"));
      const first = await sourceManifest(dir);
      expect(first["agent/link"]).toBe("symlink:missing");
      expect(manifestDigest(first)).toBe(
        manifestDigest(Object.fromEntries(Object.entries(first).reverse())),
      );
      await writeFile(path.join(dir, "agent/a.ts"), "new");
      expect(manifestDigest(await sourceManifest(dir))).not.toBe(
        manifestDigest(first),
      );
      expect(await readFile(path.join(dir, "agent/a.ts"), "utf8")).toBe("new");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
