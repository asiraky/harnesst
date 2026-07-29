/**
 * FOH inbox bell + flyout (§3 🔔). Self-fetches /api/foh/inbox with a keyed fetcher and polls
 * it — 3s while anything is pending, 10s otherwise, paused while the tab is hidden — copying
 * the WorkspaceTasksIndicator cadence exactly (D12; no SSE). Clicking an item jumps to its
 * session; opening the session resolves question/finished items through the normal read/send
 * paths, so the flyout only ever *navigates* — resolution is server-owned.
 */
import { Bell, CircleCheck, CircleHelp, ShieldQuestion } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useFetcher, useNavigate } from "react-router";

import { relativeTimeLabel } from "~/components/foh/relative-time";
import { Button } from "~/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import { cn } from "~/lib/utils";

import type { InboxViewItem } from "~/foh/inbox.server";

const ACTIVE_POLL_MS = 3000;
const IDLE_POLL_MS = 10000;

export function InboxIndicator() {
  const fetcher = useFetcher<{ items: InboxViewItem[]; count: number }>({
    key: "foh-inbox",
  });
  const { load } = fetcher;
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const items = fetcher.data?.items ?? [];
  const count = fetcher.data?.count ?? 0;
  const anyPending = count > 0;

  const anyPendingRef = useRef(anyPending);
  anyPendingRef.current = anyPending;
  useEffect(() => {
    const url = "/api/foh/inbox";
    load(url);
    let timer: ReturnType<typeof setInterval>;
    const schedule = () => {
      const ms = anyPendingRef.current ? ACTIVE_POLL_MS : IDLE_POLL_MS;
      timer = setInterval(() => {
        if (typeof document !== "undefined" && document.hidden) return;
        load(url);
      }, ms);
    };
    schedule();
    return () => clearInterval(timer);
    // Re-run when the pending state flips so the cadence switches between 3s and 10s.
  }, [load, anyPending]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="relative gap-1.5"
          aria-label={`Inbox${count > 0 ? ` — ${count} pending` : ""}`}
        >
          <Bell className="size-4" aria-hidden />
          {count > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold text-white">
              {count > 99 ? "99+" : count}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-96 max-w-[calc(100vw-1rem)] p-0"
      >
        <p className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">
          Inbox
        </p>
        {items.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            Nothing needs you right now.
          </p>
        ) : (
          <ul className="max-h-96 divide-y overflow-y-auto">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-muted/60"
                  onClick={() => {
                    setOpen(false);
                    navigate(item.href);
                  }}
                >
                  <InboxKindIcon kind={item.kind} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">
                      <span className="font-medium">
                        {item.agentName ?? "agent"}
                      </span>{" "}
                      <span className="text-muted-foreground">
                        {inboxKindLabel(item.kind)}
                      </span>
                    </span>
                    {item.prompt && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {item.prompt}
                      </span>
                    )}
                    <span className="block truncate text-xs text-muted-foreground/70">
                      {item.sessionTitle} · {relativeTimeLabel(item.createdAt)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

function inboxKindLabel(kind: string): string {
  if (kind === "approval") return "needs an approval";
  if (kind === "finished") return "finished";
  return "needs an answer";
}

function InboxKindIcon({ kind }: { kind: string }) {
  const Icon =
    kind === "approval"
      ? ShieldQuestion
      : kind === "finished"
        ? CircleCheck
        : CircleHelp;
  return (
    <Icon
      className={cn(
        "mt-0.5 size-4 shrink-0",
        kind === "finished"
          ? "text-emerald-600 dark:text-emerald-400"
          : "text-amber-600 dark:text-amber-400",
      )}
      aria-hidden
    />
  );
}
