/**
 * Host-split behavior of the routes themselves (FOH D11):
 *  - `/` (routes/foh.tsx): marketing host → landing mode with cross-host appOrigin and NO
 *    sign-in gate; app host → the usual ensureSignedIn shell loader; env unset → FOH always.
 *  - case-studies loaders: app host with a marketing host configured → redirect to the
 *    marketing origin; on the marketing host → serve with cross-host appOrigin; unset → serve
 *    with same-origin links.
 *  - robots.txt: per-host content.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sessionLoader: vi.fn(),
  ensureWorkspace: vi.fn(async () => {}),
  resolveActiveWorkspace: vi.fn(),
  isWorkspaceAdmin: vi.fn((role: string) => role === "owner" || role === "admin"),
  loadFohSidebar: vi.fn(),
}));

vi.mock("~/auth/session.server", () => ({
  sessionLoader: mocks.sessionLoader,
}));
vi.mock("~/auth/workspace.server", () => ({
  ensureWorkspace: mocks.ensureWorkspace,
  resolveActiveWorkspace: mocks.resolveActiveWorkspace,
  isWorkspaceAdmin: mocks.isWorkspaceAdmin,
}));
vi.mock("~/foh/sidebar.server", () => ({
  loadFohSidebar: mocks.loadFohSidebar,
}));

import { loader as fohLoader } from "~/routes/foh";
import { loader as caseStudiesLoader } from "~/routes/case-studies";
import { loader as robotsLoader } from "~/routes/robots[.]txt";

const SAVED = {
  MARKETING_HOST: process.env.MARKETING_HOST,
  BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
};

function setEnv(name: keyof typeof SAVED, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  vi.clearAllMocks();
  setEnv("MARKETING_HOST", undefined);
  setEnv("BETTER_AUTH_URL", "https://harnesst.example.com");
  // Default authenticated behavior: run the callback like the real overload would.
  mocks.sessionLoader.mockImplementation(
    async (
      _args: unknown,
      callback?: (ctx: { auth: unknown }) => Promise<object>,
    ) => {
      const user = { id: "user1", email: "a@example.com" };
      if (!callback) return { user };
      const result = await callback({
        auth: { user, organizationId: "org1" },
      });
      return { ...result, user };
    },
  );
  mocks.resolveActiveWorkspace.mockResolvedValue({
    org: { id: "org1", name: "Acme" },
    member: { role: "owner" },
  });
  mocks.loadFohSidebar.mockResolvedValue({
    teams: [{ projectId: "p1", name: "repo-one", agents: [] }],
  });
});

afterEach(() => {
  setEnv("MARKETING_HOST", SAVED.MARKETING_HOST);
  setEnv("BETTER_AUTH_URL", SAVED.BETTER_AUTH_URL);
});

function loaderArgs(url: string) {
  return {
    request: new Request(url),
    params: {},
    context: {},
  } as never;
}

async function caughtResponse(promise: Promise<unknown>): Promise<Response> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  throw new Error("expected the loader to throw a Response");
}

describe("routes/foh loader (the `/` host branch)", () => {
  it("serves the marketing landing on the marketing host without touching auth", async () => {
    setEnv("MARKETING_HOST", "www.harnesst.example.com");
    const result = await fohLoader(loaderArgs("https://www.harnesst.example.com/"));
    expect(result).toEqual({
      marketing: true,
      appOrigin: "https://harnesst.example.com",
    });
    expect(mocks.sessionLoader).not.toHaveBeenCalled();
    expect(mocks.ensureWorkspace).not.toHaveBeenCalled();
  });

  it("gates the app host behind sign-in (redirect surfaces from sessionLoader)", async () => {
    setEnv("MARKETING_HOST", "www.harnesst.example.com");
    mocks.sessionLoader.mockImplementation(async () => {
      throw new Response(null, {
        status: 302,
        headers: { location: "/login?returnTo=%2F" },
      });
    });
    const response = await caughtResponse(
      fohLoader(loaderArgs("https://harnesst.example.com/")),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login?returnTo=%2F");
    const opts = mocks.sessionLoader.mock.calls[0][2];
    expect(opts).toMatchObject({ ensureSignedIn: true });
  });

  it("returns shell data for a signed-in visitor on the app host", async () => {
    setEnv("MARKETING_HOST", "www.harnesst.example.com");
    const result = (await fohLoader(
      loaderArgs("https://harnesst.example.com/"),
    )) as Record<string, unknown>;
    expect(result.orgName).toBe("Acme");
    expect(result.backOfHouse).toBe(true);
    expect(result.workspaceAdmin).toBe(true);
    expect(result.teams).toEqual([
      { projectId: "p1", name: "repo-one", agents: [] },
    ]);
    expect(result).not.toHaveProperty("marketing");
    expect(mocks.ensureWorkspace).toHaveBeenCalledTimes(1);
  });

  it("always serves FOH when MARKETING_HOST is unset — even on a www-looking host", async () => {
    const result = (await fohLoader(
      loaderArgs("https://www.harnesst.example.com/"),
    )) as Record<string, unknown>;
    expect(result).not.toHaveProperty("marketing");
    expect(mocks.sessionLoader).toHaveBeenCalledTimes(1);
  });
});

describe("case-studies loader host guard", () => {
  it("redirects the app host to the marketing origin when configured", async () => {
    setEnv("MARKETING_HOST", "www.harnesst.example.com");
    const response = await caughtResponse(
      caseStudiesLoader(loaderArgs("https://harnesst.example.com/case-studies")),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://www.harnesst.example.com/case-studies",
    );
  });

  it("serves on the marketing host with cross-host auth links", async () => {
    setEnv("MARKETING_HOST", "www.harnesst.example.com");
    const result = (await caseStudiesLoader(
      loaderArgs("https://www.harnesst.example.com/case-studies"),
    )) as { appOrigin: string };
    expect(result.appOrigin).toBe("https://harnesst.example.com");
  });

  it("serves by path with same-origin links when unset (self-host, D11)", async () => {
    const result = (await caseStudiesLoader(
      loaderArgs("https://harnesst.example.com/case-studies"),
    )) as { appOrigin: string };
    expect(result.appOrigin).toBe("");
  });
});

describe("robots.txt per host", () => {
  async function robotsBody(url: string): Promise<string> {
    const response = robotsLoader(loaderArgs(url));
    expect(response.headers.get("content-type")).toContain("text/plain");
    return await response.text();
  }

  it("marketing host: crawlable marketing policy with the marketing sitemap", async () => {
    setEnv("MARKETING_HOST", "www.harnesst.example.com");
    const body = await robotsBody("https://www.harnesst.example.com/robots.txt");
    expect(body).toContain("Allow: /");
    expect(body).toContain("Disallow: /repos/");
    expect(body).toContain("Disallow: /t/");
    expect(body).toContain(
      "Sitemap: https://www.harnesst.example.com/sitemap.xml",
    );
  });

  it("app host with a marketing host configured: nothing indexable", async () => {
    setEnv("MARKETING_HOST", "www.harnesst.example.com");
    const body = await robotsBody("https://harnesst.example.com/robots.txt");
    expect(body).toContain("Disallow: /");
    expect(body).not.toContain("Allow: /");
    expect(body).not.toContain("Sitemap:");
  });

  it("unset (self-host): marketing policy with the sitemap on this host's own origin", async () => {
    const body = await robotsBody("https://my-harnesst.internal/robots.txt");
    expect(body).toContain("Allow: /");
    expect(body).toContain("Sitemap: https://my-harnesst.internal/sitemap.xml");
  });
});
