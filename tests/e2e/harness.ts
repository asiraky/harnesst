/**
 * Shared harness for the FOH e2e suite (docs/PRD-FRONT-OF-HOUSE.md §5–§6, issue #221).
 *
 * Same opt-in pattern as tests/integration: specs run only with HARNESST_DB_SMOKE=1 and a
 * DATABASE_URL pointing at a live dev database (source .env.local first). Everything here is
 * REAL — Better Auth signup/cookies against the real handler, Drizzle writes to the live
 * Postgres, and the real route modules invoked with framework-shaped args — except the eve
 * instance, which is the protocol-faithful fake in ./fake-eve.ts.
 *
 * App modules are imported dynamically inside each helper so a skipped run (no HARNESST_DB_SMOKE)
 * never touches the database-backed module graph.
 */
export const LIVE = process.env.HARNESST_DB_SMOKE === "1";

process.env.BETTER_AUTH_SECRET ??=
  "harnesst-auth-e2e-secret-at-least-32-characters";
process.env.BETTER_AUTH_URL ??= "http://localhost:5277";
/** Request origin must match BETTER_AUTH_URL (Better Auth's trusted-origin check). */
export const ORIGIN = process.env.BETTER_AUTH_URL;

/**
 * Framework context stand-in for direct route-module calls: no middleware ran, so an empty
 * context makes getSessionAuth fall back to reading the session from the request cookie.
 */
export function routeContext(): never {
  return { get: () => null, set: () => {} } as never;
}

export function actionArgs(input: {
  path: string;
  cookie: string;
  form: Record<string, string>;
  params: Record<string, string>;
}): never {
  return {
    request: new Request(`${ORIGIN}${input.path}`, {
      method: "POST",
      headers: { cookie: input.cookie, origin: ORIGIN },
      body: new URLSearchParams(input.form),
    }),
    params: input.params,
    context: routeContext(),
  } as never;
}

export function loaderArgs(input: {
  path: string;
  cookie: string;
  params: Record<string, string>;
}): never {
  return {
    request: new Request(`${ORIGIN}${input.path}`, {
      headers: { cookie: input.cookie },
    }),
    params: input.params,
    context: routeContext(),
  } as never;
}

/** HTTP status of a thrown route error (a Response or React Router's data() init). */
export function statusOfThrown(error: unknown): number | null {
  if (error instanceof Response) return error.status;
  if (error && typeof error === "object" && "init" in error) {
    const init = (error as { init?: { status?: number } }).init;
    return init?.status ?? null;
  }
  return null;
}

/**
 * Poll until `fn` returns a truthy value (the detached drain settles asynchronously — never
 * sleep, always converge on the database with a deadline).
 */
export async function until<T>(
  fn: () => Promise<T | null | undefined | false>,
  label: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Incremental NDJSON reader over a route Response — abandon() detaches mid-stream. */
export function openNdjson(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  return {
    async next(): Promise<Record<string, unknown> | null> {
      for (;;) {
        const idx = buf.indexOf("\n");
        if (idx >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line) return JSON.parse(line) as Record<string, unknown>;
          continue;
        }
        const { done, value } = await reader.read();
        if (done) return null;
        buf += decoder.decode(value, { stream: true });
      }
    },
    /** Walk away mid-turn: cancel the client reader; the detached drain keeps going. */
    async abandon(): Promise<void> {
      try {
        await reader.cancel();
      } catch {
        // already closed
      }
    },
  };
}

export interface TestUser {
  cookie: string;
  userId: string;
  email: string;
}

function cookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie");
  if (!header) {
    throw new Error("Better Auth response did not set a session cookie.");
  }
  return header.split(";", 1)[0];
}

/** Real email/password signup through the Better Auth handler; returns the session cookie. */
export async function signUp(name: string, email: string): Promise<TestUser> {
  const { auth } = await import("~/lib/auth.server");
  const response = await auth.handler(
    new Request(`${ORIGIN}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({
        name,
        email,
        password: "correct-horse-battery-staple",
      }),
    }),
  );
  if (response.status !== 200) {
    throw new Error(`sign-up failed with ${response.status}`);
  }
  const cookie = cookieFrom(response);
  const session = await auth.api.getSession({
    headers: new Headers({ cookie }),
  });
  if (!session?.user.id) throw new Error("sign-up produced no session");
  return { cookie, userId: session.user.id, email };
}

/** Create a workspace as `owner` and pin it active on their session. */
export async function createWorkspace(
  owner: TestUser,
  name: string,
  slug: string,
): Promise<string> {
  const { auth } = await import("~/lib/auth.server");
  const headers = new Headers({ cookie: owner.cookie });
  const org = await auth.api.createOrganization({
    body: { name, slug },
    headers,
  });
  if (!org?.id) throw new Error("createOrganization returned no id");
  await auth.api.setActiveOrganization({
    body: { organizationId: org.id },
    headers,
  });
  return org.id;
}

/**
 * Add an existing signed-up user as a plain workspace `member` (optionally into a repo
 * team) and pin the workspace active on their session.
 */
export async function addMember(
  user: TestUser,
  organizationId: string,
  teamId?: string,
): Promise<void> {
  const { auth } = await import("~/lib/auth.server");
  const { db } = await import("~/db/client.server");
  const { member, teamMember } = await import("~/db/auth-schema");
  await db.insert(member).values({
    id: crypto.randomUUID(),
    organizationId,
    userId: user.userId,
    role: "member",
    createdAt: new Date(),
  });
  if (teamId) {
    await db.insert(teamMember).values({
      id: crypto.randomUUID(),
      teamId,
      userId: user.userId,
      createdAt: new Date(),
    });
  }
  await auth.api.setActiveOrganization({
    body: { organizationId },
    headers: new Headers({ cookie: user.cookie }),
  });
}

/**
 * Seed the deploy substrate a talkable FOH agent needs: project + `member` agent +
 * environment + release + a `live` deployment whose url is the fake eve server — exactly
 * what `liveTargets` filters on (status "live" AND url present).
 */
export async function seedTeamStack(input: {
  orgId: string;
  suffix: string;
  eveUrl?: string;
}) {
  const { db } = await import("~/db/client.server");
  const { agents, deployments, environments, projects, releases } =
    await import("~/db/schema");
  const [project] = await db
    .insert(projects)
    .values({
      orgId: input.orgId,
      name: `foh-e2e-${input.suffix}`,
      slug: `foh-e2e-${input.suffix}`,
    })
    .returning();
  const [agent] = await db
    .insert(agents)
    .values({ projectId: project.id, name: "ivy", root: "agents/ivy/agent" })
    .returning();
  if (!input.eveUrl) return { project, agent };
  const [environment] = await db
    .insert(environments)
    .values({ projectId: project.id, agentId: agent.id, name: "production" })
    .returning();
  const [release] = await db
    .insert(releases)
    .values({
      projectId: project.id,
      agentId: agent.id,
      version: "v1",
      gitSha: "e".repeat(40),
    })
    .returning();
  const [deployment] = await db
    .insert(deployments)
    .values({
      environmentId: environment.id,
      releaseId: release.id,
      status: "live",
      trafficWeight: 100,
      url: input.eveUrl,
    })
    .returning();
  return { project, agent, environment, release, deployment };
}

/** Tear down everything a spec created: the org cascade first, then the user rows. */
export async function cleanupWorkspace(
  organizationId: string | undefined,
  users: TestUser[],
): Promise<void> {
  const { db } = await import("~/db/client.server");
  const { eq } = await import("drizzle-orm");
  const { organization, user } = await import("~/db/auth-schema");
  if (organizationId) {
    await db.delete(organization).where(eq(organization.id, organizationId));
  }
  for (const testUser of users) {
    await db.delete(user).where(eq(user.id, testUser.userId));
  }
}

/** Unique per-run suffix so parallel spec files never collide on slugs/emails. */
export function uniqueSuffix(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
