/**
 * Archived FOH conversations for one repository (#278) — the back-of-house half of the two-tier
 * lifecycle. Front of house can only archive (reversible, no dialog); this page is where an
 * admin/owner restores a conversation or deletes it for good.
 *
 * Deliberately NOT a section tab (shell.tsx TABS): it is a tidying surface, not a place you
 * work. It is reachable from the "N archived" link in the FOH session list and from one row on
 * the repository's Settings tab, so it stays findable without being a fifth thing to scan past.
 * Metadata only — restoring is how you read a conversation again.
 */
import { getSessionAuth, sessionLoader } from "~/auth/session.server";
import { Archive } from "lucide-react";
import {
  redirect,
  useNavigation,
  useSubmit,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { ConfirmDialog } from "~/components/confirm-dialog";
import { RelativeTime } from "~/components/localized-values";
import { AppShell, PageHeader, repoCrumbs } from "~/components/shell";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import {
  deleteFohSessionPermanently,
  listArchivedFohSessions,
  restoreFohSession,
} from "~/playground/sessions.server";
import { requireProject } from "~/project/guard.server";
import type { Route } from "./+types/projects.$projectId.sessions.archived";

export function meta() {
  return [{ title: "Archived conversations · harnesst" }];
}

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }) => {
      const project = await requireProject(auth, args.params.projectId, {
        request: args.request,
      });
      return {
        project: { id: project.id, name: project.name },
        sessions: await listArchivedFohSessions(project.id),
      };
    },
    { ensureSignedIn: true },
  );

export async function action(args: ActionFunctionArgs) {
  const auth = await getSessionAuth(args);
  if (!auth.user) throw redirect("/login");
  // No `{ request }`: a stale tab POSTing here must hit the hard 403, not a silent redirect.
  const project = await requireProject(auth, args.params.projectId);
  const form = await args.request.formData();
  const intent = String(form.get("intent") ?? "");
  const sessionId = String(form.get("sessionId") ?? "");
  if (!sessionId) return { error: "Pick a conversation first." };

  // requireProject has already enforced back-of-house; the helpers still take the flag so they
  // can never be reached from a front-of-house path by accident.
  if (intent === "restore") {
    const session = await restoreFohSession({
      id: sessionId,
      projectId: project.id,
      backOfHouse: true,
    });
    if (!session) return { error: "That conversation is no longer archived." };
    return { ok: true as const, restored: sessionTitle(session.title) };
  }

  if (intent === "delete-permanently") {
    const deleted = await deleteFohSessionPermanently({
      id: sessionId,
      projectId: project.id,
      backOfHouse: true,
    });
    if (!deleted) return { error: "That conversation is no longer archived." };
    // The row is gone, so its title can only come from the page that submitted — it is echoed
    // back as plain text purely so the confirmation names what just went.
    return { ok: true as const, deleted: sessionTitle(form.get("title")) };
  }

  return { error: "Unknown action." };
}

/** Untitled conversations exist (a park that never got a title) — never render a blank cell. */
function sessionTitle(value: unknown): string {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : "Untitled conversation";
}

export default function ArchivedSessionsPage({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { project, sessions } = loaderData;
  const submit = useSubmit();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <AppShell
      breadcrumbs={repoCrumbs({
        projectId: project.id,
        repoName: project.name,
        tail: [{ label: "Archived conversations" }],
      })}
    >
      <PageHeader
        title="Archived conversations"
        description="Conversations someone tidied away from the front of house. Restore one to put it back in the member's list, or delete it permanently — deleting also removes its transcript and cannot be undone."
      />

      {actionData?.error && (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>Couldn&rsquo;t do that</AlertTitle>
          <AlertDescription>{actionData.error}</AlertDescription>
        </Alert>
      )}
      {actionData?.ok && "restored" in actionData && (
        <Alert className="mb-6">
          <AlertTitle>Conversation restored</AlertTitle>
          <AlertDescription>
            {actionData.restored} is back in the front of house.
          </AlertDescription>
        </Alert>
      )}
      {actionData?.ok && "deleted" in actionData && (
        <Alert className="mb-6">
          <AlertTitle>Conversation deleted</AlertTitle>
          <AlertDescription>
            {actionData.deleted} and its transcript are gone for good.
          </AlertDescription>
        </Alert>
      )}

      {sessions.length === 0 ? (
        <Card className="border-dashed">
          <CardHeader className="items-center py-12 text-center">
            <div className="mx-auto mb-1 flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Archive className="size-6" aria-hidden />
            </div>
            <CardTitle className="text-lg">Nothing archived</CardTitle>
            <CardDescription>
              When someone archives a conversation from the front of house it
              lands here, where it can be restored or deleted for good.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Conversation</TableHead>
                  <TableHead>Member</TableHead>
                  <TableHead>Opened by</TableHead>
                  <TableHead>Archived</TableHead>
                  <TableHead>Last activity</TableHead>
                  <TableHead className="w-56 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((session) => {
                  const title = sessionTitle(session.title);
                  return (
                    <TableRow key={session.id}>
                      <TableCell className="font-medium">{title}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {session.agentName}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {session.openedBy}
                        {session.openedByAgent && " (agent)"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        <RelativeTime value={session.archivedAt} />
                        {session.archivedBy && ` by ${session.archivedBy}`}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        <RelativeTime
                          value={session.lastEventAt ?? session.updatedAt}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              submit(
                                { intent: "restore", sessionId: session.id },
                                { method: "post" },
                              )
                            }
                          >
                            Restore
                          </Button>
                          <ConfirmDialog
                            trigger={
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-destructive hover:text-destructive"
                                disabled={busy}
                              >
                                Delete
                              </Button>
                            }
                            title="Delete this conversation permanently?"
                            description={`${title} — opened by ${session.openedBy} with ${session.agentName} — and its whole transcript are deleted from harnesst. This cannot be undone.`}
                            confirmLabel="Delete permanently"
                            onConfirm={() =>
                              submit(
                                {
                                  intent: "delete-permanently",
                                  sessionId: session.id,
                                  title,
                                },
                                { method: "post" },
                              )
                            }
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </AppShell>
  );
}
