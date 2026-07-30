/**
 * FOH middle pane — one team member's session list (D14: /t/:projectId/:agentId), needs-you
 * first with unread badges, `+ new session`, and the right pane as <Outlet/> (the index child
 * shows the no-session empty state; /s/:sessionId shows the conversation).
 */
import { ChevronLeft, Loader2, Plus, Settings2 } from "lucide-react";
import { useEffect, useState } from "react";
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
import { SessionList } from "~/components/foh/session-list";
import { Button } from "~/components/ui/button";
import { bohAgentHref } from "~/foh/boh-links";
import { requireFohProject } from "~/foh/guard.server";
import { cn } from "~/lib/utils";
import {
  countArchivedFohSessions,
  createPlaygroundSession,
  listFohSessionsForAgent,
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
  if (String(form.get("intent")) !== "new-session") {
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
        {archive.notice?.kind === "archived" && (
          <div className="flex items-center gap-2 border-b bg-muted/50 px-3 py-2 text-xs">
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              Session archived — {archive.notice.title}
            </span>
            <button
              type="button"
              className="shrink-0 font-medium underline underline-offset-4 hover:text-foreground"
              onClick={() => archive.undo()}
            >
              Undo
            </button>
          </div>
        )}
        {sessions.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            No sessions with {agentName} yet.
          </p>
        ) : (
          <SessionList
            sessions={sessions}
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
 * The undo strip is a courtesy, not a decision point — archiving is reversible from the
 * back-of-house shelf forever, so the strip gets out of the way on its own rather than
 * accumulating dismissed banners at the top of the list.
 */
const ARCHIVE_NOTICE_MS = 10_000;

type ArchiveNotice =
  | { kind: "archived"; sessionId: string; title: string }
  | { kind: "refused"; sessionId: string; message: string };

/**
 * FOH archive/undo (#278). Local state, not loader data: the FOH shell revalidates on a 10s
 * timer, which would wipe a strip that lived in the loader payload halfway through the undo
 * window. Each response REPLACES the notice outright, so a second archive can never leave the
 * first session's title on screen next to the second one's Undo.
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
  const [notice, setNotice] = useState<ArchiveNotice | null>(null);
  const result = fetcher.data;

  useEffect(() => {
    if (!result) return;
    if (!result.ok) {
      setNotice({
        kind: "refused",
        sessionId: result.sessionId,
        message: result.error,
      });
    } else if (result.intent === "unarchive") {
      setNotice(null);
    } else {
      setNotice({
        kind: "archived",
        sessionId: result.sessionId,
        title: result.title,
      });
    }
  }, [result]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), ARCHIVE_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  // The conversation the user is reading can be the one they just archived — the server now
  // 404s it, so step back to the list rather than let the revalidation break the pane.
  useEffect(() => {
    if (notice?.kind !== "archived" || notice.sessionId !== openSessionId)
      return;
    navigate(basePath, { replace: true });
  }, [notice, openSessionId, basePath, navigate]);

  const submit = (sessionId: string, intent: "archive" | "unarchive") => {
    setNotice(null);
    fetcher.submit(
      { intent, playgroundSessionId: sessionId },
      { method: "post", action: `/api/foh/${projectId}/archive` },
    );
  };

  return {
    notice,
    refusal:
      notice?.kind === "refused"
        ? { sessionId: notice.sessionId, message: notice.message }
        : null,
    pendingId:
      fetcher.state === "idle"
        ? null
        : (fetcher.formData?.get("playgroundSessionId")?.toString() ?? null),
    archive: (sessionId: string) => submit(sessionId, "archive"),
    undo: () => {
      if (notice?.kind === "archived") submit(notice.sessionId, "unarchive");
    },
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
