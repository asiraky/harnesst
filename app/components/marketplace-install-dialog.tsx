/**
 * "Add from marketplace" — install a catalog template from the agent or team page without the
 * browse → detail → Install → pick-a-target detour through /marketplace.
 *
 * The dialog searches the catalog and links each row into the install wizard with the repo and
 * target already chosen, so the next screen is the change-set preview, secrets and Save. The
 * wizard stays the one place an install is planned and staged; this only removes the navigation.
 *
 * On an agent (or subagent) page the target is that agent. On the team page the user picks a
 * member — or, for an agent template, adds it as a new member of the team.
 */
import { CircleCheck, Search, Store } from "lucide-react";
import { useState } from "react";
import { Link, useFetcher } from "react-router";

import {
  DISPLAY_ORDER,
  TYPE_META,
  TypeBadge,
} from "~/components/marketplace-type-badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { TEMPLATE_TYPES, type TemplateType } from "~/marketplace/manifest";
import { filterTemplates, installWizardHref } from "~/marketplace/targets";
import { cn } from "~/lib/utils";
import type {
  CatalogTemplate,
  MarketplacePickerData,
  MarketplaceTarget,
} from "~/routes/api.projects.$projectId.marketplace";

/** Everything but `agent` installs INTO an existing agent. */
const INTO_AGENT_TYPES = TEMPLATE_TYPES.filter((t) => t !== "agent");

function targetLabel(t: Pick<MarketplaceTarget, "member" | "subagentPath">) {
  return [t.member, ...t.subagentPath.split("/").filter(Boolean)].join(" › ");
}

export function MarketplaceInstallDialog({
  projectId,
  target,
  returnTo,
}: {
  projectId: string;
  /**
   * The wizard `?member=` value of the page's own agent — pinned, no picker. Null on the team page,
   * where the user picks a member (or adds an agent template as a new one).
   */
  target: string | null;
  /** The page to come back to from the wizard's back link. */
  returnTo: string;
}) {
  const fetcher = useFetcher<MarketplacePickerData>();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [type, setType] = useState<TemplateType | "all">("all");
  const [picked, setPicked] = useState<string | null>(null);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    // Fresh on every open: what's installed changes as the user installs things.
    if (next)
      fetcher.load(`/api/repos/${encodeURIComponent(projectId)}/marketplace`);
  };

  const data = fetcher.data;
  const targets = data?.targets ?? [];
  const pinned = target !== null;
  const chosenValue = pinned ? target : (picked ?? targets[0]?.value ?? null);
  const chosen = targets.find((t) => t.value === chosenValue) ?? null;
  // Agent templates become a new team member, so only the team page of a team repo offers them.
  const allowedTypes =
    !pinned && data?.isTeam ? [...TEMPLATE_TYPES] : INTO_AGENT_TYPES;

  const templates = data?.templates ?? [];
  const matching = filterTemplates(templates, {
    query,
    type: "all",
    allowedTypes,
  });
  const shown = filterTemplates(templates, { query, type, allowedTypes });
  const counts = new Map<TemplateType, number>();
  for (const t of matching) counts.set(t.type, (counts.get(t.type) ?? 0) + 1);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Store aria-hidden />
          Add from marketplace
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add from the marketplace</DialogTitle>
          <DialogDescription>
            {pinned && chosen
              ? `Installs into ${targetLabel(chosen)}. You review the files and secrets before anything is saved.`
              : "Pick where it goes, then review the files and secrets before anything is saved."}
          </DialogDescription>
        </DialogHeader>

        {!pinned && targets.length > 0 && (
          <TargetPicker
            targets={targets}
            value={chosenValue}
            onChange={setPicked}
          />
        )}

        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tools, skills, channels…"
            aria-label="Search the marketplace"
            className="pl-8"
            autoFocus
          />
        </div>

        <div className="-mx-1 flex flex-wrap items-center gap-1 text-xs">
          <FilterChip
            label="All"
            count={matching.length}
            active={type === "all"}
            onClick={() => setType("all")}
          />
          {DISPLAY_ORDER.filter((t) => counts.get(t)).map((t) => (
            <FilterChip
              key={t}
              label={TYPE_META[t].label}
              count={counts.get(t) ?? 0}
              active={type === t}
              onClick={() => setType(t)}
            />
          ))}
        </div>

        <div className="-mx-4 max-h-[55dvh] overflow-y-auto border-y px-4">
          <CatalogResults
            data={data}
            missingPinnedTarget={pinned && !!data && !chosen}
            shown={shown}
            projectId={projectId}
            target={chosen}
            returnTo={returnTo}
          />
        </div>

        <Link
          to="/marketplace"
          className="justify-self-start text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Browse the full marketplace →
        </Link>
      </DialogContent>
    </Dialog>
  );
}

function TargetPicker({
  targets,
  value,
  onChange,
}: {
  targets: MarketplaceTarget[];
  value: string | null;
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor="marketplace-target">Install into</Label>
      <Select value={value ?? undefined} onValueChange={onChange}>
        <SelectTrigger id="marketplace-target" className="w-full sm:max-w-sm">
          <SelectValue placeholder="Pick an agent" />
        </SelectTrigger>
        <SelectContent>
          {targets.map((t) => (
            <SelectItem key={t.value} value={t.value}>
              {targetLabel(t)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="py-8 text-center text-muted-foreground">{children}</p>;
}

function CatalogResults({
  data,
  missingPinnedTarget,
  shown,
  projectId,
  target,
  returnTo,
}: {
  data: MarketplacePickerData | undefined;
  missingPinnedTarget: boolean;
  shown: CatalogTemplate[];
  projectId: string;
  target: MarketplaceTarget | null;
  returnTo: string;
}) {
  const installed = new Set(target?.installed ?? []);
  if (!data) return <EmptyState>Loading the catalog…</EmptyState>;
  if (missingPinnedTarget) {
    // The wizard resolves targets from the published branch, so an agent that only exists as
    // saved changes has nowhere to install yet.
    return (
      <EmptyState>
        This agent isn&rsquo;t published yet. Publish it, then add templates to
        it.
      </EmptyState>
    );
  }
  if (data.catalogError) {
    return (
      <EmptyState>
        {data.catalogError} Try again later, or ask an operator to check{" "}
        <span className="font-mono">HARNESST_CATALOG_REPO</span>.
      </EmptyState>
    );
  }
  if (shown.length === 0) return <EmptyState>Nothing matches.</EmptyState>;
  return (
    <ul className="divide-y">
      {shown.map((tpl) => (
        <TemplateRow
          key={`${tpl.type}/${tpl.id}`}
          tpl={tpl}
          projectId={projectId}
          target={target}
          installed={
            tpl.type !== "agent" && installed.has(`${tpl.type}/${tpl.id}`)
          }
          returnTo={returnTo}
        />
      ))}
    </ul>
  );
}

function TemplateRow({
  tpl,
  projectId,
  target,
  installed,
  returnTo,
}: {
  tpl: CatalogTemplate;
  projectId: string;
  target: MarketplaceTarget | null;
  installed: boolean;
  returnTo: string;
}) {
  const asNewAgent = tpl.type === "agent";
  // No roster yet (a brand-new team): only an agent template has somewhere to go.
  const reachable = asNewAgent || target !== null;
  const href = installWizardHref({
    type: tpl.type,
    id: tpl.id,
    projectId,
    member: asNewAgent ? null : target?.value,
    returnTo,
  });
  return (
    <li className="flex items-start gap-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium [overflow-wrap:anywhere]">
            {tpl.name}
          </span>
          <TypeBadge type={tpl.type} />
          <span className="font-mono text-xs text-muted-foreground">
            v{tpl.version}
          </span>
          {installed && (
            <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
              <CircleCheck className="size-3" aria-hidden />
              Installed
            </span>
          )}
        </div>
        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
          {tpl.description}
        </p>
      </div>
      {reachable ? (
        <Button
          asChild
          size="sm"
          variant={installed ? "outline" : "default"}
          className="shrink-0"
        >
          <Link to={href}>
            {asNewAgent ? "Add as agent" : installed ? "Update" : "Install"}
          </Link>
        </Button>
      ) : (
        <Button size="sm" variant="outline" className="shrink-0" disabled>
          Add an agent first
        </Button>
      )}
    </li>
  );
}

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex items-center gap-1 rounded-md px-2 py-1 text-muted-foreground transition-colors hover:text-foreground",
        active && "bg-accent font-medium text-foreground",
      )}
    >
      {label}
      <span className="text-muted-foreground">{count}</span>
    </button>
  );
}
