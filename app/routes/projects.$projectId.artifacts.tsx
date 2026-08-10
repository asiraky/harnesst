/**
 * Published artifacts for one repository (#370) — the back-of-house surface where public share
 * links are managed. Every artifact the repo's agents ever published is here, session-attached and
 * session-less alike; for a background publish this page is the ONLY place it surfaces, since by
 * definition it landed in no conversation.
 *
 * The actions are the share-token lifecycle and nothing else: revoke (the link 404s on the next
 * request), and generate/rotate (a fresh token, the old one dead in the same statement). The
 * artifact itself is never deleted here — cards in conversations point at these rows, and the
 * conversation lifecycle owns their deletion (cascade from the session).
 */
import { getSessionAuth, sessionLoader } from "~/auth/session.server";
import { FileBox } from "lucide-react";
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
import { artifactShareUrl } from "~/foh/artifacts.server";
import {
  listProjectArtifacts,
  regenerateArtifactShareToken,
  revokeArtifactShareToken,
} from "~/foh/artifact-store.server";
import { requireProject } from "~/project/guard.server";
import type { Route } from "./+types/projects.$projectId.artifacts";

export function meta() {
  return [{ title: "Published artifacts · harnesst" }];
}

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }) => {
      const project = await requireProject(auth, args.params.projectId, {
        request: args.request,
      });
      const artifacts = await listProjectArtifacts(project.id);
      return {
        project: { id: project.id, name: project.name },
        artifacts: artifacts.map((artifact) => ({
          id: artifact.id,
          name: artifact.name,
          title: artifact.title,
          kind: artifact.kind,
          attached: artifact.sessionId !== null,
          versionNumber: artifact.versionNumber,
          byteSize: artifact.byteSize,
          createdAt: artifact.createdAt,
          shareUrl: artifactShareUrl(artifact.shareToken),
        })),
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
  const artifactId = String(form.get("artifactId") ?? "");
  if (!artifactId) return { error: "Pick an artifact first." };

  // requireProject already scoped the caller to this repo; the store helpers put the project in
  // the WHERE anyway, so an id from another tenant updates nothing and reads as gone.
  if (intent === "revoke") {
    const artifact = await revokeArtifactShareToken({
      id: artifactId,
      projectId: project.id,
    });
    if (!artifact) return { error: "That artifact no longer exists." };
    return { ok: true as const, revoked: artifact.name };
  }

  if (intent === "regenerate") {
    const artifact = await regenerateArtifactShareToken({
      id: artifactId,
      projectId: project.id,
    });
    if (!artifact) return { error: "That artifact no longer exists." };
    return {
      ok: true as const,
      regenerated: artifact.name,
      shareUrl: artifactShareUrl(artifact.shareToken),
    };
  }

  return { error: "Unknown action." };
}

function kindLabel(kind: string): string {
  if (kind === "html") return "Page";
  if (kind === "document") return "Document";
  return "Image";
}

function sizeLabel(byteSize: number): string {
  if (byteSize >= 1024 * 1024)
    return `${(byteSize / (1024 * 1024)).toFixed(1)} MB`;
  if (byteSize >= 1024) return `${Math.round(byteSize / 1024)} KB`;
  return `${byteSize} B`;
}

export default function ProjectArtifactsPage({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { project, artifacts } = loaderData;
  const submit = useSubmit();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <AppShell
      breadcrumbs={repoCrumbs({
        projectId: project.id,
        repoName: project.name,
        tail: [{ label: "Published artifacts" }],
      })}
    >
      <PageHeader
        title="Published artifacts"
        description="Everything this repository's agents have published — including files published by background runs, which appear only here. Each artifact's public link opens its newest version for anyone holding the URL, with no sign-in; revoke a link to kill it, or rotate it to invalidate every copy in the wild."
      />

      {actionData?.error && (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>Couldn&rsquo;t do that</AlertTitle>
          <AlertDescription>{actionData.error}</AlertDescription>
        </Alert>
      )}
      {actionData?.ok && "revoked" in actionData && (
        <Alert className="mb-6">
          <AlertTitle>Link revoked</AlertTitle>
          <AlertDescription>
            The public link for {actionData.revoked} no longer works.
          </AlertDescription>
        </Alert>
      )}
      {actionData?.ok && "regenerated" in actionData && (
        <Alert className="mb-6">
          <AlertTitle>New link created</AlertTitle>
          <AlertDescription>
            {actionData.regenerated} has a fresh public link; any previous link
            is dead.
          </AlertDescription>
        </Alert>
      )}

      {artifacts.length === 0 ? (
        <Card className="border-dashed">
          <CardHeader className="items-center py-12 text-center">
            <div className="mx-auto mb-1 flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <FileBox className="size-6" aria-hidden />
            </div>
            <CardTitle className="text-lg">Nothing published yet</CardTitle>
            <CardDescription>
              When an agent publishes an image, page or document — from a
              conversation or a background run — it appears here with its
              public share link.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Published</TableHead>
                  <TableHead className="w-64 text-right">Public link</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {artifacts.map((artifact) => (
                  <TableRow key={artifact.id}>
                    <TableCell className="font-medium">
                      {artifact.name}
                      {artifact.title && (
                        <div className="text-xs text-muted-foreground">
                          {artifact.title}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {kindLabel(artifact.kind)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {artifact.attached ? "Conversation" : "Background run"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      v{artifact.versionNumber}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {sizeLabel(artifact.byteSize)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      <RelativeTime value={artifact.createdAt} />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {artifact.shareUrl ? (
                          <>
                            <Button variant="ghost" size="sm" asChild>
                              <a
                                href={artifact.shareUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Open
                              </a>
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy}
                              onClick={() =>
                                submit(
                                  {
                                    intent: "regenerate",
                                    artifactId: artifact.id,
                                  },
                                  { method: "post" },
                                )
                              }
                            >
                              Rotate
                            </Button>
                            <ConfirmDialog
                              trigger={
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="text-destructive hover:text-destructive"
                                  disabled={busy}
                                >
                                  Revoke
                                </Button>
                              }
                              title="Revoke this public link?"
                              description={`Anyone holding the link for ${artifact.name} loses access immediately. You can create a new link later.`}
                              confirmLabel="Revoke link"
                              onConfirm={() =>
                                submit(
                                  { intent: "revoke", artifactId: artifact.id },
                                  { method: "post" },
                                )
                              }
                            />
                          </>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              submit(
                                {
                                  intent: "regenerate",
                                  artifactId: artifact.id,
                                },
                                { method: "post" },
                              )
                            }
                          >
                            Create link
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </AppShell>
  );
}
