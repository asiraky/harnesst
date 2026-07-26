import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

const LIVE = process.env.HARNESST_DB_SMOKE === "1";
const ORIGIN = "http://localhost:5277";

process.env.BETTER_AUTH_SECRET ??=
  "harnesst-google-oauth-state-integration-secret-at-least-32-characters";
process.env.BETTER_AUTH_URL ??= ORIGIN;

function signupRequest(email: string): Request {
  return new Request(`${ORIGIN}/api/auth/sign-up/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
    },
    body: JSON.stringify({
      name: "Google OAuth State Smoke",
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

describe.runIf(LIVE)("Google OAuth state against real Postgres", () => {
  it("binds nonces to Better Auth and atomically permits exactly one consumer", async () => {
    const { auth } = await import("~/lib/auth.server");
    const { db } = await import("~/db/client.server");
    const { user } = await import("~/db/auth-schema");
    const { createOAuthStateNonce, consumeOAuthStateNonce } =
      await import("~/connections/oauth-state.server");

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const email = `google-state-${suffix}@smoke.test`;
    let userId: string | undefined;

    try {
      const signup = await auth.handler(signupRequest(email));
      expect(signup.status).toBe(200);
      const signedIn = await auth.api.getSession({
        headers: new Headers({ cookie: sessionCookie(signup) }),
      });
      expect(signedIn).toBeTruthy();
      userId = signedIn!.user.id;
      const binding = {
        userId,
        sessionId: signedIn!.session.id,
      };
      const expiresAt = new Date(Date.now() + 60_000);

      const nonce = await createOAuthStateNonce({ ...binding, expiresAt });
      expect(
        await consumeOAuthStateNonce({
          nonce,
          userId: binding.userId,
          sessionId: "another-session",
        }),
      ).toBe(false);
      expect(await consumeOAuthStateNonce({ nonce, ...binding })).toBe(true);
      expect(await consumeOAuthStateNonce({ nonce, ...binding })).toBe(false);

      const racedNonce = await createOAuthStateNonce({
        ...binding,
        expiresAt,
      });
      const results = await Promise.all([
        consumeOAuthStateNonce({ nonce: racedNonce, ...binding }),
        consumeOAuthStateNonce({ nonce: racedNonce, ...binding }),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    } finally {
      if (userId) await db.delete(user).where(eq(user.id, userId));
    }
  });
});
