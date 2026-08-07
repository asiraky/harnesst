/** Durable identities for per-agent GitHub Apps created by the manifest flow (issue #362). */
import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { db } from "~/db/client.server";
import { agentGithubApps, agents } from "~/db/schema";

export interface AgentGitHubApp {
  id: string;
  appId: string;
  slug: string;
  ownerLogin: string | null;
  ownerType: string | null;
  supersededAt: Date | null;
  createdAt: Date;
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
 * Make a newly converted App current and retain the outgoing identity. A transaction-scoped
 * advisory lock serializes separate manifest flows even when this agent has no identity row yet;
 * unlike a row lock, it does not block secret inserts that reference the agent by foreign key.
 */
export async function recordCreatedAgentGitHubApp(
  input: CreatedAgentGitHubApp,
  activate: () => Promise<void> = async () => {},
): Promise<{ current: AgentGitHubApp; superseded: AgentGitHubApp[] }> {
  return db.transaction(async (tx) => {
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

    const outgoing = await tx
      .select()
      .from(agentGithubApps)
      .where(
        and(
          eq(agentGithubApps.projectId, input.projectId),
          eq(agentGithubApps.agentId, input.agentId),
          isNull(agentGithubApps.supersededAt),
        ),
      );

    if (
      outgoing.length === 0 &&
      input.previous &&
      input.previous.appId !== input.appId
    ) {
      const [seeded] = await tx
        .insert(agentGithubApps)
        .values({
          projectId: input.projectId,
          agentId: input.agentId,
          appId: input.previous.appId,
          slug: input.previous.slug,
        })
        .returning();
      outgoing.push(seeded);
    }

    const sameApp = outgoing.find((row) => row.appId === input.appId);
    if (sameApp) {
      await activate();
      const [current] = await tx
        .update(agentGithubApps)
        .set({
          slug: input.slug,
          ownerLogin: input.ownerLogin,
          ownerType: input.ownerType,
        })
        .where(eq(agentGithubApps.id, sameApp.id))
        .returning();
      return { current: toAgentGitHubApp(current), superseded: [] };
    }

    // Keep the agent-row lock while replacing credentials. Two independent manifest flows can
    // otherwise interleave secret writes and commit history in the opposite order, leaving the
    // recorded current App different from the credentials the agent actually uses.
    await activate();
    const supersededAt = new Date();
    const superseded = outgoing.length
      ? await tx
          .update(agentGithubApps)
          .set({ supersededAt })
          .where(
            and(
              eq(agentGithubApps.projectId, input.projectId),
              eq(agentGithubApps.agentId, input.agentId),
              isNull(agentGithubApps.supersededAt),
            ),
          )
          .returning()
      : [];

    const [current] = await tx
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
    return {
      current: toAgentGitHubApp(current),
      superseded: superseded.map(toAgentGitHubApp),
    };
  });
}

export async function listSupersededAgentGitHubApps(
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
  return rows.filter((row) => row.supersededAt !== null).map(toAgentGitHubApp);
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
    supersededAt: row.supersededAt,
    createdAt: row.createdAt,
  };
}
