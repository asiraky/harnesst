/**
 * FOH middle pane — one team member's session list (D14: /t/:projectId/:agentId), needs-you
 * first with unread badges, `+ new session`, and the right pane as <Outlet/> (the index child
 * shows the no-session empty state; /s/:sessionId shows the conversation).
 */
import { Plus } from "lucide-react";
import {
  data,
  redirect,
  useFetcher,
  useParams,
  Outlet,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { getSessionAuth, sessionLoader } from "~/auth/session.server";
import { SessionList } from "~/components/foh/session-list";
import { Button } from "~/components/ui/button";
import { requireFohProject } from "~/foh/guard.server";
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
  const { projectId, agentId, agentName, sessions } = loaderData;
  const params = useParams();
  const newSessionFetcher = useFetcher<typeof action>();
  const basePath = `/t/${projectId}/${agentId}`;

  return (
    <>
      <section className="flex w-72 shrink-0 flex-col border-r">
        <div className="flex h-14 items-center gap-2 border-b px-3">
          <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">
            {agentName} — sessions
          </h1>
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
      <Outlet />
    </>
  );
}
