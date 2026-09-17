/**
 * Chat — the app root (FOH PRD §2.6: front of house is home). Pathless layout that owns the left
 * pane of the three-pane shell (§3): the shared sidebar frame (components/app-sidebar.tsx — the
 * Chat | Build toggle, the workspace Settings gear, the account menu) around the viewer's
 * teams → agents list with presence dots + needs-you badges and the 🔔 inbox flyout. Children
 * render the middle/right panes.
 *
 * Unauthenticated visitors are redirected to sign-in (`ensureSignedIn`); the first org-less
 * login provisions a workspace via `ensureWorkspace` exactly like the dashboard did.
 *
 * Host split (D11): on the configured MARKETING_HOST this same route serves the editorial
 * marketing landing instead — RR7 routes on pathname only, so `/` must branch on Host in the
 * loader (works identically under `react-router dev` and the Express prod server). Deep FOH
 * paths on the marketing host never reach their loaders: the root session middleware bounces
 * every non-marketing GET to the app origin. Self-host default (env unset) is always FOH.
 */
import { Zap } from "lucide-react";
import {
  NavLink,
  Outlet,
  useLocation,
  type LoaderFunctionArgs,
} from "react-router";

import { sessionLoader } from "~/auth/session.server";
import {
  ensureWorkspace,
  isWorkspaceAdmin,
  resolveActiveWorkspace,
} from "~/auth/workspace.server";
import { AppSidebar } from "~/components/app-sidebar";
import { InboxIndicator } from "~/components/foh/inbox";
import { PresenceDot } from "~/components/foh/presence-dot";
import { MarketingLanding } from "~/components/marketing/landing";
import { loadFohSidebar } from "~/foh/sidebar.server";
import { appOrigin, isMarketingHost } from "~/lib/marketing-host.server";
import { useLiveRevalidate } from "~/lib/use-live-revalidate";
import { noindexMeta, pageMeta } from "~/lib/seo";
import type { SurfaceRepo } from "~/lib/surfaces";
import { cn } from "~/lib/utils";
import type { Route } from "./+types/foh";

export async function loader(args: LoaderFunctionArgs) {
  // Marketing host: serve the landing — no sign-in gate, no workspace provisioning, no
  // shell data. Auth CTAs need the app origin because cookies don't cross subdomains.
  if (isMarketingHost(args.request)) {
    return { marketing: true as const, appOrigin: appOrigin() ?? "" };
  }
  return sessionLoader(
    args,
    async ({ auth }) => {
      await ensureWorkspace(args.request, auth);
      const active = await resolveActiveWorkspace(auth);
      // ensureWorkspace redirects whenever it changes the session; reaching here without an
      // active workspace means something is genuinely broken.
      if (!active) throw new Response("No organization", { status: 403 });
      const sidebar = await loadFohSidebar({
        userId: auth.user.id,
        orgId: active.org.id,
        workspaceRole: active.member.role,
      });
      // The build surface is reachable by anyone who can write to at least one repo; creating
      // repos (the "New repository" item) stays a workspace-admin power.
      const workspaceAdmin = isWorkspaceAdmin(active.member.role);
      const backOfHouse =
        workspaceAdmin || sidebar.teams.some((team) => team.role === "write");
      return {
        orgId: active.org.id,
        orgName: active.org.name,
        backOfHouse,
        workspaceAdmin,
        teams: sidebar.teams,
      };
    },
    { ensureSignedIn: true },
  );
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (loaderData && "marketing" in loaderData) {
    return pageMeta({
      title: "harnesst — agents for the work you keep repeating",
      description:
        "Turn the work you keep repeating into agents that do it for you. No engineer, no backlog, no code required.",
      path: "/",
    });
  }
  return [{ title: "harnesst" }, ...noindexMeta];
}

/** The FOH loader payload once the marketing branch is excluded. */
type ShellData = Exclude<Route.ComponentProps["loaderData"], { marketing: true }>;

export default function FohRoot({ loaderData }: Route.ComponentProps) {
  if ("marketing" in loaderData) {
    return <MarketingLanding appOrigin={loaderData.appOrigin} />;
  }
  return <FohShell data={loaderData} />;
}

function FohShell({ data }: { data: ShellData }) {
  const { orgId, orgName, backOfHouse, workspaceAdmin, teams, user } = data;
  // Presence + badges freshness: baseline 10s loader poll (D12-adjacent; the inbox flyout
  // has its own keyed-fetcher poll).
  useLiveRevalidate({ idleIntervalMs: 10_000 });
  // Responsive panes (issue #265). Three panes need 544px of chrome before the conversation
  // gets anything, so they only all coexist at lg. Below that the shell is a sliding window
  // over the pane stack: at lg- this sidebar shows only at `/`, and below md it is the whole
  // page there. Deeper routes hide it and render their own back button.
  const atHome = useLocation().pathname === "/";
  // The toggle only needs to translate URLs for repos the viewer can enter Build for.
  const repos: SurfaceRepo[] = teams
    .filter((team) => team.role === "write")
    .map((team) => ({
      slug: team.projectSlug ?? team.projectId,
      layout: team.layout,
      agents: team.agents.map((agent) => ({ id: agent.id, name: agent.name })),
    }));

  return (
    // `fixed inset-0` rather than a flow-positioned `h-dvh` box: the shell then fills exactly
    // the viewport no matter what any ancestor does to document height, so the header (and the
    // back control it carries) can never be scrolled out of reach on a phone.
    <div className="fixed inset-0 flex overflow-hidden overscroll-none bg-background">
      <AppSidebar
        surface="chat"
        repos={repos}
        canToggle={backOfHouse}
        canSettings={workspaceAdmin}
        account={{
          name: user?.name ?? null,
          email: user?.email ?? null,
          orgId,
          orgName,
        }}
        headerExtra={<InboxIndicator />}
        className={atHome ? "flex w-full md:w-64" : "hidden w-64 lg:flex"}
      >
        {teams.length === 0 ? (
          <p className="px-2 py-4 text-xs text-muted-foreground">
            No teams yet.
            {workspaceAdmin
              ? " Connect a repository to get started."
              : " Ask a workspace admin to give you access to a repository."}
          </p>
        ) : (
          <ul className="space-y-4">
            {teams.map((team) => (
              <li key={team.projectId}>
                <p className="min-w-0 truncate px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {team.name}
                </p>
                {team.agents.length === 0 ? (
                  <p className="px-2 py-1 text-xs text-muted-foreground/70">
                    No team members.
                  </p>
                ) : (
                  <ul className="space-y-0.5">
                    {team.agents.map((agent) => (
                      <li key={agent.id}>
                        <NavLink
                          to={`/t/${team.projectSlug ?? team.projectId}/${agent.id}`}
                          prefetch="intent"
                          className={({ isActive }) =>
                            cn(
                              "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted/60",
                              isActive && "bg-muted font-medium",
                            )
                          }
                        >
                          <PresenceDot presence={agent.presence} />
                          <span className="min-w-0 flex-1 truncate">
                            {agent.name}
                          </span>
                          {agent.needsYou > 0 && (
                            <span
                              className="flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold text-white"
                              aria-label={`${agent.needsYou} pending`}
                            >
                              {agent.needsYou}
                            </span>
                          )}
                        </NavLink>
                      </li>
                    ))}
                  </ul>
                )}
                {/* §3 mock: the team's ⚡ activity feed lives under its member list. */}
                <NavLink
                  to={`/t/${team.projectSlug ?? team.projectId}/activity`}
                  prefetch="intent"
                  className={({ isActive }) =>
                    cn(
                      "mt-0.5 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted/60",
                      isActive && "bg-muted font-medium text-foreground",
                    )
                  }
                >
                  <Zap className="size-3.5" aria-hidden />
                  activity
                </NavLink>
              </li>
            ))}
          </ul>
        )}
      </AppSidebar>

      <Outlet />
    </div>
  );
}
