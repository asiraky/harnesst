/**
 * FOH middle pane — one agent's sessions, needs-you first (the server sorts; this renders).
 * Rows show the status dot + relative time per the §3 mock, an unread marker, and an
 * "opened by agent" hint for delegation-parked sessions. Minimal keyboard nav: focus the
 * list, j/k (or arrows) to move, Enter to open.
 */
import { Archive, Loader2 } from "lucide-react";
import { useRef, useState } from "react";
import { NavLink, useFetcher, useNavigate } from "react-router";

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
        <EditableSessionRow
          key={session.id}
          session={session}
          basePath={basePath}
          cursor={i === cursor}
          onSelect={() => setCursor(i)}
          onArchive={onArchive}
          archiving={archivingId === session.id}
          refusal={
            refusal?.sessionId === session.id ? refusal.message : undefined
          }
        />
      ))}
    </ul>
  );
}

function EditableSessionRow({
  session,
  basePath,
  cursor,
  onSelect,
  onArchive,
  archiving,
  refusal,
}: {
  session: FohSessionRow;
  basePath: string;
  cursor: boolean;
  onSelect: () => void;
  onArchive?: (session: FohSessionRow) => void;
  archiving: boolean;
  refusal?: string;
}) {
  const rename = useFetcher<{
    error: string | null;
    renamed?: { id: string; title: string };
  }>();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);
  const cancelling = useRef(false);
  const submittedTitle = rename.formData?.get("title");
  const title =
    (typeof submittedTitle === "string" ? submittedTitle : null) ??
    session.title;

  const finishEditing = () => {
    if (cancelling.current) {
      cancelling.current = false;
      setDraft(title);
      setEditing(false);
      return;
    }
    const next = draft.replace(/\s+/g, " ").trim();
    setEditing(false);
    if (!next || next === title) {
      setDraft(title);
      return;
    }
    rename.submit(
      {
        intent: "rename-session",
        playgroundSessionId: session.id,
        title: next,
      },
      { method: "post", action: basePath },
    );
  };

  return (
    <li className="group/session relative">
      {/* The link is a full-row sibling, not a parent: the editable title and archive control are
          interactive in their own right and must never be nested inside an anchor. */}
      <NavLink
        to={`${basePath}/s/${session.id}`}
        prefetch="intent"
        aria-label={`Open ${title}`}
        className={({ isActive }) =>
          cn(
            "absolute inset-0 transition-colors hover:bg-muted/60",
            isActive && "bg-muted",
            cursor && "ring-1 ring-inset ring-ring/40",
          )
        }
        onClick={onSelect}
      />
      <div
        className={cn(
          "pointer-events-none relative flex items-start gap-2 py-2.5 pl-3",
          onArchive ? "pr-9" : "pr-3",
        )}
      >
        <span className="mt-1.5">
          <SessionStatusDot status={session.fohStatus} />
        </span>
        <span className="min-w-0 flex-1">
          {editing ? (
            <input
              autoFocus
              value={draft}
              maxLength={120}
              aria-label="Session title"
              className="pointer-events-auto block h-5 w-full rounded-sm border bg-background px-1 text-sm outline-none focus:ring-1 focus:ring-ring"
              onChange={(event) => setDraft(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
              onBlur={finishEditing}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelling.current = true;
                  event.currentTarget.blur();
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
              }}
            />
          ) : (
            <button
              type="button"
              aria-label={`Rename ${title}`}
              title="Rename session"
              className={cn(
                "pointer-events-auto block max-w-full truncate rounded-sm text-left text-sm outline-none hover:underline focus-visible:ring-1 focus-visible:ring-ring",
                session.unread ? "font-semibold" : "font-normal",
              )}
              onClick={() => {
                setDraft(title);
                setEditing(true);
              }}
              onKeyDown={(event) => event.stopPropagation()}
            >
              {title}
            </button>
          )}
          <span className="block text-xs text-muted-foreground">
            {STATUS_LABEL[session.fohStatus]} ·{" "}
            <FohRelativeTime value={session.updatedAt} />
            {session.openedByAgent && " · opened by the agent"}
            {session.unread && (
              <span className="ml-1 inline-block size-1.5 rounded-full bg-blue-500 align-middle" />
            )}
          </span>
        </span>
      </div>
      {onArchive && (
        <button
          type="button"
          aria-label={`Archive ${title}`}
          title="Archive"
          disabled={archiving}
          className={cn(
            "absolute right-1 top-2 rounded-sm p-1 text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover/session:opacity-100 hover:text-foreground",
            archiving && "opacity-100",
          )}
          onClick={(event) => {
            event.stopPropagation();
            onArchive(session);
          }}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {archiving ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <Archive className="size-3.5" aria-hidden />
          )}
        </button>
      )}
      {(refusal || rename.data?.error) && (
        <p className="relative px-3 pb-2 text-xs text-destructive" role="alert">
          {refusal ?? rename.data?.error}
        </p>
      )}
    </li>
  );
}
