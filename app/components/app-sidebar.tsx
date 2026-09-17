/**
 * The one sidebar skeleton both surfaces share. Chat and Build show different things in the
 * middle (teams → agents vs. repositories → agents) but the frame never changes:
 *
 *   header — wordmark, then the Chat | Build toggle and the workspace Settings gear
 *   body   — whatever the surface lists (passed as children)
 *   footer — the account menu (workspace switcher, theme, sign out)
 *
 * The exits are therefore in the same place on every page. The toggle and the gear are
 * simply absent for people who can't use them (read-only members never see Build; only
 * workspace admins reach Settings) — the frame is otherwise identical for everyone.
 */
import {
  Building2,
  Check,
  ChevronsUpDown,
  LogOut,
  Plus,
  Settings,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Form, Link, useFetcher, useLocation, useSubmit } from "react-router";

import { BrandWordmark } from "~/components/marketing/logo";
import { ThemeMenuSub } from "~/components/theme-toggle";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  SURFACE_LABEL,
  SURFACE_ROOT,
  counterpartHref,
  lastVisitedKey,
  type Surface,
  type SurfaceRepo,
} from "~/lib/surfaces";
import { cn } from "~/lib/utils";

export interface SidebarAccount {
  name: string | null;
  email: string | null;
  orgId: string;
  orgName: string;
}

export function AppSidebar({
  surface,
  repos,
  canToggle,
  canSettings,
  account,
  headerExtra,
  className,
  children,
}: {
  surface: Surface;
  /** Roster slice for the context-preserving toggle (`~/lib/surfaces`). */
  repos: SurfaceRepo[];
  /** May enter the other surface (Chat: holds `write` somewhere; Build: always). */
  canToggle: boolean;
  /** Workspace admin: show the Settings gear. */
  canSettings: boolean;
  account: SidebarAccount;
  /** Surface-specific control on the wordmark row (Chat's inbox bell). */
  headerExtra?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  useRememberSurface(surface, account.orgId);
  return (
    <aside
      className={cn("flex w-64 shrink-0 flex-col border-r bg-background", className)}
      aria-label={`${SURFACE_LABEL[surface]} sidebar`}
    >
      <div className="flex h-14 shrink-0 items-center border-b px-3">
        <Link
          to={SURFACE_ROOT[surface]}
          className="flex items-center"
          aria-label={`harnesst ${SURFACE_LABEL[surface].toLowerCase()} home`}
        >
          <BrandWordmark className="h-5" />
        </Link>
        <div className="ml-auto flex items-center gap-0.5">
          {headerExtra}
          {canSettings && (
            <Link
              to="/settings"
              prefetch="intent"
              aria-label="Workspace settings"
              title="Settings"
              className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              <Settings className="size-4" aria-hidden />
            </Link>
          )}
        </div>
      </div>
      {canToggle && (
        <div className="shrink-0 border-b px-3 py-2">
          <SurfaceToggle surface={surface} repos={repos} orgId={account.orgId} />
        </div>
      )}

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-3">{children}</nav>

      <div className="shrink-0 border-t p-2">
        <AccountMenu account={account} surface={surface} />
      </div>
    </aside>
  );
}

/**
 * Chat | Build segmented control. The other side's link is context-preserving: the mapped
 * counterpart of the current page when there is one, else the last page visited on that
 * surface (sessionStorage), else its root. Reading storage happens after hydration so the
 * server-rendered href (mapped ?? root) never mismatches.
 */
export function SurfaceToggle({
  surface,
  repos,
  orgId,
}: {
  surface: Surface;
  repos: SurfaceRepo[];
  orgId: string;
}) {
  const location = useLocation();
  const other: Surface = surface === "chat" ? "build" : "chat";
  const mapped = counterpartHref(surface, location.pathname, repos);
  const [remembered, setRemembered] = useState<string | null>(null);
  useEffect(() => {
    setRemembered(readLastVisited(other, orgId));
  }, [other, orgId, location.key]);
  const otherHref = mapped ?? remembered ?? SURFACE_ROOT[other];

  const segment =
    "flex flex-1 items-center justify-center rounded-md px-2 py-1 text-xs font-medium transition-colors";
  const segments: Surface[] = ["chat", "build"];
  return (
    <div
      role="group"
      aria-label="Surface"
      className="flex gap-0.5 rounded-lg bg-muted p-0.5"
    >
      {segments.map((s) =>
        s === surface ? (
          <span
            key={s}
            aria-current="page"
            className={cn(segment, "bg-background text-foreground shadow-sm")}
          >
            {SURFACE_LABEL[s]}
          </span>
        ) : (
          <Link
            key={s}
            to={otherHref}
            prefetch="intent"
            aria-label={`Switch to ${SURFACE_LABEL[s]}`}
            className={cn(segment, "text-muted-foreground hover:text-foreground")}
          >
            {SURFACE_LABEL[s]}
          </Link>
        ),
      )}
    </div>
  );
}

function readLastVisited(surface: Surface, orgId: string): string | null {
  try {
    return window.sessionStorage.getItem(lastVisitedKey(surface, orgId));
  } catch {
    return null;
  }
}

/** Remember the current URL as the last one visited on `surface` (the toggle's fallback). */
function useRememberSurface(surface: Surface, orgId: string) {
  const location = useLocation();
  useEffect(() => {
    try {
      window.sessionStorage.setItem(
        lastVisitedKey(surface, orgId),
        `${location.pathname}${location.search}`,
      );
    } catch {
      // Storage can be unavailable (private mode quotas); the toggle then falls back to root.
    }
  }, [surface, orgId, location.pathname, location.search]);
}

interface WorkspaceInfo {
  id: string;
  name: string;
}

/**
 * Bottom-left account control: who you are, which workspace you're in, and everything that
 * is about YOU rather than the product — switching workspace, theme, sign out. Opens upward.
 *
 * The workspace list self-fetches from `/api/workspaces` (the pattern the old header switcher
 * used) so no page loader has to thread it through. Each switch is a real `<Form>` POST —
 * a full document navigation — because the org changes underneath and every loader's data
 * would otherwise be stale.
 */
function AccountMenu({
  account,
  surface,
}: {
  account: SidebarAccount;
  surface: Surface;
}) {
  const submit = useSubmit();
  const display = account.name || account.email || "Account";
  const initial = display.charAt(0).toUpperCase();
  const workspaces = useFetcher<{
    currentOrgId: string | null;
    workspaces: WorkspaceInfo[];
  }>({ key: "workspaces" });
  const { load } = workspaces;
  useEffect(() => {
    if (!workspaces.data) load("/api/workspaces");
    // Load once per mount; a workspace switch is a document navigation and remounts anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md p-2 text-left transition-colors hover:bg-muted/60 data-[state=open]:bg-muted"
          aria-label="Account"
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
            {initial}
          </span>
          <span className="grid min-w-0 flex-1 leading-tight">
            <span className="truncate text-sm font-medium">{display}</span>
            <span className="truncate text-xs text-muted-foreground">
              {account.orgName}
            </span>
          </span>
          <ChevronsUpDown
            className="size-4 shrink-0 text-muted-foreground"
            aria-hidden
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={6}
        className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
      >
        <DropdownMenuLabel className="font-normal">
          <span className="grid leading-tight">
            <span className="truncate text-sm font-medium">{display}</span>
            {account.email && (
              <span className="truncate text-xs text-muted-foreground">
                {account.email}
              </span>
            )}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Building2 className="mr-2 h-4 w-4 text-muted-foreground" />
            <span className="truncate">Workspace</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuPortal>
            <DropdownMenuSubContent className="w-56">
              {(workspaces.data?.workspaces ?? []).map((ws) => {
                const isCurrent = ws.id === workspaces.data?.currentOrgId;
                return (
                  <Form method="post" action="/workspaces" key={ws.id}>
                    <input type="hidden" name="orgId" value={ws.id} />
                    <input
                      type="hidden"
                      name="returnTo"
                      value={SURFACE_ROOT[surface]}
                    />
                    <DropdownMenuItem asChild>
                      <button
                        type="submit"
                        className="w-full cursor-pointer"
                        disabled={isCurrent}
                      >
                        <Check
                          className={cn(
                            "mr-2 h-4 w-4",
                            isCurrent ? "opacity-100" : "opacity-0",
                          )}
                          aria-hidden
                        />
                        <span className="truncate">{ws.name}</span>
                      </button>
                    </DropdownMenuItem>
                  </Form>
                );
              })}
              {workspaces.data && workspaces.data.workspaces.length > 0 && (
                <DropdownMenuSeparator />
              )}
              <DropdownMenuItem asChild>
                <Link to="/workspaces" className="cursor-pointer">
                  <Plus className="mr-2 h-4 w-4" aria-hidden />
                  Create workspace
                </Link>
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuPortal>
        </DropdownMenuSub>
        <ThemeMenuSub />
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() =>
            submit(
              { intent: "sign-out" },
              { method: "post", action: "/dashboard" },
            )
          }
        >
          <LogOut className="mr-2 h-4 w-4 text-muted-foreground" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
