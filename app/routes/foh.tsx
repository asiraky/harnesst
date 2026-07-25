/**
 * Front of House — the app root (§2.6: FOH is home). Pathless layout that owns the left
 * sidebar of the three-pane shell (§3): teams → agents with presence dots + needs-you
 * badges, the 🔔 inbox flyout up top, and the back-of-house switcher (D18, admins/owners
 * only). Children render the middle/right panes.
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
import { Link, NavLink, Outlet, type LoaderFunctionArgs } from "react-router";

import { sessionLoader } from "~/auth/session.server";
import {
  ensureWorkspace,
  isBackOfHouse,
  resolveActiveWorkspace,
} from "~/auth/workspace.server";
import { AccountMenu } from "~/components/foh/account-menu";
import { InboxIndicator } from "~/components/foh/inbox";
import { PresenceDot } from "~/components/foh/presence-dot";
import { MarketingLanding } from "~/components/marketing/landing";
import { BrandWordmark } from "~/components/marketing/logo";
import { loadFohSidebar } from "~/foh/sidebar.server";
import { appOrigin, isMarketingHost } from "~/lib/marketing-host.server";
import { useLiveRevalidate } from "~/lib/use-live-revalidate";
import { noindexMeta, pageMeta } from "~/lib/seo";
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
      const backOfHouse = isBackOfHouse(active.member.role);
      const sidebar = await loadFohSidebar({
        userId: auth.user.id,
        orgId: active.org.id,
        backOfHouse,
      });
      return {
        orgName: active.org.name,
        backOfHouse,
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
  const { orgName, backOfHouse, teams, user } = data;
  // Presence + badges freshness: baseline 10s loader poll (D12-adjacent; the inbox flyout
  // has its own keyed-fetcher poll).
  useLiveRevalidate({ idleIntervalMs: 10_000 });

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <aside className="flex w-64 shrink-0 flex-col border-r">
        {/* Workspace name intentionally absent (issue #212 §1): nobody switches
            workspaces yet, and the label never sat aligned with the wordmark — it now
            lives in the account menu below instead. */}
        <div className="flex h-14 items-center border-b px-3">
          <Link to="/" className="flex items-center" aria-label="harnesst home">
            <BrandWordmark className="h-5" />
          </Link>
          <div className="ml-auto">
            <InboxIndicator />
          </div>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
          {teams.length === 0 ? (
            <p className="px-2 py-4 text-xs text-muted-foreground">
              No teams yet.
              {backOfHouse
                ? " Connect a repository in back of house to get started."
                : " Ask a workspace admin to invite you to a repository."}
            </p>
          ) : (
            <ul className="space-y-4">
              {teams.map((team) => (
                <li key={team.projectId}>
                  <p className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
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
                            to={`/t/${team.projectId}/${agent.id}`}
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
                    to={`/t/${team.projectId}/activity`}
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
        </nav>

        <div className="border-t p-2">
          <AccountMenu
            name={user?.name ?? null}
            email={user?.email ?? null}
            orgName={orgName}
            backOfHouse={backOfHouse}
          />
        </div>
      </aside>

      <Outlet />
    </div>
  );
}
