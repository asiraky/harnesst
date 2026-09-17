/**
 * Workspace settings tabs. Everything that is "a setting of the workspace" — spend and
 * safety, who's in it, which model providers it can use, what happened — lives under one
 * `/settings` roof with one tab row, reached from the sidebar's gear on either surface.
 */
import { NavLink } from "react-router";

import { PageHeader } from "~/components/shell";
import { Separator } from "~/components/ui/separator";
import { cn } from "~/lib/utils";

export type SettingsSection = "general" | "members" | "connections" | "audit";

export const SETTINGS_TABS: { section: SettingsSection; path: string; label: string }[] = [
  { section: "general", path: "/settings", label: "General" },
  { section: "members", path: "/settings/members", label: "Members" },
  { section: "connections", path: "/settings/connections", label: "Connections" },
  { section: "audit", path: "/settings/audit", label: "Audit" },
];

/** Which settings tab a pathname belongs to; `general` for the index and anything unknown. */
export function settingsSection(pathname: string): SettingsSection {
  const match = SETTINGS_TABS.find(
    (tab) => tab.path !== "/settings" && pathname.startsWith(tab.path),
  );
  return match?.section ?? "general";
}

export function SettingsHeader({ description }: { description?: React.ReactNode }) {
  return (
    <>
      <PageHeader title="Settings" description={description} />
      <div className="relative -mt-4 mb-8">
        <nav
          aria-label="Settings sections"
          className="-mx-4 flex items-center gap-1 overflow-x-auto px-4 text-sm [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:mx-0 sm:px-0"
        >
          {SETTINGS_TABS.map((tab) => (
            <NavLink
              key={tab.section}
              to={tab.path}
              end={tab.path === "/settings"}
              prefetch="intent"
              className={({ isActive, isPending }) =>
                cn(
                  "shrink-0 rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground",
                  isActive && "bg-accent font-medium text-foreground",
                  isPending && "bg-accent/60 font-medium text-foreground",
                )
              }
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>
        <Separator className="mt-2" />
      </div>
    </>
  );
}
