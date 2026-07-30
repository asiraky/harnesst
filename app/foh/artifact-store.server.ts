/**
 * Where published artifacts live (issue #290): rows in `artifacts`, bytes on the control plane's
 * own disk. Kept apart from the publish flow (`artifacts.server.ts`) so the transcript assembly in
 * `playground/sessions.server.ts` can read artifact rows without pulling in docker or the deploy
 * seams — and so this module never imports the session module back.
 *
 * Bytes are content-addressed (`<sha[0:2]>/<sha>`): republishing identical bytes rewrites the same
 * file, which is what makes a retried publish free. Nothing about the agent's file NAME reaches the
 * filesystem — it stays a column, so a hostile name can never shape a path.
 *
 * Since #292 an artifact is a NAMED thing in a conversation with a stack of versions, so recording
 * a publish is `recordArtifact` — one function for both kinds, because "which row does this land
 * on" is the same question for an image and for a page and answering it twice would be two chances
 * to answer it differently.
 */
import { and, count, desc, eq, gte, lte, sum } from "drizzle-orm";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { db } from "~/db/client.server";
import { artifactFiles, artifacts, artifactVersions } from "~/db/schema";

export type Artifact = typeof artifacts.$inferSelect;
export type ArtifactVersion = typeof artifactVersions.$inferSelect;
export type ArtifactFile = typeof artifactFiles.$inferSelect;

/**
 * Directory the bytes are written to. Production points this at a mounted volume
 * (deploy/vps/docker-compose.yml) so artifacts outlive a control-plane redeploy; the default keeps
 * a dev server working with no configuration.
 */
export function artifactsDir(): string {
  return (
    process.env.HARNESST_ARTIFACTS_DIR?.trim() ||
    path.join(process.cwd(), ".artifacts")
  );
}

/** Store bytes and return the path recorded on the row, relative to `artifactsDir()`. */
export async function writeArtifactBytes(
  sha256: string,
  bytes: Buffer,
): Promise<string> {
  const relative = path.posix.join(sha256.slice(0, 2), sha256);
  const absolute = path.join(artifactsDir(), relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, bytes);
  return relative;
}

/**
 * Read stored bytes back, or null when the file is gone (an operator wiped the directory, or the
 * volume was never mounted). A missing file is a 404 at the serving route, not a crash.
 *
 * The stored path is harnesst-generated, but it is still confined here: a row that somehow carried
 * a traversal would otherwise read anything the process can.
 */
export async function readArtifactBytes(
  storagePath: string,
): Promise<Buffer | null> {
  const root = artifactsDir();
  const absolute = path.resolve(root, storagePath);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) return null;
  try {
    return await readFile(absolute);
  } catch {
    return null;
  }
}

/** One member of a page bundle, as the publish flow stores it. */
export interface ArtifactFileInput {
  relPath: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  storagePath: string;
}

export interface RecordArtifactInput {
  projectId: string;
  agentId: string;
  sessionId: string;
  deploymentId: string;
  /** Identity, with the session: republishing this name appends a version to the same card. */
  name: string;
  title: string | null;
  kind: string;
  entryPath: string | null;
  contentType: string;
  byteSize: number;
  sha256: string;
  storagePath: string;
  /** Where the conversation had reached NOW — the card's place only when this is the first version. */
  streamIndex: number;
  /** Page bundles only: the members these bytes are made of. */
  files?: ArtifactFileInput[];
  /** How many versions of one artifact stay openable (`MAX_ARTIFACT_VERSIONS_KEPT`). */
  keepVersions: number;
}

export interface RecordedArtifact {
  artifact: Artifact;
  version: ArtifactVersion;
  /**
   * False when the bytes matched the version already on top, so nothing was appended — a retried
   * tool POST, or an agent republishing a file it did not actually change.
   */
  appended: boolean;
}

/** The newest version of an artifact, or null when it somehow has none. */
export async function latestArtifactVersion(
  artifactId: string,
): Promise<ArtifactVersion | null> {
  const [row] = await db
    .select()
    .from(artifactVersions)
    .where(eq(artifactVersions.artifactId, artifactId))
    .orderBy(desc(artifactVersions.versionNumber))
    .limit(1);
  return row ?? null;
}

/**
 * Record one publish (#290, #291, #292): resolve `(session, name)` to an artifact and put these
 * bytes on top of it as a new version, or return the version already holding them.
 *
 * IDEMPOTENCY IS THE SHA COMPARISON, not a unique index over content. The tool's POST is
 * best-effort and gets retried, so a redelivery must be a no-op — but so must an agent republishing
 * a file it did not change, and a REVERT to bytes an older version already held must NOT be one
 * (indexing `(artifact, sha)` would have returned the old version while the card went on showing
 * the newest). Comparing against the top of the stack gets all three right.
 *
 * Not a transaction, and deliberately — same reasoning as the bundle insert it replaces: the worst
 * interleaving leaves an artifact whose newest version's members are incomplete, which the preview
 * route reads as a 404 on the missing file (the same outcome as a wiped store) and which a retry
 * completes. What the loop below protects instead is the NUMBERING: two concurrent publishes contend
 * on `artifact_versions_number_uq`, and the loser re-reads rather than inventing a duplicate
 * ordinal or silently dropping its bytes.
 */
export async function recordArtifact(
  input: RecordArtifactInput,
): Promise<RecordedArtifact | null> {
  const { files, keepVersions, ...row } = input;
  const [created] = await db
    .insert(artifacts)
    .values(row)
    .onConflictDoNothing()
    .returning();
  const artifact =
    created ??
    (await findSessionArtifact({ sessionId: row.sessionId, name: row.name }));
  if (!artifact) return null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const latest = await latestArtifactVersion(artifact.id);
    if (latest && latest.sha256 === row.sha256) {
      return { artifact, version: latest, appended: false };
    }
    const versionNumber = (latest?.versionNumber ?? 0) + 1;
    const [version] = await db
      .insert(artifactVersions)
      .values({
        artifactId: artifact.id,
        projectId: row.projectId,
        versionNumber,
        entryPath: row.entryPath,
        contentType: row.contentType,
        byteSize: row.byteSize,
        sha256: row.sha256,
        storagePath: row.storagePath,
        streamIndex: row.streamIndex,
        deploymentId: row.deploymentId,
      })
      .onConflictDoNothing()
      .returning();
    // Lost the ordinal to a concurrent publish: read the stack again and decide afresh — the
    // winner may even have written these exact bytes, in which case this becomes a no-op.
    if (!version) continue;

    if (files?.length) {
      await db
        .insert(artifactFiles)
        .values(
          files.map((file) => ({
            ...file,
            artifactId: artifact.id,
            versionId: version.id,
          })),
        )
        .onConflictDoNothing();
    }

    // The card follows the newest version — except for `stream_index`, which stays where the FIRST
    // publish put it so the card updates in place instead of sliding down the transcript.
    const [updated] = await db
      .update(artifacts)
      .set({
        entryPath: row.entryPath,
        contentType: row.contentType,
        byteSize: row.byteSize,
        sha256: row.sha256,
        storagePath: row.storagePath,
        latestVersionId: version.id,
        versionNumber,
        // Dense ordinals plus the prune below: this is the count, without a second query.
        versionCount: Math.min(versionNumber, keepVersions),
        ...(row.title ? { title: row.title } : {}),
      })
      // Only ever forward: a slow v2 update landing after v3's must not point the card back.
      .where(
        and(
          eq(artifacts.id, artifact.id),
          lte(artifacts.versionNumber, versionNumber),
        ),
      )
      .returning();

    await pruneArtifactVersions(artifact.id, keepVersions);
    return { artifact: updated ?? artifact, version, appended: true };
  }
  return null;
}

/**
 * Drop the versions that fell off the bottom of the retention window. Rows only: the BYTES are
 * content-addressed and shared with every other artifact that published the same file, so deleting
 * them would need refcounting and could pull the bytes out from under a live card. The daily
 * per-repo byte budget is what bounds the disk (see `artifactUsage`); this bounds the picker.
 */
async function pruneArtifactVersions(
  artifactId: string,
  keep: number,
): Promise<void> {
  const [newest] = await db
    .select({ versionNumber: artifactVersions.versionNumber })
    .from(artifactVersions)
    .where(eq(artifactVersions.artifactId, artifactId))
    .orderBy(desc(artifactVersions.versionNumber))
    .limit(1);
  if (!newest) return;
  const cutoff = newest.versionNumber - keep;
  if (cutoff < 1) return;
  await db
    .delete(artifactVersions)
    .where(
      and(
        eq(artifactVersions.artifactId, artifactId),
        lte(artifactVersions.versionNumber, cutoff),
      ),
    );
}

/** The artifact a name resolves to inside one conversation — the identity `recordArtifact` keys on. */
export async function findSessionArtifact(input: {
  sessionId: string;
  name: string;
}): Promise<Artifact | null> {
  const [row] = await db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.sessionId, input.sessionId),
        eq(artifacts.name, input.name),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Every stored version of one artifact, newest first — what the preview panel's picker lists. */
export async function listArtifactVersions(
  artifactId: string,
): Promise<ArtifactVersion[]> {
  return db
    .select()
    .from(artifactVersions)
    .where(eq(artifactVersions.artifactId, artifactId))
    .orderBy(desc(artifactVersions.versionNumber));
}

/**
 * One version, constrained to its artifact. The artifact id is in the WHERE rather than compared
 * afterwards for the same reason `findProjectArtifact` puts the project there: a version id from
 * another artifact is then simply not found, and cannot become a cross-artifact selector on a
 * route that only authorized the artifact.
 */
export async function findArtifactVersion(input: {
  artifactId: string;
  versionId: string;
}): Promise<ArtifactVersion | null> {
  const [row] = await db
    .select()
    .from(artifactVersions)
    .where(
      and(
        eq(artifactVersions.id, input.versionId),
        eq(artifactVersions.artifactId, input.artifactId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** What a publish is measured against (see `publishArtifact`'s budgets). */
export interface ArtifactUsage {
  /** Distinct artifacts (cards) already in this conversation, ever — NOT their versions. */
  sessionCount: number;
  /** Versions this repo published inside the budget window. */
  projectCount: number;
  /** Bytes this repo published inside the budget window, versions included. */
  projectBytes: number;
}

/**
 * Current consumption for the two budgets a publish is held to. Rows are the ledger rather than the
 * filesystem: bytes are content-addressed and shared, so counting files would under-charge a loop
 * that republishes the same image and over-charge nothing, while the rows are exactly what the agent
 * caused.
 *
 * The two halves count DIFFERENT rows since #292, and both deliberately. The conversation ceiling
 * counts artifacts, because a refine loop on one page is one card and must not burn a budget meant
 * to bound how much a transcript holds. The daily repo ceilings count VERSIONS, because they exist
 * to bound the DISK and every version is bytes on it — counting artifacts there would let an agent
 * republish a 20 MB page five hundred times for a 20 MB charge. Cheap: `artifacts_session_idx` and
 * `artifact_versions_project_idx` cover them.
 */
export async function artifactUsage(input: {
  projectId: string;
  sessionId: string;
  /** Start of the rolling project window. */
  since: Date;
}): Promise<ArtifactUsage> {
  const [session] = await db
    .select({ value: count() })
    .from(artifacts)
    .where(eq(artifacts.sessionId, input.sessionId));
  const [project] = await db
    .select({ value: count(), bytes: sum(artifactVersions.byteSize) })
    .from(artifactVersions)
    .where(
      and(
        eq(artifactVersions.projectId, input.projectId),
        gte(artifactVersions.createdAt, input.since),
      ),
    );
  return {
    sessionCount: Number(session?.value ?? 0),
    projectCount: Number(project?.value ?? 0),
    // `sum` is numeric → a string, and null when the window is empty.
    projectBytes: Number(project?.bytes ?? 0),
  };
}

/** Every artifact published into one conversation, oldest transcript position first. */
export async function listArtifactsForSession(
  sessionId: string,
): Promise<Artifact[]> {
  return db
    .select()
    .from(artifacts)
    .where(eq(artifacts.sessionId, sessionId))
    .orderBy(artifacts.streamIndex, artifacts.createdAt);
}

/**
 * One artifact, constrained to the project the caller was already authorized for. The project id is
 * part of the WHERE rather than checked afterwards, so an id from another tenant is simply not
 * found — the same shape as `getFohSessionForViewer`.
 */
export async function findProjectArtifact(input: {
  id: string;
  projectId: string;
}): Promise<Artifact | null> {
  const [row] = await db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.id, input.id), eq(artifacts.projectId, input.projectId)))
    .limit(1);
  return row ?? null;
}

/**
 * One artifact by id alone — for the preview route (#291), which has no browser session and so no
 * project to constrain the lookup with. The project is not dropped from the authorization, it moves
 * into the signed token: the route compares `artifact.projectId` to the token's claim and then
 * re-runs the conversation-visibility check for the token's user. An id on its own still proves
 * nothing, because reaching this function at all requires a valid HMAC over that id.
 */
export async function findArtifactById(id: string): Promise<Artifact | null> {
  const [row] = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * One member of a bundle VERSION, by the normalized relative path a preview request asked for. The
 * key is the version rather than the artifact (#292) — the same `assets/app.css` exists once per
 * version, and a preview showing v1 must read v1's.
 */
export async function findArtifactFile(input: {
  versionId: string;
  relPath: string;
}): Promise<ArtifactFile | null> {
  const [row] = await db
    .select()
    .from(artifactFiles)
    .where(
      and(
        eq(artifactFiles.versionId, input.versionId),
        eq(artifactFiles.relPath, input.relPath),
      ),
    )
    .limit(1);
  return row ?? null;
}
