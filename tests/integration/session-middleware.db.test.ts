import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";

const LIVE = process.env.HARNESST_DB_SMOKE === "1";
const PASSWORD = "correct-horse-battery-staple";

process.env.BETTER_AUTH_SECRET ??=
  "harnesst-session-middleware-integration-secret-at-least-32-characters";
process.env.BETTER_AUTH_URL ??= "http://localhost:5277";
// The middleware's mutation-origin guard compares the `origin` header against the configured
// BETTER_AUTH_URL, so the test origin must follow the sourced environment (worktree `.env.local`
// files set BETTER_AUTH_URL to their own port) rather than hardcoding one.
const ORIGIN = new URL(process.env.BETTER_AUTH_URL).origin;

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

function cookieName(cookie: string): string {
  return cookie.slice(0, cookie.indexOf("="));
}

function setCookies(response: Response): string[] {
  return typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : response.headers.get("set-cookie")
      ? [response.headers.get("set-cookie")!]
      : [];
}

function middlewareArgs(request: Request, context: RouterContextProvider) {
  const url = new URL(request.url);
  return {
    request,
    url,
    pattern: url.pathname,
    params: {},
    context,
  };
}

describe.runIf(LIVE)(
  "Better Auth session middleware against real Postgres",
  () => {
    it("forwards rolling session headers and caches the refreshed session for the request", async () => {
      const { betterAuthSessionMiddleware, getSessionAuth } =
        await import("~/auth/session.server");
      const { auth } = await import("~/lib/auth.server");
      const { db } = await import("~/db/client.server");
      const { session, user } = await import("~/db/auth-schema");

      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const email = `rolling-session-${suffix}@smoke.test`;
      let userId: string | undefined;

      try {
        const signup = await auth.handler(
          authRequest("sign-up/email", {
            name: "Rolling Session Smoke",
            email,
            password: PASSWORD,
          }),
        );
        expect(signup.status).toBe(200);
        const cookie = sessionCookie(signup);
        const original = await auth.api.getSession({
          headers: new Headers({ cookie }),
        });
        expect(original?.user.email).toBe(email);
        userId = original?.user.id;
        const sessionId = original?.session.id;
        expect(userId).toBeTruthy();
        expect(sessionId).toBeTruthy();

        // Better Auth's default rolling window refreshes once a seven-day session is at least
        // one day old. Moving expiry inside that updateAge threshold forces the real DB path.
        const forcedExpiry = new Date(Date.now() + 60 * 60 * 1_000);
        await db
          .update(session)
          .set({ expiresAt: forcedExpiry })
          .where(eq(session.id, sessionId!));

        const request = new Request(`${ORIGIN}/dashboard`, {
          headers: { cookie },
        });
        const context = new RouterContextProvider();
        let firstCachedSession:
          Awaited<ReturnType<typeof getSessionAuth>> | undefined;
        let secondCachedSession:
          Awaited<ReturnType<typeof getSessionAuth>> | undefined;

        const result = await betterAuthSessionMiddleware(
          middlewareArgs(request, context),
          async () => {
            firstCachedSession = await getSessionAuth({ request, context });
            secondCachedSession = await getSessionAuth({ request, context });
            return new Response("rendered", {
              status: 200,
              headers: { "x-route-header": "preserved" },
            });
          },
        );
        expect(result).toBeInstanceOf(Response);
        if (!(result instanceof Response)) {
          throw new Error(
            "Session middleware did not return the route response.",
          );
        }

        expect(firstCachedSession?.user?.email).toBe(email);
        expect(secondCachedSession).toBe(firstCachedSession);
        expect(result.headers.get("x-route-header")).toBe("preserved");
        expect(result.headers.get("referrer-policy")).toBe("no-referrer");
        expect(result.headers.get("cache-control")).toBe("private, no-store");
        expect(result.headers.get("content-security-policy")).toBe(
          "frame-ancestors 'none'",
        );
        expect(result.headers.get("x-frame-options")).toBe("DENY");

        const refreshedCookies = setCookies(result);
        expect(
          refreshedCookies.some(
            (value) =>
              value.startsWith(`${cookieName(cookie)}=`) &&
              !value.toLowerCase().includes("max-age=0"),
          ),
        ).toBe(true);

        const [refreshed] = await db
          .select({ expiresAt: session.expiresAt })
          .from(session)
          .where(eq(session.id, sessionId!));
        expect(refreshed).toBeTruthy();
        expect(refreshed.expiresAt.getTime()).toBeGreaterThan(
          forcedExpiry.getTime(),
        );

        // Force another refresh immediately before sign-out. The route's deletion cookie must
        // win over the stale rolling cookie captured on the middleware's way down.
        await db
          .update(session)
          .set({ expiresAt: forcedExpiry })
          .where(eq(session.id, sessionId!));
        const signOutRequest = new Request(`${ORIGIN}/dashboard`, {
          method: "POST",
          headers: { cookie, origin: ORIGIN },
        });
        const signOutContext = new RouterContextProvider();
        const signOutResult = await betterAuthSessionMiddleware(
          middlewareArgs(signOutRequest, signOutContext),
          () =>
            auth.api.signOut({
              headers: signOutRequest.headers,
              asResponse: true,
            }),
        );
        expect(signOutResult).toBeInstanceOf(Response);
        if (!(signOutResult instanceof Response)) {
          throw new Error(
            "Session middleware did not return sign-out response.",
          );
        }

        const tokenCookies = setCookies(signOutResult).filter((value) =>
          value.startsWith(`${cookieName(cookie)}=`),
        );
        expect(tokenCookies).toHaveLength(1);
        expect(tokenCookies[0].toLowerCase()).toContain("max-age=0");
        expect(signOutResult.headers.get("referrer-policy")).toBe(
          "no-referrer",
        );
        expect(
          await auth.api.getSession({ headers: new Headers({ cookie }) }),
        ).toBeNull();
      } finally {
        if (userId) await db.delete(user).where(eq(user.id, userId));
      }
    });

    it("forwards Better Auth's deletion cookie for a stale session", async () => {
      const { betterAuthSessionMiddleware, getSessionAuth } =
        await import("~/auth/session.server");
      const { auth } = await import("~/lib/auth.server");
      const { db } = await import("~/db/client.server");
      const { session, user } = await import("~/db/auth-schema");

      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const email = `stale-session-${suffix}@smoke.test`;
      let userId: string | undefined;

      try {
        const signup = await auth.handler(
          authRequest("sign-up/email", {
            name: "Stale Session Smoke",
            email,
            password: PASSWORD,
          }),
        );
        expect(signup.status).toBe(200);
        const cookie = sessionCookie(signup);
        const original = await auth.api.getSession({
          headers: new Headers({ cookie }),
        });
        userId = original?.user.id;
        expect(userId).toBeTruthy();

        await db.delete(session).where(eq(session.id, original!.session.id));

        const request = new Request(`${ORIGIN}/dashboard`, {
          headers: { cookie },
        });
        const context = new RouterContextProvider();
        let cachedSession:
          Awaited<ReturnType<typeof getSessionAuth>> | undefined;
        const result = await betterAuthSessionMiddleware(
          middlewareArgs(request, context),
          async () => {
            cachedSession = await getSessionAuth({ request, context });
            return new Response("anonymous");
          },
        );
        expect(result).toBeInstanceOf(Response);
        if (!(result instanceof Response)) {
          throw new Error(
            "Session middleware did not return the route response.",
          );
        }

        expect(cachedSession?.user).toBeNull();
        expect(cachedSession?.session).toBeNull();
        expect(result.headers.get("referrer-policy")).toBe("no-referrer");
        expect(result.headers.get("cache-control")).toBe("private, no-store");
        expect(result.headers.get("content-security-policy")).toBe(
          "frame-ancestors 'none'",
        );
        expect(result.headers.get("x-frame-options")).toBe("DENY");
        expect(
          setCookies(result).some(
            (value) =>
              value.startsWith(`${cookieName(cookie)}=`) &&
              value.toLowerCase().includes("max-age=0"),
          ),
        ).toBe(true);
      } finally {
        if (userId) await db.delete(user).where(eq(user.id, userId));
      }
    });

    it("rejects a forged mutation origin before running the route", async () => {
      const { betterAuthSessionMiddleware } =
        await import("~/auth/session.server");
      const { auth } = await import("~/lib/auth.server");
      const { db } = await import("~/db/client.server");
      const { user } = await import("~/db/auth-schema");

      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const email = `origin-guard-${suffix}@smoke.test`;
      let userId: string | undefined;

      try {
        const signup = await auth.handler(
          authRequest("sign-up/email", {
            name: "Origin Guard Smoke",
            email,
            password: PASSWORD,
          }),
        );
        expect(signup.status).toBe(200);
        const cookie = sessionCookie(signup);
        userId = (
          await auth.api.getSession({ headers: new Headers({ cookie }) })
        )?.user.id;
        expect(userId).toBeTruthy();

        const request = new Request(`${ORIGIN}/org/settings`, {
          method: "POST",
          headers: {
            cookie,
            "content-type": "application/x-www-form-urlencoded",
            origin: "https://attacker.example",
          },
          body: new URLSearchParams({ intent: "set-assistant-model" }),
        });
        const context = new RouterContextProvider();
        let routeRan = false;
        const result = await betterAuthSessionMiddleware(
          middlewareArgs(request, context),
          async () => {
            routeRan = true;
            return new Response("mutated");
          },
        );
        expect(result).toBeInstanceOf(Response);
        if (!(result instanceof Response)) {
          throw new Error("Session middleware did not return a response.");
        }

        expect(result.status).toBe(403);
        expect(await result.text()).toBe("Forbidden");
        expect(result.headers.get("referrer-policy")).toBe("no-referrer");
        expect(result.headers.get("cache-control")).toBe("private, no-store");
        expect(result.headers.get("content-security-policy")).toBe(
          "frame-ancestors 'none'",
        );
        expect(result.headers.get("x-frame-options")).toBe("DENY");
        expect(routeRan).toBe(false);
      } finally {
        if (userId) await db.delete(user).where(eq(user.id, userId));
      }
    });

    it("preserves an explicit cache policy from a safe leaf response", async () => {
      const { betterAuthSessionMiddleware } =
        await import("~/auth/session.server");
      const request = new Request(`${ORIGIN}/sitemap.xml`);
      const context = new RouterContextProvider();
      const result = await betterAuthSessionMiddleware(
        middlewareArgs(request, context),
        async () =>
          new Response("sitemap", {
            headers: { "Cache-Control": "public, max-age=3600" },
          }),
      );

      expect(result).toBeInstanceOf(Response);
      if (!(result instanceof Response)) {
        throw new Error("Session middleware did not return a response.");
      }
      expect(result.headers.get("cache-control")).toBe("public, max-age=3600");
      expect(result.headers.get("referrer-policy")).toBe("no-referrer");
      expect(result.headers.get("content-security-policy")).toBe(
        "frame-ancestors 'none'",
      );
      expect(result.headers.get("x-frame-options")).toBe("DENY");
    });

    // The one route that owns its own CSP: the sandboxed artifact preview (#291), whose entire
    // safety story is a header set. Clobbering it would serve agent-authored HTML unsandboxed, and
    // leaving X-Frame-Options: DENY on would stop the preview iframe from loading at all — XFO has
    // no `frame-ancestors <origin>` equivalent, so the route's CSP has to replace it, not join it.
    it("leaves a leaf route's own Content-Security-Policy — and its X-Frame-Options — alone", async () => {
      const { betterAuthSessionMiddleware } =
        await import("~/auth/session.server");
      const leafCsp = `sandbox allow-scripts; default-src 'none'; frame-ancestors ${ORIGIN}`;
      const request = new Request(`${ORIGIN}/artifacts/preview/tok/art_1/index.html`);
      const context = new RouterContextProvider();
      const result = await betterAuthSessionMiddleware(
        middlewareArgs(request, context),
        async () =>
          new Response("<html></html>", {
            headers: {
              "Content-Security-Policy": leafCsp,
              "Cache-Control": "private, no-store",
            },
          }),
      );

      expect(result).toBeInstanceOf(Response);
      if (!(result instanceof Response)) {
        throw new Error("Session middleware did not return a response.");
      }
      expect(result.headers.get("content-security-policy")).toBe(leafCsp);
      expect(result.headers.get("x-frame-options")).toBeNull();
      // Still hardened in every other respect.
      expect(result.headers.get("referrer-policy")).toBe("no-referrer");
      expect(result.headers.get("permissions-policy")).toContain("camera=()");
    });
  },
);
