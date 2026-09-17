/**
 * The two product surfaces and the mapping between them.
 *
 *   Chat  — `/` and `/t/...`: talk to your team (FOH PRD §2.6; "front of house" internally).
 *   Build — `/dashboard`, `/repos/...`, `/marketplace`, `/settings`: author, ship, observe
 *           ("back of house" internally).
 *
 * The surface toggle in the shared sidebar is CONTEXT-PRESERVING: flipping from an agent's
 * conversation lands on that agent's Build page and back again, never on a root. These helpers
 * are pure (no router, no server) so the mapping is unit-testable and shared by both layouts.
 *
 * Chat URLs key agents by ID (`/t/:slug/:agentId`), Build URLs by NAME
 * (`/repos/:slug/agents/:name`), and a single-agent repo has no member page at all (the repo IS
 * the agent, M5.8) — so the mapping needs the roster, which both sidebars already load.
 */

export type Surface = "chat" | "build";

export interface SurfaceAgent {
  id: string;
  name: string;
}

/** The roster slice both sidebars carry, enough to translate a URL across surfaces. */
export interface SurfaceRepo {
  /** Canonical URL segment (`project.slug`), the same on both surfaces. */
  slug: string;
  layout: "single" | "team";
  agents: SurfaceAgent[];
}

export const SURFACE_ROOT: Record<Surface, string> = {
  chat: "/",
  build: "/dashboard",
};

export const SURFACE_LABEL: Record<Surface, string> = {
  chat: "Chat",
  build: "Build",
};

/** Which surface a pathname belongs to. */
export function surfaceOf(pathname: string): Surface {
  return pathname === "/" || pathname.startsWith("/t/") ? "chat" : "build";
}

/**
 * Chat → Build. `/t/:slug/:agentId[/s/:sessionId]` → the agent's Build page (member page for a
 * team, repo page for a single-agent repo); `/t/:slug/activity` → the repo page. Null when the
 * path names nothing the caller's roster knows about.
 */
export function chatToBuildHref(
  pathname: string,
  repos: SurfaceRepo[],
): string | null {
  const match = pathname.match(/^\/t\/([^/]+)(?:\/([^/]+))?/);
  if (!match) return null;
  const slug = decodeURIComponent(match[1]);
  const repo = repos.find((r) => r.slug === slug);
  if (!repo) return null;
  const base = `/repos/${encodeURIComponent(repo.slug)}`;
  const second = match[2] ? decodeURIComponent(match[2]) : null;
  if (!second || second === "activity") return base;
  const agent = repo.agents.find((a) => a.id === second);
  if (!agent) return base;
  if (repo.layout !== "team") return base;
  return `${base}/agents/${encodeURIComponent(agent.name)}`;
}

/**
 * Build → Chat. `/repos/:slug/agents/:name/...` → that agent's conversations;
 * `/repos/:slug/...` → the single agent's conversations, or the team's activity feed. Null off a
 * repo page.
 */
export function buildToChatHref(
  pathname: string,
  repos: SurfaceRepo[],
): string | null {
  const match = pathname.match(/^\/repos\/([^/]+)(?:\/agents\/([^/]+))?/);
  if (!match) return null;
  const slug = decodeURIComponent(match[1]);
  const repo = repos.find((r) => r.slug === slug);
  if (!repo) return null;
  const base = `/t/${encodeURIComponent(repo.slug)}`;
  const name = match[2] ? decodeURIComponent(match[2]) : null;
  const agent = name
    ? repo.agents.find((a) => a.name === name)
    : repo.layout !== "team"
      ? repo.agents[0]
      : undefined;
  if (agent) return `${base}/${encodeURIComponent(agent.id)}`;
  return `${base}/activity`;
}

/** The mapped counterpart of `pathname` on the other surface, or null when there is none. */
export function counterpartHref(
  from: Surface,
  pathname: string,
  repos: SurfaceRepo[],
): string | null {
  return from === "chat"
    ? chatToBuildHref(pathname, repos)
    : buildToChatHref(pathname, repos);
}

/**
 * sessionStorage key remembering the last URL visited on a surface (the toggle's fallback).
 * Scoped by workspace: a URL remembered in one workspace names repos the next one doesn't have.
 */
export function lastVisitedKey(surface: Surface, orgId: string): string {
  return `harnesst:last-visited:${orgId}:${surface}`;
}
