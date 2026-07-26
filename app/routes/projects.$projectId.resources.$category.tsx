/**
 * Resource category list — the management surface behind each overview card. Every file in
 * the category (repo + saved-new drafts) with last-commit metadata, open-in-editor, and a
 * git-native delete: removing a resource SAVES a deletion draft that rides with every other
 * saved change (one Publish takes them all live; a saved-only draft is just discarded).
 * Member-scoped (M5.8): team members' lists live at
 * /repos/:id/agents/:name/resources/:category; single-agent repos at the repo level.
 */
import { getSessionAuth, sessionLoader } from "~/auth/session.server";
import { MoreHorizontal } from "lucide-react";
import {
  Link,
  data,
  redirect,
  useNavigation,
  useSubmit,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { ConfirmDialog } from "~/components/confirm-dialog";
import { usePublishHref } from "~/components/publish";
import { RelativeTime } from "~/components/localized-values";
import { NewResourceDialog } from "~/components/new-resource-dialog";
import { categoryMeta } from "~/components/resource-category";
import {
  AgentNav,
  AppShell,
  PageHeader,
  accentChip,
  repoCrumbs,
} from "~/components/shell";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import {
  discardDrafts,
  listDrafts,
  stageDeletions,
} from "~/drafts/drafts.server";
import { buildAgentConfig } from "~/eve/parse";
import { RESOURCE_KINDS } from "~/eve/templates";
import { AGENT_CATEGORIES } from "~/eve/types";
import { getAgentSource, getLastCommitForPaths } from "~/github/cached.server";
import { fetchAgentSource, type LastCommitInfo } from "~/github/repo.server";
import { contextPath } from "~/lib/paths";
import { cn } from "~/lib/utils";
import {
  agentFromParams,
  agentParamRedirect,
  resolveAgentContext,
  requireActiveAgent,
} from "~/project/agent-context.server";
import { requireProject, requireRepo } from "~/project/guard.server";
import type { Route } from "./+types/projects.$projectId.resources.$category";

function categoryOf(param: string | undefined) {
  const cat = AGENT_CATEGORIES.find((c) => c.key === param);
  if (!cat) throw data("Unknown resource category", { status: 404 });
  return cat;
}

interface ResourceRow {
  name: string;
  path: string;
  isDirectory: boolean;
  staged: boolean;
  /** A deletion is saved (removed when the next publish lands). */
  stagedDelete: boolean;
  /** Exists in the repo (false == saved-new, not published anywhere yet). */
  inRepo: boolean;
  lastCommit: LastCommitInfo | null;
}

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }) => {
      const cat = categoryOf(args.params.category);
      const project = requireRepo(
        await requireProject(auth, args.params.projectId, {
          request: args.request,
        }),
      );
      const agentName = agentFromParams(args.params);
      if (!agentName) {
        const legacy = agentParamRedirect(args.request, project.id);
        if (legacy) throw legacy;
      }
      const { roster, active, isTeam } = await resolveAgentContext(
        project.id,
        agentName,
      );
      requireActiveAgent(active, project.id);
      // Teams have no repo-level resource lists — they exist only at the member level.
      if (isTeam && !agentName) throw redirect(`/repos/${project.id}`);
      const repo = { owner: project.repoOwner, repo: project.repoName };
      const [source, drafts] = await Promise.all([
        getAgentSource(project.repoInstallationId, repo),
        listDrafts(project.id),
      ]);

      const config = buildAgentConfig(source, active.root);
      const repoItems = config[cat.key];
      const draftPaths = new Set(drafts.map((d) => d.path));
      // Paths with a saved DELETION (content null) — directory resources save one per file.
      const deletionPaths = new Set(
        drafts.filter((d) => d.content === null).map((d) => d.path),
      );
      const stagedNew = drafts.flatMap((d) =>
        d.content !== null &&
        d.path.startsWith(`${active.root}/${cat.dir}/`) &&
        !repoItems.some((i) => i.path === d.path)
          ? [
              {
                name: d.path.split("/").pop()!,
                path: d.path,
                isDirectory: false,
              },
            ]
          : [],
      );

      // Last-commit metadata for repo-backed files only (best-effort; page renders without).
      const commitMeta = await getLastCommitForPaths(
        project.repoInstallationId,
        repo,
        repoItems.map((i) => i.path),
      );

      // A directory resource is "saved for deletion" when any file under it is.
      const deletionStaged = (item: { path: string; isDirectory: boolean }) =>
        item.isDirectory
          ? [...deletionPaths].some((p) => p.startsWith(`${item.path}/`))
          : deletionPaths.has(item.path);

      const rows: ResourceRow[] = [
        ...repoItems.map((i) => ({
          ...i,
          staged: draftPaths.has(i.path) || deletionStaged(i),
          stagedDelete: deletionStaged(i),
          inRepo: true,
          lastCommit: commitMeta[i.path] ?? null,
        })),
        ...stagedNew.map((i) => ({
          ...i,
          staged: true,
          stagedDelete: false,
          inRepo: false,
          lastCommit: null,
        })),
      ];

      return {
        project,
        category: { key: cat.key, label: cat.label },
        roster: roster.map((a) => ({ name: a.name })),
        activeAgent: active.name,
        activeRoot: active.root,
        isTeam,
        rows,
      };
    },
    { ensureSignedIn: true },
  );

export async function action(args: ActionFunctionArgs) {
  const auth = await getSessionAuth(args);
  if (!auth.user) throw redirect("/login");
  const cat = categoryOf(args.params.category);
  const project = requireRepo(
    await requireProject(auth, args.params.projectId),
  );

  const form = await args.request.formData();
  const intent = String(form.get("intent"));
  if (intent !== "delete-resource" && intent !== "undo-delete") {
    return { error: "Unknown action." };
  }
  const target = String(form.get("path") ?? "");
  const { active } = await resolveAgentContext(
    project.id,
    String(form.get("agent") ?? "") || null,
  );
  requireActiveAgent(active, project.id);
  // The path must be a resource of THIS member's category — no arbitrary deletions.
  if (
    !target.startsWith(`${active.root}/${cat.dir}/`) ||
    target.includes("..")
  ) {
    return { error: "Invalid resource path." };
  }

  const repo = { owner: project.repoOwner, repo: project.repoName };
  const name = target.split("/").pop()!;

  try {
    const [source, drafts] = await Promise.all([
      fetchAgentSource(project.repoInstallationId, repo),
      listDrafts(project.id),
    ]);
    // Directory resources delete every file under them; files delete themselves.
    const repoFiles = source.paths.filter(
      (p) => p === target || p.startsWith(`${target}/`),
    );
    const stagedHere = drafts.flatMap((d) =>
      d.path === target || d.path.startsWith(`${target}/`) ? [d.path] : [],
    );

    if (intent === "undo-delete") {
      // Unstage the deletion drafts — the resource is back to its repo state.
      if (stagedHere.length > 0) await discardDrafts(project.id, stagedHere);
      return { ok: true as const, restored: name };
    }

    if (repoFiles.length === 0) {
      // Saved-new only — never published; discarding the draft is the whole delete.
      if (stagedHere.length > 0) await discardDrafts(project.id, stagedHere);
      return { ok: true as const, discarded: name };
    }

    // Save the deletion (null-content drafts, one per file). It rides with every other
    // saved change — the header Publish control decides when it goes live. Saved edits on
    // these paths are superseded; saved-new files that never reached the repo are simply
    // discarded.
    const stagedNewHere = stagedHere.filter((p) => !repoFiles.includes(p));
    if (stagedNewHere.length > 0)
      await discardDrafts(project.id, stagedNewHere);
    await stageDeletions({
      projectId: project.id,
      paths: repoFiles,
      createdBy: auth.user.id,
    });
    return { ok: true as const, staged: name };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

export function meta({ params }: Route.MetaArgs) {
  const label =
    AGENT_CATEGORIES.find((c) => c.key === params.category)?.label ??
    "Resources";
  return [{ title: `${label} · harnesst` }];
}

const CATEGORY_HINTS: Record<string, string> = {
  tools: "TypeScript functions the agent can call",
  skills: "On-demand Markdown playbooks",
  subagents: "Specialist child agents this one delegates to",
  channels: "Entry points — HTTP, Slack, web chat",
  schedules: "Recurring cron-triggered runs",
  connections: "Typed external integrations",
};

export default function ResourceCategory({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { project, category, roster, activeAgent, activeRoot, isTeam, rows } =
    loaderData;
  const ctx = contextPath(project.id, isTeam ? activeAgent : null);
  const publishHref = usePublishHref();
  const submit = useSubmit();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const kind = RESOURCE_KINDS[category.key];
  const meta = categoryMeta(category.key);
  const CategoryIcon = meta.icon;

  return (
    <AppShell
      breadcrumbs={repoCrumbs({
        projectId: project.id,
        repoName: project.name,
        isTeam,
        agentName: activeAgent,
        tail: [{ label: category.label }],
      })}
    >
      <AgentNav
        base={ctx}
        level={isTeam ? "member" : "single"}
        roster={roster}
        activeAgent={isTeam ? activeAgent : undefined}
      />
      <PageHeader
        icon={meta.icon}
        accent={meta.accent}
        title={category.label}
        description={CATEGORY_HINTS[category.key]}
        actions={<NewResourceDialog kind={kind} base={ctx} root={activeRoot} />}
      />

      {actionData?.error && (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>Couldn&rsquo;t delete</AlertTitle>
          <AlertDescription>{actionData.error}</AlertDescription>
        </Alert>
      )}
      {actionData?.ok && "staged" in actionData && (
        <Alert className="mb-6">
          <AlertTitle>Deletion saved</AlertTitle>
          <AlertDescription>
            <span className="font-mono">{actionData.staged}</span> is marked for
            deletion — it rides with your other saved changes and nothing
            touches the repository until you publish.{" "}
            <Link
              to={publishHref}
              className="font-medium underline underline-offset-4"
            >
              Review &amp; publish →
            </Link>
          </AlertDescription>
        </Alert>
      )}
      {actionData?.ok && "restored" in actionData && (
        <Alert className="mb-6">
          <AlertTitle>Deletion undone</AlertTitle>
          <AlertDescription>
            <span className="font-mono">{actionData.restored}</span> is no
            longer marked for deletion.
          </AlertDescription>
        </Alert>
      )}
      {actionData?.ok && "discarded" in actionData && (
        <Alert className="mb-6">
          <AlertTitle>Draft discarded</AlertTitle>
          <AlertDescription>
            <span className="font-mono">{actionData.discarded}</span> was only
            a saved draft — it never reached the repository, so discarding it
            removed it entirely.
          </AlertDescription>
        </Alert>
      )}

      {rows.length === 0 ? (
        <Card className="border-dashed">
          <CardHeader className="items-center py-12 text-center">
            <span
              className={cn(
                "mx-auto mb-1 flex size-12 items-center justify-center rounded-full",
                accentChip[meta.accent],
              )}
            >
              <CategoryIcon className="size-6" aria-hidden />
            </span>
            <CardTitle className="text-lg">
              No {category.label.toLowerCase()} yet
            </CardTitle>
            <CardDescription>{CATEGORY_HINTS[category.key]}</CardDescription>
            <div className="mt-4">
              <NewResourceDialog kind={kind} base={ctx} root={activeRoot} />
            </div>
          </CardHeader>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last updated</TableHead>
                  <TableHead>By</TableHead>
                  <TableHead className="w-24 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.path}>
                    <TableCell>
                      {row.isDirectory ? (
                        <span className="font-mono">{row.name}/</span>
                      ) : (
                        <Link
                          to={`${ctx}/edit?path=${encodeURIComponent(row.path)}`}
                          className="font-mono underline-offset-4 hover:underline"
                        >
                          {row.name}
                        </Link>
                      )}
                    </TableCell>
                    <TableCell>
                      {row.stagedDelete ? (
                        <Badge variant="destructive" className="text-xs">
                          saved — delete
                        </Badge>
                      ) : row.staged ? (
                        <Badge variant="warning" className="text-xs">
                          {row.inRepo ? "saved edit" : "saved — new"}
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.lastCommit?.date ? (
                        <RelativeTime value={row.lastCommit.date} />
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.lastCommit?.authorLogin ??
                        row.lastCommit?.authorName ??
                        "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {!row.isDirectory && (
                          <Button variant="ghost" size="sm" asChild>
                            <Link
                              to={`${ctx}/edit?path=${encodeURIComponent(row.path)}`}
                            >
                              Open
                            </Link>
                          </Button>
                        )}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              aria-label={`More actions for ${row.name}`}
                              disabled={busy}
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {row.stagedDelete ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="w-full justify-start"
                                onClick={() =>
                                  submit(
                                    {
                                      intent: "undo-delete",
                                      path: row.path,
                                      agent: activeAgent,
                                    },
                                    { method: "post" },
                                  )
                                }
                              >
                                Undo delete
                              </Button>
                            ) : (
                              <ConfirmDialog
                                trigger={
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="w-full justify-start text-destructive hover:text-destructive"
                                  >
                                    Delete
                                  </Button>
                                }
                                title={`Delete ${row.name}?`}
                                description={
                                  row.inRepo
                                    ? `Saves the deletion of ${row.path}. It rides with your other saved changes — nothing is removed until you publish, and you can undo it any time before then.`
                                    : `${row.name} is only an unpublished draft — deleting discards it immediately.`
                                }
                                confirmLabel={
                                  row.inRepo
                                    ? "Save deletion"
                                    : "Discard draft"
                                }
                                onConfirm={() =>
                                  submit(
                                    {
                                      intent: "delete-resource",
                                      path: row.path,
                                      agent: activeAgent,
                                    },
                                    { method: "post" },
                                  )
                                }
                              />
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
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
