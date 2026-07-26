import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

const LIVE = process.env.HARNESST_DB_SMOKE === "1";
const ORIGIN = "http://localhost:5277";

process.env.BETTER_AUTH_SECRET ??=
  "harnesst-github-install-state-integration-secret-at-least-32-characters";
process.env.BETTER_AUTH_URL ??= ORIGIN;
process.env.HARNESST_SECRETS_KEY ??= Buffer.alloc(32, 5).toString("base64");

function signupRequest(email: string): Request {
  return new Request(`${ORIGIN}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({
      name: "GitHub State Smoke",
      email,
      password: "correct-horse-battery-staple",
    }),
  });
}

function sessionCookie(response: Response): string {
  const header = response.headers.get("set-cookie");
  if (!header) throw new Error("Better Auth did not set a session cookie.");
  return header.split(";", 1)[0];
}

describe.runIf(LIVE)("GitHub installation state against real Postgres", () => {
  it("binds setup once and consumes OAuth once with every tenant/session binding", async () => {
    const { auth } = await import("~/lib/auth.server");
    const { db } = await import("~/db/client.server");
    const { user } = await import("~/db/auth-schema");
    const {
      createGitHubInstallState,
      bindGitHubInstallationCandidate,
      consumeGitHubInstallationState,
    } = await import("~/github/install-state.server");

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let userId: string | undefined;
    try {
      const signup = await auth.handler(
        signupRequest(`github-state-${suffix}@smoke.test`),
      );
      const cookie = sessionCookie(signup);
      const signedIn = await auth.api.getSession({
        headers: new Headers({ cookie }),
      });
      expect(signedIn).toBeTruthy();
      userId = signedIn!.user.id;
      const org = await auth.api.createOrganization({
        headers: new Headers({ cookie, origin: ORIGIN }),
        body: { name: "State smoke", slug: `state-${suffix}` },
      });
      expect(org).toBeTruthy();
      const binding = {
        userId,
        sessionId: signedIn!.session.id,
        orgId: org!.id,
      };
      const created = await createGitHubInstallState(binding);

      const unbound = await createGitHubInstallState(binding);
      expect(
        await consumeGitHubInstallationState({
          ...binding,
          nonce: unbound.nonce,
        }),
      ).toBeNull();
      // An OAuth callback cannot consume an unbound setup state; its later setup callback may bind.
      expect(
        await bindGitHubInstallationCandidate({
          ...binding,
          nonce: unbound.nonce,
          installationId: "321",
        }),
      ).toBe(unbound.codeVerifier);

      const expired = await createGitHubInstallState({
        ...binding,
        now: new Date(Date.now() - 60 * 60 * 1000),
      });
      expect(
        await bindGitHubInstallationCandidate({
          ...binding,
          nonce: expired.nonce,
          installationId: "123",
        }),
      ).toBeNull();

      expect(
        await bindGitHubInstallationCandidate({
          ...binding,
          orgId: "wrong-org",
          nonce: created.nonce,
          installationId: "123",
        }),
      ).toBeNull();
      expect(
        await bindGitHubInstallationCandidate({
          ...binding,
          sessionId: "wrong-session",
          nonce: created.nonce,
          installationId: "123",
        }),
      ).toBeNull();
      expect(
        await bindGitHubInstallationCandidate({
          ...binding,
          nonce: created.nonce,
          installationId: "123",
        }),
      ).toBe(created.codeVerifier);
      expect(
        await bindGitHubInstallationCandidate({
          ...binding,
          nonce: created.nonce,
          installationId: "999",
        }),
      ).toBeNull();

      expect(
        await consumeGitHubInstallationState({
          ...binding,
          userId: "wrong-user",
          nonce: created.nonce,
        }),
      ).toBeNull();
      await expect(
        Promise.all([
          consumeGitHubInstallationState({ ...binding, nonce: created.nonce }),
          consumeGitHubInstallationState({ ...binding, nonce: created.nonce }),
        ]),
      ).resolves.toSatisfy(
        (values: unknown[]) => values.filter(Boolean).length === 1,
      );
      expect(
        await consumeGitHubInstallationState({
          ...binding,
          nonce: created.nonce,
        }),
      ).toBeNull();
    } finally {
      if (userId) await db.delete(user).where(eq(user.id, userId));
    }
  });
});
