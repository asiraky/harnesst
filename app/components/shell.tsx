/**
 * Shared application chrome, encoding the product hierarchy (D2/D3 + the eve model, M5.8):
 *   workspace (org) → repository → team member (agents/:name URL level) → page.
 *
 * AppShell renders the workspace-level header. AgentNav renders the section tabs — a
 * DIFFERENT set per level, because the scopes differ: repo level (team landing) gets the
 * repo-wide surfaces, member level gets the member-scoped ones, and single-agent repos
 * collapse both levels into one merged row.
 */
import {
  Building2,
  Check,
  ChevronsUpDown,
  LogOut,
  Menu,
  User,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useEffect } from "react";
import {
  Form,
  Link,
  NavLink,
  useFetcher,
  useLocation,
  useNavigate,
  useNavigation,
} from "react-router";

import { InviteMember } from "~/components/invite-member";
import { QuickDeploy } from "~/components/quick-deploy";
import { WorkspaceTasksIndicator } from "~/components/workspace-tasks";
import { BrandWordmark } from "~/components/marketing/logo";
import { ThemeToggle } from "~/components/theme-toggle";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Separator } from "~/components/ui/separator";
import { TooltipProvider } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

/** One level of the hierarchy trail. No `to` == the current page (rendered unlinked). */
export interface Crumb {
  label: React.ReactNode;
  to?: string;
}

/**
 * Standard trail for repository pages: repo → (team member) → page. The last crumb is
 * always unlinked (it's where you are); every ancestor links up a level.
 */
export function repoCrumbs(opts: {
  projectId: string;
  repoName: string;
  /** Team repos: the active member (adds a member crumb linking to its overview). */
  agentName?: string | null;
  isTeam?: boolean;
  /** Page-level crumbs after repo/member, e.g. [{ label: "Runs" }]. */
  tail?: Crumb[];
}): Crumb[] {
  const base = `/repos/${opts.projectId}`;
  const crumbs: Crumb[] = [{ label: opts.repoName, to: base }];
  if (opts.isTeam && opts.agentName) {
    crumbs.push({
      label: opts.agentName,
      to: `${base}/agents/${encodeURIComponent(opts.agentName)}`,
    });
  }
  crumbs.push(...(opts.tail ?? []));
  const last = crumbs[crumbs.length - 1];
  delete last.to;
  return crumbs;
}

export function AppShell({
  userEmail,
  breadcrumbs,
  fullHeight,
  children,
}: {
  userEmail?: string | null;
  /** Hierarchy trail: workspace → repo → member → …; the "up" navigation. */
  breadcrumbs?: Crumb[];
  /** Chat-style pages: lock the shell to the viewport so children own their scrolling
   * (e.g. a transcript scrolls while the composer stays pinned below it). */
  fullHeight?: boolean;
  children: React.ReactNode;
}) {
  return (
    <TooltipProvider>
    <div className={fullHeight ? "flex h-dvh flex-col overflow-hidden" : "min-h-screen"}>
      <NavProgress />
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-2 px-4 sm:gap-4 sm:px-6">
          <Link
            to="/dashboard"
            className="flex shrink-0 items-center"
            aria-label="harnesst dashboard"
          >
            <BrandWordmark className="h-5" />
          </Link>
          {breadcrumbs && breadcrumbs.length > 0 && (
            <Breadcrumbs crumbs={breadcrumbs} />
          )}
          {/* Desktop: inline primary nav. Mobile: folds into the menu button below. */}
          <nav className="ml-auto hidden items-center gap-1 text-sm md:flex">
            {/* House switcher (FOH D18): back into the operate surface at the app root. */}
            <HeaderLink to="/">Front of house</HeaderLink>
            <HeaderLink to="/dashboard">Repositories</HeaderLink>
            <HeaderLink to="/marketplace">Marketplace</HeaderLink>
            <HeaderLink to="/org/members">Members</HeaderLink>
            <HeaderLink to="/org/settings">Settings</HeaderLink>
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-1 md:ml-0">
            {userEmail && <WorkspaceMenu />}
            <ThemeToggle />
            <AccountMenu userEmail={userEmail} />
            <MobileNav />
          </div>
        </div>
        {/* Persistent workspace task-progress strip (issue #142): a slim row below the header,
            project-scoped, that survives navigation within a workspace. Renders nothing off a
            /repos/:id page or with no tasks. */}
        <WorkspaceTasksIndicator />
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
    </TooltipProvider>
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
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
      {crumbs.map((crumb) => (
        <span key={crumbKey(crumb)} className="flex min-w-0 items-center gap-1.5">
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
    <div className="mb-3 flex items-center justify-between gap-3 border-b pb-2">
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
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Account dropdown behind a user icon: shows who's signed in, and Sign out. */
function AccountMenu({ userEmail }: { userEmail?: string | null }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Account">
          <User className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {userEmail && (
          <>
            <DropdownMenuLabel className="font-normal">
              <span className="block text-xs text-muted-foreground">
                Signed in as
              </span>
              <span className="block truncate text-sm font-medium">
                {userEmail}
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
          </>
        )}
        <Form method="post" action="/dashboard">
          <input type="hidden" name="intent" value="sign-out" />
          <DropdownMenuItem asChild>
            <button type="submit" className="w-full cursor-pointer">
              <LogOut className="mr-2 h-4 w-4" />
              Sign out
            </button>
          </DropdownMenuItem>
        </Form>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Workspace switcher in the header (issue #56). Self-fetches the user's workspaces from
 * `/api/workspaces` (same pattern as StagedChangesPill) so it appears on every authed page
 * without threading data through each loader. Hard requirement: a user in ≤1 workspace sees
 * NOTHING — the switcher only exists for people who actually belong to several. Each item is a
 * real `<Form>` POST to `/workspaces` (not a fetcher) so switching does a full document
 * navigation: the org changes underneath, and every loader's data would otherwise be stale.
 */
interface WorkspaceInfo {
  id: string;
  name: string;
}
function WorkspaceMenu() {
  const fetcher = useFetcher<{
    currentOrgId: string | null;
    currentName: string | null;
    workspaces: WorkspaceInfo[];
  }>();
  const { load } = fetcher;
  useEffect(() => {
    load("/api/workspaces");
  }, [load]);

  const data = fetcher.data;
  // While loading, or for single-workspace users, render nothing at all.
  if (!data || data.workspaces.length <= 1) return null;

  const currentName =
    data.currentName ??
    data.workspaces.find((w) => w.id === data.currentOrgId)?.name ??
    "Workspace";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="hidden max-w-40 items-center gap-1.5 sm:flex"
          aria-label="Switch workspace"
        >
          <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">{currentName}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          Switch workspace
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {data.workspaces.map((ws) => {
          const isCurrent = ws.id === data.currentOrgId;
          return (
            <Form method="post" action="/workspaces" key={ws.id}>
              <input type="hidden" name="orgId" value={ws.id} />
              <input type="hidden" name="returnTo" value="/dashboard" />
              <DropdownMenuItem asChild>
                <button type="submit" className="w-full cursor-pointer" disabled={isCurrent}>
                  <Check
                    className={cn("mr-2 h-4 w-4", isCurrent ? "opacity-100" : "opacity-0")}
                    aria-hidden
                  />
                  <span className="truncate">{ws.name}</span>
                </button>
              </DropdownMenuItem>
            </Form>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Primary nav folded behind a menu button on small screens (< md). */
function MobileNav() {
  return (
    <div className="md:hidden">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Menu">
            <Menu className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem asChild>
            <Link to="/">Front of house</Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/dashboard">Repositories</Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/marketplace">Marketplace</Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/org/members">Members</Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/org/settings">Settings</Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function HeaderLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      prefetch="intent"
      className={({ isActive, isPending }) =>
        cn(
          "rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground",
          isActive && "bg-accent text-foreground",
          // Register the click within a frame, before the destination loader resolves.
          isPending && "bg-accent/60 text-foreground",
        )
      }
    >
      {children}
    </NavLink>
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
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Minimal roster info the switcher needs (serializable through loaders). */
export interface RosterMember {
  name: string;
}

/** Which level of the hierarchy the current page belongs to (M5.8). */
export type NavLevel = "single" | "repo" | "member";

const TABS: Record<NavLevel, { path: string; label: string }[]> = {
  // Single-agent repos: the repo IS the agent — one merged row.
  single: [
    { path: "", label: "Overview" },
    { path: "/deployment", label: "Deployment" },
    { path: "/playground", label: "Playground" },
    { path: "/runs", label: "Runs" },
    { path: "/assistant", label: "Assistant" },
    { path: "/settings", label: "Settings" },
  ],
  // Team landing: the repo-wide surfaces. Assistant is project-level (one per repo), so it lives
  // here at the repo level for teams, NOT on each member.
  repo: [
    { path: "", label: "Overview" },
    { path: "/deployment", label: "Deployment" },
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
          <QuickDeploy base={base} />
          <StagedChangesPill base={base} />
          {/* Invite-to-repo (FOH): repo-scoped, so it sits at the repo/single level only. */}
          {(level === "single" || level === "repo") && (
            <InviteMember base={base} />
          )}
          {level === "member" && roster && activeAgent && (
            <AgentSwitcher roster={roster} activeAgent={activeAgent} />
          )}
        </div>
      </div>
      <Separator className="mt-2" />
    </div>
  );
}

/**
 * Always-visible staged-work indicator (sits in the tab row, so it survives tab switches):
 * "N staged changes" for the CURRENT scope — a member's own drafts (+ shared) at the member
 * level, the whole repo at the repo/single level — linking to that scope's Deployment tab.
 * Self-fetching from the staged-count resource route so every page gets it without
 * threading a count through each loader; fetcher data revalidates after actions, which is
 * what keeps it live as changes stage and publish.
 */
function StagedChangesPill({ base }: { base: string }) {
  const fetcher = useFetcher<{ count: number }>();
  const match = base.match(/^\/repos\/([^/]+)(?:\/agents\/([^/]+))?$/);
  const url = match
    ? `/repos/${match[1]}/staged-count${match[2] ? `?agent=${match[2]}` : ""}`
    : null;
  const { load } = fetcher;
  useEffect(() => {
    if (url) load(url);
  }, [url, load]);
  const count = fetcher.data?.count ?? 0;
  if (count === 0) return null;
  return (
    <Link
      to={`${base}/deployment`}
      prefetch="intent"
      className="flex items-center gap-1.5 whitespace-nowrap rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-500/20 dark:text-amber-400"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden />
      {count} staged {count === 1 ? "change" : "changes"}
    </Link>
  );
}

/** Team member picker: swaps the `/agents/<name>` segment, keeping the current tab. */
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
        onValueChange={(name) => {
          const pathname = location.pathname.replace(
            /\/agents\/[^/]+/,
            `/agents/${encodeURIComponent(name)}`,
          );
          navigate(`${pathname}${location.search}`);
        }}
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
