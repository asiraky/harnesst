/**
 * Teams end-to-end smoke against a REAL Postgres (Milestone 5.5 + team UX): roster sync,
 * per-agent environments, per-agent release numbering, per-agent secret isolation, and
 * draft attribution — the Drizzle implementations the unit fakes can't prove.
 *
 * Opt-in: runs only when HARNESST_DB_SMOKE=1 and DATABASE_URL point at a live dev database
 * (`HARNESST_DB_SMOKE=1 npx vitest run tests/integration/teams.db.test.ts` with .env.local
 * sourced). Creates its own org/project rows and deletes them, so it's safe to re-run.
 */
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

const LIVE = process.env.HARNESST_DB_SMOKE === "1";

describe.runIf(LIVE)("teams against real Postgres", () => {
  it("roster → environments → releases → secrets → drafts → cascade", async () => {
    const { drizzleDataStore: store } = await import("~/data/drizzle.server");
    const { db } = await import("~/db/client.server");
    const { organization } = await import("~/db/auth-schema");
    const { projects } = await import("~/db/schema");
    const { createProject, listAgentEnvironments, syncProjectAgents } =
      await import("~/db/queries.server");
    const { createRelease, ensureReleasesForCommit } =
      await import("~/deploy/controller.server");
    const { stageDraft, listDrafts } = await import("~/drafts/drafts.server");
    const { makeLocalSecretsProvider } =
      await import("~/seams/oss/secrets.local.server");
    const { drizzleSecretKV } = await import("~/seams/oss/secret-store");

    const ORG = "org_teams_smoke";
    // Re-runs after a failed cleanup start from a fresh Better Auth organization; its
    // foreign-key cascade removes any leftover project from the previous attempt.
    await db.delete(organization).where(eq(organization.id, ORG));
    await db.insert(organization).values({
      id: ORG,
      name: "smoke",
      slug: "teams-smoke",
      createdAt: new Date(),
    });

    // 1. Team project: roster created, per-member environments seeded.
    const project = await createProject(
      {
        orgId: ORG,
        name: "smoke-team",
        roster: [
          { name: "deployer", root: "agents/deployer/agent" },
          { name: "pm", root: "agents/pm/agent" },
        ],
      },
      store,
    );
    try {
      let roster = await store.agents.listByProject(project.id);
      expect(roster.map((a) => a.name)).toEqual(["deployer", "pm"]);
      const deployer = roster[0];
      // Environments are user-defined (M5.7): each member starts with exactly one.
      const deployerEnvs = await listAgentEnvironments(deployer.id, store);
      expect(deployerEnvs.map((e) => e.name)).toEqual(["default"]);
      expect(await listAgentEnvironments(roster[1].id, store)).toHaveLength(1);

      // 2. Roster sync: add qa, drop pm; empty detection never wipes the roster; a re-sync
      // never re-seeds members that already have environments. The fake deploy target keeps
      // the pruned member's infra teardown away from real docker.
      const { fakeDeployTarget } = await import("../fakes/infra");
      roster = await syncProjectAgents(
        project.id,
        [
          { name: "deployer", root: "agents/deployer/agent" },
          { name: "qa", root: "agents/qa/agent" },
        ],
        store,
        fakeDeployTarget(),
      );
      expect(roster.map((a) => a.name)).toEqual(["deployer", "qa"]);
      const qa = roster[1];
      expect(await listAgentEnvironments(qa.id, store)).toHaveLength(1);
      expect(await listAgentEnvironments(deployer.id, store)).toHaveLength(1);
      expect(await store.agents.syncRoster(project.id, [])).toHaveLength(2);

      // 3. Releases: one per member per merge commit, idempotent, per-agent numbering.
      const sha = crypto.randomBytes(20).toString("hex");
      const cut = await ensureReleasesForCommit(
        { projectId: project.id, gitSha: sha },
        store,
      );
      expect(cut).toHaveLength(2);
      expect(cut.every((r) => r.created)).toBe(true);
      const again = await ensureReleasesForCommit(
        { projectId: project.id, gitSha: sha },
        store,
      );
      expect(again.every((r) => !r.created)).toBe(true);
      const v2 = await createRelease(
        {
          projectId: project.id,
          agentId: deployer.id,
          gitSha: crypto.randomBytes(20).toString("hex"),
        },
        store,
      );
      expect(v2.version).toBe("v2");

      // 4. Secrets: per-agent isolation + env-over-agent override on the real KV.
      const key = crypto.randomBytes(32);
      const secrets = makeLocalSecretsProvider(drizzleSecretKV, () => key);
      const scope = (agentId: string, environmentId: string | null = null) => ({
        projectId: project.id,
        agentId,
        environmentId,
      });
      await secrets.set(
        { ...scope(deployer.id), key: "CLOUDFLARE_API_TOKEN" },
        "deployer-only",
      );
      expect(
        (await secrets.resolve(scope(deployer.id))).CLOUDFLARE_API_TOKEN,
      ).toBe("deployer-only");
      expect(await secrets.resolve(scope(qa.id))).toEqual({});
      await secrets.set(
        {
          ...scope(deployer.id, deployerEnvs[0].id),
          key: "CLOUDFLARE_API_TOKEN",
        },
        "prod-override",
      );
      expect(
        (await secrets.resolve(scope(deployer.id, deployerEnvs[0].id)))
          .CLOUDFLARE_API_TOKEN,
      ).toBe("prod-override");

      // 5. Drafts: member attribution from the path; shared files unattributed.
      const owned = await stageDraft(
        {
          projectId: project.id,
          path: "agents/qa/agent/tools/check.ts",
          content: "//",
        },
        store,
      );
      expect(owned.agentId).toBe(qa.id);
      const shared = await stageDraft(
        { projectId: project.id, path: "package.json", content: "{}" },
        store,
      );
      expect(shared.agentId).toBeNull();
      expect(await listDrafts(project.id, store)).toHaveLength(2);
    } finally {
      // 6. Cascade cleanup: deleting the project removes roster/envs/releases/secrets/drafts.
      await db.delete(projects).where(eq(projects.id, project.id));
      expect(await store.agents.listByProject(project.id)).toHaveLength(0);
      await db.delete(organization).where(eq(organization.id, ORG));
    }
  });
});

describe.runIf(!LIVE)("teams db smoke (skipped)", () => {
  it("runs only with HARNESST_DB_SMOKE=1 against a live database", () => {
    expect(LIVE).toBe(false);
  });
});
