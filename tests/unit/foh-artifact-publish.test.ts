/**
 * `publishArtifact` against in-memory fakes (#290) — the decisions that are security decisions.
 *
 * WHERE an artifact lands is the first one. The tool carries no session id, so the destination is
 * derived from the live turn on the CALLING deployment; deriving it from "the agent's newest
 * conversation" instead was a cross-member image leak, because one deployment serves every member's
 * FOH sessions and those sessions are per-creator confidential. Two live turns are refused rather
 * than guessed, and a publish with no live turn is refused too.
 *
 * The budgets are the second: the caller is an agent that can loop, nothing ever deletes stored
 * bytes, and every in-flight copy holds its tar in this process's heap.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  ARTIFACT_BUDGET_WINDOW_MS,
  MAX_ARTIFACTS_PER_PROJECT_WINDOW,
  MAX_ARTIFACTS_PER_SESSION,
  MAX_ARTIFACT_BYTES_PER_PROJECT_WINDOW,
  MAX_ARTIFACT_VERSIONS_TOTAL,
  MAX_CONCURRENT_ARTIFACT_COPIES,
  publishArtifact,
  withArtifactCopySlot,
  type PublishArtifactDeps,
} from "~/foh/artifacts.server";
import type {
  Artifact,
  ArtifactFileInput,
  ArtifactVersion,
} from "~/foh/artifact-store.server";
import type { PlaygroundSession } from "~/playground/sessions.server";
import { makeFakeStore, type FakeStore } from "../fakes/store";

const PROJECT = "proj_1";
const NOW = new Date(1_700_000_000_000);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
const HTML = Buffer.from("<html><body>hi</body></html>");
const CSS = Buffer.from("body{color:red}");
/** A two-file page, as the bundle copy hands it over: names already bundle-relative. */
const PAGE = [
  { name: "index.html", bytes: HTML },
  { name: "assets/app.css", bytes: CSS },
];

let store: FakeStore;

async function seedDeployment(): Promise<string> {
  store.seedProject({ id: PROJECT, orgId: "org_1" });
  store.seedAgent({ id: "agent_1", projectId: PROJECT, name: "dev" });
  store.seedEnvironment({
    id: "env_1",
    projectId: PROJECT,
    agentId: "agent_1",
    name: "production",
  });
  const release = await store.releases.insert({
    projectId: PROJECT,
    agentId: "agent_1",
    version: "v1",
    gitSha: "a".repeat(40),
  });
  const dep = await store.deployments.insert({
    environmentId: "env_1",
    releaseId: release.id,
    status: "live",
    trafficWeight: 100,
  });
  return dep.id;
}

function session(over: Partial<PlaygroundSession> = {}): PlaygroundSession {
  return {
    id: "ps_live",
    projectId: PROJECT,
    agentId: "agent_1",
    environmentId: "env_1",
    createdBy: "user_b",
    surface: "foh",
    status: "running",
    streamIndex: 7,
    ...over,
  } as unknown as PlaygroundSession;
}

type Deps = PublishArtifactDeps & {
  copies: Array<{ deploymentId: string; path: string; bundle?: true }>;
  finds: Array<Parameters<PublishArtifactDeps["findSession"]>[0]>;
  /** One entry per CARD — a republish appends to `versions`, it does not push here (#292). */
  rows: Artifact[];
  versions: ArtifactVersion[];
  /** Bundle member rows, as the recorder was asked to write them. */
  files: Array<ArtifactFileInput[]>;
  /** Every `(sha, bytes)` pair handed to the store, in order. */
  written: Array<{ sha256: string; byteSize: number }>;
};

/**
 * The store's version semantics, in memory: `(session, name)` resolves to one artifact row, bytes
 * land on it as a version, and bytes identical to the one already on top append nothing. Modelled
 * rather than stubbed because the branch under test IS "which of those happened".
 */
function makeDeps(
  over: {
    find?: PublishArtifactDeps["findSession"];
    copy?: PublishArtifactDeps["copyFile"];
    copyBundle?: PublishArtifactDeps["copyBundle"];
    usage?: PublishArtifactDeps["usage"];
  } = {},
): Deps {
  const copies: Deps["copies"] = [];
  const finds: Deps["finds"] = [];
  const rows: Artifact[] = [];
  const versions: ArtifactVersion[] = [];
  const files: Deps["files"] = [];
  const written: Deps["written"] = [];

  const findArtifact: PublishArtifactDeps["findArtifact"] = async (input) =>
    rows.find(
      (row) => row.sessionId === input.sessionId && row.name === input.name,
    ) ?? null;

  const record: PublishArtifactDeps["record"] = async (input) => {
    const { files: members, keepVersions, maxVersions, ...row } = input;
    let artifact = await findArtifact({
      sessionId: row.sessionId,
      name: row.name,
    });
    if (!artifact) {
      artifact = {
        ...row,
        id: `art_${rows.length + 1}`,
        latestVersionId: null,
        versionNumber: 0,
        versionCount: 0,
        createdAt: NOW,
      } as Artifact;
      rows.push(artifact);
    }
    // The store's own refusals, which are the ones a publish racing another publish of the same
    // name meets: the kind pin and the version ceiling are re-decided where the row is written.
    if (artifact.kind !== row.kind) return { ok: false as const, reason: "kind" as const };
    const stack = versions.filter((v) => v.artifactId === artifact.id);
    const latest = stack.at(-1) ?? null;
    if (latest && latest.sha256 === row.sha256) {
      return { ok: true as const, artifact, version: latest, appended: false };
    }
    if (latest && latest.versionNumber >= maxVersions) {
      return { ok: false as const, reason: "cap" as const };
    }
    const version = {
      ...row,
      id: `ver_${versions.length + 1}`,
      artifactId: artifact.id,
      versionNumber: (latest?.versionNumber ?? 0) + 1,
      createdAt: NOW,
    } as ArtifactVersion;
    versions.push(version);
    if (members?.length) files.push(members);
    Object.assign(artifact, {
      entryPath: row.entryPath,
      contentType: row.contentType,
      byteSize: row.byteSize,
      sha256: row.sha256,
      storagePath: row.storagePath,
      latestVersionId: version.id,
      versionNumber: version.versionNumber,
      versionCount: Math.min(version.versionNumber, keepVersions),
      ...(row.title ? { title: row.title } : {}),
    });
    return { ok: true as const, artifact, version, appended: true };
  };

  return {
    store,
    copies,
    finds,
    rows,
    versions,
    files,
    written,
    findSession: async (input) => {
      finds.push(input);
      return over.find
        ? over.find(input)
        : { ok: true as const, session: session() };
    },
    copyFile: async (input) => {
      copies.push({ deploymentId: input.deploymentId, path: input.path });
      return over.copy ? over.copy(input) : { ok: true as const, bytes: PNG };
    },
    copyBundle: async (input) => {
      copies.push({
        deploymentId: input.deploymentId,
        path: input.path,
        bundle: true,
      });
      return over.copyBundle
        ? over.copyBundle(input)
        : { ok: true as const, files: PAGE };
    },
    usage:
      over.usage ??
      (async () => ({ sessionCount: 0, projectCount: 0, projectBytes: 0 })),
    writeBytes: async (sha256, bytes) => {
      written.push({ sha256, byteSize: bytes.length });
      return `${sha256.slice(0, 2)}/${sha256}`;
    },
    findArtifact,
    record,
    now: () => NOW,
  };
}

beforeEach(() => {
  store = makeFakeStore();
});

describe("publishArtifact destination", () => {
  it("publishes into the conversation whose turn is running on the calling deployment", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps();

    const result = await publishArtifact(
      { deploymentId, path: "artifacts/chart.png", title: "  Chart  " },
      deps,
    );

    expect(result).toMatchObject({
      ok: true,
      name: "chart.png",
      contentType: "image/png",
      byteSize: PNG.length,
      // Version-scoped: the URL has to keep meaning the same bytes, and an artifact's newest
      // version does not.
      url: `/api/foh/${PROJECT}/artifact/art_1/ver_1`,
      version: 1,
    });
    expect(deps.rows[0]).toMatchObject({
      sessionId: "ps_live",
      projectId: PROJECT,
      agentId: "agent_1",
      deploymentId,
      title: "Chart",
      streamIndex: 7,
    });
    // The narrowing fact comes off the token's deployment, not the body: the environment (a
    // staging container must not publish into a production conversation; #288 dropped
    // last_deployment_id, so the environment's live turn is the scope).
    expect(deps.finds[0]).toMatchObject({
      projectId: PROJECT,
      agentId: "agent_1",
      environmentId: "env_1",
    });
    expect(deps.finds[0].staleAfterMs).toBeGreaterThan(0);
  });

  it("refuses when no conversation is running a turn instead of falling back to the newest one", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps({
      find: async () => ({ ok: false, reason: "no_live_turn" }),
    });

    const result = await publishArtifact(
      { deploymentId, path: "artifacts/chart.png" },
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/no Front of House conversation waiting on you/i);
    // Nothing was read: a refusal must not cost a 25 MB copy either.
    expect(deps.copies).toHaveLength(0);
    expect(deps.rows).toHaveLength(0);
  });

  it("refuses when two conversations are live at once rather than guessing between members", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps({
      find: async () => ({ ok: false, reason: "ambiguous" }),
    });

    const result = await publishArtifact(
      { deploymentId, path: "artifacts/chart.png" },
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/more than one Front of House conversation/i);
    expect(deps.copies).toHaveLength(0);
  });
});

/**
 * The kind branch (#291) decides which COPY runs and, more importantly, which serving route the
 * bytes can ever come back out of: an `image` row is served same-origin behind the viewer's cookie,
 * an `html` row only through the sandboxed preview. So "which branch did this take" is a security
 * assertion, not a routing detail.
 */
describe("publishArtifact kinds", () => {
  it("stores a page as ONE row plus a member row per file, charged the summed bytes", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps();

    const result = await publishArtifact(
      { deploymentId, path: "artifacts/site", kind: "html", title: "Landing" },
      deps,
    );

    expect(result).toMatchObject({
      ok: true,
      kind: "html",
      // No stable URL by design: a bundle is reachable only through a minted preview capability.
      url: null,
      name: "site",
      contentType: "text/html",
      byteSize: HTML.length + CSS.length,
      fileCount: 2,
    });
    expect(deps.copies).toEqual([
      { deploymentId, path: "/workspace/home/artifacts/site", bundle: true },
    ]);
    expect(deps.rows).toHaveLength(1);
    expect(deps.rows[0]).toMatchObject({
      kind: "html",
      entryPath: "index.html",
      sessionId: "ps_live",
      streamIndex: 7,
      title: "Landing",
    });
    expect(deps.files[0].map((f) => [f.relPath, f.contentType, f.byteSize])).toEqual([
      ["index.html", "text/html", HTML.length],
      ["assets/app.css", "text/css", CSS.length],
    ]);
    // Every member's bytes are stored, content-addressed, and the row points at the ENTRY's.
    expect(deps.written).toHaveLength(2);
    expect(deps.rows[0].storagePath).toBe(
      deps.files[0].find((f) => f.relPath === "index.html")!.storagePath,
    );
  });

  it("identifies a bundle by its members' manifest, not by the entry document's bytes", async () => {
    const deploymentId = await seedDeployment();
    const same = makeDeps();
    const restyled = makeDeps({
      copyBundle: async () => ({
        ok: true,
        // Same index.html, changed stylesheet — a page whose sha came off the entry alone would
        // dedupe onto the previous card via artifacts_session_sha_uq and show the stale version.
        files: [
          { name: "index.html", bytes: HTML },
          { name: "assets/app.css", bytes: Buffer.from("body{color:blue}") },
        ],
      }),
    });

    for (const deps of [same, restyled]) {
      await publishArtifact(
        { deploymentId, path: "artifacts/site", kind: "html" },
        deps,
      );
    }

    expect(same.rows[0].sha256).not.toBe(restyled.rows[0].sha256);
    // And an identical publish is identical — the retry has to be a no-op at the unique index.
    const again = makeDeps();
    await publishArtifact(
      { deploymentId, path: "artifacts/site", kind: "html" },
      again,
    );
    expect(again.rows[0].sha256).toBe(same.rows[0].sha256);
  });

  it("takes the html branch for an .html path with no kind, and the image branch otherwise", async () => {
    const deploymentId = await seedDeployment();
    const page = makeDeps({
      copyBundle: async () => ({
        ok: true,
        files: [{ name: "report.html", bytes: HTML }],
      }),
    });
    const image = makeDeps();

    await publishArtifact({ deploymentId, path: "artifacts/report.html" }, page);
    await publishArtifact({ deploymentId, path: "artifacts/chart.png" }, image);

    expect(page.copies[0].bundle).toBe(true);
    expect(page.rows[0]).toMatchObject({ kind: "html", entryPath: "report.html" });
    expect(image.copies[0].bundle).toBeUndefined();
    expect(image.rows[0]).toMatchObject({ kind: "image", entryPath: null });
  });

  it("refuses a kind it does not publish before reading a byte", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps();

    const result = await publishArtifact(
      { deploymentId, path: "artifacts/report.pdf", kind: "pdf" },
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/images and HTML pages/i);
    expect(deps.copies).toHaveLength(0);
  });

  it("refuses a page whose members are not all servable, rather than dropping the odd one", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps({
      copyBundle: async () => ({
        ok: true,
        files: [
          { name: "index.html", bytes: HTML },
          { name: "build.sh", bytes: Buffer.from("#!/bin/sh") },
        ],
      }),
    });

    const result = await publishArtifact(
      { deploymentId, path: "artifacts/site", kind: "html" },
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/will not publish build\.sh/);
    // Nothing partial was stored: a refused page leaves no member bytes and no row behind.
    expect(deps.written).toHaveLength(0);
    expect(deps.rows).toHaveLength(0);
  });

  it("refuses a page it cannot pick an entry document for, and one whose page is empty", async () => {
    const deploymentId = await seedDeployment();
    const ambiguous = makeDeps({
      copyBundle: async () => ({
        ok: true,
        files: [
          { name: "a.html", bytes: HTML },
          { name: "b.html", bytes: HTML },
        ],
      }),
    });
    const blank = makeDeps({
      copyBundle: async () => ({
        ok: true,
        files: [
          { name: "index.html", bytes: Buffer.alloc(0) },
          { name: "assets/app.css", bytes: CSS },
        ],
      }),
    });

    const first = await publishArtifact(
      { deploymentId, path: "artifacts/site", kind: "html" },
      ambiguous,
    );
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.error).toMatch(/which page to open/i);

    const second = await publishArtifact(
      { deploymentId, path: "artifacts/site", kind: "html" },
      blank,
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toMatch(/is empty/i);
  });

  it("holds a page to the same destination and budget rules as an image", async () => {
    const deploymentId = await seedDeployment();
    const noTurn = makeDeps({ find: async () => ({ ok: false, reason: "no_live_turn" }) });
    const overBudget = makeDeps({
      usage: async () => ({
        sessionCount: MAX_ARTIFACTS_PER_SESSION,
        projectCount: 1,
        projectBytes: 0,
      }),
    });

    for (const deps of [noTurn, overBudget]) {
      const result = await publishArtifact(
        { deploymentId, path: "artifacts/site", kind: "html" },
        deps,
      );
      expect(result.ok).toBe(false);
      // A page is one card and one budget charge, and refused before the copy either way.
      expect(deps.copies).toHaveLength(0);
    }
  });
});

/**
 * VERSIONS (#292). The unit is a NAME in a conversation, so the branch every test here pins is
 * "did this publish make a card or update one" — a wrong answer either spams the transcript with a
 * card per refinement, or silently overwrites something the user was still looking at.
 */
describe("publishArtifact versions", () => {
  it("appends a version to the card of the same name instead of publishing a second card", async () => {
    const deploymentId = await seedDeployment();
    let bytes = PNG;
    let streamIndex = 7;
    const deps = makeDeps({
      copy: async () => ({ ok: true, bytes }),
      find: async () => ({ ok: true, session: session({ streamIndex }) }),
    });

    const first = await publishArtifact(
      { deploymentId, path: "artifacts/chart.png" },
      deps,
    );
    // Two turns later, the agent redraws the chart and publishes the same name.
    bytes = Buffer.from([...PNG, 0x03]);
    streamIndex = 19;
    const second = await publishArtifact(
      { deploymentId, path: "artifacts/chart.png", title: "Redrawn" },
      deps,
    );

    expect(first).toMatchObject({ ok: true, version: 1, updated: true });
    expect(second).toMatchObject({
      ok: true,
      // The SAME card: the transcript entry id is built from this, which is what makes the update
      // happen in place rather than as a second card under a later turn.
      artifactId: first.ok ? first.artifactId : "",
      version: 2,
      updated: true,
    });
    expect(deps.rows).toHaveLength(1);
    expect(deps.versions.map((v) => v.versionNumber)).toEqual([1, 2]);
    // The card keeps the position its FIRST publish gave it, while the version records where the
    // conversation had actually reached — moving the card would slide it down past the turns in
    // between, away from the exchange it belongs to.
    expect(deps.rows[0].streamIndex).toBe(7);
    expect(deps.versions[1].streamIndex).toBe(19);
    expect(deps.rows[0]).toMatchObject({
      versionNumber: 2,
      byteSize: bytes.length,
      title: "Redrawn",
    });
  });

  it("appends nothing when the bytes match the version already on top", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps();

    const first = await publishArtifact(
      { deploymentId, path: "artifacts/chart.png" },
      deps,
    );
    // The tool's POST is best-effort and gets retried; an agent also republishes files it did not
    // actually change. Neither may become a version, or the picker fills with identical entries.
    const again = await publishArtifact(
      { deploymentId, path: "artifacts/chart.png" },
      deps,
    );

    expect(first).toMatchObject({ ok: true, version: 1, updated: true });
    expect(again).toMatchObject({ ok: true, version: 1, updated: false });
    expect(deps.rows).toHaveLength(1);
    expect(deps.versions).toHaveLength(1);
  });

  it("versions a page the same way an image is, members and all", async () => {
    const deploymentId = await seedDeployment();
    let page = PAGE;
    const deps = makeDeps({ copyBundle: async () => ({ ok: true, files: page }) });

    await publishArtifact(
      { deploymentId, path: "artifacts/site", kind: "html" },
      deps,
    );
    const restyled = [
      { name: "index.html", bytes: HTML },
      { name: "assets/app.css", bytes: Buffer.from("body{color:blue}") },
    ];
    page = restyled;
    const second = await publishArtifact(
      { deploymentId, path: "artifacts/site", kind: "html" },
      deps,
    );

    expect(second).toMatchObject({ ok: true, version: 2, updated: true, fileCount: 2 });
    expect(deps.rows).toHaveLength(1);
    // Each version owns its own member rows: keyed to the artifact instead, v2's index.html would
    // collide with v1's and the preview would go on serving the old page.
    expect(deps.files).toHaveLength(2);
    expect(deps.files[1].map((f) => f.sha256)).not.toEqual(
      deps.files[0].map((f) => f.sha256),
    );
    expect(deps.rows[0].byteSize).toBe(
      HTML.length + restyled[1].bytes.length,
    );
  });

  it("refuses to republish a name as the other kind rather than swapping which door serves it", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps();

    await publishArtifact({ deploymentId, path: "artifacts/report.png" }, deps);
    const swapped = await publishArtifact(
      { deploymentId, path: "artifacts/report.png", kind: "html" },
      deps,
    );

    expect(swapped.ok).toBe(false);
    if (swapped.ok) return;
    // An image is served same-origin behind the viewer's cookie and a page only through the
    // sandboxed preview, so a kind that could change would move bytes between two very differently
    // trusted routes — under a preview token that is already live.
    expect(swapped.error).toMatch(/already published .* as an image/i);
    expect(deps.copies).toHaveLength(1);
  });

  it("refuses new bytes once one name has been republished to the limit, without storing them", async () => {
    const deploymentId = await seedDeployment();
    let bytes = PNG;
    const deps = makeDeps({ copy: async () => ({ ok: true, bytes }) });

    await publishArtifact({ deploymentId, path: "artifacts/chart.png" }, deps);
    deps.rows[0].versionNumber = MAX_ARTIFACT_VERSIONS_TOTAL;
    bytes = Buffer.from([...PNG, 0x05]);
    const capped = await publishArtifact(
      { deploymentId, path: "artifacts/chart.png" },
      deps,
    );

    expect(capped.ok).toBe(false);
    if (capped.ok) return;
    // Retention prunes old version ROWS for free, so this ceiling is what actually stops a runaway
    // refine loop from spending the repo's disk on a single card — and it has to read as an
    // instruction the agent can act on.
    expect(capped.error).toMatch(
      new RegExp(`published ${MAX_ARTIFACT_VERSIONS_TOTAL} times`),
    );
    expect(capped.error).toMatch(/different name/i);
    // The refusal costs a copy (the bytes are what it is decided on) but never the disk: one write,
    // from the publish that succeeded.
    expect(deps.written).toHaveLength(1);
    expect(deps.versions).toHaveLength(1);
  });

  it("still answers a redelivery at the limit as the no-op it is", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps();

    const first = await publishArtifact(
      { deploymentId, path: "artifacts/chart.png" },
      deps,
    );
    deps.rows[0].versionNumber = MAX_ARTIFACT_VERSIONS_TOTAL;
    // The tool's POST is best-effort and retried, so the request that follows a publish whose
    // response was lost carries the bytes that already landed. Refusing it at the ceiling would
    // tell the agent its publish failed when the card is showing it.
    const retried = await publishArtifact(
      { deploymentId, path: "artifacts/chart.png" },
      deps,
    );

    expect(first).toMatchObject({ ok: true, updated: true });
    expect(retried).toMatchObject({ ok: true, updated: false, version: 1 });
    expect(deps.versions).toHaveLength(1);
  });

  it("relays the store's own kind refusal, which is where a racing publish meets it", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps();

    await publishArtifact({ deploymentId, path: "artifacts/report.png" }, deps);
    // What a publish that raced another publish of the same name sees: its pre-copy check read
    // "no such name", and the row that exists by the time it writes is the other kind. The check
    // before the copy cannot hold this — it is taken seconds earlier.
    deps.findArtifact = async () => null;
    const raced = await publishArtifact(
      { deploymentId, path: "artifacts/report.png", kind: "html" },
      deps,
    );

    expect(raced.ok).toBe(false);
    if (raced.ok) return;
    expect(raced.error).toMatch(/cannot be republished as a page/i);
    // Nothing landed under the wrong kind: an html version on an image card is bytes at the
    // cookie-authenticated image door.
    expect(deps.versions).toHaveLength(1);
  });

  it("charges a new card to the conversation ceiling, but lets an existing one keep refining", async () => {
    const deploymentId = await seedDeployment();
    let sessionCount = 0;
    let bytes = PNG;
    const deps = makeDeps({
      copy: async () => ({ ok: true, bytes }),
      usage: async () => ({ sessionCount, projectCount: 0, projectBytes: 0 }),
    });

    await publishArtifact({ deploymentId, path: "artifacts/chart.png" }, deps);
    sessionCount = MAX_ARTIFACTS_PER_SESSION;
    bytes = Buffer.from([...PNG, 0x04]);
    const refined = await publishArtifact(
      { deploymentId, path: "artifacts/chart.png" },
      deps,
    );
    const fresh = await publishArtifact(
      { deploymentId, path: "artifacts/other.png" },
      deps,
    );

    // That budget bounds how much a TRANSCRIPT holds, and a republish adds no card. Its bytes are
    // still charged to the daily repo ceiling, which is the one that bounds the disk.
    expect(refined).toMatchObject({ ok: true, version: 2 });
    expect(fresh.ok).toBe(false);
  });
});

describe("publishArtifact budgets", () => {
  it("refuses once a conversation holds the per-conversation maximum", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps({
      usage: async () => ({
        sessionCount: MAX_ARTIFACTS_PER_SESSION,
        projectCount: 1,
        projectBytes: 10,
      }),
    });

    const result = await publishArtifact(
      { deploymentId, path: "artifacts/chart.png" },
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/already holds 100 published files/);
    expect(deps.copies).toHaveLength(0);
  });

  it("refuses on the repo's daily count and byte ceilings, and measures them over the window", async () => {
    const deploymentId = await seedDeployment();
    const seen: Array<{ since: Date; projectId: string; sessionId: string }> = [];
    const byCount = makeDeps({
      usage: async (input) => {
        seen.push(input);
        return {
          sessionCount: 0,
          projectCount: MAX_ARTIFACTS_PER_PROJECT_WINDOW,
          projectBytes: 0,
        };
      },
    });
    const byBytes = makeDeps({
      usage: async () => ({
        sessionCount: 0,
        projectCount: 1,
        projectBytes: MAX_ARTIFACT_BYTES_PER_PROJECT_WINDOW,
      }),
    });

    for (const deps of [byCount, byBytes]) {
      const result = await publishArtifact(
        { deploymentId, path: "artifacts/chart.png" },
        deps,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/daily limit/i);
      expect(deps.copies).toHaveLength(0);
    }
    expect(seen[0]).toMatchObject({ projectId: PROJECT, sessionId: "ps_live" });
    expect(seen[0].since.getTime()).toBe(NOW.getTime() - ARTIFACT_BUDGET_WINDOW_MS);
  });
});

describe("withArtifactCopySlot", () => {
  it("refuses past the concurrency ceiling and frees the slot even when the copy throws", async () => {
    const releases: Array<() => void> = [];
    const held = Array.from({ length: MAX_CONCURRENT_ARTIFACT_COPIES }, () =>
      withArtifactCopySlot(
        () =>
          new Promise<string>((resolve) =>
            releases.push(() => resolve("done")),
          ),
      ),
    );

    expect(await withArtifactCopySlot(async () => "extra")).toEqual({ ok: false });
    for (const release of releases) release();
    expect(await Promise.all(held)).toEqual(
      held.map(() => ({ ok: true, value: "done" })),
    );

    await expect(
      withArtifactCopySlot(async () => {
        throw new Error("docker exploded");
      }),
    ).rejects.toThrow("docker exploded");
    // The throw above must not have leaked its slot.
    expect(await withArtifactCopySlot(async () => "free")).toEqual({
      ok: true,
      value: "free",
    });
  });
});
