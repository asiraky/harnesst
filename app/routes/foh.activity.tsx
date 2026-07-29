/**
 * FOH activity feed — one team's wall-clock timeline (§5, D14: /t/:projectId/activity).
 * Redesigned per issue #212 §3 for glanceability: every event renders as ONE uniform-height
 * row — timestamp, a colored category badge (the visual language lives in CATEGORIES), and a
 * viewer-oriented headline ("Aaron messaged sam", "ivy → sam") with the message preview in
 * muted text. Every row opens the same detail dialog; delegation dialogs lazy-load the full
 * exchange transcript via a fetcher on `?exchange=<id>`. Cursor-paginated with `?before=`.
 */
import {
  ArrowRightLeft,
  ChevronLeft,
  Clock,
  FlaskConical,
  Globe,
  MessageCircle,
  MessageSquarePlus,
  Play,
  Rocket,
  Wrench,
  Zap,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useFetcher, type LoaderFunctionArgs } from "react-router";

import { sessionLoader } from "~/auth/session.server";
import { LocalizedDateTime } from "~/components/localized-values";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import type { ActivityEvent } from "~/foh/activity";
import {
  getDelegationExchange,
  listTeamActivity,
  type DelegationExchange,
} from "~/foh/activity.server";
import { requireFohProject } from "~/foh/guard.server";
import { cn } from "~/lib/utils";
import type { Route } from "./+types/foh.activity";

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }) => {
      const access = await requireFohProject(auth, args.params.projectId, {
        request: args.request,
      });
      const url = new URL(args.request.url);
      const beforeParam = url.searchParams.get("before");
      const before = beforeParam ? new Date(beforeParam) : undefined;
      const exchangeId = url.searchParams.get("exchange");
      const [page, exchange] = await Promise.all([
        listTeamActivity(access.project.id, {
          viewer: { userId: auth.user.id, backOfHouse: access.backOfHouse },
          before: before && !Number.isNaN(before.getTime()) ? before : undefined,
        }),
        exchangeId
          ? getDelegationExchange(access.project.id, exchangeId)
          : Promise.resolve(null),
      ]);
      return {
        projectId: access.project.id,
        projectName: access.project.name,
        events: page.events,
        nextBefore: page.nextBefore,
        paged: before != null,
        exchange,
      };
    },
    { ensureSignedIn: true },
  );

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `activity · ${loaderData?.projectName ?? "harnesst"}` }];
}

const AGENT_FALLBACK = "removed agent";

/* ---------------------------------------------------------------------------------------
 * Category visual language (issue #212 §3): each kind of event gets a color + icon + label
 * so the feed is scannable without reading. Runs are sub-typed by channel — "me messaging
 * an agent" (foh) is a different beat than a Discord run or a playground test.
 * ------------------------------------------------------------------------------------- */

interface CategorySpec {
  label: string;
  icon: typeof Zap;
  /** Colored icon-badge classes (background tint + icon color, light and dark). */
  badge: string;
}

const CATEGORIES = {
  session: {
    label: "Session",
    icon: MessageSquarePlus,
    badge: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  },
  delegation: {
    label: "Agent ↔ agent",
    icon: ArrowRightLeft,
    badge: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  },
  chat: {
    label: "Chat",
    icon: MessageCircle,
    badge: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  },
  discord: {
    label: "Discord",
    icon: MessageCircle,
    badge: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400",
  },
  assistant: {
    label: "Assistant",
    icon: Wrench,
    badge: "bg-teal-500/15 text-teal-600 dark:text-teal-400",
  },
  playground: {
    label: "Playground",
    icon: FlaskConical,
    badge: "bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-400",
  },
  schedule: {
    label: "Scheduled",
    icon: Clock,
    badge: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
  },
  portal: {
    label: "Portal",
    icon: Globe,
    badge: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400",
  },
  run: {
    label: "Run",
    icon: Play,
    badge: "bg-slate-500/15 text-slate-600 dark:text-slate-400",
  },
  deployment: {
    label: "Deploy",
    icon: Rocket,
    badge: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  },
} satisfies Record<string, CategorySpec>;

function categoryFor(event: ActivityEvent): CategorySpec {
  if (event.type === "run") {
    switch (event.channel) {
      case "foh":
        return CATEGORIES.chat;
      case "discord":
        return CATEGORIES.discord;
      case "assistant":
        return CATEGORIES.assistant;
      case "playground":
        return CATEGORIES.playground;
      case "schedule":
        return CATEGORIES.schedule;
      case "portal":
        return CATEGORIES.portal;
      default:
        return CATEGORIES.run;
    }
  }
  return CATEGORIES[event.type];
}

/* ---------------------------------------------------------------------------------------
 * Headlines — oriented from the people/agents acting, not the machinery ("Aaron messaged
 * sam", "ivy → sam"), with the message preview in muted text after the who/what.
 * ------------------------------------------------------------------------------------- */

function Quote({ text }: { text: string }) {
  return <span className="text-muted-foreground">“{text}”</span>;
}

function Headline({ event }: { event: ActivityEvent }) {
  switch (event.type) {
    case "session": {
      const opener =
        event.openedByAgentName ?? event.openedByUserName ?? "Someone";
      return (
        <>
          <span className="font-medium">{opener}</span> opened a session with{" "}
          <span className="font-medium">{event.agentName ?? AGENT_FALLBACK}</span>
          {event.title && (
            <>
              {" · "}
              <Quote text={event.title} />
            </>
          )}
        </>
      );
    }
    case "delegation":
      return (
        <>
          <span className="font-medium">
            {event.fromAgentName ?? AGENT_FALLBACK}
          </span>
          {" → "}
          <span className="font-medium">{event.toAgentName ?? AGENT_FALLBACK}</span>
          {event.ask && (
            <>
              {" · "}
              <Quote text={event.ask} />
            </>
          )}
        </>
      );
    case "run": {
      const agent = event.agentName ?? AGENT_FALLBACK;
      const preview = event.input && (
        <>
          {" · "}
          <Quote text={event.input} />
        </>
      );
      if (event.channel === "foh") {
        return (
          <>
            <span className="font-medium">{event.actorUserName ?? "Someone"}</span>{" "}
            messaged <span className="font-medium">{agent}</span>
            {preview}
          </>
        );
      }
      if (event.channel === "discord") {
        return (
          <>
            <span className="font-medium">{agent}</span> answered on Discord
            {preview}
          </>
        );
      }
      if (event.channel === "assistant") {
        return (
          <>
            <span className="font-medium">{agent}</span> worked with the assistant
            {preview}
          </>
        );
      }
      if (event.channel === "playground") {
        return (
          <>
            <span className="font-medium">{agent}</span> ran in the playground
            {preview}
          </>
        );
      }
      if (event.channel === "schedule") {
        return (
          <>
            <span className="font-medium">{agent}</span> ran on a schedule
            {preview}
          </>
        );
      }
      if (event.channel === "portal") {
        return (
          <>
            <span className="font-medium">{agent}</span> answered a portal
            visitor
            {preview}
          </>
        );
      }
      return (
        <>
          <span className="font-medium">{agent}</span> ran
          {preview}
        </>
      );
    }
    case "deployment":
      return (
        <>
          <span className="font-medium">{event.agentName ?? AGENT_FALLBACK}</span>{" "}
          was deployed
          {event.version && (
            <span className="text-muted-foreground"> · {event.version}</span>
          )}
        </>
      );
  }
}

/* ---------------------------------------------------------------------------------------
 * Status chips — only states worth a glance get color; happy-path terminal states stay
 * quiet so the exceptional rows pop.
 * ------------------------------------------------------------------------------------- */

const DELEGATION_STATUS_LABEL: Record<string, string> = {
  running: "in progress",
  waiting: "needs you",
  completed: "completed",
  failed: "failed",
};

function statusChip(event: ActivityEvent): { label: string; className: string } | null {
  if (event.type === "session") return null;
  if (event.type === "delegation" && event.status === "waiting") {
    return {
      label: DELEGATION_STATUS_LABEL.waiting,
      className:
        "bg-amber-500/15 text-amber-700 dark:text-amber-400 font-medium",
    };
  }
  if (event.status === "failed") {
    return { label: "failed", className: "bg-destructive/10 text-destructive" };
  }
  if (event.status === "running") {
    return { label: "running", className: "bg-muted text-muted-foreground" };
  }
  return null;
}

function EventTime({ at }: { at: string }) {
  return (
    <span className="w-24 shrink-0 text-xs tabular-nums text-muted-foreground">
      <LocalizedDateTime
        value={at}
        options={{
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }}
      />
    </span>
  );
}

/* ---------------------------------------------------------------------------------------
 * Detail dialog — the ONE consistent drill-in for every row (issue #212 §3): full
 * timestamps, untruncated text, and for delegations the lazy-loaded exchange transcript.
 * ------------------------------------------------------------------------------------- */

function ExchangeTranscript({ exchange }: { exchange: DelegationExchange }) {
  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-sm">
      {exchange.ask && (
        <p>
          <span className="font-medium">
            {exchange.fromAgentName ?? AGENT_FALLBACK}:
          </span>{" "}
          {exchange.ask}
        </p>
      )}
      {exchange.steps.length === 0 && !exchange.ask ? (
        <p className="text-muted-foreground">
          No transcript was recorded for this exchange.
        </p>
      ) : (
        exchange.steps.map((step, i) =>
          step.kind === "message" ? (
            // The transcript is the PEER's: its "assistant" is the delegate answering.
            // User beats after the initial ask are the human's answers (speaker: "human").
            <p key={i}>
              <span className="font-medium">
                {step.role === "assistant"
                  ? (exchange.toAgentName ?? AGENT_FALLBACK)
                  : step.speaker === "human"
                    ? "human"
                    : (exchange.fromAgentName ?? AGENT_FALLBACK)}
                :
              </span>{" "}
              {step.text}
            </p>
          ) : step.kind === "tool" ? (
            <p
              key={i}
              className={cn(
                "text-xs text-muted-foreground",
                step.isError && "text-destructive",
              )}
            >
              ⚙ {step.toolName ?? "tool"}
              {step.summary ? ` — ${step.summary}` : ""}
            </p>
          ) : (
            <p key={i} className="text-xs text-destructive">
              {step.text}
            </p>
          ),
        )
      )}
      {exchange.error && (
        <p className="text-xs text-destructive">{exchange.error}</p>
      )}
    </div>
  );
}

function DetailField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="text-sm">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <div className="mt-0.5 break-words">{children}</div>
    </div>
  );
}

function EventDetail({ event }: { event: ActivityEvent }) {
  switch (event.type) {
    case "session":
      return (
        <>
          <DetailField label="Opened by">
            {event.openedByAgentName ?? event.openedByUserName ?? "Unknown"}
          </DetailField>
          <DetailField label="Agent">
            {event.agentName ?? AGENT_FALLBACK}
          </DetailField>
          {event.title && <DetailField label="Title">{event.title}</DetailField>}
        </>
      );
    case "run":
      return (
        <>
          <DetailField label="Agent">
            {event.agentName ?? AGENT_FALLBACK}
          </DetailField>
          {event.actorUserName && (
            <DetailField label="Sent by">{event.actorUserName}</DetailField>
          )}
          {event.channel && (
            <DetailField label="Channel">{event.channel}</DetailField>
          )}
          <DetailField label="Status">{event.status}</DetailField>
          {event.input && (
            <DetailField label="Message">
              <span className="whitespace-pre-wrap">{event.input}</span>
            </DetailField>
          )}
          {event.error && (
            <DetailField label="Error">
              <span className="text-destructive">{event.error}</span>
            </DetailField>
          )}
        </>
      );
    case "deployment":
      return (
        <>
          <DetailField label="Agent">
            {event.agentName ?? AGENT_FALLBACK}
          </DetailField>
          {event.version && (
            <DetailField label="Version">{event.version}</DetailField>
          )}
          <DetailField label="Status">{event.status}</DetailField>
        </>
      );
    case "delegation":
      // The transcript block is rendered by the dialog itself (it owns the fetcher).
      return (
        <>
          <DetailField label="Status">
            {DELEGATION_STATUS_LABEL[event.status] ?? event.status}
          </DetailField>
          {event.error && (
            <DetailField label="Error">
              <span className="text-destructive">{event.error}</span>
            </DetailField>
          )}
        </>
      );
  }
}

function EventDetailDialog({
  event,
  projectId,
  onClose,
}: {
  event: ActivityEvent;
  projectId: string;
  onClose: () => void;
}) {
  const category = categoryFor(event);
  const Icon = category.icon;
  const fetcher = useFetcher<typeof loader>();
  const exchange =
    event.type === "delegation" &&
    fetcher.data?.exchange?.delegationId === event.delegationId
      ? fetcher.data.exchange
      : null;

  // Delegations lazy-load their full exchange the moment the dialog opens.
  useEffect(() => {
    if (event.type !== "delegation") return;
    fetcher.load(
      `/t/${projectId}/activity?exchange=${encodeURIComponent(event.delegationId)}`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per opened event
  }, [event.id]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[80dvh] gap-4 overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <span
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full",
                category.badge,
              )}
            >
              <Icon className="size-3.5" aria-hidden />
            </span>
            {category.label}
          </DialogTitle>
          <DialogDescription>
            <LocalizedDateTime
              value={event.at}
              options={{ dateStyle: "medium", timeStyle: "short" }}
            />
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm">
          <Headline event={event} />
        </p>
        <div className="space-y-3">
          <EventDetail event={event} />
        </div>
        {event.type === "delegation" &&
          (exchange ? (
            <ExchangeTranscript exchange={exchange} />
          ) : (
            <p className="text-xs text-muted-foreground">
              {fetcher.state !== "idle"
                ? "Loading exchange…"
                : "No exchange details available."}
            </p>
          ))}
      </DialogContent>
    </Dialog>
  );
}

export default function FohActivity({ loaderData }: Route.ComponentProps) {
  const { projectId, projectName, events, nextBefore, paged } = loaderData;
  const [detail, setDetail] = useState<ActivityEvent | null>(null);

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="-ml-2 px-1.5 md:hidden"
        >
          <Link to="/" aria-label="Back to team list">
            <ChevronLeft className="size-4" aria-hidden />
          </Link>
        </Button>
        <Zap className="size-4 text-muted-foreground" aria-hidden />
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">
          Activity — {projectName}
        </h1>
        {paged && (
          <Button asChild variant="ghost" size="sm">
            <Link to={`/t/${projectId}/activity`}>Latest</Link>
          </Button>
        )}
      </div>

      {events.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="max-w-sm px-6 text-center">
            <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Zap className="size-6" aria-hidden />
            </div>
            <h2 className="text-lg font-semibold">Nothing has happened yet</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Sessions, delegations, runs, and deployments for this team will
              show up here as they happen.
            </p>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ol className="divide-y">
            {events.map((event) => {
              const category = categoryFor(event);
              const Icon = category.icon;
              const chip = statusChip(event);
              return (
                <li key={event.id}>
                  <button
                    type="button"
                    onClick={() => setDetail(event)}
                    className="flex h-11 w-full items-center gap-3 px-4 text-left transition-colors hover:bg-muted/40"
                  >
                    <EventTime at={event.at} />
                    <span
                      className={cn(
                        "flex size-6 shrink-0 items-center justify-center rounded-full",
                        category.badge,
                      )}
                      title={category.label}
                    >
                      <Icon className="size-3.5" aria-hidden />
                    </span>
                    <span className="hidden w-24 shrink-0 truncate text-xs text-muted-foreground sm:inline">
                      {category.label}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm">
                      <Headline event={event} />
                    </span>
                    {chip && (
                      <span
                        className={cn(
                          "shrink-0 rounded-full px-2 py-0.5 text-xs",
                          chip.className,
                        )}
                      >
                        {chip.label}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ol>
          {nextBefore && (
            <div className="flex justify-center border-t p-3">
              <Button asChild variant="ghost" size="sm">
                <Link
                  to={`/t/${projectId}/activity?before=${encodeURIComponent(nextBefore)}`}
                >
                  Load older
                </Link>
              </Button>
            </div>
          )}
        </div>
      )}

      {detail && (
        <EventDetailDialog
          event={detail}
          projectId={projectId}
          onClose={() => setDetail(null)}
        />
      )}
    </section>
  );
}
