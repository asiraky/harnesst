/** Verified, tenant-scoped GitHub installation grants. */
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";

import { db } from "~/db/client.server";
import { githubInstallations } from "~/db/schema";

export interface KnownInstallation {
  grantId: string;
  accountLogin: string | null;
}

export interface VerifiedInstallationGrant {
  grantId: string;
  orgId: string;
  /** Raw GitHub id: server-only. */
  installationId: string;
  accountLogin: string | null;
}

export async function upsertVerifiedInstallation(input: {
  orgId: string;
  installationId: string;
  accountLogin: string | null;
  verifiedByUserId: string;
}): Promise<VerifiedInstallationGrant> {
  const rows = await db
    .insert(githubInstallations)
    .values({
      orgId: input.orgId,
      installationId: input.installationId,
      accountLogin: input.accountLogin,
      verifiedAt: new Date(),
      verifiedByUserId: input.verifiedByUserId,
    })
    .onConflictDoUpdate({
      target: [githubInstallations.orgId, githubInstallations.installationId],
      set: {
        accountLogin: input.accountLogin,
        verifiedAt: new Date(),
        verifiedByUserId: input.verifiedByUserId,
      },
    })
    .returning();
  return toGrant(rows[0]);
}

export async function listKnownInstallations(
  orgId: string,
): Promise<KnownInstallation[]> {
  const rows = await db
    .select({
      grantId: githubInstallations.id,
      accountLogin: githubInstallations.accountLogin,
    })
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.orgId, orgId),
        isNotNull(githubInstallations.verifiedAt),
      ),
    )
    .orderBy(desc(githubInstallations.createdAt));
  return rows;
}

/** The org's verified grants on one GitHub account (logins are case-insensitive), newest first. */
export async function listInstallationsForAccount(
  orgId: string,
  accountLogin: string,
): Promise<KnownInstallation[]> {
  return db
    .select({
      grantId: githubInstallations.id,
      accountLogin: githubInstallations.accountLogin,
    })
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.orgId, orgId),
        isNotNull(githubInstallations.verifiedAt),
        sql`lower(${githubInstallations.accountLogin}) = lower(${accountLogin})`,
      ),
    )
    .orderBy(desc(githubInstallations.createdAt));
}

export async function resolveInstallationGrantForOrg(
  orgId: string,
  grantId: string,
): Promise<VerifiedInstallationGrant> {
  const rows = await db
    .select()
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.orgId, orgId),
        eq(githubInstallations.id, grantId),
        isNotNull(githubInstallations.verifiedAt),
      ),
    )
    .limit(1);
  if (!rows[0]) throw reauthorizationError();
  return toGrant(rows[0]);
}

/** Internal project boundary. Grant ids are globally opaque but still must be verified. */
export async function resolveInstallationGrant(
  grantId: string,
): Promise<VerifiedInstallationGrant> {
  const rows = await db
    .select()
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.id, grantId),
        isNotNull(githubInstallations.verifiedAt),
      ),
    )
    .limit(1);
  if (!rows[0]) throw reauthorizationError();
  return toGrant(rows[0]);
}

/**
 * Thrown when a project's installation grant is missing or unverified — the repo can't be read
 * until the GitHub App is (re)installed and ownership re-verified. Typed so UI surfaces can offer
 * a Reconnect action instead of dead-ending on the bare message (a plain repo read error has no
 * such remedy).
 */
export class GithubReauthorizationError extends Error {
  constructor() {
    super(
      "This GitHub installation is not authorized for this workspace. Reauthorize it from Connect.",
    );
    this.name = "GithubReauthorizationError";
  }
}

export function isGithubReauthorizationError(
  error: unknown,
): error is GithubReauthorizationError {
  return error instanceof GithubReauthorizationError;
}

function reauthorizationError(): Error {
  return new GithubReauthorizationError();
}

function toGrant(
  row: typeof githubInstallations.$inferSelect,
): VerifiedInstallationGrant {
  return {
    grantId: row.id,
    orgId: row.orgId,
    installationId: row.installationId,
    accountLogin: row.accountLogin,
  };
}
