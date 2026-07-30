/**
 * Where published artifacts live (issue #290): rows in `artifacts`, bytes on the control plane's
 * own disk. Kept apart from the publish flow (`artifacts.server.ts`) so the transcript assembly in
 * `playground/sessions.server.ts` can read artifact rows without pulling in docker or the deploy
 * seams — and so this module never imports the session module back.
 *
 * Bytes are content-addressed (`<sha[0:2]>/<sha>`): republishing identical bytes rewrites the same
 * file, which is what makes a retried publish free. Nothing about the agent's file NAME reaches the
 * filesystem — it stays a column, so a hostile name can never shape a path.
 */
import { and, count, eq, gte, sum } from "drizzle-orm";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { db } from "~/db/client.server";
import { artifactFiles, artifacts } from "~/db/schema";

export type Artifact = typeof artifacts.$inferSelect;
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

/**
 * Record one published artifact. Idempotent on `(session_id, sha256)`: the tool's POST is
 * best-effort and gets retried, and a redelivery must return the FIRST row rather than stack a
 * second card for the same bytes.
 */
export async function insertArtifact(input: {
  projectId: string;
  agentId: string;
  sessionId: string;
  deploymentId: string;
  name: string;
  title: string | null;
  kind: string;
  entryPath: string | null;
  contentType: string;
  byteSize: number;
  sha256: string;
  storagePath: string;
  streamIndex: number;
}): Promise<Artifact> {
  const [inserted] = await db
    .insert(artifacts)
    .values(input)
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;
  const [existing] = await db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.sessionId, input.sessionId),
        eq(artifacts.sha256, input.sha256),
      ),
    )
    .limit(1);
  return existing;
}

/** One member of a page bundle, as the publish flow stores it. */
export interface ArtifactFileInput {
  relPath: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  storagePath: string;
}

/**
 * Record a page bundle (#291): the card's row plus one row per member. Idempotent the same way a
 * single image is — a retried publish lands on `artifacts_session_sha_uq`, whose key is the members'
 * manifest, so the first row (and its already-written files) is returned rather than a second card.
 *
 * Not a transaction, and deliberately: the failure this could leave behind is an artifact row whose
 * member rows are incomplete, which the preview route reads as a 404 on the missing file — the same
 * outcome as a wiped store, and better than a publish the agent must retry because one INSERT of
 * forty raced. The member insert is itself conflict-tolerant, so a retry completes the set.
 */
export async function insertArtifactBundle(input: {
  artifact: Parameters<typeof insertArtifact>[0];
  files: ArtifactFileInput[];
}): Promise<Artifact> {
  const row = await insertArtifact(input.artifact);
  if (!row) return row;
  await db
    .insert(artifactFiles)
    .values(input.files.map((file) => ({ ...file, artifactId: row.id })))
    .onConflictDoNothing();
  return row;
}

/** What a publish is measured against (see `publishArtifact`'s budgets). */
export interface ArtifactUsage {
  /** Artifacts already in this conversation, ever. */
  sessionCount: number;
  /** Artifacts this repo published inside the budget window. */
  projectCount: number;
  /** Bytes this repo published inside the budget window. */
  projectBytes: number;
}

/**
 * Current consumption for the two budgets a publish is held to. Rows are the ledger rather than the
 * filesystem: bytes are content-addressed and shared, so counting files would under-charge a loop
 * that republishes the same image and over-charge nothing, while the rows are exactly what the agent
 * caused. Cheap — both halves are covered by `artifacts_session_idx` / the project column.
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
    .select({ value: count(), bytes: sum(artifacts.byteSize) })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.projectId, input.projectId),
        gte(artifacts.createdAt, input.since),
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

/** One member of a bundle, by the normalized relative path a preview request asked for. */
export async function findArtifactFile(input: {
  artifactId: string;
  relPath: string;
}): Promise<ArtifactFile | null> {
  const [row] = await db
    .select()
    .from(artifactFiles)
    .where(
      and(
        eq(artifactFiles.artifactId, input.artifactId),
        eq(artifactFiles.relPath, input.relPath),
      ),
    )
    .limit(1);
  return row ?? null;
}
