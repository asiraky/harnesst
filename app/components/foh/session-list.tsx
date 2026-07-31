/**
 * FOH middle pane — one agent's sessions, needs-you first (the server sorts; this renders).
 * Rows show the status dot + relative time per the §3 mock, an unread marker, and an
 * "opened by agent" hint for delegation-parked sessions. Minimal keyboard nav: focus the
 * list, j/k (or arrows) to move, Enter to open.
 */
import { Archive, Loader2 } from "lucide-react";
import { useState } from "react";
import { NavLink, useNavigate } from "react-router";

import { FohRelativeTime } from "~/components/foh/relative-time";
import { cn } from "~/lib/utils";

export interface FohSessionRow {
  id: string;
  title: string;
  fohStatus: "working" | "needs_you" | "done" | "error";
  updatedAt: string;
  unread?: boolean;
  openedByAgent?: boolean;
}

const STATUS_LABEL: Record<FohSessionRow["fohStatus"], string> = {
  working: "working",
  needs_you: "needs you",
  done: "done",
  error: "failed",
};

export function SessionStatusDot({
  status,
}: {
  status: FohSessionRow["fohStatus"];
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-2 shrink-0 rounded-full",
        status === "working" && "animate-pulse bg-blue-500",
        status === "needs_you" && "bg-amber-500",
        status === "done" && "bg-muted-foreground/40",
        status === "error" && "bg-destructive",
      )}
    />
  );
}

export function SessionList({
  sessions,
  basePath,
  selectedId,
  onArchive,
  archivingId,
  refusal,
}: {
  sessions: FohSessionRow[];
  /** `/t/:projectId/:agentId` — rows link under it (D14). */
  basePath: string;
  selectedId?: string | null;
  /** #278: absent = no archive affordance at all (the control is opt-in per surface). */
  onArchive?: (session: FohSessionRow) => void;
  archivingId?: string | null;
  /** A server refusal ("still working"), rendered under its own row — never as a dialog. */
  refusal?: { sessionId: string; message: string } | null;
}) {
  const navigate = useNavigate();
  const [cursor, setCursor] = useState(() =>
    Math.max(
      0,
      sessions.findIndex((session) => session.id === selectedId),
    ),
  );

  const move = (delta: number) =>
    setCursor((prev) =>
      Math.min(sessions.length - 1, Math.max(0, prev + delta)),
    );

  return (
    <ul
      tabIndex={0}
      aria-label="Sessions"
      className="flex-1 divide-y overflow-y-auto outline-none focus-visible:ring-1 focus-visible:ring-ring"
      onKeyDown={(e) => {
        if (e.key === "j" || e.key === "ArrowDown") {
          e.preventDefault();
          move(1);
        } else if (e.key === "k" || e.key === "ArrowUp") {
          e.preventDefault();
          move(-1);
        } else if (e.key === "Enter") {
          const session = sessions[cursor];
          if (session) navigate(`${basePath}/s/${session.id}`);
        }
      }}
    >
      {sessions.map((session, i) => (
        <li key={session.id} className="group/session relative">
          <NavLink
            to={`${basePath}/s/${session.id}`}
            prefetch="intent"
            className={({ isActive }) =>
              cn(
                "flex items-start gap-2 py-2.5 pl-3 transition-colors hover:bg-muted/60",
                // Reserve the archive control's gutter even when it is invisible, so a long
                // title never runs under it on hover.
                onArchive ? "pr-9" : "pr-3",
                isActive && "bg-muted",
                i === cursor && "ring-1 ring-inset ring-ring/40",
              )
            }
            onClick={() => setCursor(i)}
          >
            <span className="mt-1.5">
              <SessionStatusDot status={session.fohStatus} />
            </span>
            <span className="min-w-0 flex-1">
              <span
                className={cn(
                  "block truncate text-sm",
                  session.unread ? "font-semibold" : "font-normal",
                )}
              >
                {session.title}
              </span>
              <span className="block text-xs text-muted-foreground">
                {STATUS_LABEL[session.fohStatus]} ·{" "}
                <FohRelativeTime value={session.updatedAt} />
                {session.openedByAgent && " · opened by the agent"}
                {session.unread && (
                  <span className="ml-1 inline-block size-1.5 rounded-full bg-blue-500 align-middle" />
                )}
              </span>
            </span>
          </NavLink>
          {/* Sibling of the NavLink, never inside it — a button nested in an anchor is invalid
              markup and eats the row's keyboard focus. Hidden at rest (#246 cross-link idiom)
              so the list stays a calm column of conversations. */}
          {onArchive && (
            <button
              type="button"
              aria-label={`Archive ${session.title}`}
              title="Archive"
              disabled={archivingId === session.id}
              className={cn(
                "absolute right-1 top-2 rounded-sm p-1 text-muted-foreground transition-opacity focus-visible:opacity-100 group-hover/session:opacity-100 hover:text-foreground",
                archivingId === session.id ? "opacity-100" : "opacity-0",
              )}
              onClick={(e) => {
                e.stopPropagation();
                onArchive(session);
              }}
              // The list's j/k/Enter handler sits on the <ul>; without this, Enter on the
              // archive button would also navigate to the cursor row.
              onKeyDown={(e) => e.stopPropagation()}
            >
              {archivingId === session.id ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <Archive className="size-3.5" aria-hidden />
              )}
            </button>
          )}
          {refusal?.sessionId === session.id && (
            <p className="px-3 pb-2 text-xs text-destructive">
              {refusal.message}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
