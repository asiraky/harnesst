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
 *
 * Publishing is also VERSIONED (#292). The unit is a NAME in a conversation, not a file: publishing
 * `report.html` twice refines one card instead of stacking two, because the loop this exists to
 * serve is "show me" → "make it bolder" → "show me again". That makes the identity resolution a
 * fourth decision here — and it is why the version ceilings sit beside the other budgets, since a
 * refine loop is invisible to a per-conversation card count.
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
  ARTIFACT_DOCUMENT_MAX_BYTES,
  ARTIFACT_MAX_BYTES,
  artifactKindFor,
  artifactUrl,
  pickBundleEntry,
  resolveArtifactSource,
  resolveBundleMember,
  sniffArtifactContentType,
  sniffArtifactDocumentContentType,
} from "~/foh/artifact-media";
import { fohArtifactSandboxSessionId } from "~/foh/session-workspace";
import {
  artifactUsage,
  findSessionArtifact,
  recordArtifact,
  writeArtifactBytes,
  type ArtifactFileInput,
  type RecordArtifactResult,
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
 * VERSIONS (#292). Republishing a name refines one card instead of making another, so the two
 * ceilings above stop bounding it: the conversation count never moves and the daily repo budget is
 * a whole day wide. These are the ones a refine loop actually meets.
 *
 * KEPT is retention — the versions that stay openable in the picker. Older rows are dropped (the
 * bytes are not; they are shared and content-addressed, and the daily byte budget is what bounds
 * the disk). Ten is a conversation's worth of "make it bolder", not an archive: config rather than
 * schema exactly so it can ship conservative and loosen.
 *
 * TOTAL is the refusal, and it is what makes retention safe to be lenient about: pruning rows costs
 * nothing, so without a ceiling on how many times one name may be republished a runaway agent would
 * spend the repo's daily disk on a single card while every per-artifact number stayed small.
 */
export const MAX_ARTIFACT_VERSIONS_KEPT = 10;
export const MAX_ARTIFACT_VERSIONS_TOTAL = 50;

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
    worldKey: string;
    sandboxSessionId: string;
    path: string;
    maxBytes: number;
  }) => Promise<ArtifactCopyResult>;
  /** The same, for a page bundle: one HTML file, or a directory of one. */
  copyBundle: (input: {
    deploymentId: string;
    worldKey: string;
    sandboxSessionId: string;
    path: string;
    maxBytes: number;
    maxFiles: number;
  }) => Promise<ArtifactBundleCopyResult>;
  writeBytes: (sha256: string, bytes: Buffer) => Promise<string>;
  /** Resolve `(session, name)` to the artifact a republish lands on, or null for a new one. */
  findArtifact: typeof findSessionArtifact;
  /** Append these bytes to that artifact as a version (or recognise them as the one on top). */
  record: typeof recordArtifact;
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
    findArtifact: findSessionArtifact,
    record: recordArtifact,
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
  /** `image`, `html`, or `document`; omitted, the path's own extension decides. */
  kind?: string | null;
  /** PDF bytes read by the authored tool from its current (possibly subagent) sandbox. */
  documentBytes?: Buffer;
}

export type PublishArtifactResult =
  | {
      ok: true;
      artifactId: string;
      /** Immutable version id for correlating this exact publish from another transcript record. */
      artifactVersionId: string;
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
      /** SHA-256 of the exact published bytes (or bundle manifest) for evidence correlation. */
      sha256: string;
      /**
       * Which version of this name the publish produced (#292). 1 for a first publish; higher when
       * the agent republished the same name, which UPDATES the card rather than adding one. The
       * agent's own reply is the narrative, so it needs to know which it did.
       */
      version: number;
      /**
       * False when these bytes were already the newest version, so nothing changed — a retried
       * call, or a republish of a file the agent did not actually edit.
       */
      updated: boolean;
      /** Bundle only: how many files were stored, so the agent can see nothing went missing. */
      fileCount?: number;
    }
  | { ok: false; error: string };

function deny(error: string): PublishArtifactResult {
  return { ok: false, error };
}

/** How the agent is told a name is pinned to a kind — `was` omitted when only the store knows it. */
function kindPinned(name: string, kind: string, was?: string): string {
  const words = (value: string) => {
    if (value === "html") return "a page";
    if (value === "document") return "a document";
    return "an image";
  };
  return `${name} was already published in this conversation as ${was ? words(was) : "a different kind of file"}, so it cannot be republished as ${words(kind)}. Publish it under a different name.`;
}

/** How the agent is told one name has been refined as many times as it may be. */
function versionsExhausted(name: string): string {
  return `${name} has been published ${MAX_ARTIFACT_VERSIONS_TOTAL} times in this conversation, which is the limit for one file. Publish the next revision under a different name.`;
}

/**
 * A bundle's content identity: a sha256 over its members' `(rel_path, sha256)` manifest, sorted.
 * The entry document's own sha would not do — a page whose stylesheet changed while `index.html`
 * did not would read as "same bytes as the version on top", no version would be appended, and the
 * user would go on being shown the previous version of the page.
 */
function bundleSha256(
  files: readonly { relPath: string; sha256: string }[],
): string {
  const manifest = [...files]
    .sort((a, b) =>
      a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0,
    )
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
      `harnesst publishes images, PDF documents and HTML pages, not "${input.kind}". Pass kind "image", "document" or "html".`,
    );
  }
  if (kind === "document" && !input.documentBytes) {
    return deny(
      "The PDF bytes were not supplied by Publish Artifact. Update the installed tool and try again.",
    );
  }
  if (
    kind === "document" &&
    input.documentBytes &&
    input.documentBytes.length > ARTIFACT_DOCUMENT_MAX_BYTES
  ) {
    return deny("PDF document artifacts are capped at 4 MiB.");
  }
  if (kind !== "document" && input.documentBytes) {
    return deny("Only a document publish may include uploaded file bytes.");
  }

  // Caller resolution — deployment → environment → agent → project, all from the token's
  // deployment id (the park/`runAsk` rule: nothing about identity comes off the wire).
  const deployment = await store.deployments.findById(input.deploymentId);
  if (!deployment)
    return deny("Your deployment is no longer known to harnesst.");
  const environment = await store.environments.findById(
    deployment.environmentId,
  );
  if (!environment)
    return deny("Your environment is no longer known to harnesst.");
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
  const sandboxSessionId = fohArtifactSandboxSessionId(session);
  if (!sandboxSessionId || !session.worldKey) {
    return deny(
      "harnesst could not identify this conversation's isolated workspace, so it refused to publish a file from anywhere else.",
    );
  }

  // IDENTITY (#292): a name inside a conversation. Republishing it appends a version to the card
  // that is already on screen, which is the whole refine loop — "make it bolder", publish again,
  // the same card updates. Resolved before the copy so both refusals below are free.
  const existing = await deps.findArtifact({
    sessionId: session.id,
    name: source.name,
  });
  if (existing && existing.kind !== kind) {
    // The kind is pinned for the artifact's life: the serving routes are chosen by it (an image is
    // served same-origin behind the viewer's cookie, a page only through the sandboxed preview), so
    // a row whose kind could change under a live preview token would move bytes between two very
    // differently trusted doors. Only the free half of the refusal is here — `recordArtifact` holds
    // it against the publish that raced this read.
    return deny(kindPinned(source.name, kind, existing.kind));
  }
  // At the version ceiling one publish is still legitimate: a REDELIVERY of the bytes already on
  // top, because the tool's POST is best-effort and retried and denying it would report a failure
  // for a publish that landed. Which one it is cannot be known before the copy, so the refusal
  // moves down to where the bytes have a sha — still before any of them are written, so a runaway
  // refine loop at the cap costs a copy and nothing on the disk.
  const capSha =
    existing && existing.versionNumber >= MAX_ARTIFACT_VERSIONS_TOTAL
      ? existing.sha256
      : null;

  const usage = await deps.usage({
    projectId: project.id,
    sessionId: session.id,
    since: new Date(deps.now().getTime() - ARTIFACT_BUDGET_WINDOW_MS),
  });
  // Only a NEW card is held to the conversation ceiling: that budget bounds how much a transcript
  // holds, and a republish adds no card. Its bytes are still charged to the daily repo ceiling
  // below, which is the one that bounds the disk.
  if (!existing && usage.sessionCount >= MAX_ARTIFACTS_PER_SESSION) {
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
  // progress saves keep it within the in-flight turn. On a republish it is the VERSION's position:
  // the card keeps the one its first publish gave it, or it would slide down the transcript away
  // from the conversation the user is having about it.
  const common = {
    projectId: project.id,
    agentId: agent.id,
    sessionId: session.id,
    deploymentId: deployment.id,
    name: source.name,
    title: input.title?.trim()
      ? input.title.trim().slice(0, MAX_TITLE_LENGTH)
      : null,
    streamIndex: session.streamIndex,
    keepVersions: MAX_ARTIFACT_VERSIONS_KEPT,
    maxVersions: MAX_ARTIFACT_VERSIONS_TOTAL,
  };

  // Budget-checked and destination-resolved before a single byte is read: everything above is a
  // couple of indexed queries, while the copies below hold up to 25 MB of this process's heap.
  if (kind === "html") {
    return publishBundle(
      {
        deployment,
        source,
        common,
        capSha,
        sandboxSessionId,
        worldKey: session.worldKey,
      },
      deps,
    );
  }
  return publishFile(
    {
      deployment,
      source,
      common,
      capSha,
      sandboxSessionId,
      worldKey: session.worldKey,
    },
    kind,
    input.documentBytes,
    deps,
  );
}

/** The row fields all artifact kinds share, resolved before any bytes are read. */
interface ArtifactRowCommon {
  projectId: string;
  agentId: string;
  sessionId: string;
  deploymentId: string;
  name: string;
  title: string | null;
  streamIndex: number;
  keepVersions: number;
  maxVersions: number;
}

interface PublishHalfInput {
  deployment: { id: string };
  worldKey: string;
  sandboxSessionId: string;
  source: { path: string; name: string };
  common: ArtifactRowCommon;
  /**
   * Set only when this name is already at the version ceiling: the sha of the version on top, the
   * one content identity still allowed through (a retried delivery of it). Anything else is refused
   * once its own sha is known — before its bytes are written.
   */
  capSha: string | null;
}

const BUSY =
  "harnesst is already copying as many files as it can at once. Try publishing again in a moment.";
const RECORD_FAILED =
  "harnesst could not record the artifact. Try publishing again.";

/**
 * What the store refused, in the agent's words. Two of the three are the refusals `publishArtifact`
 * already made before the copy: reaching them here means a concurrent publish of the same name got
 * in between, and the agent should read the same thing it would have read a moment earlier rather
 * than "try again" for something no retry can fix.
 */
function recordRefusal(
  reason: "kind" | "cap" | "contended",
  name: string,
  kind: string,
): string {
  if (reason === "kind") return kindPinned(name, kind);
  if (reason === "cap") return versionsExhausted(name);
  return RECORD_FAILED;
}

/**
 * Publish one image or PDF document: copy the file under a concurrency slot, read its real type out
 * of its own bytes, content-address the bytes into the store and record the row. The type is sniffed
 * rather than claimed because the artifact route serves same-origin behind the operator's cookie.
 */
async function publishFile(
  {
    deployment,
    source,
    common,
    capSha,
    worldKey,
    sandboxSessionId,
  }: PublishHalfInput,
  kind: "image" | "document",
  suppliedBytes: Buffer | undefined,
  deps: PublishArtifactDeps,
): Promise<PublishArtifactResult> {
  const copied = suppliedBytes
    ? { ok: true as const, bytes: suppliedBytes }
    : await (async () => {
        const slot = await withArtifactCopySlot(() =>
          deps.copyFile({
            deploymentId: deployment.id,
            worldKey,
            sandboxSessionId,
            path: source.path,
            maxBytes: ARTIFACT_MAX_BYTES,
          }),
        );
        return slot.ok ? slot.value : ({ ok: false, error: BUSY } as const);
      })();
  if (!copied.ok) return deny(copied.error);

  const contentType =
    kind === "document"
      ? sniffArtifactDocumentContentType(copied.bytes)
      : sniffArtifactContentType(copied.bytes, source.name);
  if (!contentType) {
    return deny(
      kind === "document"
        ? `${source.name} is not a PDF document. harnesst reads the file's own bytes, so renaming it does not help.`
        : `${source.name} is not a PNG, JPEG, WebP or SVG image. harnesst reads the file's own bytes, so renaming it does not help.`,
    );
  }

  const sha256 = createHash("sha256").update(copied.bytes).digest("hex");
  // At the ceiling only the bytes already on top may come through — see `capSha`. Checked before the
  // write so a refused publish leaves nothing on the disk.
  if (capSha && capSha !== sha256) return deny(versionsExhausted(source.name));
  const storagePath = await deps.writeBytes(sha256, copied.bytes);

  let recorded: RecordArtifactResult;
  try {
    recorded = await deps.record({
      ...common,
      kind,
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
  if (!recorded.ok)
    return deny(recordRefusal(recorded.reason, source.name, kind));
  const { artifact, version, appended } = recorded;

  return {
    ok: true,
    artifactId: artifact.id,
    artifactVersionId: version.id,
    kind: artifact.kind,
    // Version-scoped, so the URL in transcript data stays immutably cacheable while the card it
    // sits on goes on changing.
    url: artifactUrl(artifact.projectId, artifact.id, version.id),
    name: artifact.name,
    contentType: version.contentType,
    byteSize: version.byteSize,
    sha256: version.sha256,
    version: version.versionNumber,
    updated: appended,
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
  {
    deployment,
    source,
    common,
    capSha,
    worldKey,
    sandboxSessionId,
  }: PublishHalfInput,
  deps: PublishArtifactDeps,
): Promise<PublishArtifactResult> {
  const slot = await withArtifactCopySlot(() =>
    deps.copyBundle({
      deploymentId: deployment.id,
      worldKey,
      sandboxSessionId,
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
  if (
    members.find((member) => member.relPath === entryPath)?.bytes.length === 0
  ) {
    return deny(`${entryPath} is empty, so there is no page to show.`);
  }

  // Hashed before anything is written, because the bundle's identity is the members' manifest and
  // the ceiling check below needs it: a refused publish must not have spent the disk first.
  const hashed = members.map((member) => ({
    ...member,
    sha256: createHash("sha256").update(member.bytes).digest("hex"),
  }));
  const sha256 = bundleSha256(hashed);
  if (capSha && capSha !== sha256) return deny(versionsExhausted(source.name));

  const files: ArtifactFileInput[] = [];
  for (const member of hashed) {
    files.push({
      relPath: member.relPath,
      contentType: member.contentType,
      byteSize: member.bytes.length,
      sha256: member.sha256,
      storagePath: await deps.writeBytes(member.sha256, member.bytes),
    });
  }
  const entry = files.find((file) => file.relPath === entryPath)!;

  let recorded: RecordArtifactResult;
  try {
    recorded = await deps.record({
      ...common,
      kind: "html",
      entryPath,
      contentType: entry.contentType,
      // The SUM, not the entry's size: the daily per-repo byte ceiling reads this column, and
      // charging one member would let a bundle spend the disk a stylesheet at a time.
      byteSize: files.reduce((total, file) => total + file.byteSize, 0),
      sha256,
      storagePath: entry.storagePath,
      files,
    });
  } catch (error) {
    console.error("[foh] artifact bundle publish failed to record:", error);
    return deny(RECORD_FAILED);
  }
  if (!recorded.ok)
    return deny(recordRefusal(recorded.reason, source.name, "html"));
  const { artifact, version, appended } = recorded;

  return {
    ok: true,
    artifactId: artifact.id,
    artifactVersionId: version.id,
    kind: artifact.kind,
    // No stable URL by design — a bundle is reachable only through a short-lived preview token the
    // app mints when the user opens the card.
    url: null,
    name: artifact.name,
    contentType: version.contentType,
    byteSize: version.byteSize,
    sha256: version.sha256,
    version: version.versionNumber,
    updated: appended,
    fileCount: files.length,
  };
}
