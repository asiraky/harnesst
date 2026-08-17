/**
 * FOH middle pane — one team member's session list (D14: /t/:projectId/:agentId), needs-you
 * first with unread badges, `+ new session`, and the right pane as <Outlet/> (the index child
 * shows the no-session empty state; /s/:sessionId shows the conversation).
 */
import { ChevronLeft, Loader2, Plus, Settings2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  data,
  redirect,
  Link,
  useFetcher,
  useNavigate,
  useNavigation,
  useParams,
  Outlet,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { getSessionAuth, sessionLoader } from "~/auth/session.server";
import { FohPaneError } from "~/components/foh/pane-error";
import { SessionList } from "~/components/foh/session-list";
import { Button } from "~/components/ui/button";
import { bohAgentHref } from "~/foh/boh-links";
import { requireFohProject } from "~/foh/guard.server";
import { suppressOpenSessionUnread } from "~/foh/unread";
import { cn } from "~/lib/utils";
import {
  countArchivedFohSessions,
  createPlaygroundSession,
  listFohSessionsForAgent,
  renameFohSession,
  summarizePlaygroundSession,
} from "~/playground/sessions.server";
import { getRuntime } from "~/seams/index.server";
import type { action as archiveAction } from "./api.foh.archive";
import type { Route } from "./+types/foh.agent";

async function requireFohAgent(projectId: string, agentId: string | undefined) {
  const agent = agentId
    ? await getRuntime().data.agents.findById(agentId)
    : null;
  if (!agent || agent.projectId !== projectId || agent.kind !== "member") {
    throw data("Team member not found", { status: 404 });
  }
  return agent;
}

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }) => {
      const access = await requireFohProject(auth, args.params.projectId, {
        request: args.request,
      });
      const agent = await requireFohAgent(
        access.project.id,
        args.params.agentId,
      );
      const sessions = await listFohSessionsForAgent({
        projectId: access.project.id,
        agentId: agent.id,
        viewerId: auth.user.id,
        includeAll: access.backOfHouse,
      });
      // #278: the archived shelf is admin-only, and so is knowing how full it is — a plain
      // member never learns that conversations they can't see exist.
      const archivedCount = access.backOfHouse
        ? await countArchivedFohSessions(access.project.id)
        : 0;
      return {
        projectId: access.project.id,
        projectName: access.project.name,
        agentId: agent.id,
        agentName: agent.name,
        backOfHouse: access.backOfHouse,
        archivedCount,
        archivedHref: access.backOfHouse
          ? `/repos/${access.project.id}/sessions/archived`
          : null,
        // #246: the admin-only cross-link into this member's BOH config. Null (absent, not
        // disabled) for plain members.
        bohHref: access.backOfHouse
          ? bohAgentHref(access.project, agent.name)
          : null,
        sessions: sessions.map((session) => ({
          ...summarizePlaygroundSession(session, { unread: session.unread }),
          openedByAgent: session.openedByAgentId != null,
        })),
      };
    },
    { ensureSignedIn: true },
  );

export async function action(args: ActionFunctionArgs) {
  const auth = await getSessionAuth(args);
  if (!auth.user) throw redirect("/login");
  const access = await requireFohProject(auth, args.params.projectId);
  const agent = await requireFohAgent(access.project.id, args.params.agentId);

  const form = await args.request.formData();
  const intent = String(form.get("intent"));
  if (intent === "rename-session") {
    const sessionId = String(form.get("playgroundSessionId") ?? "").trim();
    const title = String(form.get("title") ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (!sessionId || !title) {
      return data({ error: "A session title is required." }, { status: 400 });
    }
    if (title.length > 120) {
      return data(
        { error: "Session titles must be 120 characters or fewer." },
        { status: 400 },
      );
    }
    const renamed = await renameFohSession({
      id: sessionId,
      projectId: access.project.id,
      agentId: agent.id,
      viewerId: auth.user.id,
      includeAll: access.backOfHouse,
      title,
    });
    if (!renamed) {
      return data({ error: "That session was not found." }, { status: 404 });
    }
    return { error: null, renamed };
  }
  if (intent !== "new-session") {
    return { error: "Unknown action." };
  }
  const existing = await listFohSessionsForAgent({
    projectId: access.project.id,
    agentId: agent.id,
    viewerId: auth.user.id,
    includeAll: access.backOfHouse,
  });
  // Row-spam guard (portal-page precedent): an accidental refresh-loop on the new-session
  // form must not flood the table. Since #278 the list excludes archived rows, so this counts
  // live conversations only — archiving is the way back under the ceiling.
  if (existing.length >= 100) {
    return {
      error:
        "Too many conversations with this member — reuse or archive one first.",
    };
  }
  const session = await createPlaygroundSession({
    projectId: access.project.id,
    agentId: agent.id,
    userId: auth.user.id,
    surface: "foh",
  });
  throw redirect(`/t/${access.project.id}/${agent.id}/s/${session.id}`);
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData?.agentName ?? "agent"} · harnesst` }];
}

export default function FohAgent({ loaderData }: Route.ComponentProps) {
  const {
    projectId,
    agentId,
    agentName,
    sessions,
    bohHref,
    archivedCount,
    archivedHref,
  } = loaderData;
  const params = useParams();
  const newSessionFetcher = useFetcher<typeof action>();
  const basePath = `/t/${projectId}/${agentId}`;
  const openSessionId = params.sessionId ?? null;
  // The open conversation is already being acknowledged by its child route. Hide its unread
  // state immediately so a loader poll cannot flash a badge for a reply the viewer is watching.
  const visibleSessions = suppressOpenSessionUnread(sessions, openSessionId);
  const archive = useArchive({ projectId, basePath, openSessionId });
  const showPending = usePendingPane(openSessionId);
  // Below md only one pane fits, and the right one is whatever the user is waiting on: the
  // list until a session is open OR the pending pane has taken over. Keying this off
  // `openSessionId` alone would leave the full-width list covering a slow load's spinner.
  const detailVisible = openSessionId !== null || showPending;

  return (
    <>
      <section
        className={cn(
          "shrink-0 flex-col border-r",
          detailVisible ? "hidden w-72 md:flex" : "flex w-full md:w-72",
        )}
      >
        <div className="flex h-14 items-center gap-2 border-b px-3">
          <Button
            asChild
            variant="ghost"
            size="sm"
            className="-ml-1 shrink-0 gap-0.5 px-1.5 lg:hidden"
          >
            <Link to="/" aria-label="Back to team list">
              <ChevronLeft className="size-4" aria-hidden />
              Team
            </Link>
          </Button>
          <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">
            {agentName} — sessions
          </h1>
          {bohHref && (
            <Link
              to={bohHref}
              prefetch="intent"
              aria-label={`Manage ${agentName} in Repositories`}
              title="Manage in Repositories"
              className="rounded-sm p-1 text-muted-foreground/50 transition-colors hover:text-foreground"
            >
              <Settings2 className="size-3.5" aria-hidden />
            </Link>
          )}
          <newSessionFetcher.Form method="post">
            <input type="hidden" name="intent" value="new-session" />
            <Button
              type="submit"
              variant="ghost"
              size="sm"
              className="gap-1"
              disabled={newSessionFetcher.state !== "idle"}
              aria-label="New session"
            >
              <Plus className="size-3.5" aria-hidden />
              New
            </Button>
          </newSessionFetcher.Form>
        </div>
        {newSessionFetcher.data?.error && (
          <p className="border-b px-3 py-2 text-xs text-destructive">
            {newSessionFetcher.data.error}
          </p>
        )}
        {sessions.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            No sessions with {agentName} yet.
          </p>
        ) : (
          <SessionList
            sessions={visibleSessions}
            basePath={basePath}
            selectedId={params.sessionId ?? null}
            onArchive={(session) => archive.archive(session.id)}
            archivingId={archive.pendingId}
            refusal={archive.refusal}
          />
        )}
        {/* Outside the empty-state ternary on purpose: archiving the last conversation is
            exactly when an admin needs the way back to the shelf. */}
        {archivedHref && archivedCount > 0 && (
          <div className="shrink-0 border-t px-3 py-2">
            <Link
              to={archivedHref}
              prefetch="intent"
              className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              {archivedCount} archived
            </Link>
          </div>
        )}
      </section>
      <SessionPane pending={showPending} basePath={basePath}>
        <Outlet />
      </SessionPane>
    </>
  );
}

/**
 * A loader failure here takes out the session list AND the conversation pane, so it renders in
 * their place rather than at root — the FOH sidebar stays, and with it the way to another team
 * member (issue #250). A throw from the child session route never reaches this boundary: that
 * route declares its own.
 */
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return (
    <FohPaneError
      error={error}
      subject="team member"
      backTo="/"
      backLabel="Team"
    />
  );
}

/**
 * The undo toast is a courtesy, not a decision point — archiving is reversible from the
 * back-of-house shelf forever, so it gets out of the way on its own rather than
 * accumulating dismissed banners.
 */
const ARCHIVE_UNDO_MS = 10_000;

/**
 * One fixed toast id: a second archive REPLACES the first toast, so two Undos never stack
 * and the first session's title can never sit on screen next to the second one's Undo.
 */
const ARCHIVE_TOAST_ID = "foh-archive-undo";

/**
 * FOH archive/undo (#278). The undo lives in a toast, not a strip above the list — inserting
 * a strip shifted every row down when it appeared and back up when the archived row left on
 * revalidation. The refusal stays local state, not loader data: the FOH shell revalidates on
 * a 10s timer, which would wipe copy that lived in the loader payload while the user reads it.
 */
function useArchive({
  projectId,
  basePath,
  openSessionId,
}: {
  projectId: string;
  basePath: string;
  openSessionId: string | null;
}) {
  const fetcher = useFetcher<typeof archiveAction>();
  const navigate = useNavigate();
  const [refusal, setRefusal] = useState<{
    sessionId: string;
    message: string;
  } | null>(null);
  const result = fetcher.data;

  const submit = (sessionId: string, intent: "archive" | "unarchive") => {
    setRefusal(null);
    fetcher.submit(
      { intent, playgroundSessionId: sessionId },
      { method: "post", action: `/api/foh/${projectId}/archive` },
    );
  };

  // The toast's Undo fires long after the render that created it; the ref keeps it aimed at
  // the current submit (and its current projectId) instead of a stale closure.
  const submitRef = useRef(submit);
  useEffect(() => {
    submitRef.current = submit;
  });

  // Keyed on the response alone: the fetcher's identity churns through idle → loading → idle
  // around every submit, and re-running on that churn would resurrect a toast the user had
  // just dismissed via Undo.
  useEffect(() => {
    if (!result) return;
    if (!result.ok) {
      setRefusal({ sessionId: result.sessionId, message: result.error });
      return;
    }
    if (result.intent !== "archive") return;
    const { sessionId, title } = result;
    toast("Session archived", {
      id: ARCHIVE_TOAST_ID,
      description: title,
      duration: ARCHIVE_UNDO_MS,
      action: {
        label: "Undo",
        onClick: () => submitRef.current(sessionId, "unarchive"),
      },
    });
  }, [result]);

  useEffect(() => {
    if (!refusal) return;
    const timer = setTimeout(() => setRefusal(null), ARCHIVE_UNDO_MS);
    return () => clearTimeout(timer);
  }, [refusal]);

  // React Router REUSES this component across `/t/:projectId/:agentId`, so without this the
  // toast outlives the list it belongs to: switching agents mid-window would leave an Undo that
  // silently restores the previous agent's conversation, and switching repos would post the old
  // session id to the new repo's endpoint. The undo belongs to one list; it dies with it.
  useEffect(() => {
    setRefusal(null);
    return () => {
      toast.dismiss(ARCHIVE_TOAST_ID);
    };
  }, [basePath]);

  // The conversation the user is reading can be the one they just archived — the server now
  // 404s it, so step back to the list rather than let the revalidation break the pane.
  useEffect(() => {
    if (!result?.ok || result.intent !== "archive") return;
    if (openSessionId !== null && result.sessionId === openSessionId) {
      navigate(basePath, { replace: true });
    }
  }, [result, openSessionId, basePath, navigate]);

  return {
    refusal,
    pendingId:
      fetcher.state === "idle"
        ? null
        : (fetcher.formData?.get("playgroundSessionId")?.toString() ?? null),
    archive: (sessionId: string) => submit(sessionId, "archive"),
  };
}

/** `/t/:projectId/:agentId/s/:sessionId` → the session id, or null for any other path. */
function sessionIdFromPath(pathname: string): string | null {
  return /\/s\/([^/?#]+)/.exec(pathname)?.[1] ?? null;
}

/**
 * React Router keeps the CURRENT pane mounted while the next route's loader runs, which is the
 * right default for a fast load and badly wrong for a slow one: clicking a session leaves the
 * previous conversation sitting there, indistinguishable from a click that did nothing. Some
 * loads genuinely are slow — a session whose eve instance has to be consulted pays a network
 * round trip before it can render a single message.
 *
 * So: swap in a pending pane, but only once the wait is long enough to notice. Under the delay
 * the old pane stays put and the navigation just feels instant, which is the whole point — a
 * spinner that flashes for 40ms is worse than no spinner at all.
 */
const PENDING_PANE_DELAY_MS = 250;

function usePendingPane(openSessionId: string | null) {
  const navigation = useNavigation();
  const pendingId = navigation.location
    ? sessionIdFromPath(navigation.location.pathname)
    : null;
  // Only a move to a DIFFERENT session blanks the pane. A revalidation of the conversation on
  // screen (the FOH page does this on a timer) must never wipe what the user is reading.
  const switching =
    navigation.state === "loading" &&
    pendingId !== null &&
    pendingId !== openSessionId;
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!switching) {
      setShow(false);
      return;
    }
    const timer = setTimeout(() => setShow(true), PENDING_PANE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [switching]);

  return show;
}

function SessionPane({
  pending,
  basePath,
  children,
}: {
  pending: boolean;
  basePath: string;
  children: React.ReactNode;
}) {
  if (!pending) return <>{children}</>;
  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-busy="true">
      {/* Below md this pane has hidden the session list, and a wait here can run to several
          seconds (eve reconciliation) — without its own back control the user would be
          stranded on a spinner with no way out. */}
      <div className="flex h-14 shrink-0 items-center border-b px-4 md:hidden">
        <Button asChild variant="ghost" size="sm" className="-ml-2 px-1.5">
          <Link to={basePath} aria-label="Back to sessions">
            <ChevronLeft className="size-4" aria-hidden />
          </Link>
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Opening conversation…
        </p>
      </div>
    </section>
  );
}
