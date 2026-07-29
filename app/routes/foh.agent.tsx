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
  createPlaygroundSession,
  listFohSessionsForAgent,
  summarizePlaygroundSession,
} from "~/playground/sessions.server";
import { getRuntime } from "~/seams/index.server";
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
      const agent = await requireFohAgent(access.project.id, args.params.agentId);
      const sessions = await listFohSessionsForAgent({
        projectId: access.project.id,
        agentId: agent.id,
        viewerId: auth.user.id,
        includeAll: access.backOfHouse,
      });
      return {
        projectId: access.project.id,
        projectName: access.project.name,
        agentId: agent.id,
        agentName: agent.name,
        backOfHouse: access.backOfHouse,
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
  // form must not flood the table.
  if (existing.length >= 100) {
    return { error: "Too many conversations with this member — reuse one." };
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
  const { projectId, agentId, agentName, sessions, bohHref } = loaderData;
  const params = useParams();
  const newSessionFetcher = useFetcher<typeof action>();
  const basePath = `/t/${projectId}/${agentId}`;
  const openSessionId = params.sessionId ?? null;
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
            className="-ml-1 px-1.5 lg:hidden"
          >
            <Link to="/" aria-label="Back to team list">
              <ChevronLeft className="size-4" aria-hidden />
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
            sessions={sessions}
            basePath={basePath}
            selectedId={params.sessionId ?? null}
          />
        )}
      </section>
      <SessionPane pending={showPending} basePath={basePath}>
        <Outlet />
      </SessionPane>
    </>
  );
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
