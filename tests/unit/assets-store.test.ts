import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  runAssetOperation,
  type AssetRepository,
  type AssetSnapshot,
  type AssetStoreDeps,
} from "~/assets/store.server";
import { normalizeAssetFilePath, normalizeAssetId } from "~/assets/policy";
import { NonFastForwardError, type GitFileChange } from "~/github/write.server";
import { makeFakeStore, type FakeStore } from "../fakes/store";

class MemoryAssetRepository implements AssetRepository {
  head = "head-0";
  commits: { message: string; files: GitFileChange[] }[] = [];
  failCommits = 0;
  private sequence = 0;
  private readonly paths = new Map<
    string,
    { type: string; mode: string; sha: string }
  >();
  private readonly blobs = new Map<string, Buffer>();

  async snapshot(): Promise<AssetSnapshot> {
    return {
      headSha: this.head,
      truncated: false,
      entries: [...this.paths.entries()].map(([path, entry]) => ({
        path,
        ...entry,
      })),
    };
  }

  async readBlob(sha: string): Promise<Buffer> {
    return this.blobs.get(sha) ?? Buffer.alloc(0);
  }

  async commit(input: {
    expectedHeadSha: string;
    files: GitFileChange[];
    message: string;
  }): Promise<string> {
    if (this.failCommits > 0) {
      this.failCommits -= 1;
      this.head = `external-${++this.sequence}`;
      throw new NonFastForwardError("main");
    }
    expect(input.expectedHeadSha).toBe(this.head);
    for (const file of input.files) {
      if (file.content === null) {
        this.paths.delete(file.path);
        continue;
      }
      const bytes = Buffer.from(file.content);
      const sha = createHash("sha1")
        .update(`${++this.sequence}\0`)
        .update(bytes)
        .digest("hex");
      this.blobs.set(sha, bytes);
      this.paths.set(file.path, { type: "blob", mode: "100644", sha });
    }
    this.commits.push({ message: input.message, files: input.files });
    this.head = `head-${++this.sequence}`;
    return this.head;
  }

  pathsList(): string[] {
    return [...this.paths.keys()].sort();
  }
}

describe("asset path policy", () => {
  it.each([
    "../agents",
    "templates/../../agents",
    "templates/.github",
    "/absolute",
    "templates//page",
    "templates/",
    ".hidden",
    "templates%2Fpage",
    "templates%2f..%2fagents",
    "templates\\page",
  ])("refuses a crafted asset id: %s", (id) => {
    expect(normalizeAssetId(id)).toBeNull();
  });

  it("accepts hierarchical ids but never turns them into repo-root paths", () => {
    expect(normalizeAssetId("templates/property-page.v2")).toBe(
      "templates/property-page.v2",
    );
  });

  it.each([
    "../agents/agent.ts",
    ".env",
    "images//hero.png",
    "images/.hidden.png",
    "manifest.json",
    "nested/manifest.json",
    "payload.exe",
    "/root.txt",
  ])("refuses an unsafe or unexpected asset file: %s", (path) => {
    expect(normalizeAssetFilePath(path)).toBeNull();
  });
});

describe("repo-backed asset operations", () => {
  let store: FakeStore;
  let repository: MemoryAssetRepository;
  let deploymentId: string;
  let deps: AssetStoreDeps;
  const openRepository = vi.fn();
  let clock = 0;

  beforeEach(async () => {
    store = makeFakeStore();
    store.seedProject({
      id: "project-1",
      orgId: "org-1",
      repoOwner: "acme",
      repoName: "agents",
      repoInstallationId: "installation-grant-1",
      defaultBranch: "managed",
    });
    store.seedAgent({
      id: "designer-1",
      projectId: "project-1",
      name: "Designer",
      root: "agents/designer/agent",
    });
    store.seedEnvironment({
      id: "environment-1",
      projectId: "project-1",
      agentId: "designer-1",
    });
    const deployment = await store.deployments.insert({
      environmentId: "environment-1",
      releaseId: "release-1",
      status: "live",
      trafficWeight: 100,
    });
    deploymentId = deployment.id;
    repository = new MemoryAssetRepository();
    openRepository.mockReset().mockResolvedValue(repository);
    deps = {
      store,
      openRepository,
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)),
    };
  });

  it("puts, lists and gets identical text and binary bytes from managed-branch HEAD", async () => {
    const binary = Buffer.from([0, 255, 1, 2, 3]);
    const put = await runAssetOperation(
      deploymentId,
      {
        op: "put",
        id: "templates/property-page",
        description: "Branded property page",
        files: [
          { path: "index.html", content: "<h1>Home</h1>", encoding: "utf8" },
          {
            path: "images/hero.png",
            content: binary.toString("base64"),
            encoding: "base64",
          },
        ],
        // Request-supplied repository coordinates are ignored.
        repo: "victim/other",
      },
      deps,
    );
    expect(put.ok).toBe(true);
    expect(openRepository).toHaveBeenCalledWith({
      installationId: "installation-grant-1",
      owner: "acme",
      repo: "agents",
    });
    expect(repository.commits[0].message).toBe(
      "assets: put templates/property-page (Designer)",
    );
    expect(repository.pathsList()).toEqual([
      "assets/templates/property-page/images/hero.png",
      "assets/templates/property-page/index.html",
      "assets/templates/property-page/manifest.json",
    ]);
    expect(
      repository.commits[0].files.every((file) =>
        file.path.startsWith("assets/templates/property-page/"),
      ),
    ).toBe(true);

    const list = await runAssetOperation(deploymentId, { op: "list" }, deps);
    expect(list).toMatchObject({
      ok: true,
      assets: [
        {
          id: "templates/property-page",
          description: "Branded property page",
          writer: {
            deploymentId,
            agentId: "designer-1",
            agent: "Designer",
          },
        },
      ],
    });

    const get = await runAssetOperation(
      deploymentId,
      { op: "get", id: "templates/property-page" },
      deps,
    );
    expect(get).toMatchObject({
      ok: true,
      files: [
        {
          path: "images/hero.png",
          encoding: "base64",
          content: binary.toString("base64"),
        },
        { path: "index.html", encoding: "utf8", content: "<h1>Home</h1>" },
      ],
    });
  });

  it("replaces the whole asset, preserves createdAt, removes stale files, then deletes it", async () => {
    const first = await runAssetOperation(
      deploymentId,
      {
        op: "put",
        id: "brand/current",
        files: [
          { path: "old.txt", content: "old" },
          { path: "keep.txt", content: "one" },
        ],
      },
      deps,
    );
    expect(first.ok).toBe(true);
    const createdAt = first.ok && "asset" in first ? first.asset.createdAt : "";

    const second = await runAssetOperation(
      deploymentId,
      {
        op: "put",
        id: "brand/current",
        files: [{ path: "keep.txt", content: "two" }],
      },
      deps,
    );
    expect(second.ok && "asset" in second ? second.asset.createdAt : null).toBe(
      createdAt,
    );
    expect(repository.pathsList()).not.toContain(
      "assets/brand/current/old.txt",
    );

    const deleted = await runAssetOperation(
      deploymentId,
      { op: "delete", id: "brand/current" },
      deps,
    );
    expect(deleted).toMatchObject({ ok: true, id: "brand/current" });
    expect(repository.pathsList()).toEqual([]);
  });

  it("retries the whole atomic write on a non-fast-forward race", async () => {
    repository.failCommits = 1;
    const result = await runAssetOperation(
      deploymentId,
      {
        op: "put",
        id: "templates/page",
        files: [{ path: "index.html", content: "hello" }],
      },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(repository.commits).toHaveLength(1);
    expect(repository.pathsList()).toContain(
      "assets/templates/page/manifest.json",
    );
  });

  it("refuses invalid ids, invalid files, too many files and overlapping asset directories", async () => {
    for (const id of ["../agents", "templates//page", "templates/.github"]) {
      expect(
        await runAssetOperation(
          deploymentId,
          { op: "put", id, files: [{ path: "x.txt", content: "x" }] },
          deps,
        ),
      ).toMatchObject({ ok: false });
    }
    expect(
      await runAssetOperation(
        deploymentId,
        {
          op: "put",
          id: "safe",
          files: [{ path: "../../agents/a.ts", content: "x" }],
        },
        deps,
      ),
    ).toMatchObject({ ok: false });
    expect(
      await runAssetOperation(
        deploymentId,
        {
          op: "put",
          id: "safe",
          files: Array.from({ length: 41 }, (_, index) => ({
            path: `file-${index}.txt`,
            content: "x",
          })),
        },
        deps,
      ),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/40/) });

    await runAssetOperation(
      deploymentId,
      {
        op: "put",
        id: "templates",
        files: [{ path: "root.txt", content: "x" }],
      },
      deps,
    );
    const overlap = await runAssetOperation(
      deploymentId,
      {
        op: "put",
        id: "templates/property-page",
        files: [{ path: "index.html", content: "x" }],
      },
      deps,
    );
    expect(overlap).toMatchObject({
      ok: false,
      error: expect.stringMatching(/overlap/),
    });
  });

  it("refuses a deployment that no longer resolves without opening GitHub", async () => {
    const result = await runAssetOperation(
      "missing-deployment",
      { op: "list" },
      deps,
    );
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/no longer known/),
    });
    expect(openRepository).not.toHaveBeenCalled();
  });
});
