import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";

const LIVE = process.env.HARNESST_DB_SMOKE === "1";
const ORIGIN = "http://localhost:5277";
const PASSWORD = "correct-horse-battery-staple";

process.env.BETTER_AUTH_SECRET ??=
  "harnesst-org-permission-integration-secret-at-least-32-characters";
process.env.BETTER_AUTH_URL ??= ORIGIN;
// This fixture uses the real invitation API, but a DB smoke test must never send externally.
process.env.SMTP_URL = "";
process.env.POSTMARK_SERVER_TOKEN = "";

function authRequest(path: string, body: Record<string, unknown>) {
  return new Request(`${ORIGIN}/api/auth/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
    },
    body: JSON.stringify(body),
  });
}

function sessionCookie(response: Response): string {
  const header = response.headers.get("set-cookie");
  if (!header) {
    throw new Error("Better Auth did not set a session cookie.");
  }
  return header.split(";", 1)[0];
}

function settingsRequest(cookie: string, assistantModel: string): Request {
  return new Request(`${ORIGIN}/org/settings`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/x-www-form-urlencoded",
      origin: ORIGIN,
    },
    body: new URLSearchParams({
      intent: "set-assistant-model",
      assistantModel,
    }),
  });
}

function settingsActionArgs(request: Request) {
  return {
    request,
    url: new URL(request.url),
    pattern: "/org/settings",
    params: {},
    context: new RouterContextProvider(),
  };
}

async function thrownResponse(operation: Promise<unknown>): Promise<Response> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  throw new Error("Expected the route action to throw a Response.");
}

describe.runIf(LIVE)(
  "organization settings permissions against real Postgres",
  () => {
    it("rejects a forged member mutation while allowing owners and admins", async () => {
      const { auth } = await import("~/lib/auth.server");
      const { db } = await import("~/db/client.server");
      const { organization, user } = await import("~/db/auth-schema");
      const { modelProviderConnections, workspaceSettings } =
        await import("~/db/schema");
      const { action } = await import("~/routes/org.settings");

      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const ownerEmail = `org-owner-${suffix}@smoke.test`;
      const memberEmail = `org-member-${suffix}@smoke.test`;
      const observerEmail = `org-observer-${suffix}@smoke.test`;
      const slug = `org-permission-${suffix}`;
      let ownerUserId: string | undefined;
      let memberUserId: string | undefined;
      let observerUserId: string | undefined;
      let organizationId: string | undefined;

      try {
        const ownerSignup = await auth.handler(
          authRequest("sign-up/email", {
            name: "Organization Owner",
            email: ownerEmail,
            password: PASSWORD,
          }),
        );
        expect(ownerSignup.status).toBe(200);
        const ownerCookie = sessionCookie(ownerSignup);
        const ownerHeaders = new Headers({ cookie: ownerCookie });
        ownerUserId = (await auth.api.getSession({ headers: ownerHeaders }))
          ?.user.id;
        expect(ownerUserId).toBeTruthy();

        const memberSignup = await auth.handler(
          authRequest("sign-up/email", {
            name: "Organization Member",
            email: memberEmail,
            password: PASSWORD,
          }),
        );
        expect(memberSignup.status).toBe(200);
        const memberCookie = sessionCookie(memberSignup);
        const memberHeaders = new Headers({ cookie: memberCookie });
        memberUserId = (await auth.api.getSession({ headers: memberHeaders }))
          ?.user.id;
        expect(memberUserId).toBeTruthy();

        const observerSignup = await auth.handler(
          authRequest("sign-up/email", {
            name: "Existing Organization Member",
            email: observerEmail,
            password: PASSWORD,
          }),
        );
        expect(observerSignup.status).toBe(200);
        const observerCookie = sessionCookie(observerSignup);
        const observerHeaders = new Headers({ cookie: observerCookie });
        observerUserId = (
          await auth.api.getSession({ headers: observerHeaders })
        )?.user.id;
        expect(observerUserId).toBeTruthy();

        const createdOrganization = await auth.api.createOrganization({
          headers: ownerHeaders,
          body: { name: "Organization Permission Smoke", slug },
        });
        expect(createdOrganization?.slug).toBe(slug);
        organizationId = createdOrganization?.id;
        expect(organizationId).toBeTruthy();

        // Better Auth's server-only member API is appropriate for this fixture. It creates an
        // ordinary member who demonstrates the upstream list-invitations ID exposure covered by
        // CVE-2026-53514; the invitation-specific verification gate must make the ID insufficient.
        await auth.api.addMember({
          body: {
            userId: observerUserId!,
            role: "member",
            organizationId: organizationId!,
          },
        });
        await auth.api.setActiveOrganization({
          headers: observerHeaders,
          body: { organizationId: organizationId! },
        });

        const invitation = await auth.api.createInvitation({
          headers: ownerHeaders,
          body: {
            email: memberEmail,
            role: "member",
            organizationId: organizationId!,
          },
        });

        const memberInvitationList = await auth.handler(
          new Request(
            `${ORIGIN}/api/auth/organization/list-invitations?organizationId=${encodeURIComponent(organizationId!)}`,
            { headers: { cookie: observerCookie } },
          ),
        );
        expect(memberInvitationList.status).toBe(200);
        const exposedInvitations = (await memberInvitationList.json()) as {
          id: string;
        }[];
        expect(exposedInvitations.map(({ id }) => id)).toContain(invitation.id);

        await expect(
          auth.api.getInvitation({
            headers: memberHeaders,
            query: { id: invitation.id },
          }),
        ).rejects.toMatchObject({
          body: { code: "EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION" },
        });
        await expect(
          auth.api.acceptInvitation({
            headers: memberHeaders,
            body: { invitationId: invitation.id },
          }),
        ).rejects.toMatchObject({
          body: {
            code: "EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION",
          },
        });

        // The browser flow proves ownership through Better Auth's emailed verification URL. For
        // this database-only fixture, mark that completed state directly before exercising the
        // remaining organization-role regression.
        await db
          .update(user)
          .set({ emailVerified: true })
          .where(eq(user.id, memberUserId!));
        const accepted = await auth.api.acceptInvitation({
          headers: memberHeaders,
          body: { invitationId: invitation.id },
        });
        expect(accepted.member.role).toBe("member");

        await auth.api.setActiveOrganization({
          headers: memberHeaders,
          body: { organizationId: organizationId! },
        });

        const permissions: { organization: ("update" | "delete")[] } = {
          organization: ["update"],
        };
        await expect(
          auth.api.hasPermission({
            headers: ownerHeaders,
            body: { organizationId: organizationId!, permissions },
          }),
        ).resolves.toMatchObject({ success: true });
        await expect(
          auth.api.hasPermission({
            headers: memberHeaders,
            body: { organizationId: organizationId!, permissions },
          }),
        ).resolves.toMatchObject({ success: false });

        const [connection] = await db
          .insert(modelProviderConnections)
          .values({
            orgId: organizationId!,
            provider: "codex",
            label: "Permission test Codex",
            status: "active",
            createdBy: ownerUserId,
          })
          .returning({ id: modelProviderConnections.id });
        const ownerModel = `codex/${connection.id}/gpt-5.5`;
        const ownerResult = await thrownResponse(
          action(settingsActionArgs(settingsRequest(ownerCookie, ownerModel))),
        );
        expect(ownerResult.status).toBe(302);

        const [afterOwner] = await db
          .select({ assistantModel: workspaceSettings.assistantModel })
          .from(workspaceSettings)
          .where(eq(workspaceSettings.orgId, organizationId!));
        expect(afterOwner?.assistantModel).toBe(ownerModel);

        const forgedModel = "attacker/forged-member-model";
        const memberResult = await thrownResponse(
          action(
            settingsActionArgs(settingsRequest(memberCookie, forgedModel)),
          ),
        );
        expect(memberResult.status).toBe(403);

        const [afterForgery] = await db
          .select({ assistantModel: workspaceSettings.assistantModel })
          .from(workspaceSettings)
          .where(eq(workspaceSettings.orgId, organizationId!));
        expect(afterForgery?.assistantModel).toBe(ownerModel);

        await auth.api.updateMemberRole({
          headers: ownerHeaders,
          body: {
            organizationId: organizationId!,
            memberId: accepted.member.id,
            role: "admin",
          },
        });
        await expect(
          auth.api.hasPermission({
            headers: memberHeaders,
            body: { organizationId: organizationId!, permissions },
          }),
        ).resolves.toMatchObject({ success: true });

        const adminModel = `codex/${connection.id}/gpt-5.4`;
        const adminResult = await thrownResponse(
          action(settingsActionArgs(settingsRequest(memberCookie, adminModel))),
        );
        expect(adminResult.status).toBe(302);

        const [afterAdmin] = await db
          .select({ assistantModel: workspaceSettings.assistantModel })
          .from(workspaceSettings)
          .where(eq(workspaceSettings.orgId, organizationId!));
        expect(afterAdmin?.assistantModel).toBe(adminModel);
      } finally {
        if (organizationId) {
          await db
            .delete(organization)
            .where(eq(organization.id, organizationId));
        }
        if (memberUserId) {
          await db.delete(user).where(eq(user.id, memberUserId));
        }
        if (observerUserId) {
          await db.delete(user).where(eq(user.id, observerUserId));
        }
        if (ownerUserId) {
          await db.delete(user).where(eq(user.id, ownerUserId));
        }
      }
    });
  },
);
