import { createHash, randomBytes } from "node:crypto";

import { and, eq, gt, isNotNull, isNull, lt } from "drizzle-orm";

import { db } from "~/db/client.server";
import { githubInstallationStates } from "~/db/schema";
import { signState, verifyState } from "~/lib/signed-state.server";
import { decodeKey } from "~/seams/oss/secretbox";

export const GITHUB_INSTALL_STATE_TTL_MS = 15 * 60 * 1000;

export interface GitHubInstallState {
  nonce: string;
  userId: string;
  sessionId: string;
  orgId: string;
  exp: number;
}

function stateKey(): Buffer {
  return decodeKey(process.env.HARNESST_SECRETS_KEY);
}

function nonceHash(nonce: string): string {
  return createHash("sha256").update(nonce).digest("hex");
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function signGitHubInstallState(
  state: GitHubInstallState,
  key: Buffer = stateKey(),
): string {
  return signState(state, key);
}

export function verifyGitHubInstallState(
  token: string,
  key: Buffer = stateKey(),
  now = Date.now(),
): GitHubInstallState | null {
  const value = verifyState<GitHubInstallState>(token, key, now);
  if (
    !value ||
    typeof value.nonce !== "string" ||
    typeof value.userId !== "string" ||
    typeof value.sessionId !== "string" ||
    typeof value.orgId !== "string" ||
    typeof value.exp !== "number" ||
    value.nonce.length < 32 ||
    !value.userId ||
    !value.sessionId ||
    !value.orgId
  ) {
    return null;
  }
  return value;
}

export async function createGitHubInstallState(input: {
  userId: string;
  sessionId: string;
  orgId: string;
  now?: Date;
}): Promise<{
  state: string;
  nonce: string;
  codeVerifier: string;
  expiresAt: Date;
}> {
  const now = input.now ?? new Date();
  await db
    .delete(githubInstallationStates)
    .where(lt(githubInstallationStates.expiresAt, now));

  const nonce = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + GITHUB_INSTALL_STATE_TTL_MS);
  await db.insert(githubInstallationStates).values({
    nonceHash: nonceHash(nonce),
    userId: input.userId,
    sessionId: input.sessionId,
    orgId: input.orgId,
    codeVerifier,
    expiresAt,
  });
  return {
    state: signGitHubInstallState({
      nonce,
      userId: input.userId,
      sessionId: input.sessionId,
      orgId: input.orgId,
      exp: expiresAt.getTime(),
    }),
    nonce,
    codeVerifier,
    expiresAt,
  };
}

/** Bind exactly one setup callback to a live state. */
export async function bindGitHubInstallationCandidate(input: {
  nonce: string;
  userId: string;
  sessionId: string;
  orgId: string;
  installationId: string;
}): Promise<string | null> {
  const updated = await db
    .update(githubInstallationStates)
    .set({ candidateInstallationId: input.installationId })
    .where(
      and(
        eq(githubInstallationStates.nonceHash, nonceHash(input.nonce)),
        eq(githubInstallationStates.userId, input.userId),
        eq(githubInstallationStates.sessionId, input.sessionId),
        eq(githubInstallationStates.orgId, input.orgId),
        isNull(githubInstallationStates.candidateInstallationId),
        gt(githubInstallationStates.expiresAt, new Date()),
      ),
    )
    .returning({ codeVerifier: githubInstallationStates.codeVerifier });
  return updated[0]?.codeVerifier ?? null;
}

/** Consume before exchanging OAuth code; concurrent/replayed callbacks cannot proceed. */
export async function consumeGitHubInstallationState(input: {
  nonce: string;
  userId: string;
  sessionId: string;
  orgId: string;
}): Promise<{ installationId: string; codeVerifier: string } | null> {
  const deleted = await db
    .delete(githubInstallationStates)
    .where(
      and(
        eq(githubInstallationStates.nonceHash, nonceHash(input.nonce)),
        eq(githubInstallationStates.userId, input.userId),
        eq(githubInstallationStates.sessionId, input.sessionId),
        eq(githubInstallationStates.orgId, input.orgId),
        isNotNull(githubInstallationStates.candidateInstallationId),
        gt(githubInstallationStates.expiresAt, new Date()),
      ),
    )
    .returning({
      installationId: githubInstallationStates.candidateInstallationId,
      codeVerifier: githubInstallationStates.codeVerifier,
    });
  const row = deleted[0];
  return row?.installationId
    ? { installationId: row.installationId, codeVerifier: row.codeVerifier }
    : null;
}
