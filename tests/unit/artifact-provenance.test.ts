import { createHash } from "node:crypto";
import {
  chmod,
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
  runtimeSourceManifest,
  verifyStoppedArtifactContainer,
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
let executable = false;
let changes = "";
let streamed = "";
beforeEach(() => {
  source = "new";
  extra = false;
  actualDigest = digest;
  executable = false;
  changes = "";
  streamed = "";
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
      if (args[0] === "diff") return callback(null, changes, "");
      return {
        stdin: {
          on: () => {},
          end: (input: string) => {
            streamed = input;
            try {
              const script = args[args.indexOf("-e") + 1];
              const fakeFs = {
                lstatSync: () => ({
                  isSymbolicLink: () => false,
                  mode: executable ? 0o755 : 0o644,
                }),
                readFileSync: (file: unknown) => (file === 0 ? input : source),
                existsSync: () => true,
                readdirSync: () =>
                  ["agent.ts", ...(extra ? ["deleted.ts"] : [])].map(
                    (name) => ({ name, isDirectory: () => false }),
                  ),
              };
              vm.runInNewContext(script, {
                Buffer,
                require: (name: string) =>
                  name === "node:fs"
                    ? fakeFs
                    : name === "node:crypto"
                      ? { createHash }
                      : path,
              });
              callback(null, "", "");
            } catch (error) {
              callback(error as Error, "", (error as Error).message);
            }
          },
        },
      };
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
  it("streams a manifest larger than Linux's per-argument limit", async () => {
    const files = {
      ...provenance.files,
      ...Object.fromEntries(
        Array.from({ length: 2000 }, (_, i) => [
          `files/${i}.ts`,
          provenance.files["agent/agent.ts"],
        ]),
      ),
    };
    await verifyArtifactContainer("container", { ...provenance, files });
    expect(streamed.length).toBeGreaterThan(131072);
    expect(JSON.parse(streamed)).toEqual(files);
    expect(
      execFile.mock.calls.every(([, args]) =>
        args.every((arg: string) => arg.length < 131072),
      ),
    ).toBe(true);
  });
  it("rejects executable-bit drift in the image", async () => {
    const withMode = {
      ...provenance,
      files: {
        "agent/agent.ts": provenance.files["agent/agent.ts"] + ":mode:100755",
      },
    };
    await expect(verifyArtifactImage(digest, withMode)).rejects.toThrow(
      "source mismatch",
    );
    executable = true;
    await verifyArtifactImage(digest, withMode);
  });
  it("checks a stopped container without starting channels and ignores generated sibling writes", async () => {
    changes = "C /app\nA /app/.eve/session.json\n";
    await verifyStoppedArtifactContainer("container", provenance);
    changes = "C /app/agent/agent.ts";
    await expect(
      verifyStoppedArtifactContainer("container", provenance),
    ).rejects.toThrow("Redeploy to rebuild");
    expect(
      execFile.mock.calls.some(([, args]) =>
        ["start", "exec", "run"].includes(args[0]),
      ),
    ).toBe(false);
  });
  it("respects Docker ignores and exceptions, but refuses to omit agent configuration", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dockerignore-test-"));
    try {
      await writeFile(
        path.join(dir, ".dockerignore"),
        "docs\ntests\n!tests/runtime.ts\n",
      );
      const files = {
        "agent/agent.ts": "agent",
        "docs/README.md": "docs",
        "tests/unit.ts": "test",
        "tests/runtime.ts": "runtime",
      };
      expect(await runtimeSourceManifest(dir, files)).toEqual({
        "agent/agent.ts": "agent",
        "tests/runtime.ts": "runtime",
      });
      await writeFile(
        path.join(dir, "Dockerfile.dockerignore"),
        "docs\nagent\n",
      );
      await expect(runtimeSourceManifest(dir, files)).rejects.toThrow(
        "excludes required configuration",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("hashes changed bytes and symlink targets without depending on traversal order", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "provenance-test-"));
    try {
      await mkdir(path.join(dir, "agent"));
      await writeFile(path.join(dir, "agent/a.ts"), "old");
      await symlink("missing", path.join(dir, "agent/link"));
      await mkdir(path.join(dir, "agent/node_modules"));
      await writeFile(
        path.join(dir, "agent/node_modules/authored.ts"),
        "tracked nested source",
      );
      const first = await sourceManifest(dir);
      expect(first["agent/node_modules/authored.ts"]).toBeDefined();
      expect(first["agent/link"]).toBe("symlink:missing:mode:120000");
      expect(manifestDigest(first)).toBe(
        manifestDigest(Object.fromEntries(Object.entries(first).reverse())),
      );
      await chmod(path.join(dir, "agent/a.ts"), 0o755);
      expect(manifestDigest(await sourceManifest(dir))).not.toBe(
        manifestDigest(first),
      );
      await chmod(path.join(dir, "agent/a.ts"), 0o644);
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
