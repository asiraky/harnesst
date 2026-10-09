/**
 * Agent-facing read of the repository's published artifacts — the `team-artifacts` tool's relay.
 * A teammate (Hermes turning a prototype into a spec) lists what any agent in the repo published
 * and pulls one version's files into its own home.
 *
 * Scope is the caller's PROJECT, re-derived from the delegation token's deployment on every call,
 * so an id from another repo is simply not found. Conversation artifacts are included: the
 * project's Artifacts page already shows them to every operator, and this grants no more.
 *
 * Every failure the model can act on is `{ ok:false, error }`; the route owns the 401.
 */
import type { DataStore } from "~/data/ports";
import { ARTIFACT_MAX_BYTES } from "~/foh/artifact-media";
import {
  findProjectArtifact,
  listArtifactFiles,
  listArtifactVersions,
  listProjectArtifacts,
  readArtifactBytes,
  type Artifact,
  type ArtifactFile,
  type ArtifactVersion,
} from "~/foh/artifact-store.server";
import { getRuntime } from "~/seams/index.server";

/** How many artifacts one list returns, newest first. A filter narrows before the cut. */
export const TEAM_ARTIFACT_LIST_LIMIT = 100;

export interface TeamArtifactDeps {
  store: DataStore;
  listProjectArtifacts(
    projectId: string,
  ): Promise<Array<Artifact & { lastPublishedAt: Date }>>;
  findProjectArtifact(input: {
    id: string;
    projectId: string;
  }): Promise<Artifact | null>;
  listArtifactVersions(artifactId: string): Promise<ArtifactVersion[]>;
  listArtifactFiles(versionId: string): Promise<ArtifactFile[]>;
  readArtifactBytes(storagePath: string): Promise<Buffer | null>;
}

export function defaultTeamArtifactDeps(): TeamArtifactDeps {
  return {
    store: getRuntime().data,
    listProjectArtifacts,
    findProjectArtifact,
    listArtifactVersions,
    listArtifactFiles,
    readArtifactBytes,
  };
}

export interface TeamArtifactSummary {
  id: string;
  name: string;
  title: string | null;
  kind: string;
  agent: string | null;
  lastPublishedAt: string;
}

export interface TeamArtifactWireFile {
  path: string;
  contentType: string;
  content: string;
  encoding: "base64";
}

export type TeamArtifactResult =
  | { ok: false; error: string }
  | { ok: true; artifacts: TeamArtifactSummary[]; truncated: boolean }
  | {
      ok: true;
      artifact: TeamArtifactSummary;
      version: number;
      versions: Array<{ version: number; publishedAt: string }>;
      folder: string;
      entry: string;
      files: TeamArtifactWireFile[];
    };

const fail = (error: string): TeamArtifactResult => ({ ok: false, error });

/**
 * A published name as one safe path segment — the folder the tool writes into, and a single
 * file's own name inside it. Published names are file and directory basenames, so this is almost
 * always the identity; it exists for the odd space or symbol, never to make an unsafe name safe.
 */
export function artifactPathSegment(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^[^A-Za-z0-9_]+/, "")
    .slice(0, 120);
  return cleaned || "artifact";
}

function summarize(
  artifact: Artifact,
  lastPublishedAt: Date,
  agentNames: Map<string, string>,
): TeamArtifactSummary {
  return {
    id: artifact.id,
    name: artifact.name,
    title: artifact.title,
    kind: artifact.kind,
    agent: agentNames.get(artifact.agentId) ?? null,
    lastPublishedAt: lastPublishedAt.toISOString(),
  };
}

function matches(summary: TeamArtifactSummary, query: string): boolean {
  const needle = query.toLowerCase();
  return [summary.name, summary.title ?? "", summary.agent ?? ""].some(
    (field) => field.toLowerCase().includes(needle),
  );
}

export async function runTeamArtifactOperation(
  deploymentId: string,
  raw: unknown,
  deps: TeamArtifactDeps = defaultTeamArtifactDeps(),
): Promise<TeamArtifactResult> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return fail("Send a JSON object describing the artifact operation.");
  }
  const body = raw as {
    op?: unknown;
    id?: unknown;
    version?: unknown;
    query?: unknown;
  };
  if (body.op !== "list" && body.op !== "get") {
    return fail("Choose one artifact operation: list or get.");
  }

  const deployment = await deps.store.deployments.findById(deploymentId);
  const environment = deployment
    ? await deps.store.environments.findById(deployment.environmentId)
    : null;
  const caller = environment
    ? await deps.store.agents.findById(environment.agentId)
    : null;
  if (!caller) return fail("Your deployment is no longer known to harnesst.");
  const agentNames = new Map(
    (await deps.store.agents.listByProject(caller.projectId)).map((a) => [
      a.id,
      a.name,
    ]),
  );

  if (body.op === "list") {
    if (body.query !== undefined && typeof body.query !== "string") {
      return fail("query must be text.");
    }
    const query = body.query?.trim() ?? "";
    const all = (await deps.listProjectArtifacts(caller.projectId))
      .map((a) => summarize(a, a.lastPublishedAt, agentNames))
      .filter((summary) => !query || matches(summary, query));
    return {
      ok: true,
      artifacts: all.slice(0, TEAM_ARTIFACT_LIST_LIMIT),
      truncated: all.length > TEAM_ARTIFACT_LIST_LIMIT,
    };
  }

  if (typeof body.id !== "string" || !body.id) {
    return fail("Give the id of an artifact from artifacts-list.");
  }
  if (
    body.version !== undefined &&
    !(Number.isInteger(body.version) && (body.version as number) > 0)
  ) {
    return fail("version must be a positive whole number.");
  }
  const artifact = await deps.findProjectArtifact({
    id: body.id,
    projectId: caller.projectId,
  });
  if (!artifact) {
    return fail(
      `No artifact ${body.id} in this repository. List them with artifacts-list.`,
    );
  }
  const versions = await deps.listArtifactVersions(artifact.id);
  const version =
    body.version === undefined
      ? versions[0]
      : versions.find((v) => v.versionNumber === body.version);
  if (!version) {
    return fail(
      versions.length
        ? `${artifact.name} has no version ${String(body.version)}; it has versions 1 to ${versions[0].versionNumber}.`
        : `${artifact.name} has no stored versions.`,
    );
  }

  const fileName = artifactPathSegment(artifact.name);
  const members =
    artifact.kind === "html"
      ? (await deps.listArtifactFiles(version.id)).map((f) => ({
          path: f.relPath,
          contentType: f.contentType,
          byteSize: f.byteSize,
          storagePath: f.storagePath,
        }))
      : [
          {
            path: fileName,
            contentType: version.contentType,
            byteSize: version.byteSize,
            storagePath: version.storagePath,
          },
        ];
  const total = members.reduce((sum, m) => sum + m.byteSize, 0);
  if (total > ARTIFACT_MAX_BYTES) {
    return fail(
      `Version ${version.versionNumber} of ${artifact.name} is ${Math.ceil(total / 1024 / 1024)} MB, over the 25 MB a fetch can carry.`,
    );
  }

  const files: TeamArtifactWireFile[] = [];
  for (const member of members) {
    const bytes = await deps.readArtifactBytes(member.storagePath);
    if (!bytes) {
      return fail(
        `Version ${version.versionNumber} of ${artifact.name} is missing ${member.path} from storage.`,
      );
    }
    files.push({
      path: member.path,
      contentType: member.contentType,
      content: bytes.toString("base64"),
      encoding: "base64",
    });
  }

  const lastPublishedAt = versions[0].createdAt;
  return {
    ok: true,
    artifact: summarize(artifact, lastPublishedAt, agentNames),
    version: version.versionNumber,
    versions: versions.map((v) => ({
      version: v.versionNumber,
      publishedAt: v.createdAt.toISOString(),
    })),
    folder: fileName,
    entry:
      artifact.kind === "html" ? (version.entryPath ?? "index.html") : fileName,
    files,
  };
}
