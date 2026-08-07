/** Durable identities for per-agent GitHub Apps created by the manifest flow (issue #362). */
import { and, asc, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";

import { db } from "~/db/client.server";
import { agentGithubApps, agents } from "~/db/schema";

export interface AgentGitHubApp {
  id: string;
  appId: string;
  slug: string;
  ownerLogin: string | null;
  ownerType: string | null;
  activatedAt: Date | null;
  supersededAt: Date | null;
  createdAt: Date;
  status: "pending" | "active" | "superseded";
}

export interface CreatedAgentGitHubApp {
  projectId: string;
  agentId: string;
  appId: string;
  slug: string;
  ownerLogin: string | null;
  ownerType: string | null;
  /** Existing secret identity, used to seed history when upgrading from pre-#362 installs. */
  previous?: { appId: string; slug: string } | null;
}

/**
 * Durably record the newly-created identity before writing its single-copy credentials, then make
 * it current after those writes succeed. The pending row survives a process/DB failure between
 * the two transactions, so the new App never becomes invisible. A transaction advisory lock
 * serializes credential activation without blocking secret rows' agent foreign keys.
 */
export async function recordCreatedAgentGitHubApp(
  input: CreatedAgentGitHubApp,
  activate: () => Promise<void> = async () => {},
): Promise<{ current: AgentGitHubApp; superseded: AgentGitHubApp[] }> {
  const pendingId = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${input.agentId}))`,
    );
    const lockedAgent = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.id, input.agentId),
          eq(agents.projectId, input.projectId),
        ),
      );
    if (lockedAgent.length === 0) {
      throw new Error(
        "Cannot record a GitHub App outside its agent's project.",
      );
    }

    const unsuperseded = await tx
      .select()
      .from(agentGithubApps)
      .where(
        and(
          eq(agentGithubApps.projectId, input.projectId),
          eq(agentGithubApps.agentId, input.agentId),
          isNull(agentGithubApps.supersededAt),
        ),
      );

    const active = unsuperseded.filter((row) => row.activatedAt !== null);
    if (
      active.length === 0 &&
      input.previous &&
      input.previous.appId !== input.appId
    ) {
      await tx
        .insert(agentGithubApps)
        .values({
          projectId: input.projectId,
          agentId: input.agentId,
          appId: input.previous.appId,
          slug: input.previous.slug,
          activatedAt: new Date(),
        })
        .onConflictDoNothing();
    }

    const sameApp = unsuperseded.find((row) => row.appId === input.appId);
    if (sameApp) {
      await tx
        .update(agentGithubApps)
        .set({
          slug: input.slug,
          ownerLogin: input.ownerLogin,
          ownerType: input.ownerType,
        })
        .where(eq(agentGithubApps.id, sameApp.id));
      return sameApp.id;
    }

    const [pending] = await tx
      .insert(agentGithubApps)
      .values({
        projectId: input.projectId,
        agentId: input.agentId,
        appId: input.appId,
        slug: input.slug,
        ownerLogin: input.ownerLogin,
        ownerType: input.ownerType,
      })
      .returning();
    return pending.id;
  });

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${input.agentId}))`,
    );

    // Keep the advisory lock while replacing credentials. Two independent manifest flows can
    // otherwise interleave secret writes and commit history in the opposite order.
    await activate();
    const transitioned = await tx
      .update(agentGithubApps)
      .set({
        activatedAt: sql`case when ${agentGithubApps.id} = ${pendingId} then now() else ${agentGithubApps.activatedAt} end`,
        supersededAt: sql`case when ${agentGithubApps.id} = ${pendingId} then null else now() end`,
      })
      .where(
        and(
          eq(agentGithubApps.projectId, input.projectId),
          eq(agentGithubApps.agentId, input.agentId),
          or(
            eq(agentGithubApps.id, pendingId),
            and(
              ne(agentGithubApps.id, pendingId),
              isNotNull(agentGithubApps.activatedAt),
              isNull(agentGithubApps.supersededAt),
            ),
          ),
        ),
      )
      .returning();
    let current: (typeof transitioned)[number] | undefined;
    const superseded: AgentGitHubApp[] = [];
    for (const row of transitioned) {
      if (row.id === pendingId) current = row;
      else superseded.push(toAgentGitHubApp(row));
    }
    if (!current) throw new Error("The pending GitHub App identity disappeared.");
    return {
      current: toAgentGitHubApp(current),
      superseded,
    };
  });
}

/** Superseded Apps plus pending creations whose credential activation never committed. */
export async function listAgentGitHubAppsNeedingCleanup(
  projectId: string,
  agentId: string,
): Promise<AgentGitHubApp[]> {
  const rows = await db
    .select()
    .from(agentGithubApps)
    .where(
      and(
        eq(agentGithubApps.projectId, projectId),
        eq(agentGithubApps.agentId, agentId),
      ),
    )
    .orderBy(asc(agentGithubApps.createdAt));
  const cleanup: AgentGitHubApp[] = [];
  for (const row of rows) {
    if (row.supersededAt !== null || row.activatedAt === null) {
      cleanup.push(toAgentGitHubApp(row));
    }
  }
  return cleanup;
}

/**
 * Recover the narrow crash window where every credential write committed (App id is written last)
 * but the history-finalization transaction did not. Safe to call from a loader: it is a no-op
 * unless an unsuperseded pending row exactly matches the active secret App id.
 */
export async function reconcilePendingAgentGitHubApp(
  projectId: string,
  agentId: string,
  activeAppId: string | null,
): Promise<boolean> {
  if (!activeAppId) return false;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${agentId}))`);
    const [pending] = await tx
      .select()
      .from(agentGithubApps)
      .where(
        and(
          eq(agentGithubApps.projectId, projectId),
          eq(agentGithubApps.agentId, agentId),
          eq(agentGithubApps.appId, activeAppId),
          isNull(agentGithubApps.activatedAt),
          isNull(agentGithubApps.supersededAt),
        ),
      )
      .limit(1);
    if (!pending) return false;

    await tx
      .update(agentGithubApps)
      .set({
        activatedAt: sql`case when ${agentGithubApps.id} = ${pending.id} then now() else ${agentGithubApps.activatedAt} end`,
        supersededAt: sql`case when ${agentGithubApps.id} = ${pending.id} then null else now() end`,
      })
      .where(
        and(
          eq(agentGithubApps.projectId, projectId),
          eq(agentGithubApps.agentId, agentId),
          or(
            eq(agentGithubApps.id, pending.id),
            and(
              ne(agentGithubApps.id, pending.id),
              isNotNull(agentGithubApps.activatedAt),
              isNull(agentGithubApps.supersededAt),
            ),
          ),
        ),
      );
    return true;
  });
}

/** Direct settings URL for deletion; the public App page is the safe fallback for old rows. */
export function agentGitHubAppSettingsUrl(app: {
  slug: string;
  ownerLogin: string | null;
  ownerType: string | null;
}): string {
  const slug = encodeURIComponent(app.slug);
  if (app.ownerType === "Organization" && app.ownerLogin) {
    return `https://github.com/organizations/${encodeURIComponent(app.ownerLogin)}/settings/apps/${slug}`;
  }
  if (app.ownerType === "User")
    return `https://github.com/settings/apps/${slug}`;
  return `https://github.com/apps/${slug}`;
}

function toAgentGitHubApp(
  row: typeof agentGithubApps.$inferSelect,
): AgentGitHubApp {
  return {
    id: row.id,
    appId: row.appId,
    slug: row.slug,
    ownerLogin: row.ownerLogin,
    ownerType: row.ownerType,
    activatedAt: row.activatedAt,
    supersededAt: row.supersededAt,
    createdAt: row.createdAt,
    status:
      row.supersededAt !== null
        ? "superseded"
        : row.activatedAt !== null
          ? "active"
          : "pending",
  };
}
