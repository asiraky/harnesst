/**
 * Workspace settings sections. Everything that is "a setting of the workspace" — spend and
 * safety, who's in it, which model providers it can use, what happened — lives under one
 * `/settings` roof. The sections are the sidebar's entries while you're in Settings
 * (components/app-sidebar.tsx); each page only carries its own title.
 */
import { KeyRound, ScrollText, SlidersHorizontal, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { PageHeader } from "~/components/shell";

export type SettingsSection = "general" | "members" | "connections" | "audit";

export const SETTINGS_TABS: {
  section: SettingsSection;
  path: string;
  label: string;
  icon: LucideIcon;
}[] = [
  { section: "general", path: "/settings", label: "General", icon: SlidersHorizontal },
  { section: "members", path: "/settings/members", label: "Members", icon: Users },
  { section: "connections", path: "/settings/connections", label: "Connections", icon: KeyRound },
  { section: "audit", path: "/settings/audit", label: "Audit", icon: ScrollText },
];

/** Which settings section a pathname belongs to; `general` for the index and anything unknown. */
export function settingsSection(pathname: string): SettingsSection {
  const match = SETTINGS_TABS.find(
    (tab) => tab.path !== "/settings" && pathname.startsWith(tab.path),
  );
  return match?.section ?? "general";
}

export function SettingsHeader({
  section,
  description,
}: {
  section: SettingsSection;
  description?: React.ReactNode;
}) {
  const tab = SETTINGS_TABS.find((t) => t.section === section) ?? SETTINGS_TABS[0];
  return (
    <PageHeader
      eyebrow="Settings"
      title={tab.label}
      description={description}
    />
  );
}
