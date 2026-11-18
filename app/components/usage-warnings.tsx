/**
 * Usage warnings and the send-to-assistant draft (issue #419). A card per warning; "Send to
 * assistant" opens a sheet with the drafted message to edit, then opens the repository's
 * assistant with the draft in its message box. Nothing is sent from here: the owner presses send
 * in the assistant. Platform warnings (plan, 429, cache) have no owning assistant, so the sheet
 * offers a copy instead.
 */
import { AlertTriangle, Copy, Send, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";

import { LocalizedDateTime } from "~/components/localized-values";
import { Panel, usageHref } from "~/components/usage";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "~/components/ui/sheet";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";
import type { WindowDays } from "~/usage/format";
import { RULE_LABELS, type Severity, type Warning } from "~/usage/warnings";

/** What a loader sends per warning (`ShownWarning`, serialised). */
export interface WarningView extends Warning {
  title: string;
  summary: string;
  fix: string;
  draft: string;
  link: string | null;
  agentName: string | null;
  projectName: string | null;
  connectionLabel: string | null;
}

/** The longest draft carried to the assistant in its URL. */
const MAX_DRAFT = 6000;

export function assistantDraftHref(projectId: string, draft: string): string {
  return `/repos/${projectId}/assistant?draft=${encodeURIComponent(draft.slice(0, MAX_DRAFT))}`;
}

function SevDot({ severity }: { severity: Severity }) {
  return (
    <span
      aria-label={severity}
      className={cn("mt-1.5 inline-block size-2 shrink-0 rounded-full", severity === "critical" ? "bg-red-500" : "bg-amber-500")}
    />
  );
}

const fmt = { month: "short", day: "numeric", hour: "numeric", minute: "numeric" } as const;

function WarningCard({
  w,
  days,
  compact,
  onDraft,
}: {
  w: WarningView;
  days: WindowDays;
  compact?: boolean;
  onDraft: (w: WarningView) => void;
}) {
  return (
    <div className={cn("rounded-lg border p-3", w.severity === "critical" ? "border-red-500/40 bg-red-500/[0.03]" : "bg-card")}>
      <div className="flex items-start gap-2">
        <SevDot severity={w.severity} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium [overflow-wrap:anywhere]">{w.title}</p>
            <Badge variant="outline">{RULE_LABELS[w.rule].short}</Badge>
            {w.platform && <Badge variant="secondary">platform</Badge>}
          </div>
          {!compact && <p className="mt-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">{w.summary}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {w.runs > 0 ? (
              <span>
                {w.count} occurrence{w.count === 1 ? "" : "s"} · {w.runs} run{w.runs === 1 ? "" : "s"}
              </span>
            ) : null}
            <span>
              last <LocalizedDateTime value={w.lastSeen} options={fmt} />
            </span>
            {w.link && (
              <Link to={usageHref(w.link, days)} className="font-medium text-primary underline-offset-4 hover:underline">
                Run {w.worst.runId}
                {w.worst.callSeq != null ? ` · step ${w.worst.callSeq}` : ""} →
              </Link>
            )}
            {!w.link && w.connectionId && (
              <Link to={usageHref(`/usage/connections/${w.connectionId}`, days)} className="font-medium text-primary underline-offset-4 hover:underline">
                Connection →
              </Link>
            )}
          </div>
        </div>
        <Button variant="outline" size="sm" className="h-7 shrink-0 gap-1.5 px-2.5 text-xs" onClick={() => onDraft(w)}>
          {w.platform ? <Copy className="size-3.5" aria-hidden /> : <Send className="size-3.5" aria-hidden />}
          {w.platform ? "Copy draft" : "Send to assistant"}
        </Button>
      </div>
    </div>
  );
}

export function WarningSheet({ warning, onClose }: { warning: WarningView | null; onClose: () => void }) {
  return (
    <Sheet open={warning != null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full gap-0 p-0 sm:w-[min(36rem,92vw)] sm:max-w-none">
        {warning && <DraftBody key={warning.id} w={warning} onClose={onClose} />}
      </SheetContent>
    </Sheet>
  );
}

function DraftBody({ w, onClose }: { w: WarningView; onClose: () => void }) {
  const [text, setText] = useState(w.draft);
  const [copied, setCopied] = useState(false);
  const target = !w.platform && w.projectId ? w.projectId : null;
  const e = w.worst.evidence;
  const chips = [
    w.worst.runId ? `run ${w.worst.runId}${w.worst.callSeq != null ? ` · step ${w.worst.callSeq}` : ""}` : null,
    e.tool ?? null,
    e.count && w.rule !== "compaction" ? `×${e.count} in run` : null,
    e.requested ? `${e.count} in one turn · ${e.requested} requested` : null,
    w.runs ? `${w.runs} run${w.runs === 1 ? "" : "s"} affected` : null,
  ].filter((c): c is string => !!c);

  return (
    <>
      <div className="flex items-start justify-between gap-3 border-b px-5 py-4">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {target ? "Send to assistant · draft" : "Platform issue · draft"}
          </p>
          <SheetTitle className="mt-1 flex items-start gap-2 text-base font-semibold">
            <SevDot severity={w.severity} />
            <span className="[overflow-wrap:anywhere]">{w.title}</span>
          </SheetTitle>
          <SheetDescription className="mt-1 text-xs">
            {target ? (
              <>To <b>{w.projectName ?? "this repository"}</b>'s assistant. It opens with this message in its box; nothing is sent until you press send there.</>
            ) : (
              "No agent's assistant owns this fix."
            )}
          </SheetDescription>
        </div>
        <button type="button" onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-muted" aria-label="Close">
          <X className="size-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {!target && (
          <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
            <b>Platform fix, not an agent change.</b> Sending this to an agent's assistant would ask it to change something it
            doesn't own. Copy the draft into an issue for harnesst instead.
          </div>
        )}
        {chips.length > 0 && (
          <>
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Evidence attached</p>
            <div className="mb-4 flex flex-wrap gap-1.5">
              {chips.map((c) => (
                <span key={c} className="rounded-full border bg-muted/40 px-2 py-0.5 font-mono text-[11px]">{c}</span>
              ))}
            </div>
          </>
        )}
        <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Suggested fix</p>
        <p className="mb-4 rounded-lg border-l-2 border-primary bg-accent/40 px-3 py-2 text-sm">{w.fix}</p>
        <label htmlFor={`draft-${w.id}`} className="mb-1.5 flex items-baseline justify-between text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <span>Message</span>
          <span className="normal-case tracking-normal">Edit before sending. Nothing is sent automatically.</span>
        </label>
        <Textarea id={`draft-${w.id}`} rows={16} value={text} onChange={(ev) => setText(ev.target.value)} className="font-mono text-xs leading-relaxed" />
      </div>
      <div className="flex items-center justify-between gap-2 border-t px-5 py-3">
        <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setText(w.draft)}>
          Reset draft
        </button>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button
            variant={target ? "outline" : "default"}
            size="sm"
            onClick={() => {
              void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => {});
            }}
          >
            <Copy className="size-3.5" aria-hidden /> {copied ? "Copied" : "Copy draft"}
          </Button>
          {target && (
            <Button size="sm" asChild>
              <Link to={assistantDraftHref(target, text)}>
                <Send className="size-3.5" aria-hidden /> Open in assistant
              </Link>
            </Button>
          )}
        </div>
      </div>
    </>
  );
}

/** A warnings panel: cards (the first `max`, the rest folded) and the draft sheet. */
export function WarningsPanel({
  warnings,
  days,
  title = "Warnings",
  max = 6,
  grid,
  compact,
  emptyText = "No warnings at this scope.",
  id,
}: {
  warnings: WarningView[];
  days: WindowDays;
  title?: string;
  max?: number;
  grid?: boolean;
  compact?: boolean;
  emptyText?: string | null;
  id?: string;
}) {
  const [open, setOpen] = useState<WarningView | null>(null);
  if (warnings.length === 0 && emptyText == null) return null;
  const crit = warnings.filter((w) => w.severity === "critical").length;
  const gc = grid ? "grid gap-2 md:grid-cols-2" : "grid gap-2";
  const card = (w: WarningView) => <WarningCard key={w.id} w={w} days={days} compact={compact} onDraft={setOpen} />;
  return (
    <div id={id}>
      <Panel
        title={title}
        icon={<AlertTriangle className="size-4" aria-hidden />}
        aside={
          warnings.length ? (
            <span className="flex gap-1">
              {crit > 0 && <Badge variant="destructive">{crit} critical</Badge>}
              {warnings.length - crit > 0 && <Badge variant="secondary">{warnings.length - crit} warn</Badge>}
            </span>
          ) : undefined
        }
      >
        {warnings.length === 0 ? (
          <p className="text-sm text-muted-foreground">{emptyText}</p>
        ) : (
          <>
            <div className={gc}>{warnings.slice(0, max).map(card)}</div>
            {warnings.length > max && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs font-medium text-primary">Show {warnings.length - max} more</summary>
                <div className={cn("mt-2", gc)}>{warnings.slice(max).map(card)}</div>
              </details>
            )}
          </>
        )}
      </Panel>
      <WarningSheet warning={open} onClose={() => setOpen(null)} />
    </div>
  );
}
