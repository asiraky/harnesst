import { beforeEach, describe, expect, it } from "vitest";

import type {
  Artifact,
  ArtifactFile,
  ArtifactVersion,
} from "~/foh/artifact-store.server";
import { ARTIFACT_MAX_BYTES } from "~/foh/artifact-media";
import {
  artifactPathSegment,
  runTeamArtifactOperation,
  TEAM_ARTIFACT_LIST_LIMIT,
  type TeamArtifactDeps,
} from "~/foh/team-artifacts.server";
import { makeFakeStore, type FakeStore } from "../fakes/store";

function artifact(over: Partial<Artifact> & { id: string }): Artifact {
  return {
    projectId: "project-1",
    agentId: "proto-1",
    sessionId: "session-1",
    name: "landing",
    title: "Landing page",
    kind: "html",
    ...over,
  } as Artifact;
}

function version(
  over: Partial<ArtifactVersion> & { id: string; artifactId: string },
): ArtifactVersion {
  return {
    versionNumber: 1,
    entryPath: "index.html",
    contentType: "text/html",
    byteSize: 0,
    storagePath: `${over.id}.bin`,
    createdAt: new Date(Date.UTC(2026, 9, 1)),
    ...over,
  } as ArtifactVersion;
}

describe("runTeamArtifactOperation", () => {
  let store: FakeStore;
  let deploymentId: string;
  let artifacts: Array<Artifact & { lastPublishedAt: Date }>;
  let versions: ArtifactVersion[];
  let files: ArtifactFile[];
  let bytes: Map<string, Buffer>;
  let deps: TeamArtifactDeps;

  beforeEach(async () => {
    store = makeFakeStore();
    store.seedProject({ id: "project-1", orgId: "org-1" });
    store.seedProject({ id: "project-2", orgId: "org-1" });
    store.seedAgent({ id: "hermes-1", projectId: "project-1", name: "hermes" });
    store.seedAgent({ id: "proto-1", projectId: "project-1", name: "proto" });
    store.seedEnvironment({
      id: "env-1",
      projectId: "project-1",
      agentId: "hermes-1",
    });
    deploymentId = (
      await store.deployments.insert({
        environmentId: "env-1",
        releaseId: "release-1",
        status: "live",
        trafficWeight: 100,
      })
    ).id;
    artifacts = [];
    versions = [];
    files = [];
    bytes = new Map();
    deps = {
      store,
      listProjectArtifacts: async (projectId) =>
        artifacts.filter((a) => a.projectId === projectId),
      findProjectArtifact: async ({ id, projectId }) =>
        artifacts.find((a) => a.id === id && a.projectId === projectId) ?? null,
      listArtifactVersions: async (artifactId) =>
        versions
          .filter((v) => v.artifactId === artifactId)
          .sort((a, b) => b.versionNumber - a.versionNumber),
      listArtifactFiles: async (versionId) =>
        files.filter((f) => f.versionId === versionId),
      readArtifactBytes: async (path) => bytes.get(path) ?? null,
    };
  });

  function seedBundle(versionNumber: number, html: string) {
    const v = version({
      id: `v${versionNumber}`,
      artifactId: "a-landing",
      versionNumber,
      createdAt: new Date(Date.UTC(2026, 9, versionNumber)),
    });
    versions.push(v);
    for (const [relPath, content] of [
      ["index.html", html],
      ["assets/app.css", `body{--v:${versionNumber}}`],
    ]) {
      const storagePath = `${v.id}/${relPath}`;
      bytes.set(storagePath, Buffer.from(content));
      files.push({
        id: `${v.id}-${relPath}`,
        versionId: v.id,
        relPath,
        contentType: relPath.endsWith(".css") ? "text/css" : "text/html",
        byteSize: content.length,
        storagePath,
      } as ArtifactFile);
    }
  }

  it("lists the repo's artifacts with the publishing agent, and only this repo's", async () => {
    artifacts.push(
      {
        ...artifact({ id: "a-landing" }),
        lastPublishedAt: new Date(Date.UTC(2026, 9, 3)),
      },
      {
        ...artifact({ id: "a-other", projectId: "project-2" }),
        lastPublishedAt: new Date(),
      },
    );

    const result = await runTeamArtifactOperation(
      deploymentId,
      { op: "list" },
      deps,
    );

    expect(result).toEqual({
      ok: true,
      truncated: false,
      artifacts: [
        {
          id: "a-landing",
          name: "landing",
          title: "Landing page",
          kind: "html",
          agent: "proto",
          lastPublishedAt: "2026-10-03T00:00:00.000Z",
        },
      ],
    });
  });

  it("filters the list by name, title or agent, and says when it cut the list", async () => {
    for (let i = 0; i < TEAM_ARTIFACT_LIST_LIMIT + 1; i++) {
      artifacts.push({
        ...artifact({ id: `a-${i}`, name: `chart-${i}`, title: null }),
        lastPublishedAt: new Date(),
      });
    }
    artifacts.push({
      ...artifact({ id: "a-landing", agentId: "hermes-1" }),
      lastPublishedAt: new Date(),
    });

    const all = await runTeamArtifactOperation(
      deploymentId,
      { op: "list" },
      deps,
    );
    const byTitle = await runTeamArtifactOperation(
      deploymentId,
      { op: "list", query: "LANDING page" },
      deps,
    );
    const byAgent = await runTeamArtifactOperation(
      deploymentId,
      { op: "list", query: "hermes" },
      deps,
    );

    expect(all).toMatchObject({ ok: true, truncated: true });
    expect("artifacts" in all && all.artifacts).toHaveLength(
      TEAM_ARTIFACT_LIST_LIMIT,
    );
    for (const filtered of [byTitle, byAgent]) {
      expect(
        "artifacts" in filtered && filtered.artifacts.map((a) => a.id),
      ).toEqual(["a-landing"]);
    }
  });

  it("gets the latest version of a bundle with every file, or a pinned older one", async () => {
    artifacts.push({
      ...artifact({ id: "a-landing" }),
      lastPublishedAt: new Date(),
    });
    seedBundle(1, "<h1>first</h1>");
    seedBundle(2, "<h1>second</h1>");

    const latest = await runTeamArtifactOperation(
      deploymentId,
      { op: "get", id: "a-landing" },
      deps,
    );
    const pinned = await runTeamArtifactOperation(
      deploymentId,
      { op: "get", id: "a-landing", version: 1 },
      deps,
    );

    expect(latest).toMatchObject({
      ok: true,
      version: 2,
      folder: "landing",
      entry: "index.html",
      versions: [{ version: 2 }, { version: 1 }],
      artifact: { agent: "proto", lastPublishedAt: "2026-10-02T00:00:00.000Z" },
    });
    const decode = (r: typeof latest) =>
      "files" in r
        ? Object.fromEntries(
            r.files.map((f) => [
              f.path,
              Buffer.from(f.content, "base64").toString(),
            ]),
          )
        : null;
    expect(decode(latest)).toEqual({
      "index.html": "<h1>second</h1>",
      "assets/app.css": "body{--v:2}",
    });
    expect(decode(pinned)).toMatchObject({ "index.html": "<h1>first</h1>" });
  });

  it("gets a single file under a safe version of its published name", async () => {
    artifacts.push({
      ...artifact({
        id: "a-chart",
        name: "Q3 revenue.png",
        kind: "image",
      }),
      lastPublishedAt: new Date(),
    });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]);
    versions.push(
      version({
        id: "v-chart",
        artifactId: "a-chart",
        contentType: "image/png",
        byteSize: png.length,
        entryPath: null,
      }),
    );
    bytes.set("v-chart.bin", png);

    const result = await runTeamArtifactOperation(
      deploymentId,
      { op: "get", id: "a-chart" },
      deps,
    );

    expect(result).toMatchObject({
      ok: true,
      folder: "Q3-revenue.png",
      entry: "Q3-revenue.png",
      files: [{ path: "Q3-revenue.png", contentType: "image/png" }],
    });
    expect(
      "files" in result && Buffer.from(result.files[0].content, "base64"),
    ).toEqual(png);
  });

  it("refuses another repo's artifact, a missing version and an oversized one", async () => {
    artifacts.push(
      { ...artifact({ id: "a-landing" }), lastPublishedAt: new Date() },
      {
        ...artifact({ id: "a-foreign", projectId: "project-2" }),
        lastPublishedAt: new Date(),
      },
      {
        ...artifact({ id: "a-huge", name: "huge.pdf", kind: "document" }),
        lastPublishedAt: new Date(),
      },
    );
    seedBundle(1, "<h1>first</h1>");
    versions.push(
      version({
        id: "v-huge",
        artifactId: "a-huge",
        byteSize: ARTIFACT_MAX_BYTES + 1,
      }),
    );

    for (const body of [
      { op: "get", id: "a-foreign" },
      { op: "get", id: "a-landing", version: 7 },
      { op: "get", id: "a-landing", version: 0 },
      { op: "get", id: "a-huge" },
      { op: "get" },
      { op: "put", id: "a-landing" },
    ]) {
      expect(
        await runTeamArtifactOperation(deploymentId, body, deps),
      ).toMatchObject({ ok: false });
    }
  });

  it("refuses a deployment harnesst no longer knows", async () => {
    expect(
      await runTeamArtifactOperation("gone", { op: "list" }, deps),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/no longer/) });
  });
});

describe("artifactPathSegment", () => {
  it("keeps plain names and makes anything else one safe segment", () => {
    expect(artifactPathSegment("landing-v2.html")).toBe("landing-v2.html");
    expect(artifactPathSegment("../../etc/passwd")).toBe("etc-passwd");
    expect(artifactPathSegment(".env")).toBe("env");
    expect(artifactPathSegment("???")).toBe("artifact");
  });
});
