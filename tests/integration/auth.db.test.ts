import { and, eq, like } from "drizzle-orm";
import { describe, expect, it } from "vitest";

const LIVE = process.env.HARNESST_DB_SMOKE === "1";
const ORIGIN = "http://localhost:5277";

process.env.BETTER_AUTH_SECRET ??=
  "harnesst-auth-integration-secret-at-least-32-characters";
process.env.BETTER_AUTH_URL ??= ORIGIN;

function jsonRequest(
  path: string,
  body: Record<string, unknown>,
  origin = ORIGIN,
) {
  return new Request(`${ORIGIN}/api/auth/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
    },
    body: JSON.stringify(body),
  });
}

function cookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie");
  if (!header)
    throw new Error("Better Auth response did not set a session cookie.");
  return header.split(";", 1)[0];
}

describe.runIf(LIVE)("Better Auth against real Postgres", () => {
  it("signs up, creates an owner organization, persists it on the session, and signs out", async () => {
    const { auth } = await import("~/lib/auth.server");
    const { db } = await import("~/db/client.server");
    const { organization, user } = await import("~/db/auth-schema");

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const email = `auth-${suffix}@smoke.test`;
    const slug = `auth-${suffix}`;
    let userId: string | undefined;
    let organizationId: string | undefined;

    try {
      const signup = await auth.handler(
        jsonRequest("sign-up/email", {
          name: "Auth Smoke",
          email,
          password: "correct-horse-battery-staple",
        }),
      );
      expect(signup.status).toBe(200);
      expect(signup.headers.get("set-cookie")).toContain("HttpOnly");
      expect(signup.headers.get("set-cookie")).toContain("SameSite=Lax");

      const cookie = cookieFrom(signup);
      const headers = new Headers({ cookie });
      const signedIn = await auth.api.getSession({ headers });
      expect(signedIn?.user.email).toBe(email);
      expect(signedIn?.session.activeOrganizationId).toBeFalsy();
      userId = signedIn?.user.id;

      const created = await auth.api.createOrganization({
        body: { name: "Auth Smoke Workspace", slug },
        headers,
      });
      expect(created?.slug).toBe(slug);
      organizationId = created?.id;

      const activeSession = await auth.api.getSession({ headers });
      expect(activeSession?.session.activeOrganizationId).toBe(organizationId);
      const activeMember = await auth.api.getActiveMember({ headers });
      expect(activeMember.organizationId).toBe(organizationId);
      expect(activeMember.role).toBe("owner");

      const duplicate = await auth.handler(
        jsonRequest("sign-up/email", {
          name: "Duplicate",
          email,
          password: "correct-horse-battery-staple",
        }),
      );
      expect(duplicate.status).toBeGreaterThanOrEqual(400);

      const wrongPassword = await auth.handler(
        jsonRequest("sign-in/email", { email, password: "definitely-wrong" }),
      );
      expect(wrongPassword.status).toBeGreaterThanOrEqual(400);

      const signout = await auth.api.signOut({ headers, asResponse: true });
      expect(signout.status).toBe(200);
      expect(await auth.api.getSession({ headers })).toBeNull();
    } finally {
      if (organizationId) {
        await db
          .delete(organization)
          .where(eq(organization.id, organizationId));
      }
      if (userId) await db.delete(user).where(eq(user.id, userId));
    }
  });

  it("uses Better Auth password-reset tokens without revealing whether an email exists", async () => {
    const { auth } = await import("~/lib/auth.server");
    const { db } = await import("~/db/client.server");
    const { user, verification } = await import("~/db/auth-schema");

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const email = `reset-${suffix}@smoke.test`;
    const originalPassword = "correct-horse-battery-staple";
    const replacementPassword = "fresh-horse-battery-staple";
    let userId: string | undefined;

    try {
      const signup = await auth.handler(
        jsonRequest("sign-up/email", {
          name: "Reset Smoke",
          email,
          password: originalPassword,
        }),
      );
      expect(signup.status).toBe(200);
      const originalCookie = cookieFrom(signup);
      userId = (
        await auth.api.getSession({
          headers: new Headers({ cookie: originalCookie }),
        })
      )?.user.id;
      expect(userId).toBeTruthy();

      const redirectTo = `${ORIGIN}/reset-password`;
      const unknown = await auth.handler(
        jsonRequest("request-password-reset", {
          email: `missing-${suffix}@smoke.test`,
          redirectTo,
        }),
      );
      const existing = await auth.handler(
        jsonRequest("request-password-reset", { email, redirectTo }),
      );
      expect(unknown.status).toBe(200);
      expect(existing.status).toBe(200);
      expect(await unknown.json()).toEqual(await existing.json());

      const [storedReset] = await db
        .select()
        .from(verification)
        .where(
          and(
            eq(verification.value, userId!),
            like(verification.identifier, "reset-password:%"),
          ),
        );
      expect(storedReset).toBeTruthy();
      const token = storedReset.identifier.slice("reset-password:".length);

      const callback = await auth.handler(
        new Request(
          `${ORIGIN}/api/auth/reset-password/${token}?callbackURL=${encodeURIComponent(redirectTo)}`,
        ),
      );
      expect(callback.status).toBe(302);
      expect(callback.headers.get("location")).toBe(
        `${redirectTo}?token=${token}`,
      );

      const reset = await auth.handler(
        jsonRequest("reset-password", {
          token,
          newPassword: replacementPassword,
        }),
      );
      expect(reset.status).toBe(200);
      expect(
        await auth.api.getSession({
          headers: new Headers({ cookie: originalCookie }),
        }),
      ).toBeNull();

      const oldPassword = await auth.handler(
        jsonRequest("sign-in/email", { email, password: originalPassword }),
      );
      expect(oldPassword.status).toBeGreaterThanOrEqual(400);
      const newPassword = await auth.handler(
        jsonRequest("sign-in/email", { email, password: replacementPassword }),
      );
      expect(newPassword.status).toBe(200);

      const reused = await auth.handler(
        jsonRequest("reset-password", {
          token,
          newPassword: "another-horse-battery-staple",
        }),
      );
      expect(reused.status).toBeGreaterThanOrEqual(400);
    } finally {
      if (userId) await db.delete(user).where(eq(user.id, userId));
    }
  });
});
