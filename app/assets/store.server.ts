/**
 * Repo-backed shared asset store (issue #322).
 *
 * A delegation token identifies only a deployment. This service re-derives deployment →
 * environment → agent → project → GitHub installation on every call, then confines all paths to
 * `assets/<validated-id>/`. Writes are one compare-and-swap Git Data commit and retry on a moving
 * managed branch. Reads use branch HEAD directly and never touch the cached agent-source view.
 */
import type { DataStore } from "~/data/ports";
import { getRuntime } from "~/seams/index.server";
import { getInstallationOctokit } from "~/github/client.server";
import {
  commitToDefaultBranch,
  NonFastForwardError,
  type GitFileChange,
} from "~/github/write.server";
import {
  ASSET_MAX_BYTES,
  ASSET_MAX_FILES,
  assetRepoPrefix,
  decodeBase64,
  isTextAssetPath,
  normalizeAssetFilePath,
  normalizeAssetId,
  sha256,
} from "./policy";

export interface AssetManifestFile {
  path: string;
  size: number;
  sha256: string;
}

export interface AssetManifest {
  id: string;
  description: string | null;
  files: AssetManifestFile[];
  createdAt: string;
  updatedAt: string;
  writer: {
    deploymentId: string;
    agentId: string;
    agent: string;
  };
}

export interface AssetTreeEntry {
  path: string;
  type: string;
  mode: string;
  sha: string | null;
  size?: number;
}

export interface AssetSnapshot {
  headSha: string;
  entries: AssetTreeEntry[];
  truncated: boolean;
}

export interface AssetRepository {
  snapshot(branch: string): Promise<AssetSnapshot>;
  readBlob(sha: string): Promise<Buffer>;
  commit(input: {
    branch: string;
    expectedHeadSha: string;
    files: GitFileChange[];
    message: string;
  }): Promise<string>;
}

export interface AssetStoreDeps {
  store: DataStore;
  openRepository(input: {
    installationId: string;
    owner: string;
    repo: string;
  }): Promise<AssetRepository>;
  now(): Date;
}

async function defaultOpenRepository(input: {
  installationId: string;
  owner: string;
  repo: string;
}): Promise<AssetRepository> {
  const octokit = await getInstallationOctokit(input.installationId);
  const coordinates = { owner: input.owner, repo: input.repo };
  return {
    async snapshot(branch) {
      const ref = await octokit.rest.git.getRef({
        ...coordinates,
        ref: `heads/${branch}`,
      });
      const headSha = ref.data.object.sha;
      const commit = await octokit.rest.git.getCommit({
        ...coordinates,
        commit_sha: headSha,
      });
      const tree = await octokit.rest.git.getTree({
        ...coordinates,
        tree_sha: commit.data.tree.sha,
        recursive: "1",
      });
      return {
        headSha,
        truncated: Boolean(tree.data.truncated),
        entries: tree.data.tree.flatMap((entry) =>
          entry.path && entry.type && entry.mode
            ? [
                {
                  path: entry.path,
                  type: entry.type,
                  mode: entry.mode,
                  sha: entry.sha ?? null,
                  size: entry.size,
                },
              ]
            : [],
        ),
      };
    },
    async readBlob(sha) {
      const blob = await octokit.rest.git.getBlob({
        ...coordinates,
        file_sha: sha,
      });
      return Buffer.from(blob.data.content.replace(/\n/g, ""), "base64");
    },
    async commit(commitInput) {
      const result = await commitToDefaultBranch(
        input.installationId,
        coordinates,
        {
          ...commitInput,
          invalidateSourceCache: false,
        },
      );
      return result.sha;
    },
  };
}

export function defaultAssetStoreDeps(): AssetStoreDeps {
  return {
    store: getRuntime().data,
    openRepository: defaultOpenRepository,
    now: () => new Date(),
  };
}

export type AssetResult =
  | { ok: false; error: string }
  | { ok: true; assets: AssetManifest[] }
  | { ok: true; asset: AssetManifest; files: AssetWireFile[] }
  | { ok: true; asset: AssetManifest; commitSha: string }
  | { ok: true; id: string; commitSha: string };

export interface AssetWireFile {
  path: string;
  content: string;
  encoding: "utf8" | "base64";
}

const fail = (error: string): AssetResult => ({ ok: false, error });
const MAX_MANIFEST_BYTES = 128 * 1024;

function parseManifest(
  bytes: Buffer,
  expectedId: string,
): AssetManifest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Partial<AssetManifest>;
  if (
    value.id !== expectedId ||
    (typeof value.description !== "string" && value.description !== null) ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    (typeof value.description === "string" &&
      value.description.length > 2_000) ||
    !value.writer ||
    typeof value.writer.deploymentId !== "string" ||
    typeof value.writer.agentId !== "string" ||
    typeof value.writer.agent !== "string" ||
    !Array.isArray(value.files) ||
    value.files.length === 0 ||
    value.files.length > ASSET_MAX_FILES
  ) {
    return null;
  }
  const files: AssetManifestFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const file of value.files) {
    if (
      !file ||
      typeof file !== "object" ||
      normalizeAssetFilePath((file as AssetManifestFile).path) !==
        (file as AssetManifestFile).path ||
      !Number.isSafeInteger((file as AssetManifestFile).size) ||
      (file as AssetManifestFile).size < 0 ||
      !/^[a-f0-9]{64}$/.test((file as AssetManifestFile).sha256) ||
      seen.has((file as AssetManifestFile).path)
    ) {
      return null;
    }
    seen.add((file as AssetManifestFile).path);
    total += (file as AssetManifestFile).size;
    if (total > ASSET_MAX_BYTES) return null;
    files.push(file as AssetManifestFile);
  }
  return { ...(value as AssetManifest), files };
}

function assetEntries(snapshot: AssetSnapshot, id: string): AssetTreeEntry[] {
  const prefix = assetRepoPrefix(id);
  return snapshot.entries.filter(
    (entry) => entry.path.startsWith(prefix) && entry.type !== "tree",
  );
}

/** Hierarchical ids are useful, but one asset directory cannot contain another asset. */
function overlappingAssetId(
  snapshot: AssetSnapshot,
  id: string,
): string | null {
  const suffix = "/manifest.json";
  for (const entry of snapshot.entries) {
    if (!entry.path.startsWith("assets/") || !entry.path.endsWith(suffix))
      continue;
    const other = entry.path.slice("assets/".length, -suffix.length);
    if (
      other !== id &&
      (other.startsWith(`${id}/`) || id.startsWith(`${other}/`)) &&
      normalizeAssetId(other) === other
    ) {
      return other;
    }
  }
  return null;
}

async function manifestFromSnapshot(
  repository: AssetRepository,
  snapshot: AssetSnapshot,
  id: string,
): Promise<AssetManifest | null> {
  const entry = snapshot.entries.find(
    (candidate) =>
      candidate.path === `${assetRepoPrefix(id)}manifest.json` &&
      candidate.type === "blob" &&
      candidate.mode === "100644" &&
      (candidate.size === undefined || candidate.size <= MAX_MANIFEST_BYTES) &&
      candidate.sha,
  );
  if (!entry?.sha) return null;
  return parseManifest(await repository.readBlob(entry.sha), id);
}

function parsePutFiles(
  raw: unknown,
):
  | { ok: true; files: { path: string; bytes: Buffer }[] }
  | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "Put at least one file in the asset." };
  }
  if (raw.length > ASSET_MAX_FILES) {
    return {
      ok: false,
      error: `An asset can hold at most ${ASSET_MAX_FILES} files.`,
    };
  }
  const seen = new Set<string>();
  const files: { path: string; bytes: Buffer }[] = [];
  let total = 0;
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return {
        ok: false,
        error: "Each asset file needs a path, content and encoding.",
      };
    }
    const input = item as {
      path?: unknown;
      content?: unknown;
      encoding?: unknown;
    };
    const path = normalizeAssetFilePath(input.path);
    if (!path || path !== input.path) {
      return {
        ok: false,
        error:
          "Asset file paths use plain segments (letters, digits, dots and dashes), an allowed extension, and no leading dots or manifest.json.",
      };
    }
    if (seen.has(path))
      return { ok: false, error: `The file ${path} was supplied twice.` };
    if (typeof input.content !== "string") {
      return { ok: false, error: `The file ${path} has no string content.` };
    }
    const encoding = input.encoding ?? "utf8";
    const bytes =
      encoding === "utf8"
        ? Buffer.from(input.content, "utf8")
        : encoding === "base64"
          ? decodeBase64(input.content)
          : null;
    if (!bytes) {
      return {
        ok: false,
        error: `The file ${path} has invalid ${String(encoding)} content.`,
      };
    }
    total += bytes.length;
    if (total > ASSET_MAX_BYTES) {
      return {
        ok: false,
        error: "An asset can hold at most 25 MB of file content.",
      };
    }
    seen.add(path);
    files.push({ path, bytes });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { ok: true, files };
}

async function listAssets(
  repository: AssetRepository,
  snapshot: AssetSnapshot,
): Promise<AssetResult> {
  const suffix = "/manifest.json";
  const manifests = snapshot.entries
    .filter(
      (entry) =>
        entry.path.startsWith("assets/") &&
        entry.path.endsWith(suffix) &&
        entry.type === "blob" &&
        entry.mode === "100644" &&
        (entry.size === undefined || entry.size <= MAX_MANIFEST_BYTES) &&
        entry.sha,
    )
    .map((entry) => ({
      entry,
      id: entry.path.slice("assets/".length, -suffix.length),
    }))
    .filter(({ id }) => normalizeAssetId(id) === id)
    .sort((a, b) => a.id.localeCompare(b.id));
  const assets: AssetManifest[] = [];
  for (const { entry, id } of manifests) {
    const manifest = parseManifest(await repository.readBlob(entry.sha!), id);
    if (!manifest) return fail(`Asset "${id}" has an invalid manifest.json.`);
    assets.push(manifest);
  }
  return { ok: true, assets };
}

async function getAsset(
  repository: AssetRepository,
  snapshot: AssetSnapshot,
  id: string,
): Promise<AssetResult> {
  const manifest = await manifestFromSnapshot(repository, snapshot, id);
  if (!manifest) return fail(`No asset named "${id}" exists.`);
  const prefix = assetRepoPrefix(id);
  const entries = assetEntries(snapshot, id);
  const contentEntries = entries.filter(
    (entry) => entry.path !== `${prefix}manifest.json`,
  );
  if (
    contentEntries.some(
      (entry) =>
        entry.type !== "blob" ||
        entry.mode !== "100644" ||
        !entry.sha ||
        normalizeAssetFilePath(entry.path.slice(prefix.length)) !==
          entry.path.slice(prefix.length),
    )
  ) {
    return fail(
      `Asset "${id}" contains a link or unexpected file and cannot be read safely.`,
    );
  }
  const byPath = new Map(
    contentEntries.map((entry) => [entry.path.slice(prefix.length), entry]),
  );
  if (
    byPath.size !== manifest.files.length ||
    manifest.files.some((file) => !byPath.has(file.path))
  ) {
    return fail(`Asset "${id}" does not match its manifest.json.`);
  }
  const files: AssetWireFile[] = [];
  for (const expected of manifest.files) {
    const entry = byPath.get(expected.path)!;
    const bytes = await repository.readBlob(entry.sha!);
    if (bytes.length !== expected.size || sha256(bytes) !== expected.sha256) {
      return fail(
        `Asset "${id}" file ${expected.path} does not match its manifest.json.`,
      );
    }
    const text = isTextAssetPath(expected.path) ? bytes.toString("utf8") : null;
    // A text extension is only a hint. Preserve arbitrary bytes exactly when UTF-8 decoding would
    // insert replacement characters (for example a Windows-1252 HTML template).
    const encoding =
      text !== null && Buffer.from(text, "utf8").equals(bytes)
        ? "utf8"
        : "base64";
    files.push({
      path: expected.path,
      content: encoding === "utf8" ? text! : bytes.toString("base64"),
      encoding,
    });
  }
  return { ok: true, asset: manifest, files };
}

const MAX_COMMIT_ATTEMPTS = 3;

async function putAsset(
  repository: AssetRepository,
  id: string,
  description: string | null,
  rawFiles: unknown,
  writer: AssetManifest["writer"],
  branch: string,
  now: () => Date,
): Promise<AssetResult> {
  const parsed = parsePutFiles(rawFiles);
  if (!parsed.ok) return parsed;
  for (let attempt = 1; attempt <= MAX_COMMIT_ATTEMPTS; attempt += 1) {
    const snapshot = await repository.snapshot(branch);
    if (snapshot.truncated)
      return fail("This repository is too large to update assets safely.");
    const overlap = overlappingAssetId(snapshot, id);
    if (overlap) {
      return fail(`Asset "${id}" overlaps the existing asset "${overlap}".`);
    }
    const prior = await manifestFromSnapshot(repository, snapshot, id);
    const timestamp = now().toISOString();
    const manifest: AssetManifest = {
      id,
      description,
      files: parsed.files.map(({ path, bytes }) => ({
        path,
        size: bytes.length,
        sha256: sha256(bytes),
      })),
      createdAt: prior?.createdAt ?? timestamp,
      updatedAt: timestamp,
      writer,
    };
    const changes = new Map<string, GitFileChange>();
    for (const entry of assetEntries(snapshot, id)) {
      changes.set(entry.path, { path: entry.path, content: null });
    }
    const prefix = assetRepoPrefix(id);
    for (const file of parsed.files) {
      const path = `${prefix}${file.path}`;
      changes.set(path, { path, content: file.bytes });
    }
    const manifestPath = `${prefix}manifest.json`;
    changes.set(manifestPath, {
      path: manifestPath,
      content: `${JSON.stringify(manifest, null, 2)}\n`,
    });
    try {
      const commitSha = await repository.commit({
        branch,
        expectedHeadSha: snapshot.headSha,
        files: [...changes.values()],
        message: `assets: put ${id} (${writer.agent.replace(/[\r\n]/g, " ")})`,
      });
      return { ok: true, asset: manifest, commitSha };
    } catch (error) {
      if (
        !(error instanceof NonFastForwardError) ||
        attempt === MAX_COMMIT_ATTEMPTS
      ) {
        if (error instanceof NonFastForwardError) {
          return fail(
            "The repository kept changing while this asset was written. Try again.",
          );
        }
        throw error;
      }
    }
  }
  return fail("The asset could not be written.");
}

async function deleteAsset(
  repository: AssetRepository,
  id: string,
  writerName: string,
  branch: string,
): Promise<AssetResult> {
  for (let attempt = 1; attempt <= MAX_COMMIT_ATTEMPTS; attempt += 1) {
    const snapshot = await repository.snapshot(branch);
    if (snapshot.truncated)
      return fail("This repository is too large to update assets safely.");
    const overlap = overlappingAssetId(snapshot, id);
    if (overlap) {
      return fail(`Asset "${id}" overlaps the existing asset "${overlap}".`);
    }
    const entries = assetEntries(snapshot, id);
    if (entries.length === 0) return fail(`No asset named "${id}" exists.`);
    try {
      const commitSha = await repository.commit({
        branch,
        expectedHeadSha: snapshot.headSha,
        files: entries.map((entry) => ({ path: entry.path, content: null })),
        message: `assets: delete ${id} (${writerName.replace(/[\r\n]/g, " ")})`,
      });
      return { ok: true, id, commitSha };
    } catch (error) {
      if (
        !(error instanceof NonFastForwardError) ||
        attempt === MAX_COMMIT_ATTEMPTS
      ) {
        if (error instanceof NonFastForwardError) {
          return fail(
            "The repository kept changing while this asset was deleted. Try again.",
          );
        }
        throw error;
      }
    }
  }
  return fail("The asset could not be deleted.");
}

export async function runAssetOperation(
  deploymentId: string,
  raw: unknown,
  deps: AssetStoreDeps = defaultAssetStoreDeps(),
): Promise<AssetResult> {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return fail("Send a JSON object describing the asset operation.");
    }
    const body = raw as {
      op?: unknown;
      id?: unknown;
      description?: unknown;
      files?: unknown;
    };
    if (!["list", "get", "put", "delete"].includes(String(body.op))) {
      return fail("Choose one asset operation: list, get, put or delete.");
    }
    const deployment = await deps.store.deployments.findById(deploymentId);
    const environment = deployment
      ? await deps.store.environments.findById(deployment.environmentId)
      : null;
    const agent = environment
      ? await deps.store.agents.findById(environment.agentId)
      : null;
    const project = agent
      ? await deps.store.projects.findById(agent.projectId)
      : null;
    if (!deployment || !environment || !agent || !project) {
      return fail("Your deployment is no longer known to harnesst.");
    }
    if (
      !project.repoInstallationId ||
      !project.repoOwner ||
      !project.repoName
    ) {
      return fail(
        "This project is not connected to a writable GitHub repository.",
      );
    }
    const repository = await deps.openRepository({
      installationId: project.repoInstallationId,
      owner: project.repoOwner,
      repo: project.repoName,
    });
    if (body.op === "list") {
      const snapshot = await repository.snapshot(project.defaultBranch);
      if (snapshot.truncated)
        return fail("This repository is too large to list assets safely.");
      return listAssets(repository, snapshot);
    }
    const id = normalizeAssetId(body.id);
    if (!id || id !== body.id) {
      return fail(
        "Asset ids use slash-separated plain segments (letters, digits, dots and dashes), with no leading dots or empty segments.",
      );
    }
    if (body.op === "get") {
      const snapshot = await repository.snapshot(project.defaultBranch);
      if (snapshot.truncated)
        return fail("This repository is too large to read assets safely.");
      return getAsset(repository, snapshot, id);
    }
    if (body.op === "put") {
      if (
        body.description !== undefined &&
        body.description !== null &&
        (typeof body.description !== "string" ||
          body.description.length > 2_000)
      ) {
        return fail("An asset description must be at most 2,000 characters.");
      }
      return putAsset(
        repository,
        id,
        typeof body.description === "string" ? body.description : null,
        body.files,
        { deploymentId, agentId: agent.id, agent: agent.name },
        project.defaultBranch,
        deps.now,
      );
    }
    return deleteAsset(repository, id, agent.name, project.defaultBranch);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail(`The asset operation failed: ${detail}`);
  }
}
