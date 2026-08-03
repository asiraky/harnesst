import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The browser-CSRF origin guard in betterAuthSessionMiddleware runs BEFORE any route action, so
// exercising it through `action(...)` (as the capability-route unit tests do) can't catch a
// machine endpoint that was left out of the allowlist. This regression test drives the middleware
// directly with Origin-less POSTs — the exact shape of a server-to-server bearer call from an agent
// container — and pins which paths are exempt. Guards issues #166 (capabilities) and #167
// (connections token broker): both are bearer-authenticated and MUST bypass the origin check.

const getSession = vi.hoisted(() => vi.fn());

vi.mock("~/lib/auth.server", () => ({
  auth: { api: { getSession } },
}));

function middlewareArgs(request: Request, context: RouterContextProvider) {
  const url = new URL(request.url);
  return { request, context, url, pattern: url.pathname, params: {} };
}

function originlessPost(pathname: string): Request {
  // No Origin header — the defining trait of a non-browser caller.
  return new Request(`https://harnesst.example.com${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

describe("mutation-origin guard: bearer machine endpoints bypass the browser CSRF check", () => {
  beforeEach(() => {
    getSession.mockReset();
    process.env.HARNESST_SECRETS_KEY =
      "1f8b16e6a46dd3ac12ef7a328f1ce35c67b5bc8f1acdd76280e3674c3a4f19b2";
    process.env.BETTER_AUTH_URL = "https://harnesst.example.com";
  });

  const machinePaths = [
    "/api/capabilities/xero/list-accounts",
    "/api/capabilities/mayi/anything",
    "/api/connections/token",
    // WS1: a channel-homed agent parks its `input.requested` question here with the delegation
    // bearer. Dropping it from the allowlist would 403 every park with no other symptom.
    "/api/foh/park",
    // #288 3c: the baked `notify-user` tool POSTs its notification here with the same
    // delegation bearer. Dropping it from the allowlist would 403 every notification before
    // bearer auth ever ran — the agent sees only an opaque HTTP 403.
    "/api/foh/notify",
    // WS2: every harnesst-built image's `harnesst-runs` hook POSTs its turns here with the same
    // delegation bearer. The hook is fire-and-forget and swallows failures, so a 403 here would
    // silently produce zero channel runs — the exact class of invisible failure this workstream
    // exists to end.
    "/api/agent/runs",
  ];

  for (const path of machinePaths) {
    it(`lets an Origin-less POST to ${path} through to the route`, async () => {
      const { betterAuthSessionMiddleware } =
        await import("~/auth/session.server");
      const routed = new Response("handled by route", { status: 200 });
      const next = vi.fn(async () => routed);

      const result = await betterAuthSessionMiddleware(
        middlewareArgs(originlessPost(path), new RouterContextProvider()),
        next,
      );

      expect(next).toHaveBeenCalledTimes(1);
      // Machine endpoints own their own auth — the wrapper must not load a session for them.
      expect(getSession).not.toHaveBeenCalled();
      expect(result).toBe(routed);
      expect(result).toBeInstanceOf(Response);
      if (!(result instanceof Response)) throw new Error("no response");
      expect(result.status).toBe(200);
    });
  }

  it("still rejects an Origin-less POST to a non-machine (browser) route", async () => {
    const { betterAuthSessionMiddleware } =
      await import("~/auth/session.server");
    const next = vi.fn(async () => new Response("must not render"));

    const result = await betterAuthSessionMiddleware(
      middlewareArgs(originlessPost("/org/settings"), new RouterContextProvider()),
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) throw new Error("no response");
    expect(result.status).toBe(403);
    expect(await result.text()).toBe("Forbidden");
  });

  it("rejects a browser POST whose Origin does not match the configured origin", async () => {
    const { betterAuthSessionMiddleware } =
      await import("~/auth/session.server");
    const request = new Request("https://harnesst.example.com/org/settings", {
      method: "POST",
      headers: { origin: "https://evil.example.com" },
    });
    const next = vi.fn(async () => new Response("must not render"));

    const result = await betterAuthSessionMiddleware(
      middlewareArgs(request, new RouterContextProvider()),
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) throw new Error("no response");
    expect(result.status).toBe(403);
  });
});
