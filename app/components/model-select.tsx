/**
 * Searchable picker over the active workspace's connected-provider model union.
 *
 * Values are always connection-qualified. There is intentionally no free-text escape hatch:
 * saving an unconnected model would leave deployments without the credential that can run it.
 */
import { Check, Gauge, Plug, TriangleAlert } from "lucide-react";
import * as React from "react";
import { useEffect, useMemo, useState } from "react";
import { Link, useFetcher } from "react-router";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import { filterModels, limitModelsPerConnection } from "~/models/filter";
import type { ModelCatalogEntry } from "~/models/catalog.server";
import type { ReasoningEffort } from "~/models/reasoning";
import { cn } from "~/lib/utils";

const MAX_ROWS_PER_CONNECTION = 50;

export interface UnavailableModelConnection {
  connectionId: string;
  provider: string;
  connectionLabel: string;
  message: string;
}

/** A model and its optional explicit effort, kept together across every settings surface. */
export interface ModelSelectionValue {
  model: string | null;
  effort: ReasoningEffort | null;
}

export function ModelSelection({
  model,
  effort,
  busy,
  disabled,
  placeholder,
  triggerClassName,
  effortTriggerClassName,
  compact = false,
  onCommit,
}: ModelSelectionValue & {
  busy: boolean;
  disabled?: boolean;
  placeholder?: string;
  triggerClassName?: string;
  /** Override for the reasoning-effort trigger (compact toolbars vs. settings forms). */
  effortTriggerClassName?: string;
  /**
   * Toolbar layout: model + effort sit inline as equal-height pills with no field label,
   * for the composer's control row. Default (false) is the labelled, form-style stack.
   */
  compact?: boolean;
  onCommit: (model: string, effort: ReasoningEffort | null) => void;
}) {
  const fetcher = useFetcher<ModelsApiResponse>();

  useEffect(() => {
    if (fetcher.state === "idle" && !fetcher.data) fetcher.load("/api/models");
  }, [fetcher]);

  const selected = fetcher.data?.models.find((entry) => entry.id === model);
  const supported = selected?.supportedEfforts;
  const effectiveEffort = effort && supported?.includes(effort) ? effort : null;

  const modelSelect = (
    <ModelSelect
      value={model}
      busy={busy}
      disabled={disabled}
      placeholder={placeholder}
      triggerClassName={triggerClassName}
      onCommit={(nextModel) => {
        const next = fetcher.data?.models.find(
          (entry) => entry.id === nextModel,
        );
        const nextEffort =
          effort && next?.supportedEfforts?.includes(effort) ? effort : null;
        onCommit(nextModel, nextEffort);
      }}
    />
  );

  const hasEffort = supported && supported.length > 0;
  const effortSelect = hasEffort ? (
    <Select
      value={effectiveEffort ?? "provider-default"}
      disabled={busy || disabled}
      onValueChange={(value) =>
        onCommit(
          model ?? "",
          value === "provider-default" ? null : (value as ReasoningEffort),
        )
      }
    >
      <SelectTrigger
        className={cn(compact ? "gap-1.5" : "w-full", effortTriggerClassName)}
        aria-label="Reasoning effort"
      >
        {compact && (
          <Gauge className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="provider-default">
          {compact ? "Default effort" : "Provider default"}
        </SelectItem>
        {supported.map((level) => (
          <SelectItem key={level} value={level}>
            {level}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  ) : null;

  if (compact) {
    return (
      <div className="flex items-center gap-2">
        {modelSelect}
        {effortSelect}
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-end">
      {modelSelect}
      {effortSelect && (
        <label className="grid w-full gap-1 text-xs text-muted-foreground sm:w-72">
          <span>Reasoning effort</span>
          {effortSelect}
        </label>
      )}
    </div>
  );
}

export interface ModelsApiResponse {
  models: ModelCatalogEntry[];
  unavailable: UnavailableModelConnection[];
}

function formatContext(tokens: number | null): string | null {
  if (tokens == null) return null;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M ctx`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K ctx`;
  return `${tokens} ctx`;
}

function formatPricing(model: ModelCatalogEntry): string | null {
  if (model.inputPerMTok == null || model.outputPerMTok == null) return null;
  return `$${model.inputPerMTok.toFixed(2)} / $${model.outputPerMTok.toFixed(2)} per M`;
}

function groupLabel(model: ModelCatalogEntry): string {
  return `${model.providerName} · ${model.connectionLabel}`;
}

export function ModelSelect({
  value,
  busy,
  disabled,
  placeholder = "Pick a model",
  triggerClassName,
  onCommit,
}: {
  value: string | null;
  busy: boolean;
  disabled?: boolean;
  placeholder?: string;
  triggerClassName?: string;
  onCommit: (model: string) => void;
}) {
  const fetcher = useFetcher<ModelsApiResponse>();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);

  // Load on mount, not just on open: the closed trigger resolves the raw qualified id
  // (openrouter/abc…/slug) into "Name · Provider", which needs the catalog.
  const { load, state, data } = fetcher;
  useEffect(() => {
    if (state === "idle" && !data) load("/api/models");
  }, [state, data, load]);

  const models = fetcher.data?.models;
  const unavailable = fetcher.data?.unavailable ?? [];
  const loading = fetcher.state === "loading";
  const selected = value
    ? models?.find((entry) => entry.id === value)
    : undefined;

  const commit = (id: string) => {
    setOpen(false);
    setQuery("");
    onCommit(id);
  };

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setQuery("");
      setHighlight(0);
      // Connections can be renamed or removed while this component stays mounted after route
      // revalidation, so each open refreshes the authoritative connected union.
      if (fetcher.state === "idle") {
        fetcher.load("/api/models");
      }
    }
  };

  const { display, targets } = useMemo(() => {
    type Row =
      | { type: "label"; key: string; text: string }
      | { type: "model"; model: ModelCatalogEntry; index: number };
    const rows: Row[] = [];
    if (!models) return { display: rows, targets: [] as string[] };

    const filtered = limitModelsPerConnection(
      filterModels(models, query),
      MAX_ROWS_PER_CONNECTION,
    );
    const targets: string[] = [];
    let previousGroup: string | null = null;
    for (const model of filtered) {
      const group = groupLabel(model);
      if (group !== previousGroup) {
        rows.push({
          type: "label",
          key: `${model.provider}/${model.connectionId}`,
          text: group,
        });
        previousGroup = group;
      }
      rows.push({ type: "model", model, index: targets.length });
      targets.push(model.id);
    }
    return { display: rows, targets };
  }, [models, query]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((current) =>
        Math.min(Math.max(0, targets.length - 1), current + 1),
      );
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((current) => Math.max(0, current - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const target = targets[highlight];
      if (target) commit(target);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  };

  const removed =
    Boolean(value) &&
    !loading &&
    Array.isArray(models) &&
    !models.some((m) => m.id === value);

  return (
    <div>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            disabled={busy || disabled}
            aria-label="Model"
            className={cn(
              "w-full justify-between font-mono text-sm sm:w-72",
              triggerClassName,
            )}
          >
            {/* Resolve the qualified id to "Name · Provider" — the raw openrouter/abc…/slug form
                reads as noise and hides WHICH connection serves the model (the whole point of a
                qualified reference). Fall back to the raw id until the catalog loads. */}
            <span className="truncate">
              {busy
                ? "Saving…"
                : selected
                  ? selected.providerName
                    ? `${selected.name} · ${selected.providerName}`
                    : selected.name
                  : (value ?? placeholder)}
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-[calc(100vw-2rem)] p-0 sm:w-[30rem]"
        >
          <div className="border-b border-border p-1">
            <Input
              autoFocus
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setHighlight(0);
              }}
              onKeyDown={onKeyDown}
              placeholder="Search connected models…"
              className="border-0 font-mono text-sm focus-visible:ring-0"
              aria-label="Search models"
            />
          </div>
          {!loading && unavailable.length > 0 && (
            <div className="flex gap-2 border-b border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>
                Could not load{" "}
                {unavailable.map((item) => item.connectionLabel).join(", ")}.
                Healthy connections remain available.
              </span>
            </div>
          )}
          <div
            role="listbox"
            aria-label="Models"
            className="max-h-80 overflow-y-auto p-1"
          >
            {loading && (
              <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                Refreshing connected models…
              </p>
            )}
            {!loading && models?.length === 0 && unavailable.length === 0 && (
              <div className="space-y-3 px-4 py-7 text-center text-sm">
                <Plug
                  className="mx-auto size-5 text-muted-foreground"
                  aria-hidden
                />
                <p>No model provider is connected to this workspace.</p>
                <Button asChild size="sm" variant="secondary">
                  <Link to="/org/settings">Connect a provider</Link>
                </Button>
              </div>
            )}
            {!loading && models?.length === 0 && unavailable.length > 0 && (
              <div className="space-y-3 px-4 py-7 text-center text-sm">
                <p>Connected provider catalogs are currently unavailable.</p>
                <Button asChild size="sm" variant="secondary">
                  <Link to="/org/settings">Review connections</Link>
                </Button>
              </div>
            )}
            {!loading &&
              models &&
              models.length > 0 &&
              display.length === 0 && (
                <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                  No connected models match “{query.trim()}”.
                </p>
              )}
            {!loading &&
              display.map((row) => {
                if (row.type === "label") {
                  return (
                    <div
                      key={row.key}
                      className="px-2 pt-3 pb-1 text-xs font-medium text-muted-foreground"
                    >
                      {row.text}
                    </div>
                  );
                }
                const { model } = row;
                const context = formatContext(model.contextWindow);
                const price = formatPricing(model);
                return (
                  <Option
                    key={model.id}
                    highlighted={highlight === row.index}
                    selected={model.id === value}
                    onHighlight={() => setHighlight(row.index)}
                    onSelect={() => commit(model.id)}
                  >
                    <div className="min-w-0 flex-1">
                      {/* Per-row provider badge: slugs overlap across providers (OpenRouter's
                          catalog carries codex-slug models), and the group header scrolls out of
                          view — every row must say on its own which connection it belongs to. */}
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm">{model.name}</span>
                        {model.providerName && (
                          <span className="shrink-0 rounded border border-border px-1 py-px text-[10px] leading-4 text-muted-foreground">
                            {model.providerName}
                          </span>
                        )}
                      </div>
                      <div className="truncate font-mono text-xs text-muted-foreground">
                        {model.upstreamModelId}
                      </div>
                    </div>
                    <div className="shrink-0 text-right text-xs text-muted-foreground">
                      {context && <div>{context}</div>}
                      {price && <div>{price}</div>}
                    </div>
                    {model.id === value && (
                      <Check
                        className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
                        aria-hidden
                      />
                    )}
                  </Option>
                );
              })}
          </div>
        </PopoverContent>
      </Popover>
      {removed && (
        <p className="mt-2 flex max-w-md items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            <span className="font-mono">{value}</span> is unavailable. Its
            provider connection may have been removed; choose a connected model
            before saving or deploying.
          </span>
        </p>
      )}
    </div>
  );
}

function Option({
  highlighted,
  selected,
  onHighlight,
  onSelect,
  children,
}: {
  highlighted: boolean;
  selected: boolean;
  onHighlight: () => void;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={highlighted ? 0 : -1}
      onMouseMove={onHighlight}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5",
        highlighted && "bg-accent text-accent-foreground",
      )}
    >
      {children}
    </div>
  );
}
