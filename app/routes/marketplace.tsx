/**
 * Recruit — the marketplace catalog (PRD §7.8, Milestone 6 phase 1).
 *
 * The browse surface: the pitch, type filter tabs with counts, and a card per template linking
 * to its detail page. It lists from the catalog's `index.json` only (never file bodies) via the
 * CatalogSource seam — fixture-backed in dev, the eve OSS repo's `marketplace/` in production.
 *
 * The catalog is a remote/optional dependency, so an unreachable index is an expected state, not
 * a crash: the loader catches it and the page renders a friendly empty-state explaining the
 * EDEN_CATALOG_REPO pointer and the fixture fallback.
 */
import { sessionLoader } from "~/auth/session.server";
import {
  Bot,
  CircleCheck,
  Hash,
  Package,
  Plug,
  Sparkles,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { Link, type LoaderFunctionArgs } from "react-router";

import { AppShell, PageHeader } from "~/components/shell";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { TEMPLATE_TYPES, type TemplateType } from "~/marketplace/manifest";
import { getRuntime } from "~/seams/index.server";
import {
  ensureWorkspace,
  requireBackOfHouse,
  resolveActiveWorkspace,
} from "~/auth/workspace.server";
import { listProjects } from "~/db/queries.server";
import { getAgentSource } from "~/github/cached.server";
import { listDrafts } from "~/drafts/drafts.server";
import { overlayLock, installedKeys } from "~/marketplace/lock";
import { noindexMeta } from "~/lib/seo";
import type { Route } from "./+types/marketplace";

/**
 * Per-type presentation: a distinct icon + accent colour so a card's kind is scannable at a
 * glance (not just readable), and singular/plural labels for the badge vs the filter tabs and
 * grouped-section headers. `accent` styles the badge chip; `dot` is the solid swatch.
 */
interface TypeMeta {
  label: string;
  plural: string;
  icon: LucideIcon;
  accent: string;
  dot: string;
}
/**
 * Presentation order for the filter tabs and grouped "All" sections — a product ordering (most
 * recruited first), distinct from `TEMPLATE_TYPES` (which is the manifest/registry order). Any
 * type absent here would just be dropped from the UI, so it lists all of them.
 */
const DISPLAY_ORDER: TemplateType[] = [
  "agent",
  "bundle",
  "skill",
  "channel",
  "tool",
  "subagent",
  "connection",
];

const TYPE_META: Record<TemplateType, TypeMeta> = {
  agent: {
    label: "Agent",
    plural: "Agents",
    icon: Bot,
    accent: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
    dot: "bg-violet-500",
  },
  bundle: {
    label: "Bundle",
    plural: "Bundles",
    icon: Package,
    accent: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
    dot: "bg-rose-500",
  },
  tool: {
    label: "Tool",
    plural: "Tools",
    icon: Wrench,
    accent: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
    dot: "bg-blue-500",
  },
  skill: {
    label: "Skill",
    plural: "Skills",
    icon: Sparkles,
    accent: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    dot: "bg-amber-500",
  },
  subagent: {
    label: "Subagent",
    plural: "Subagents",
    icon: Workflow,
    accent: "bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400",
    dot: "bg-fuchsia-500",
  },
  channel: {
    label: "Channel",
    plural: "Channels",
    icon: Hash,
    accent: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    dot: "bg-emerald-500",
  },
  connection: {
    label: "Connection",
    plural: "Connections",
    icon: Plug,
    accent: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
    dot: "bg-cyan-500",
  },
};

/**
 * The set of installed "type/id" keys for the marketplace "Installed" facet. The browse listing
 * has NO project/target context, so the scope is the UNION across ALL of the org's connected
 * projects (any member): a template counts as installed if it appears in any project's effective
 * `eden-lock.json`. Each project's fetch is wrapped in its own try/catch so one unreachable repo
 * degrades to "nothing installed there" rather than breaking the browse page — the same ethos as
 * the loader treating an unreachable catalog as an expected empty-state.
 */
async function collectInstalledKeys(
  org: { id: string } | null | undefined,
): Promise<string[]> {
  if (!org) return [];
  const projects = (await listProjects(org.id)).filter(
    (p) => p.repoInstallationId && p.repoOwner && p.repoName,
  );
  const perProject = await Promise.all(
    projects.map(async (p) => {
      try {
        const repo = { owner: p.repoOwner!, repo: p.repoName! };
        const [source, drafts] = await Promise.all([
          getAgentSource(p.repoInstallationId!, repo),
          listDrafts(p.id),
        ]);
        const lock = overlayLock(
          source.files["eden-lock.json"] ?? null,
          drafts.map((d) => ({ path: d.path, content: d.content })),
        );
        return installedKeys(lock);
      } catch {
        return [];
      }
    }),
  );
  return [...new Set(perProject.flat())];
}

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }) => {
      await ensureWorkspace(args.request, auth);
      const active = await resolveActiveWorkspace(auth);
      // Back of house is admin/owner-only (D10); front-of-house members live at `/`.
      if (active) requireBackOfHouse(active, "page");
      const org = active?.org;
      // Installed keys are catalog-independent, so both return branches carry them.
      const installed = await collectInstalledKeys(org);
      try {
        const index = await getRuntime().catalog.index();
        return {
          org,
          templates: index.templates,
          installed,
          catalogError: null as string | null,
        };
      } catch (error) {
        // Unreachable catalog is an expected state — render an empty-state, don't 500.
        return {
          org,
          templates: [],
          installed,
          catalogError: (error as Error).message,
        };
      }
    },
    { ensureSignedIn: true },
  );

export function meta() {
  return [{ title: "Marketplace · harnesst" }, ...noindexMeta];
}

export default function Marketplace({ loaderData }: Route.ComponentProps) {
  const { user, templates, installed, catalogError } = loaderData;
  const [filter, setFilter] = useState<TemplateType | "all" | "installed">(
    "all",
  );

  const counts = TEMPLATE_TYPES.reduce(
    (acc, t) => {
      acc[t] = templates.filter((tpl) => tpl.type === t).length;
      return acc;
    },
    {} as Record<TemplateType, number>,
  );
  const installedSet = new Set(installed);
  const isInstalled = (tpl: { type: TemplateType; id: string }) =>
    installedSet.has(`${tpl.type}/${tpl.id}`);
  const installedCount = templates.filter(isInstalled).length;
  const shown =
    filter === "all"
      ? templates
      : filter === "installed"
        ? templates.filter(isInstalled)
        : templates.filter((t) => t.type === filter);

  return (
    <AppShell userEmail={user.email}>
      <PageHeader
        title="Marketplace"
        description="Recruit pre-built tools, skills, and agents — instantiate an expert-authored template instead of writing one from scratch."
      />

      {catalogError ? (
        <Card className="border-dashed">
          <CardHeader className="items-center py-12 text-center">
            <CardTitle className="text-lg">Catalog unavailable</CardTitle>
            <CardDescription className="max-w-lg">
              harnesst couldn&rsquo;t reach the template catalog. In development it
              reads the in-repo <span className="font-mono">marketplace/</span>{" "}
              seed; in production set{" "}
              <span className="font-mono">EDEN_CATALOG_REPO</span> to an
              &ldquo;owner/repo&rdquo; pointer at the catalog.
            </CardDescription>
            <p className="mt-3 max-w-lg font-mono text-xs text-muted-foreground">
              {catalogError}
            </p>
          </CardHeader>
        </Card>
      ) : (
        <>
          <div className="mb-6 flex flex-wrap items-center gap-1 text-sm">
            <FilterTab
              label="All"
              count={templates.length}
              active={filter === "all"}
              onClick={() => setFilter("all")}
            />
            {/* Positive "show me what's installed" facet — mutually exclusive with the type tabs. */}
            <FilterTab
              label="Installed"
              icon={CircleCheck}
              count={installedCount}
              active={filter === "installed"}
              onClick={() => setFilter("installed")}
            />
            {DISPLAY_ORDER.map((t) => (
              <FilterTab
                key={t}
                label={TYPE_META[t].plural}
                dot={TYPE_META[t].dot}
                count={counts[t]}
                active={filter === t}
                onClick={() => setFilter(t)}
              />
            ))}
          </div>

          {shown.length === 0 ? (
            <Card className="border-dashed">
              <CardHeader className="items-center py-12 text-center">
                <CardTitle className="text-lg">Nothing here yet</CardTitle>
                <CardDescription>
                  No templates in this category. Check back as the catalog
                  grows.
                </CardDescription>
              </CardHeader>
            </Card>
          ) : filter === "all" ? (
            // "All" groups by type so the catalog reads as sections, not one undifferentiated
            // wall of cards. A single filtered type stays a flat grid (the header'd be noise).
            <div className="space-y-8">
              {DISPLAY_ORDER.filter((t) => counts[t] > 0).map((t) => {
                const meta = TYPE_META[t];
                const Icon = meta.icon;
                return (
                  <section key={t}>
                    <div className="mb-3 flex items-center gap-2">
                      <span
                        className={`flex size-6 items-center justify-center rounded-md ${meta.accent}`}
                      >
                        <Icon className="size-3.5" />
                      </span>
                      <h2 className="text-sm font-medium">{meta.plural}</h2>
                      <span className="text-xs text-muted-foreground">
                        {counts[t]}
                      </span>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                      {templates
                        .filter((tpl) => tpl.type === t)
                        .map((tpl) => (
                          <TemplateCard
                            key={`${tpl.type}/${tpl.id}`}
                            tpl={tpl}
                            installed={isInstalled(tpl)}
                          />
                        ))}
                    </div>
                  </section>
                );
              })}
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {shown.map((tpl) => (
                <TemplateCard
                  key={`${tpl.type}/${tpl.id}`}
                  tpl={tpl}
                  installed={isInstalled(tpl)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </AppShell>
  );
}

function FilterTab({
  label,
  count,
  active,
  onClick,
  dot,
  icon: Icon,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  /** Type accent swatch; omitted for the "All" tab. */
  dot?: string;
  /** Leading icon (in place of `dot`) — e.g. the "Installed" facet's check. */
  icon?: LucideIcon;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground " +
        (active ? "bg-accent font-medium text-foreground" : "")
      }
    >
      {Icon ? (
        <Icon className="size-3.5" />
      ) : (
        dot && <span className={`size-1.5 rounded-full ${dot}`} />
      )}
      {label}
      <span className="text-xs text-muted-foreground">{count}</span>
    </button>
  );
}

/** A coloured icon + label chip marking a template's type. */
function TypeBadge({ type }: { type: TemplateType }) {
  const meta = TYPE_META[type];
  const Icon = meta.icon;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${meta.accent}`}
    >
      <Icon className="size-3" />
      {meta.label}
    </span>
  );
}

/** One catalog entry as a card, linking to its detail page. */
function TemplateCard({
  tpl,
  installed,
}: {
  tpl: Route.ComponentProps["loaderData"]["templates"][number];
  installed?: boolean;
}) {
  return (
    <Link
      to={`/marketplace/${tpl.type}/${tpl.id}`}
      prefetch="intent"
      className="group"
    >
      <Card className="h-full transition-colors group-hover:border-ring/60">
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="truncate text-base">{tpl.name}</CardTitle>
            <TypeBadge type={tpl.type} />
          </div>
          <CardDescription className="line-clamp-2">
            {tpl.description}
          </CardDescription>
          <div className="mt-1 flex items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground">
              v{tpl.version}
            </span>
            {installed && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                <CircleCheck className="size-3" />
                Installed
              </span>
            )}
          </div>
        </CardHeader>
      </Card>
    </Link>
  );
}
