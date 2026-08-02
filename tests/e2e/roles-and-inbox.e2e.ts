/**
 * FOH roles + inbox rules, end to end (PRD-FRONT-OF-HOUSE §5 invites & roles, D5/D13):
 * against real Better Auth users/teams and the REAL route modules —
 *
 *  - a member's session is invisible to a fellow team member (the session loader 404s,
 *    indistinguishable from nonexistent) but visible to a workspace admin/owner;
 *  - the inbox loader scopes items per viewer (own + team-wide only — another member's and
 *    even the admin's view exclude a personal item);
 *  - the inbox resolve action refuses question/approval items (they belong to the drain
 *    chokepoints) and dismisses `finished` ones;
 *  - the read action resolves the viewer's finished item and advances their read cursor.
 *
 * Invite delivery/acceptance itself is already covered end-to-end by
 * tests/integration/foh-teams.db.test.ts (real Better Auth + mailbox driver) — not repeated.
 *
 * Opt-in: HARNESST_DB_SMOKE=1 with DATABASE_URL pointing at the live dev database.
 */
import { describe, expect, it } from "vitest";

import {
  actionArgs,
  cleanupWorkspace,
  createWorkspace,
  addMember,
  LIVE,
  loaderArgs,
  seedTeamStack,
  signUp,
  statusOfThrown,
  uniqueSuffix,
  type TestUser,
} from "./harness";

describe.runIf(LIVE)("FOH roles and inbox visibility", () => {
  it("scopes sessions and inbox items per viewer and enforces the resolve rules", async () => {
    const { db } = await import("~/db/client.server");
    const { and, eq } = await import("drizzle-orm");
    const { conversationReads, inboxItems } = await import("~/db/schema");
    const { ensureProjectTeam } = await import("~/auth/teams.server");
    const { openInboxQuestion, recordInboxFinished } =
      await import("~/foh/inbox.server");
    const { createPlaygroundSession } = await import(
      "~/playground/sessions.server"
    );
    const { loader: sessionViewLoader } = await import(
      "~/routes/foh.session"
    );
    const { loader: inboxLoader, action: inboxAction } = await import(
      "~/routes/api.foh.inbox"
    );
    const { action: readAction } = await import("~/routes/api.foh.read");

    const suffix = uniqueSuffix("roles");
    let orgId: string | undefined;
    const users: TestUser[] = [];
    try {
      const owner = await signUp("Roles Owner", `foh-e2e-${suffix}@smoke.test`);
      const memberA = await signUp(
        "Member A",
        `foh-e2e-${suffix}-a@smoke.test`,
      );
      const memberB = await signUp(
        "Member B",
        `foh-e2e-${suffix}-b@smoke.test`,
      );
      users.push(owner, memberA, memberB);
      orgId = await createWorkspace(owner, "FOH E2E Roles", `foh-e2e-${suffix}`);
      const { project, agent } = await seedTeamStack({ orgId, suffix });
      const teamId = await ensureProjectTeam(orgId, project);
      // Both members belong to the repo's team — visibility differences below are pure D5,
      // never a team-scoping artifact.
      await addMember(memberA, orgId, teamId);
      await addMember(memberB, orgId, teamId);

      // Member A's own conversation with the agent.
      const session = await createPlaygroundSession({
        projectId: project.id,
        agentId: agent.id,
        userId: memberA.userId,
        surface: "foh",
        status: "waiting",
        title: "A's private thread",
        lastEventAt: new Date(),
      });
      const sessionPath = `/t/${project.id}/${agent.id}/s/${session.id}`;
      const sessionParams = {
        projectId: project.id,
        agentId: agent.id,
        sessionId: session.id,
      };

      // The creator sees their session.
      const asA = await sessionViewLoader(
        loaderArgs({ path: sessionPath, cookie: memberA.cookie, params: sessionParams }),
      );
      expect(asA).toMatchObject({
        sessionId: session.id,
        sessionTitle: "A's private thread",
      });

      // A fellow team member does NOT — 404, indistinguishable from nonexistent.
      let thrown: unknown = null;
      try {
        await sessionViewLoader(
          loaderArgs({ path: sessionPath, cookie: memberB.cookie, params: sessionParams }),
        );
      } catch (error) {
        thrown = error;
      }
      expect(statusOfThrown(thrown)).toBe(404);

      // A workspace admin/owner sees every FOH session.
      const asOwner = await sessionViewLoader(
        loaderArgs({ path: sessionPath, cookie: owner.cookie, params: sessionParams }),
      );
      expect(asOwner).toMatchObject({ sessionId: session.id });

      // Seed A's inbox: one parked question + one finished pointer (both personal to A).
      const question = await openInboxQuestion({
        projectId: project.id,
        sessionId: session.id,
        agentId: agent.id,
        userId: memberA.userId,
        request: { requestId: "req_roles_1", prompt: "Which environment?" },
      });
      const finished = await recordInboxFinished({
        projectId: project.id,
        sessionId: session.id,
        agentId: agent.id,
        userId: memberA.userId,
        prompt: "Wrapped up the report.",
      });

      // Inbox loader: A sees both; B and even the admin see NEITHER (personal items).
      const inboxOfA = await inboxLoader(
        loaderArgs({ path: "/api/foh/inbox", cookie: memberA.cookie, params: {} }),
      );
      expect(inboxOfA.count).toBe(2);
      expect(inboxOfA.items.map((item) => item.id).sort()).toEqual(
        [question.id, finished.id].sort(),
      );
      const inboxOfB = await inboxLoader(
        loaderArgs({ path: "/api/foh/inbox", cookie: memberB.cookie, params: {} }),
      );
      expect(inboxOfB).toMatchObject({ items: [], count: 0 });
      const inboxOfOwner = await inboxLoader(
        loaderArgs({ path: "/api/foh/inbox", cookie: owner.cookie, params: {} }),
      );
      expect(inboxOfOwner).toMatchObject({ items: [], count: 0 });

      // Resolve rules: a question item is refused (drain chokepoints own its lifecycle)…
      const refuseQuestion = await inboxAction(
        actionArgs({
          path: "/api/foh/inbox",
          cookie: memberA.cookie,
          params: {},
          form: { intent: "resolve", itemId: question.id },
        }),
      );
      expect(refuseQuestion).toEqual({ ok: false });
      // …and B cannot dismiss A's finished item they can't even see…
      const refuseForeign = await inboxAction(
        actionArgs({
          path: "/api/foh/inbox",
          cookie: memberB.cookie,
          params: {},
          form: { intent: "resolve", itemId: finished.id },
        }),
      );
      expect(refuseForeign).toEqual({ ok: false });
      // …while A dismisses their own finished item.
      const dismissed = await inboxAction(
        actionArgs({
          path: "/api/foh/inbox",
          cookie: memberA.cookie,
          params: {},
          form: { intent: "resolve", itemId: finished.id },
        }),
      );
      expect(dismissed).toEqual({ ok: true });
      const [questionRow] = await db
        .select()
        .from(inboxItems)
        .where(eq(inboxItems.id, question.id));
      expect(questionRow.status).toBe("pending");
      const [finishedRow] = await db
        .select()
        .from(inboxItems)
        .where(eq(inboxItems.id, finished.id));
      expect(finishedRow.status).toBe("resolved");

      // Read acknowledgement (D3/D13): opening the session posts the read action, which
      // acknowledges every notification visible to the viewer and advances their cursor.
      const finishedAgain = await recordInboxFinished({
        projectId: project.id,
        sessionId: session.id,
        agentId: agent.id,
        userId: memberA.userId,
        prompt: "Another finish.",
      });
      const readResult = await readAction(
        actionArgs({
          path: `/api/foh/${project.id}/read`,
          cookie: memberA.cookie,
          params: { projectId: project.id },
          form: { playgroundSessionId: session.id },
        }),
      );
      expect(readResult).toEqual({ ok: true });
      const [finishedAgainRow] = await db
        .select()
        .from(inboxItems)
        .where(eq(inboxItems.id, finishedAgain.id));
      expect(finishedAgainRow.status).toBe("resolved");
      const [cursor] = await db
        .select()
        .from(conversationReads)
        .where(
          and(
            eq(conversationReads.sessionId, session.id),
            eq(conversationReads.userId, memberA.userId),
          ),
        );
      expect(cursor?.lastReadAt).not.toBeNull();
      // The question remains answerable in the transcript, but its notification is acknowledged.
      const [questionAfterRead] = await db
        .select()
        .from(inboxItems)
        .where(eq(inboxItems.id, question.id));
      expect(questionAfterRead).toMatchObject({
        status: "pending",
        acknowledgedAt: expect.any(Date),
      });
    } finally {
      await cleanupWorkspace(orgId, users);
    }
  });
});

describe.runIf(!LIVE)("FOH roles/inbox e2e (skipped)", () => {
  it("runs only with HARNESST_DB_SMOKE=1 against a live database", () => {
    expect(LIVE).toBe(false);
  });
});
