/**
 * Artifact publishing (issues #290, #291) — the control-plane half of "the agent made something and
 * the user should see it in the conversation": a single image, or a small static PAGE BUNDLE that
 * the FOH preview panel renders in a sandboxed iframe.
 *
 * The transcript cannot carry assets: the wire protocol between harnesst and an instance is JSON
 * text and `textOf` flattens every event to a string, so anything that is not prose is dropped
 * before it could reach the UI. Publication is therefore a side-channel call, shaped exactly like
 * `park.server.ts`: the bearer authenticates a DEPLOYMENT and nothing more, every identity fact
 * (environment, agent, project, conversation) is re-derived server-side from that id, and every
 * business outcome is a VALUE the agent can read rather than an HTTP failure it would retry
 * forever. Collaborators are injected so the whole flow unit-tests with no docker and no disk.
 *
 * Two things the agent says are load-bearing and both are validated here, not trusted: the PATH
 * (confined to the agent's own home volume — `docker cp` would otherwise read any file in the
 * instance) and the CONTENT TYPE. For an image the type is sniffed from the bytes, because the image
 * serving route is same-origin and cookie-authenticated, so a mislabelled HTML payload would be
 * stored XSS. A bundle's members cannot be sniffed (HTML/CSS/JS have no magic bytes), so their types
 * come from a closed extension allowlist and their SAFETY comes from the preview response's own
 * `sandbox` CSP instead — see `artifact-preview.server.ts` for why that swap is sound.
 *
 * The DESTINATION is derived the same way, and it is the third security decision here: an artifact
 * goes to the conversation whose turn is running on the calling deployment right now, never to "the
 * agent's most recent conversation" — one deployment serves every member's FOH sessions, and those
 * sessions are per-creator confidential, so the newest row is routinely a different person's.
 *
 * And because the caller is an agent in a loop, publishing is BUDGETED: per-conversation and daily
 * per-repo ceilings bound the disk (nothing ever deletes stored bytes) and a copy-slot gate bounds
 * the heap (each copy buffers its tar whole). Both are refusals the agent can read.
 */
import { createHash } from "node:crypto";

import { TURN_IDLE_TIMEOUT_MS } from "~/chat/turn-stream.server";
import type { DataStore } from "~/data/ports";
import {
  copyArtifactBundleFromInstance,
  copyArtifactFromInstance,
  type ArtifactBundleCopyResult,
  type ArtifactCopyResult,
} from "~/foh/artifact-copy.server";
import {
  ARTIFACT_BUNDLE_EXTENSIONS,
  ARTIFACT_BUNDLE_MAX_FILES,
  ARTIFACT_MAX_BYTES,
  artifactKindFor,
  artifactUrl,
  pickBundleEntry,
  resolveArtifactSource,
  resolveBundleMember,
  sniffArtifactContentType,
} from "~/foh/artifact-media";
import {
  artifactUsage,
  insertArtifact,
  insertArtifactBundle,
  writeArtifactBytes,
  type Artifact,
  type ArtifactFileInput,
} from "~/foh/artifact-store.server";
import { liveFohTurnForDeployment } from "~/playground/sessions.server";
import { getRuntime } from "~/seams/index.server";

/** Longest agent-supplied caption kept — it is one line under a card. */
const MAX_TITLE_LENGTH = 200;

/**
 * BUDGETS. The 25 MB per-artifact cap bounds one call; these bound a LOOP, which is the shape the
 * failure actually takes (a buggy or prompt-injected agent publishing near-identical screenshots).
 * Nothing ever deletes stored bytes and content addressing only dedups byte-identical files, so
 * without a ceiling an agent owns the control plane's disk — which in the single-VPS deploy is the
 * same disk Postgres writes to (deploy/vps/docker-compose.yml).
 *
 * Deliberately generous: a real conversation shows a handful of images, so these are only ever felt
 * by a runaway. Refusals are VALUES, so hitting one reads to the agent as "stop publishing", which
 * is exactly the intended feedback.
 */
export const MAX_ARTIFACTS_PER_SESSION = 100;
export const ARTIFACT_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_ARTIFACTS_PER_PROJECT_WINDOW = 500;
export const MAX_ARTIFACT_BYTES_PER_PROJECT_WINDOW = 2 * 1024 * 1024 * 1024;

/**
 * CONCURRENCY. Each copy buffers a whole tar in this process (up to `ARTIFACT_MAX_BYTES`), so the
 * heap cost of publishing is N × 25 MB and N is otherwise whatever the agents choose. The gate is a
 * refusal rather than a queue on purpose: a queued publish would hold the caller's turn open for as
 * long as the queue is deep, and "harnesst is busy, try again" is something the agent can act on.
 */
export const MAX_CONCURRENT_ARTIFACT_COPIES = 3;

let copiesInFlight = 0;

/**
 * Run `body` in one of the copy slots, or report that none was free. Exported for its own test:
 * the interesting property (the slot is released even when the copy throws) is invisible from
 * `publishArtifact`.
 */
export async function withArtifactCopySlot<T>(
  body: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  if (copiesInFlight >= MAX_CONCURRENT_ARTIFACT_COPIES) return { ok: false };
  copiesInFlight += 1;
  try {
    return { ok: true, value: await body() };
  } finally {
    copiesInFlight -= 1;
  }
}

export interface PublishArtifactDeps {
  store: DataStore;
  /** Read the file out of the publishing deployment's instance over the docker socket. */
  copyFile: (input: {
    deploymentId: string;
    path: string;
    maxBytes: number;
  }) => Promise<ArtifactCopyResult>;
  /** The same, for a page bundle: one HTML file, or a directory of one. */
  copyBundle: (input: {
    deploymentId: string;
    path: string;
    maxBytes: number;
    maxFiles: number;
  }) => Promise<ArtifactBundleCopyResult>;
  writeBytes: (sha256: string, bytes: Buffer) => Promise<string>;
  insert: typeof insertArtifact;
  insertBundle: typeof insertArtifactBundle;
  /** The conversation an artifact published by this agent belongs to — the live turn's, only. */
  findSession: typeof liveFohTurnForDeployment;
  /** Consumption the publish is held against (see the budgets above). */
  usage: typeof artifactUsage;
  now: () => Date;
}

export function defaultPublishArtifactDeps(): PublishArtifactDeps {
  return {
    store: getRuntime().data,
    copyFile: copyArtifactFromInstance,
    copyBundle: copyArtifactBundleFromInstance,
    writeBytes: writeArtifactBytes,
    insert: insertArtifact,
    insertBundle: insertArtifactBundle,
    findSession: liveFohTurnForDeployment,
    usage: artifactUsage,
    now: () => new Date(),
  };
}

export interface PublishArtifactInput {
  /** The caller deployment id the route's bearer authenticated. Never from the body. */
  deploymentId: string;
  path: string;
  title?: string | null;
  /** `image` or `html`; omitted, the path's own extension decides (see `artifactKindFor`). */
  kind?: string | null;
}

export type PublishArtifactResult =
  | {
      ok: true;
      artifactId: string;
      kind: string;
      /**
       * App path the artifact is served at, or null for a page bundle — a bundle's bytes are ONLY
       * reachable through a preview URL the app mints per panel-open, so there is no stable link to
       * hand the agent. It says "published" in the reply; the card opens the preview.
       */
      url: string | null;
      name: string;
      contentType: string;
      byteSize: number;
      /** Bundle only: how many files were stored, so the agent can see nothing went missing. */
      fileCount?: number;
    }
  | { ok: false; error: string };

function deny(error: string): PublishArtifactResult {
  return { ok: false, error };
}

/**
 * A bundle's content identity: a sha256 over its members' `(rel_path, sha256)` manifest, sorted.
 * The entry document's own sha would not do — a page whose stylesheet changed while `index.html`
 * did not would dedupe onto the stale card via `artifacts_session_sha_uq` and the user would be
 * shown the previous version of the page.
 */
function bundleSha256(files: readonly ArtifactFileInput[]): string {
  const manifest = [...files]
    .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
    .map((file) => `${file.relPath}\0${file.sha256}`)
    .join("\n");
  return createHash("sha256").update(manifest, "utf8").digest("hex");
}

export async function publishArtifact(
  input: PublishArtifactInput,
  deps: PublishArtifactDeps,
): Promise<PublishArtifactResult> {
  const { store } = deps;

  // Cheap refusals first: nothing below should run for a payload that can never be accepted.
  const source = resolveArtifactSource(input.path);
  if (!source) {
    return deny(
      "Publish a file inside /workspace/home (for example /workspace/home/artifacts/chart.png) — that is the only tree harnesst can read.",
    );
  }
  const kind = artifactKindFor(input.kind, source.name);
  if (!kind) {
    return deny(
      `harnesst publishes images and HTML pages, not "${input.kind}". Pass kind "image" or "html".`,
    );
  }

  // Caller resolution — deployment → environment → agent → project, all from the token's
  // deployment id (the park/`runAsk` rule: nothing about identity comes off the wire).
  const deployment = await store.deployments.findById(input.deploymentId);
  if (!deployment) return deny("Your deployment is no longer known to harnesst.");
  const environment = await store.environments.findById(deployment.environmentId);
  if (!environment) return deny("Your environment is no longer known to harnesst.");
  const agent = await store.agents.findById(environment.agentId);
  if (!agent) return deny("Your agent is no longer part of this repository.");
  const project = await store.projects.findById(agent.projectId);
  if (!project) return deny("This repository is no longer connected.");

  // The DESTINATION is derived from the live turn, never from "the agent's newest conversation":
  // one deployment serves every member's conversation with this agent, so the newest row is
  // routinely someone else's and publishing into it would show one member's image to another
  // (and let them download the bytes). See `liveFohTurnForDeployment`.
  const found = await deps.findSession({
    projectId: project.id,
    agentId: agent.id,
    environmentId: deployment.environmentId,
    staleAfterMs: TURN_IDLE_TIMEOUT_MS,
    now: deps.now(),
  });
  if (!found.ok) {
    return deny(
      found.reason === "ambiguous"
        ? "You are working on more than one Front of House conversation at once, so harnesst cannot tell which one this file belongs to. Publish it when only this conversation is running."
        : "There is no Front of House conversation waiting on you right now, so there is nowhere to show the file. Publish it while you are answering someone in harnesst.",
    );
  }
  const session = found.session;

  const usage = await deps.usage({
    projectId: project.id,
    sessionId: session.id,
    since: new Date(deps.now().getTime() - ARTIFACT_BUDGET_WINDOW_MS),
  });
  if (usage.sessionCount >= MAX_ARTIFACTS_PER_SESSION) {
    return deny(
      `This conversation already holds ${MAX_ARTIFACTS_PER_SESSION} published files, which is the limit. Describe the file instead, or start a new conversation.`,
    );
  }
  if (
    usage.projectCount >= MAX_ARTIFACTS_PER_PROJECT_WINDOW ||
    usage.projectBytes >= MAX_ARTIFACT_BYTES_PER_PROJECT_WINDOW
  ) {
    return deny(
      "This repository has hit its daily limit for published files. Describe the file instead; publishing works again tomorrow.",
    );
  }

  // The position the conversation had reached WHEN the publish landed, so the card renders inside
  // the turn that produced it rather than at the end of the transcript forever after. With the
  // durable cache gone (#288) the row's eve-space cursor IS that position — the live drain's
  // progress saves keep it within the in-flight turn.
  const common = {
    projectId: project.id,
    agentId: agent.id,
    sessionId: session.id,
    deploymentId: deployment.id,
    title: input.title?.trim()
      ? input.title.trim().slice(0, MAX_TITLE_LENGTH)
      : null,
    streamIndex: session.streamIndex,
  };

  // Budget-checked and destination-resolved before a single byte is read: everything above is a
  // couple of indexed queries, while the copies below hold up to 25 MB of this process's heap.
  return kind === "html"
    ? publishBundle({ deployment, source, common }, deps)
    : publishImage({ deployment, source, common }, deps);
}

/** The row fields both kinds share, resolved before any bytes are read. */
interface ArtifactRowCommon {
  projectId: string;
  agentId: string;
  sessionId: string;
  deploymentId: string;
  title: string | null;
  streamIndex: number;
}

interface PublishHalfInput {
  deployment: { id: string };
  source: { path: string; name: string };
  common: ArtifactRowCommon;
}

const BUSY = "harnesst is already copying as many files as it can at once. Try publishing again in a moment.";
const RECORD_FAILED = "harnesst could not record the artifact. Try publishing again.";

/**
 * Publish one image (#290): copy the file under a concurrency slot, read its real type out of its
 * own bytes, content-address the bytes into the store and record the row. The type is sniffed rather
 * than claimed because the image route serves same-origin behind the operator's own cookie.
 */
async function publishImage(
  { deployment, source, common }: PublishHalfInput,
  deps: PublishArtifactDeps,
): Promise<PublishArtifactResult> {
  const slot = await withArtifactCopySlot(() =>
    deps.copyFile({
      deploymentId: deployment.id,
      path: source.path,
      maxBytes: ARTIFACT_MAX_BYTES,
    }),
  );
  if (!slot.ok) return deny(BUSY);
  const copied = slot.value;
  if (!copied.ok) return deny(copied.error);

  const contentType = sniffArtifactContentType(copied.bytes, source.name);
  if (!contentType) {
    return deny(
      `${source.name} is not a PNG, JPEG, WebP or SVG image. harnesst reads the file's own bytes, so renaming it does not help.`,
    );
  }

  const sha256 = createHash("sha256").update(copied.bytes).digest("hex");
  const storagePath = await deps.writeBytes(sha256, copied.bytes);

  let row: Artifact;
  try {
    row = await deps.insert({
      ...common,
      name: source.name,
      kind: "image",
      entryPath: null,
      contentType,
      byteSize: copied.bytes.length,
      sha256,
      storagePath,
    });
  } catch (error) {
    console.error("[foh] artifact publish failed to record:", error);
    return deny(RECORD_FAILED);
  }
  if (!row) return deny(RECORD_FAILED);

  return {
    ok: true,
    artifactId: row.id,
    kind: row.kind,
    url: artifactUrl(row.projectId, row.id),
    name: row.name,
    contentType: row.contentType,
    byteSize: row.byteSize,
  };
}

/**
 * A page bundle (#291): an HTML file, or a directory holding one plus its static siblings.
 *
 * Every member is re-validated here rather than in the copy, because the copy's job ends at "these
 * bytes came from inside the home volume" — the type allowlist and the path normalization are what
 * decide what may be SERVED, and the preview route trusts the stored rows completely.
 */
async function publishBundle(
  { deployment, source, common }: PublishHalfInput,
  deps: PublishArtifactDeps,
): Promise<PublishArtifactResult> {
  const slot = await withArtifactCopySlot(() =>
    deps.copyBundle({
      deploymentId: deployment.id,
      path: source.path,
      maxBytes: ARTIFACT_MAX_BYTES,
      maxFiles: ARTIFACT_BUNDLE_MAX_FILES,
    }),
  );
  if (!slot.ok) return deny(BUSY);
  const copied = slot.value;
  if (!copied.ok) return deny(copied.error);

  const members: Array<{
    relPath: string;
    contentType: string;
    bytes: Buffer;
  }> = [];
  for (const file of copied.files) {
    const member = resolveBundleMember(file.name, file.bytes);
    if (!member) {
      return deny(
        `harnesst will not publish ${file.name} as part of a page. A page may hold ${ARTIFACT_BUNDLE_EXTENSIONS.join(", ")} files with plain names (letters, digits, dots, dashes), and an image member has to really be the image its name claims. Remove it and publish again.`,
      );
    }
    members.push({ ...member, bytes: file.bytes });
  }

  const entryPath = pickBundleEntry(members.map((member) => member.relPath));
  if (!entryPath) {
    return deny(
      `harnesst couldn't tell which page to open in ${source.name}. Name the page index.html, or publish a single .html file.`,
    );
  }
  if (members.find((member) => member.relPath === entryPath)?.bytes.length === 0) {
    return deny(`${entryPath} is empty, so there is no page to show.`);
  }

  const files: ArtifactFileInput[] = [];
  for (const member of members) {
    const sha256 = createHash("sha256").update(member.bytes).digest("hex");
    files.push({
      relPath: member.relPath,
      contentType: member.contentType,
      byteSize: member.bytes.length,
      sha256,
      storagePath: await deps.writeBytes(sha256, member.bytes),
    });
  }
  const entry = files.find((file) => file.relPath === entryPath)!;

  let row: Artifact;
  try {
    row = await deps.insertBundle({
      artifact: {
        ...common,
        name: source.name,
        kind: "html",
        entryPath,
        contentType: entry.contentType,
        // The SUM, not the entry's size: the daily per-repo byte ceiling reads this column, and
        // charging one member would let a bundle spend the disk a stylesheet at a time.
        byteSize: files.reduce((total, file) => total + file.byteSize, 0),
        sha256: bundleSha256(files),
        storagePath: entry.storagePath,
      },
      files,
    });
  } catch (error) {
    console.error("[foh] artifact bundle publish failed to record:", error);
    return deny(RECORD_FAILED);
  }
  if (!row) return deny(RECORD_FAILED);

  return {
    ok: true,
    artifactId: row.id,
    kind: row.kind,
    // No stable URL by design — a bundle is reachable only through a short-lived preview token the
    // app mints when the user opens the card.
    url: null,
    name: row.name,
    contentType: row.contentType,
    byteSize: row.byteSize,
    fileCount: files.length,
  };
}
