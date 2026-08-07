/**
 * Durable per-agent GitHub App identity history against real Postgres (issue #362).
 *
 * Opt-in: HARNESST_DB_SMOKE=1 npx vitest run tests/integration/agent-github-apps.db.test.ts
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

const LIVE = process.env.HARNESST_DB_SMOKE === "1";

describe.runIf(LIVE)("agent GitHub App history against real Postgres", () => {
  it("reports the outgoing App as superseded when the callback records a replacement", async () => {
    const { db } = await import("~/db/client.server");
    const { organization } = await import("~/db/auth-schema");
    const { agents, projects } = await import("~/db/schema");
    const {
      listAgentGitHubAppsNeedingCleanup,
      reconcilePendingAgentGitHubApp,
      recordCreatedAgentGitHubApp,
    } = await import("~/github/agent-apps.server");

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const orgId = `gh-app-${suffix}`;
    await db.insert(organization).values({
      id: orgId,
      name: "GitHub App history smoke",
      slug: orgId,
      createdAt: new Date(),
    });

    try {
      const [project] = await db
        .insert(projects)
        .values({ orgId, name: "agents", slug: `agents-${suffix}` })
        .returning();
      const [agent] = await db
        .insert(agents)
        .values({
          projectId: project.id,
          name: "sam",
          root: "agents/sam/agent",
        })
        .returning();

      const first = await recordCreatedAgentGitHubApp({
        projectId: project.id,
        agentId: agent.id,
        appId: "4271951",
        slug: "eden-sam",
        ownerLogin: "worksauceapp",
        ownerType: "Organization",
      });
      expect(first.superseded).toEqual([]);

      const second = await recordCreatedAgentGitHubApp({
        projectId: project.id,
        agentId: agent.id,
        appId: "4395332",
        slug: "sam-harnesst",
        ownerLogin: "worksauceapp",
        ownerType: "Organization",
      });

      expect(second.current.appId).toBe("4395332");
      expect(second.superseded).toHaveLength(1);
      expect(second.superseded[0]).toMatchObject({
        appId: "4271951",
        slug: "eden-sam",
      });
      expect(second.superseded[0].supersededAt).toBeInstanceOf(Date);
      await expect(
        listAgentGitHubAppsNeedingCleanup(project.id, agent.id),
      ).resolves.toMatchObject([{ appId: "4271951", slug: "eden-sam" }]);

      await expect(
        recordCreatedAgentGitHubApp(
          {
            projectId: project.id,
            agentId: agent.id,
            appId: "4500000",
            slug: "sam-next",
            ownerLogin: "worksauceapp",
            ownerType: "Organization",
          },
          async () => {
            throw new Error("lost final history commit");
          },
        ),
      ).rejects.toThrow("lost final history commit");
      await expect(
        listAgentGitHubAppsNeedingCleanup(project.id, agent.id),
      ).resolves.toMatchObject([
        { appId: "4271951", status: "superseded" },
        { appId: "4500000", status: "pending" },
      ]);

      await expect(
        reconcilePendingAgentGitHubApp(project.id, agent.id, "4500000"),
      ).resolves.toBe(true);
      await expect(
        listAgentGitHubAppsNeedingCleanup(project.id, agent.id),
      ).resolves.toMatchObject([
        { appId: "4271951", status: "superseded" },
        { appId: "4395332", status: "superseded" },
      ]);
    } finally {
      await db.delete(organization).where(eq(organization.id, orgId));
    }
  });
});
