import {
  Boxes,
  CalendarClock,
  Hash,
  Plug,
  Sparkles,
  Webhook,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import type { Accent } from "~/components/shell";

/**
 * Per-category signature glyph + accent — the single source of truth for how an agent's resource
 * kinds (tools, skills, subagents, channels, schedules, connections, hooks) are colour-coded across the
 * app, mirroring the marketplace's per-type colours so a kind is scannable at a glance. Consumed by
 * the agent surface (projects.$projectId), the category list page (…resources.$category), and the
 * "New …" dialog (new-resource-dialog).
 */
export const CATEGORY_META: Record<
  string,
  { icon: LucideIcon; accent: Accent }
> = {
  tools: { icon: Wrench, accent: "blue" },
  skills: { icon: Sparkles, accent: "amber" },
  subagents: { icon: Workflow, accent: "fuchsia" },
  channels: { icon: Hash, accent: "emerald" },
  schedules: { icon: CalendarClock, accent: "amber" },
  connections: { icon: Plug, accent: "cyan" },
  hooks: { icon: Webhook, accent: "violet" },
};

/** CATEGORY_META lookup with the neutral Resources fallback (Boxes/cyan) for unknown keys. */
export function categoryMeta(key: string): { icon: LucideIcon; accent: Accent } {
  return CATEGORY_META[key] ?? { icon: Boxes, accent: "cyan" };
}
