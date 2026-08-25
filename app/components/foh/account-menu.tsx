/**
 * FOH sidebar account menu — the single bottom-left control (issue #212 §2). Collapses the
 * loose stack (new repository, surface switcher, email, theme, sign-out) into one trigger
 * that opens upward, shadcn nav-user style. The build-surface link is labeled "Repositories"
 * (what /dashboard actually presents as) — "back of house" is internal jargon and must not
 * ship in the UI.
 */
import {
  Building2,
  ChevronsUpDown,
  FolderGit2,
  LogOut,
  Plus,
  Users,
} from "lucide-react";
import { Link, useSubmit } from "react-router";

import { ThemeMenuSub } from "~/components/theme-toggle";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";

export function AccountMenu({
  name,
  email,
  orgName,
  backOfHouse,
  workspaceAdmin,
}: {
  name: string | null;
  email: string | null;
  orgName: string;
  /** Holds `write` on at least one repo (or is a workspace admin): show the build surface. */
  backOfHouse: boolean;
  /** Workspace owner/admin: may create repos and manage members. */
  workspaceAdmin: boolean;
}) {
  const submit = useSubmit();
  const display = name || email || "Account";
  const initial = display.charAt(0).toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md p-2 text-left transition-colors hover:bg-muted/60 data-[state=open]:bg-muted"
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
            {initial}
          </span>
          <span className="grid min-w-0 flex-1 leading-tight">
            <span className="truncate text-sm font-medium">{display}</span>
            <span className="truncate text-xs text-muted-foreground">
              {orgName}
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
            {email && (
              <span className="truncate text-xs text-muted-foreground">
                {email}
              </span>
            )}
          </span>
        </DropdownMenuLabel>
        {(backOfHouse || workspaceAdmin) && <DropdownMenuSeparator />}
        {workspaceAdmin && (
          <DropdownMenuItem asChild>
            <Link to="/connect">
              <Plus className="mr-2 h-4 w-4 text-muted-foreground" />
              New repository
            </Link>
          </DropdownMenuItem>
        )}
        {backOfHouse && (
          <DropdownMenuItem asChild>
            {/* D18: the switcher into the build surface. */}
            <Link to="/dashboard">
              <FolderGit2 className="mr-2 h-4 w-4 text-muted-foreground" />
              Repositories
            </Link>
          </DropdownMenuItem>
        )}
        {workspaceAdmin && (
          <DropdownMenuItem asChild>
            <Link to="/org/members">
              <Users className="mr-2 h-4 w-4 text-muted-foreground" />
              Members &amp; access
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/workspaces">
            <Building2 className="mr-2 h-4 w-4 text-muted-foreground" />
            Switch workspace
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
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
