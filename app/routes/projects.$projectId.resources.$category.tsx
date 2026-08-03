/**
 * Resource category list — the management surface behind each overview card. Every file in
 * the category (repo + saved-new drafts) with last-commit metadata, open-in-editor, and a
 * git-native delete: removing a resource SAVES a deletion draft that rides with every other
 * saved change (one Publish takes them all live; a saved-only draft is just discarded).
 * Member-scoped (M5.8): team members' lists live at
 * /repos/:id/agents/:name/resources/:category; single-agent repos at the repo level.
 *
 * A declared subagent is its own agent root (issue #344), so the same page serves
 * `…/sub/:subPath/resources/:category` — for the categories a subagent may author. Channels and
 * schedules are root-only, and the 404 for them is issued in the LOADER AND THE ACTION: a
 * category that isn't offered must not be reachable as a write surface either. The `subagents`
 * category is where nested subagents are created (`create-subagent`) and entered.
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
import { stageDraft } from "~/drafts/drafts.server";
import { orgResolverAgentName } from "~/eve/agentModule";
import { scaffoldOrgModelAgentModule } from "~/eve/org-model-module";
import { buildAgentConfig, overlayDrafts } from "~/eve/parse";
import { RESOURCE_KINDS, slugifyResourceName } from "~/eve/templates";
import {
  AGENT_CATEGORIES,
  categoriesFor,
  type AgentResource,
  type TargetKind,
} from "~/eve/types";
import { getAgentSource, getLastCommitForPaths } from "~/github/cached.server";
import { fetchAgentSource, type LastCommitInfo } from "~/github/repo.server";
import { contextPath, subagentContextPath } from "~/lib/paths";
import { cn } from "~/lib/utils";
import { agentFromParams, agentParamRedirect } from "~/project/agent-context.server";
import {
  resolveConfigTarget,
  subagentSegmentsFromParams,
} from "~/project/config-target.server";
import {
  confineToRoot,
  requireProject,
  requireRepo,
} from "~/project/guard.server";
import type { Route } from "./+types/projects.$projectId.resources.$category";

/**
 * The category this URL names, for THIS target — a root-only category (channels, schedules) is
 * a 404 at a subagent target, not merely a hidden card, so no write path exists for it either.
 */
function categoryOf(param: string | undefined, kind: TargetKind) {
  const cat = categoriesFor(kind).find((c) => c.key === param);
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
      const project = requireRepo(
        await requireProject(auth, args.params.projectId, {
          request: args.request,
        }),
      );
      const agentName = agentFromParams(args.params);
      const subSegments = subagentSegmentsFromParams(args.params);
      if (!agentName && !subSegments) {
        const legacy = agentParamRedirect(args.request, project.id);
        if (legacy) throw legacy;
      }
      const repo = { owner: project.repoOwner, repo: project.repoName };
      const [source, drafts] = await Promise.all([
        getAgentSource(project.repoInstallationId, repo),
        listDrafts(project.id),
      ]);
      const draftFiles = drafts.map((d) => ({
        path: d.path,
        content: d.content,
      }));
      const { roster, active, isTeam, target } = await resolveConfigTarget({
        projectId: project.id,
        agentName,
        subSegments,
        source,
        drafts: draftFiles,
      });
      const cat = categoryOf(args.params.category, target.kind);
      // Teams have no repo-level resource lists — they exist only at the member level.
      if (isTeam && !agentName) throw redirect(`/repos/${project.id}`);

      // Saved-but-unpublished work is part of what this page manages, so it parses the tree
      // with drafts applied: a subagent you created a minute ago is a directory row here.
      // ADDITIONS only — a resource saved for deletion must keep its row (badged, undoable)
      // until the publish that removes it actually lands.
      const config = buildAgentConfig(
        overlayDrafts(
          source,
          draftFiles.filter((d) => d.content !== null),
        ),
        target.root,
      );
      const repoItems = config[cat.key];
      const draftPaths = new Set(drafts.map((d) => d.path));
      // Paths with a saved DELETION (content null) — directory resources save one per file.
      const deletionPaths = new Set(
        drafts.filter((d) => d.content === null).map((d) => d.path),
      );
      const dir = `${target.root}/${cat.dir}/`;
      const stagedNew = drafts.flatMap((d) =>
        d.content !== null &&
        d.path.startsWith(dir) &&
        !d.path.slice(dir.length).includes("/") &&
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

      // A directory resource carries the state of the files under it: it is saved for deletion
      // when any of them is, saved-new when none of them is in the repo yet.
      const under = (paths: Iterable<string>, item: AgentResource) =>
        item.isDirectory
          ? [...paths].some((p) => p.startsWith(`${item.path}/`))
          : [...paths].includes(item.path);
      const deletionStaged = (item: AgentResource) => under(deletionPaths, item);
      const inRepo = (item: AgentResource) => under(source.paths, item);

      // Last-commit metadata for repo-backed files only (best-effort; page renders without).
      const commitMeta = await getLastCommitForPaths(
        project.repoInstallationId,
        repo,
        repoItems.filter((i) => !i.isDirectory && inRepo(i)).map((i) => i.path),
      );

      const rows: ResourceRow[] = [
        ...repoItems.map((i) => ({
          ...i,
          staged: under(draftPaths, i) || deletionStaged(i),
          stagedDelete: deletionStaged(i),
          inRepo: inRepo(i),
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
        activeRoot: target.root,
        subagentPath: target.kind === "subagent" ? target.subagentPath : [],
        isTeam,
        rows,
      };
    },
    { ensureSignedIn: true },
  );

/**
 * Delete / undo-delete a resource, and create a nested subagent.
 *
 * The target is derived from the URL (`:agentName`, `:subPath`), never from the form: a posted
 * member name would let one member's page save deletions inside another's tree. Every path the
 * action touches is then confined to this target's category directory.
 */
export async function action(args: ActionFunctionArgs) {
  const auth = await getSessionAuth(args);
  if (!auth.user) throw redirect("/login");
  const project = requireRepo(
    await requireProject(auth, args.params.projectId),
  );
  const repo = { owner: project.repoOwner, repo: project.repoName };

  const [source, drafts] = await Promise.all([
    fetchAgentSource(project.repoInstallationId, repo),
    listDrafts(project.id),
  ]);
  const draftFiles = drafts.map((d) => ({ path: d.path, content: d.content }));
  const { active, isTeam, target } = await resolveConfigTarget({
    projectId: project.id,
    agentName: agentFromParams(args.params),
    subSegments: subagentSegmentsFromParams(args.params),
    source,
    drafts: draftFiles,
  });
  const cat = categoryOf(args.params.category, target.kind);
  const dir = `${target.root}/${cat.dir}`;
  const member = isTeam ? active.name : null;
  const parentSegments = target.kind === "subagent" ? target.subagentPath : [];

  const form = await args.request.formData();
  const intent = String(form.get("intent"));

  if (intent === "create-subagent") {
    if (cat.key !== "subagents") return { error: "Unknown action." };
    const name = slugifyResourceName(String(form.get("name") ?? ""));
    if (!name || !/^[a-z0-9][\w.-]*$/.test(name)) {
      return { error: "Enter a name for the subagent." };
    }
    const root = `${dir}/${name}`;
    const taken = [
      ...source.paths,
      ...drafts.flatMap((d) => (d.content === null ? [] : [d.path])),
    ].some((p) => p === root || p.startsWith(`${root}/`));
    if (taken) return { error: `A subagent named ${name} already exists.` };

    try {
      // The scaffold names the PARENT member's resolver plus this subagent's own path, so it can
      // hold its own model selection and otherwise inherits (see `org-model-module`).
      const parentModule =
        overlayDrafts(source, draftFiles).files[
          `${target.deploymentRoot}/agent.ts`
        ];
      const resolverName =
        (parentModule ? orgResolverAgentName(parentModule) : null) ??
        active.name;
      const segments = [...parentSegments, name];
      await stageDraft({
        projectId: project.id,
        path: `${root}/agent.ts`,
        content: scaffoldOrgModelAgentModule(resolverName, {
          subagentPath: segments.join("/"),
        }),
        createdBy: auth.user.id,
      });
      await stageDraft({
        projectId: project.id,
        path: `${root}/instructions.md`,
        content: `# ${name}\n\nDescribe what this subagent is for and how it should work.\n`,
        createdBy: auth.user.id,
      });
    } catch (error) {
      return { error: (error as Error).message };
    }
    // Land on the new subagent's own configuration surface — it is an agent root now.
    throw redirect(subagentContextPath(project.id, member, [...parentSegments, name]));
  }

  if (intent !== "delete-resource" && intent !== "undo-delete") {
    return { error: "Unknown action." };
  }
  // The path must be a resource of THIS target's category — no arbitrary deletions.
  const path = confineToRoot(dir, String(form.get("path") ?? ""));
  if (!path || path === dir) return { error: "Invalid resource path." };

  const name = path.split("/").pop()!;

  try {
    // Directory resources delete every file under them; files delete themselves.
    const repoFiles = source.paths.filter(
      (p) => p === path || p.startsWith(`${path}/`),
    );
    const stagedHere = drafts.flatMap((d) =>
      d.path === path || d.path.startsWith(`${path}/`) ? [d.path] : [],
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
  hooks: "Handlers that observe the agent's runtime events",
};

export default function ResourceCategory({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const {
    project,
    category,
    roster,
    activeAgent,
    activeRoot,
    subagentPath,
    isTeam,
    rows,
  } = loaderData;
  const member = isTeam ? activeAgent : null;
  const ctx = subagentContextPath(project.id, member, subagentPath);
  // A subagents row is a directory that is its own agent root — it opens as a context, not a file.
  const subagentHref = (name: string) =>
    subagentContextPath(project.id, member, [...subagentPath, name]);
  const opensAsContext = (row: ResourceRow) =>
    category.key === "subagents" && row.isDirectory;
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
        subagentPath,
        tail: [{ label: category.label }],
      })}
    >
      <AgentNav
        base={ctx}
        level={
          subagentPath.length > 0 ? "subagent" : isTeam ? "member" : "single"
        }
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
                      {opensAsContext(row) ? (
                        <Link
                          to={subagentHref(row.name)}
                          className="font-mono underline-offset-4 hover:underline"
                        >
                          {row.name}/
                        </Link>
                      ) : row.isDirectory ? (
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
                        {opensAsContext(row) ? (
                          <Button variant="ghost" size="sm" asChild>
                            <Link to={subagentHref(row.name)}>Open</Link>
                          </Button>
                        ) : row.isDirectory ? null : (
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
                                    { intent: "undo-delete", path: row.path },
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
                                    { intent: "delete-resource", path: row.path },
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
