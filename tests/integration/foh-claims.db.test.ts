/**
 * Atomic turn claim + drain fencing against a REAL Postgres (issue #221 finding 5): two
 * sequential claims on one waiting session (first wins, second null), stale-`running`
 * takeover past the idle cutoff, and the claim-fenced cursor save (a superseded drain's old
 * claimId writes zero rows; the winning claimId applies).
 *
 * Opt-in: HARNESST_DB_SMOKE=1 with DATABASE_URL pointing at a live dev database
 * (`set -a; source .env.local; set +a; HARNESST_DB_SMOKE=1 npx vitest run
 * tests/integration/foh-claims.db.test.ts`). Seeds and removes its own rows.
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

const LIVE = process.env.HARNESST_DB_SMOKE === "1";

describe.runIf(LIVE)("FOH turn claim against real Postgres", () => {
  it("claims atomically, takes over stale runs, and fences cursor writes", async () => {
    const { db } = await import("~/db/client.server");
    const { organization, user } = await import("~/db/auth-schema");
    const { agents, playgroundSessions, projects } = await import("~/db/schema");
    const {
      claimPlaygroundSessionForTurn,
      createPlaygroundSession,
      savePlaygroundSessionCursor,
    } = await import("~/playground/sessions.server");

    const ORG = "org_foh_claim";
    const USER = "user_foh_claim";
    const STALE_AFTER_MS = 5 * 60_000;
    const now = new Date();
    await db.delete(organization).where(eq(organization.id, ORG));
    await db.delete(user).where(eq(user.id, USER));
    await db.insert(organization).values({
      id: ORG,
      name: "foh claim smoke",
      slug: "foh-claim-smoke",
      createdAt: now,
    });
    await db.insert(user).values({
      id: USER,
      name: "FOH Claim",
      email: "foh-claim@smoke.test",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    const [project] = await db
      .insert(projects)
      .values({ orgId: ORG, name: "foh-claim", slug: "foh-claim-smoke" })
      .returning();
    const [agent] = await db
      .insert(agents)
      .values({ projectId: project.id, name: "ivy", root: "agents/ivy/agent" })
      .returning();

    const session = await createPlaygroundSession({
      projectId: project.id,
      agentId: agent.id,
      userId: USER,
      surface: "foh",
      status: "waiting",
      externalSessionId: "sess_ext_claim",
      continuationToken: "tok_0",
    });

    // No real deployment/environment behind the fake turn — null FK-ish target fields.
    const target = {
      deploymentId: null,
      releaseId: null,
      environmentId: null,
      url: "http://fake-eve",
      version: null,
    } as unknown as import("~/chat/playground.server").Target;

    // 1. Two claims on one waiting session: the first wins, the second returns null.
    const winner = await claimPlaygroundSessionForTurn({
      id: session.id,
      target,
      claimId: "claim_A",
      staleAfterMs: STALE_AFTER_MS,
    });
    expect(winner).toMatchObject({
      id: session.id,
      status: "running",
      turnClaimId: "claim_A",
    });
    const loser = await claimPlaygroundSessionForTurn({
      id: session.id,
      target,
      claimId: "claim_B",
      staleAfterMs: STALE_AFTER_MS,
    });
    expect(loser).toBeNull();

    // 2. A stale `running` row (no drain activity past the idle cutoff) is taken over.
    await db
      .update(playgroundSessions)
      .set({ updatedAt: new Date(Date.now() - STALE_AFTER_MS - 60_000) })
      .where(eq(playgroundSessions.id, session.id));
    const takeover = await claimPlaygroundSessionForTurn({
      id: session.id,
      target,
      claimId: "claim_C",
      staleAfterMs: STALE_AFTER_MS,
    });
    expect(takeover).toMatchObject({ status: "running", turnClaimId: "claim_C" });

    // 3. The superseded drain's fenced cursor save (old claimId) is a zero-row no-op…
    await savePlaygroundSessionCursor({
      id: session.id,
      target,
      externalSessionId: "sess_ext_claim",
      continuationToken: "tok_stale",
      streamIndex: 7,
      title: null,
      status: "waiting",
      claimId: "claim_A",
    });
    let [row] = await db
      .select()
      .from(playgroundSessions)
      .where(eq(playgroundSessions.id, session.id));
    expect(row.status).toBe("running");
    expect(row.streamIndex).toBe(0);
    expect(row.continuationToken).toBe("tok_0");

    // …while the winning claimId applies.
    await savePlaygroundSessionCursor({
      id: session.id,
      target,
      externalSessionId: "sess_ext_claim",
      continuationToken: "tok_live",
      streamIndex: 9,
      title: null,
      status: "waiting",
      claimId: "claim_C",
    });
    [row] = await db
      .select()
      .from(playgroundSessions)
      .where(eq(playgroundSessions.id, session.id));
    expect(row.status).toBe("waiting");
    expect(row.streamIndex).toBe(9);
    expect(row.continuationToken).toBe("tok_live");

    // Cleanup (org cascade removes project/agent/session rows).
    await db.delete(organization).where(eq(organization.id, ORG));
    await db.delete(user).where(eq(user.id, USER));
  });
});
