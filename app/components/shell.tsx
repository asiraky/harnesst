/**
 * Shared application chrome, encoding the product hierarchy (D2/D3 + the eve model, M5.8):
 *   workspace (org) → repository → team member (agents/:name URL level) → page.
 *
 * AppShell renders the Build surface's frame: the shared sidebar (components/app-sidebar.tsx,
 * fed by the `routes/build` layout loader) beside the page column with its breadcrumb trail.
 * AgentNav renders the section tabs — a DIFFERENT set per level, because the scopes differ:
 * repo level (team landing) gets the repo-wide surfaces, member level gets the member-scoped
 * ones, and single-agent repos collapse both levels into one merged row.
 */
import {
  Bot,
  FolderGit2,
  Menu,
  Plus,
  Store,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  Link,
  NavLink,
  useLocation,
  useNavigate,
  useNavigation,
  useRouteLoaderData,
} from "react-router";

import { AppSidebar } from "~/components/app-sidebar";
import { PublishControl } from "~/components/publish";
import { WorkspaceTasksIndicator } from "~/components/workspace-tasks";
import { BrandWordmark } from "~/components/marketing/logo";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Separator } from "~/components/ui/separator";
import { TooltipProvider } from "~/components/ui/tooltip";
import { contextPath, repoPath, subagentContextPath } from "~/lib/paths";
import { cn } from "~/lib/utils";
import type { BuildSidebarData, loader as buildLoader } from "~/routes/build";

/** One level of the hierarchy trail. No `to` == the current page (rendered unlinked). */
export interface Crumb {
  label: React.ReactNode;
  to?: string;
}

/**
 * Standard trail for repository pages: repo → (team member) → (subagent chain) → page. The last
 * crumb is always unlinked (it's where you are); every ancestor links up a level.
 *
 * A declared subagent (issue #344) contributes TWO crumbs per level — the parent's `Subagents`
 * list and the subagent itself — so the trail reads `ivy → Subagents → researcher` and every
 * hop up the chain is one click.
 */
export function repoCrumbs(opts: {
  projectId: string;
  repoName: string;
  /** Team repos: the active member (adds a member crumb linking to its overview). */
  agentName?: string | null;
  isTeam?: boolean;
  /** Declared-subagent chain below the member, e.g. ["researcher", "fact-checker"]. */
  subagentPath?: string[];
  /** Page-level crumbs after repo/member, e.g. [{ label: "Runs" }]. */
  tail?: Crumb[];
}): Crumb[] {
  const base = `/repos/${opts.projectId}`;
  const member = opts.isTeam && opts.agentName ? opts.agentName : null;
  const crumbs: Crumb[] = [{ label: opts.repoName, to: base }];
  if (member) {
    crumbs.push({
      label: member,
      to: `${base}/agents/${encodeURIComponent(member)}`,
    });
  }
  let parent = contextPath(opts.projectId, member);
  (opts.subagentPath ?? []).forEach((name, i) => {
    crumbs.push({ label: "Subagents", to: `${parent}/resources/subagents` });
    parent = subagentContextPath(
      opts.projectId,
      member,
      (opts.subagentPath ?? []).slice(0, i + 1),
    );
    crumbs.push({ label: name, to: parent });
  });
  crumbs.push(...(opts.tail ?? []));
  const last = crumbs[crumbs.length - 1];
  delete last.to;
  return crumbs;
}

export function AppShell({
  breadcrumbs,
  fullHeight,
  children,
}: {
  /** Accepted for call-site compatibility; the sidebar's account menu reads the layout's data. */
  userEmail?: string | null;
  /** Hierarchy trail: workspace → repo → member → …; the "up" navigation. */
  breadcrumbs?: Crumb[];
  /** Chat-style pages: lock the shell to the viewport so children own their scrolling
   * (e.g. a transcript scrolls while the composer stays pinned below it). */
  fullHeight?: boolean;
  children: React.ReactNode;
}) {
  const layout = useRouteLoaderData<typeof buildLoader>("routes/build");
  const location = useLocation();
  // Mobile drawer state: below md the sidebar is off-canvas behind the menu button and closes
  // on every committed navigation.
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [location.key]);
  const hasCrumbs = !!breadcrumbs && breadcrumbs.length > 0;

  return (
    <TooltipProvider>
      <div
        className={cn(
          "flex bg-background",
          fullHeight ? "h-dvh overflow-hidden" : "min-h-screen",
        )}
      >
        <NavProgress />
        {layout?.sidebar && layout.user && (
          <>
            <AppSidebar
              surface="build"
              repos={layout.sidebar.repos}
              canToggle
              canSettings={layout.sidebar.workspaceAdmin}
              account={{
                name: layout.user.name ?? null,
                email: layout.user.email ?? null,
                orgName: layout.sidebar.orgName,
              }}
              className={cn(
                // Desktop: pinned to the viewport beside a normally-scrolling document.
                "top-0 h-dvh md:sticky",
                open ? "fixed inset-y-0 left-0 z-50 flex" : "hidden md:flex",
              )}
            >
              <BuildNav sidebar={layout.sidebar} />
            </AppSidebar>
            {open && (
              <button
                type="button"
                aria-label="Close menu"
                className="fixed inset-0 z-40 bg-black/40 md:hidden"
                onClick={() => setOpen(false)}
              />
            )}
          </>
        )}
        <div
          className={cn(
            "flex min-w-0 flex-1 flex-col",
            fullHeight && "min-h-0 overflow-hidden",
          )}
        >
          <header className="sticky top-0 z-30 shrink-0 bg-background/80 backdrop-blur">
            <div
              className={cn(
                "flex min-h-12 flex-wrap items-center gap-2 border-b px-4 sm:gap-4 sm:px-6",
                !hasCrumbs && "md:hidden",
              )}
            >
              <Button
                variant="ghost"
                size="icon"
                className="-ml-2 md:hidden"
                aria-label="Open menu"
                onClick={() => setOpen(true)}
              >
                <Menu className="h-4 w-4" aria-hidden />
              </Button>
              <Link
                to="/dashboard"
                className="flex shrink-0 items-center md:hidden"
                aria-label="harnesst build home"
              >
                <BrandWordmark className="h-5" />
              </Link>
              {breadcrumbs && breadcrumbs.length > 0 && (
                <Breadcrumbs crumbs={breadcrumbs} />
              )}
            </div>
            {/* Strips below the header, both project-scoped and both rendering nothing off a
                /repos/:id page. Order matters: task progress (issue #142) is what's happening NOW,
                so it sits above the publish nudge (issue #225 §4.1), which is only ever a
                dismissible "there's something you haven't shipped". */}
            <WorkspaceTasksIndicator />
            <PublishControl />
          </header>
          <main
            className={
              // Full-height (chat) pages go full-bleed: children center their own columns so
              // the scroll region can span the whole viewport width.
              fullHeight
                ? "flex min-h-0 flex-1 flex-col"
                : "mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8"
            }
          >
            {children}
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}

/**
 * The Build sidebar body: the repositories you can work on, each with its roster, then the
 * surface's other destinations. It mirrors Chat's teams → agents list on purpose — the same
 * shape on both sides is what makes the toggle feel like a flip rather than a teleport.
 */
function BuildNav({ sidebar }: { sidebar: BuildSidebarData }) {
  const { pathname } = useLocation();
  const item =
    "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted/60";
  return (
    <div className="space-y-4">
      <div>
        <NavLink
          to="/dashboard"
          end
          prefetch="intent"
          className={({ isActive }) =>
            cn(
              "mb-1 flex items-center gap-2 rounded-md px-2 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground",
              isActive && "bg-muted text-foreground",
            )
          }
        >
          <FolderGit2 className="size-3.5" aria-hidden />
          Repositories
        </NavLink>
        {sidebar.repos.length === 0 ? (
          <p className="px-2 py-1 text-xs text-muted-foreground/70">
            {sidebar.workspaceAdmin
              ? "No repositories yet."
              : "No repositories you can edit."}
          </p>
        ) : (
          <ul className="space-y-0.5">
            {sidebar.repos.map((repo) => {
              const base = repoPath(repo.slug);
              const inRepo = pathname === base || pathname.startsWith(`${base}/`);
              const onMember = inRepo && pathname.startsWith(`${base}/agents/`);
              return (
                <li key={repo.id}>
                  <Link
                    to={base}
                    prefetch="intent"
                    aria-current={inRepo && !onMember ? "page" : undefined}
                    className={cn(item, inRepo && !onMember && "bg-muted font-medium")}
                  >
                    {repo.layout === "team" ? (
                      <Users className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    ) : (
                      <Bot className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    )}
                    <span className="min-w-0 flex-1 truncate">{repo.name}</span>
                  </Link>
                  {repo.layout === "team" && repo.agents.length > 0 && (
                    <ul className="ml-4 space-y-0.5 border-l pl-1">
                      {repo.agents.map((agent) => {
                        const href = contextPath(repo.slug, agent.name);
                        const active = pathname === href || pathname.startsWith(`${href}/`);
                        return (
                          <li key={agent.id}>
                            <Link
                              to={href}
                              prefetch="intent"
                              aria-current={active ? "page" : undefined}
                              className={cn(item, "py-1", active && "bg-muted font-medium")}
                            >
                              <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {sidebar.workspaceAdmin && (
          <Link
            to="/connect"
            prefetch="intent"
            className={cn(item, "mt-0.5 text-muted-foreground hover:text-foreground")}
          >
            <Plus className="size-3.5" aria-hidden />
            New repository
          </Link>
        )}
      </div>
      <div>
        <NavLink
          to="/marketplace"
          prefetch="intent"
          className={({ isActive }) =>
            cn(item, "text-muted-foreground hover:text-foreground", isActive && "bg-muted font-medium text-foreground")
          }
        >
          <Store className="size-3.5" aria-hidden />
          Marketplace
        </NavLink>
      </div>
    </div>
  );
}

/**
 * Global pending-navigation indicator (M5.9). Mounts only while a navigation is in flight; the
 * CSS fades it in 150ms after mount, so quick navigations resolve before it's ever seen.
 */
function NavProgress() {
  const navigation = useNavigation();
  if (navigation.state === "idle") return null;
  return (
    <div className="harnesst-nav-progress" aria-hidden>
      <div className="harnesst-nav-progress-bar bg-primary" />
    </div>
  );
}

/** The "up" navigation: each ancestor links to its level; the last crumb is the page. */
function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="order-last flex w-full min-w-0 items-center gap-1.5 overflow-x-auto pb-2 text-sm sm:order-none sm:w-auto sm:pb-0">
      {crumbs.map((crumb) => (
        <span key={crumbKey(crumb)} className="flex shrink-0 items-center gap-1.5">
          <span className="text-muted-foreground">/</span>
          {crumb.to ? (
            <Link
              to={crumb.to}
              prefetch="intent"
              className="max-w-44 truncate text-muted-foreground transition-colors hover:text-foreground"
            >
              {crumb.label}
            </Link>
          ) : (
            <span className="max-w-44 truncate font-medium">{crumb.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

function crumbKey(crumb: Crumb): string {
  if (crumb.to) return crumb.to;
  if (typeof crumb.label === "string" || typeof crumb.label === "number") {
    return String(crumb.label);
  }
  return "current";
}

/**
 * Standard section heading: title + badges left, actions right, hairline below. The one
 * pattern for edit affordances on content surfaces — no more buttons floating in card
 * headers.
 */
export function SectionHeader({
  title,
  badges,
  actions,
  icon: Icon,
  accent = "brand",
}: {
  title: React.ReactNode;
  badges?: React.ReactNode;
  actions?: React.ReactNode;
  /** Optional colored glyph left of the title, matching PageHeader's convention. */
  icon?: LucideIcon;
  accent?: Accent;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border-b pb-2">
      <div className="flex items-center gap-2">
        {Icon && (
          <span
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded-md",
              accentChip[accent],
            )}
          >
            <Icon className="size-3.5" aria-hidden />
          </span>
        )}
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        {badges}
      </div>
      {actions && <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * Tailwind accent presets for colored iconography (matches the marketplace's per-type colours).
 * Use `accentChip[c]` for a tinted rounded glyph square; `accentText[c]` for a bare icon/label.
 * Keyed by a semantic-ish colour name so call sites read intentionally. `brand` is special: it
 * tracks the `--primary` theme token (not a fixed hue), so the app-wide brand accent changes by
 * editing one CSS variable. The named hues are for categorical/semantic use (status, type chips).
 */
export type Accent =
  | "brand"
  | "violet"
  | "indigo"
  | "blue"
  | "sky"
  | "cyan"
  | "emerald"
  | "amber"
  | "fuchsia"
  | "rose";

export const accentChip: Record<Accent, string> = {
  brand: "bg-primary/10 text-primary ring-1 ring-primary/20",
  violet: "bg-violet-500/10 text-violet-600 ring-1 ring-violet-500/20 dark:text-violet-400",
  indigo: "bg-indigo-500/10 text-indigo-600 ring-1 ring-indigo-500/20 dark:text-indigo-400",
  blue: "bg-blue-500/10 text-blue-600 ring-1 ring-blue-500/20 dark:text-blue-400",
  sky: "bg-sky-500/10 text-sky-600 ring-1 ring-sky-500/20 dark:text-sky-400",
  cyan: "bg-cyan-500/10 text-cyan-600 ring-1 ring-cyan-500/20 dark:text-cyan-400",
  emerald: "bg-emerald-500/10 text-emerald-600 ring-1 ring-emerald-500/20 dark:text-emerald-400",
  amber: "bg-amber-500/10 text-amber-600 ring-1 ring-amber-500/20 dark:text-amber-400",
  fuchsia: "bg-fuchsia-500/10 text-fuchsia-600 ring-1 ring-fuchsia-500/20 dark:text-fuchsia-400",
  rose: "bg-rose-500/10 text-rose-600 ring-1 ring-rose-500/20 dark:text-rose-400",
};

export const accentText: Record<Accent, string> = {
  brand: "text-primary",
  violet: "text-violet-600 dark:text-violet-400",
  indigo: "text-indigo-600 dark:text-indigo-400",
  blue: "text-blue-600 dark:text-blue-400",
  sky: "text-sky-600 dark:text-sky-400",
  cyan: "text-cyan-600 dark:text-cyan-400",
  emerald: "text-emerald-600 dark:text-emerald-400",
  amber: "text-amber-600 dark:text-amber-400",
  fuchsia: "text-fuchsia-600 dark:text-fuchsia-400",
  rose: "text-rose-600 dark:text-rose-400",
};

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  /** Accepted for call-site compatibility but no longer rendered (page glyphs were removed). */
  icon?: LucideIcon;
  accent?: Accent;
}) {
  return (
    <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 max-w-full">
        <h1 className="[overflow-wrap:anywhere] text-2xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Minimal roster info the switcher needs (serializable through loaders). */
export interface RosterMember {
  name: string;
}

/** Which level of the hierarchy the current page belongs to (M5.8; subagents in #344). */
export type NavLevel = "single" | "repo" | "member" | "subagent";

const TABS: Record<NavLevel, { path: string; label: string }[]> = {
  // Single-agent repos: the repo IS the agent — one merged row.
  single: [
    { path: "", label: "Overview" },
    { path: "/deployment", label: "Deployment" },
    { path: "/playground", label: "Playground" },
    { path: "/runs", label: "Runs" },
    { path: "/artifacts", label: "Artifacts" },
    { path: "/assistant", label: "Assistant" },
    { path: "/settings", label: "Settings" },
  ],
  // Team landing: the repo-wide surfaces. Assistant is project-level (one per repo), so it lives
  // here at the repo level for teams, NOT on each member.
  // Artifacts is project-level like Assistant: session-less (background-run) publishes have no
  // conversation card, so this tab is the ONLY discoverable surface for them (#370).
  repo: [
    { path: "", label: "Agents" },
    { path: "/deployment", label: "Deployment" },
    { path: "/artifacts", label: "Artifacts" },
    { path: "/assistant", label: "Assistant" },
    { path: "/settings", label: "Settings" },
  ],
  // One team member: the member-scoped surfaces (+ the switcher). No Assistant tab — it is a
  // project-level surface at the repo level, not per member.
  member: [
    { path: "", label: "Overview" },
    { path: "/deployment", label: "Deployment" },
    { path: "/playground", label: "Playground" },
    { path: "/runs", label: "Runs" },
    { path: "/settings", label: "Settings" },
  ],
  // One declared subagent (issue #344): it is configured here but it does not deploy, chat or
  // run on its own — it runs inside its member. Only the two surfaces that mean something at
  // this depth exist, so no tab leads to a dead end.
  subagent: [
    { path: "", label: "Overview" },
    { path: "/settings", label: "Settings" },
  ],
};

/**
 * Section tabs for one hierarchy level. `base` is `/repos/<id>` (single/repo levels) or
 * `/repos/<id>/agents/<name>` (member level). The tab SET differs per level — that is the
 * point: a tab row never changes meaning underneath you (M5.8).
 */
export function AgentNav({
  base,
  level,
  roster,
  activeAgent,
  className,
}: {
  base: string;
  level: NavLevel;
  /** Member level: the roster for the switcher. */
  roster?: RosterMember[];
  /** Member level: the current member (switcher value). */
  activeAgent?: string;
  /** Override spacing (chat pages sit the scroll region flush under the separator). */
  className?: string;
}) {
  return (
    <div className={cn("mb-8", className)}>
      {/* Stack on mobile so the tab nav gets the full viewport width; single row at sm+.
          On mobile the action controls sit ABOVE the tabs (tabs read best directly over the
          separator) and the controls group is allowed to wrap. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {/* Tabs scroll horizontally on narrow screens rather than wrapping/overflowing.
            Negative margin + padding lets the row bleed to the container edge. The relative
            wrapper + mobile-only right-edge gradient hints that more tabs scroll into view. */}
        <div className="relative order-2 min-w-0 sm:order-1">
          <nav className="-mx-4 flex items-center gap-1 overflow-x-auto px-4 text-sm [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:mx-0 sm:px-0">
            {TABS[level].map((item) => (
              <NavLink
                key={item.label}
                to={`${base}${item.path}`}
                end={item.path === ""}
                prefetch="intent"
                className={({ isActive, isPending }) =>
                  cn(
                    "shrink-0 rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground",
                    isActive && "bg-accent font-medium text-foreground",
                    // Highlight the destination tab immediately on click (before its loader resolves).
                    isPending && "bg-accent/60 font-medium text-foreground",
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          {/* Discoverability hint only — full-width scroll already guarantees reachability.
              pointer-events-none so it never blocks tapping the last (Settings) tab. */}
          <div className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-background to-transparent sm:hidden" />
        </div>
        <div className="order-1 flex shrink-0 flex-wrap items-center gap-3 sm:order-2">
          {(level === "member" || level === "subagent") &&
            roster &&
            activeAgent && (
              <AgentSwitcher roster={roster} activeAgent={activeAgent} />
            )}
        </div>
      </div>
      <Separator className="mt-2" />
    </div>
  );
}

/**
 * Team member picker: swaps the `/agents/<name>` segment, keeping the current tab.
 *
 * A nested subagent context (`…/sub/researcher`) is dropped on the way: the chosen member has
 * its own subagents, and carrying this one's path across would land on a 404 (issue #344). The
 * editor's `?path=` goes with it for the same reason — it names a file inside the agent root you
 * are leaving — while every other search param (tab state, filters) is kept.
 */
export function switchAgentHref(
  location: { pathname: string; search: string },
  name: string,
): string {
  const pathname = location.pathname
    .replace(/\/sub\/[^/]+/, "")
    .replace(/\/agents\/[^/]+/, `/agents/${encodeURIComponent(name)}`);
  const params = new URLSearchParams(location.search);
  // `path` names a file inside the agent root being left — it cannot survive the switch.
  params.delete("path");
  const search = params.toString();
  return `${pathname}${search ? `?${search}` : ""}`;
}

function AgentSwitcher({
  roster,
  activeAgent,
}: {
  roster: RosterMember[];
  activeAgent: string;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <div className="flex items-center gap-2">
      <Users className="h-4 w-4 text-muted-foreground" aria-hidden />
      <Select
        value={activeAgent}
        onValueChange={(name) => navigate(switchAgentHref(location, name))}
      >
        <SelectTrigger className="h-8 min-w-36 font-mono text-xs" aria-label="Agent">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {roster.map((m) => (
            <SelectItem key={m.name} value={m.name} className="font-mono text-xs">
              {m.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
