/**
 * Install a TEAM template: every roster agent lands as a new member of the chosen team repo in one
 * change-set, and the lock records role → member. Nothing is collected here beyond the target and
 * member names. Secrets, the ledger, GitHub Apps and connections are the setup wizard's job
 * (`/repos/:projectId/setup`), which this page hands off to after staging.
 *
 * Registered before `marketplace/:type/:id/install`, so `/marketplace/team/<id>/install` lands here.
 */
import { Boxes, Users } from "lucide-react";
import {
  Form,
  Link,
  data,
  redirect,
  useNavigate,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { getSessionAuth, sessionLoader } from "~/auth/session.server";
import { listAccessibleProjectIds } from "~/auth/project-access.server";
import { safeReturnTo } from "~/auth/return-to";
import {
  ensureWorkspace,
  requireWorkspaceAdmin,
  resolveActiveWorkspace,
} from "~/auth/workspace.server";
import { TYPE_META, TypeBadge } from "~/components/marketplace-type-badge";
import { AppShell, PageHeader, accentText } from "~/components/shell";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { listProjects } from "~/db/queries.server";
import { listDrafts, stageDraft } from "~/drafts/drafts.server";
import { getAgentSource } from "~/github/cached.server";
import { fetchAgentSource } from "~/github/repo.server";
import { resolveTemplate } from "~/marketplace/compose.server";
import { catalogLocator } from "~/marketplace/install.server";
import { overlayLock } from "~/marketplace/lock";
import { isTemplateSlug, type TemplateManifest } from "~/marketplace/manifest";
import { ensureProvisioning } from "~/marketplace/provisioning.server";
import { planTeamInstall } from "~/marketplace/team-install.server";
import { getWorkspaceAssistantSelection } from "~/org/workspace.server";
import { ownsWorkspaceModelReference } from "~/models/union.server";
import { resolveSyncedAgentContext } from "~/project/agent-context.server";
import { requireProject, requireRepo } from "~/project/guard.server";
import { getRuntime } from "~/seams/index.server";
import type { Route } from "./+types/marketplace.team.$id.install";

async function activeWorkspaceDefaultModel(orgId: string) {
  const selection = await getWorkspaceAssistantSelection(orgId).catch(() => ({
    model: null,
    effort: null,
  }));
  return selection.model &&
    (await ownsWorkspaceModelReference(orgId, selection.model))
    ? selection
    : { model: null, effort: null };
}

async function loadTeam(id: string) {
  const catalog = getRuntime().catalog;
  const team = await resolveTemplate(catalog, "team", id);
  const roster = team.manifest.roster ?? [];
  const agents = await Promise.all(
    roster.map((r) => resolveTemplate(catalog, "agent", r.agent)),
  );
  return { team, roster, agents };
}

/** Member names: the installer's (form or query `name.<role>`), else the roster default. */
function memberNames(
  roster: NonNullable<TemplateManifest["roster"]>,
  read: (key: string) => string | null,
): Record<string, string> {
  return Object.fromEntries(
    roster.map((r) => [
      r.role,
      (read(`name.${r.role}`) ?? "").trim() || r.name,
    ]),
  );
}

async function planFor(input: {
  projectId: string;
  orgId: string;
  fresh: boolean;
  installationId: Parameters<typeof getAgentSource>[0];
  repo: { owner: string; repo: string };
  loaded: Awaited<ReturnType<typeof loadTeam>>;
  names: Record<string, string>;
}) {
  const [source, drafts, workspaceModel] = await Promise.all([
    input.fresh
      ? fetchAgentSource(input.installationId, input.repo)
      : getAgentSource(input.installationId, input.repo),
    listDrafts(input.projectId),
    activeWorkspaceDefaultModel(input.orgId),
  ]);
  const ctx = await resolveSyncedAgentContext(
    input.projectId,
    null,
    source.paths,
  );
  const draftPaths = drafts.map((d) => ({ path: d.path, content: d.content }));
  const lock = overlayLock(
    source.files["harnesst-lock.json"] ?? null,
    draftPaths,
  );
  const { team, roster, agents } = input.loaded;
  const plan =
    ctx.isTeam && workspaceModel.model
      ? planTeamInstall({
          team,
          members: roster.map((r, i) => ({
            role: r.role,
            name: input.names[r.role],
            template: agents[i],
          })),
          registry: catalogLocator(),
          repoPaths: source.paths,
          drafts: draftPaths,
          lock,
          rosterNames: ctx.roster.map((a) => a.name),
          model: workspaceModel.model,
          effort: workspaceModel.effort,
        })
      : null;
  return {
    plan,
    isTeam: ctx.isTeam,
    missingModelDefault: workspaceModel.model === null,
  };
}

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(args, async ({ auth }) => {
    const id = args.params.id!;
    if (!isTemplateSlug(id)) throw data("Unknown template", { status: 404 });
    await ensureWorkspace(args.request, auth);
    const active = await resolveActiveWorkspace(auth);
    if (active) requireWorkspaceAdmin(active, "page");

    let loaded;
    try {
      loaded = await loadTeam(id);
    } catch (error) {
      console.warn(`[install] team ${id} failed to load:`, error);
      throw data(`Team ${id} isn't in the catalog.`, { status: 404 });
    }

    const url = new URL(args.request.url);
    const projectId = url.searchParams.get("project");
    const rawReturnTo = url.searchParams.get("returnTo");
    const returnTo = rawReturnTo ? safeReturnTo(rawReturnTo, "") || null : null;
    const names = memberNames(loaded.roster, (k) => url.searchParams.get(k));

    const org = active?.org;
    const all = org ? await listProjects(org.id) : [];
    const writable = active
      ? new Set(
          await listAccessibleProjectIds(
            {
              userId: auth.user.id,
              workspaceRole: active.member.role,
              orgId: active.org.id,
            },
            "write",
          ),
        )
      : new Set<string>();
    const projects = all
      .filter((p) => p.repoInstallationId && p.repoOwner && p.repoName)
      .filter((p) => writable.has(p.id))
      .map((p) => ({ id: p.id, name: p.name }));

    const roster = loaded.roster.map((r, i) => ({
      role: r.role,
      agentName: loaded.agents[i].manifest.name,
      description: loaded.agents[i].manifest.description,
      name: names[r.role],
    }));
    const base = {
      manifest: loaded.team.manifest as TemplateManifest,
      projects,
      selectedProjectId: projectId,
      returnTo,
      roster,
      isTeam: true,
      missingModelDefault: false,
      conflicts: [] as string[],
      files: 0,
    };
    if (!projectId) return base;

    const project = requireRepo(await requireProject(auth, projectId));
    const result = await planFor({
      projectId: project.id,
      orgId: project.orgId,
      fresh: false,
      installationId: project.repoInstallationId,
      repo: { owner: project.repoOwner, repo: project.repoName },
      loaded,
      names,
    });
    return {
      ...base,
      isTeam: result.isTeam,
      missingModelDefault: result.missingModelDefault,
      conflicts: result.plan?.conflicts ?? [],
      files: result.plan?.writes.length ?? 0,
    };
  });

export async function action(args: ActionFunctionArgs) {
  const auth = await getSessionAuth(args);
  if (!auth.user) throw redirect("/login");
  const id = args.params.id!;
  if (!isTemplateSlug(id)) throw data("Unknown template", { status: 404 });
  const form = await args.request.formData();
  if (String(form.get("intent")) !== "install")
    return { error: "Unknown action." };

  try {
    const project = requireRepo(
      await requireProject(auth, String(form.get("project") ?? "")),
    );
    const loaded = await loadTeam(id);
    const names = memberNames(loaded.roster, (k) => {
      const v = form.get(k);
      return typeof v === "string" ? v : null;
    });
    // Re-plan from a fresh read; never trust the preview.
    const result = await planFor({
      projectId: project.id,
      orgId: project.orgId,
      fresh: true,
      installationId: project.repoInstallationId,
      repo: { owner: project.repoOwner, repo: project.repoName },
      loaded,
      names,
    });
    if (!result.isTeam)
      return {
        error:
          "A team installs as new agents, and this is a single-agent repository. Pick a team repository.",
      };
    if (!result.plan)
      return {
        error:
          "Choose a connected workspace default model in Org settings before installing a team.",
      };
    if (result.plan.conflicts.length > 0)
      return {
        error: `Can't install the team:\n${result.plan.conflicts.join("\n")}`,
      };

    for (const write of result.plan.writes) {
      await stageDraft({
        projectId: project.id,
        path: write.path,
        content: write.content,
        createdBy: auth.user.id,
      });
    }
    if (
      result.plan.members.some((m) =>
        m.provisioning.includes("supabase-ledger"),
      )
    ) {
      await ensureProvisioning(project.id);
    }
    throw redirect(`/repos/${project.slug}/setup`);
  } catch (error) {
    if (error instanceof Response) throw error;
    return { error: (error as Error).message };
  }
}

export function meta() {
  return [{ title: "Install team · Marketplace · harnesst" }];
}

export default function TeamInstall({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const {
    user,
    manifest,
    projects,
    selectedProjectId,
    returnTo,
    roster,
    isTeam,
    missingModelDefault,
    conflicts,
  } = loaderData;
  const navigate = useNavigate();
  const busy = useNavigation().state !== "idle";
  const backTo = returnTo ?? `/marketplace/team/${manifest.id}`;
  const canSubmit =
    !!selectedProjectId && isTeam && !missingModelDefault && !busy;

  return (
    <AppShell userEmail={user.email}>
      <div className="mb-4">
        <Link
          to={backTo}
          prefetch="intent"
          className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          ← {returnTo ? "Back" : manifest.name}
        </Link>
      </div>

      <PageHeader
        icon={TYPE_META.team.icon}
        accent={TYPE_META.team.accent}
        title={
          <span className="flex flex-wrap items-center gap-3">
            Install {manifest.name}
            <TypeBadge type="team" />
          </span>
        }
        description={manifest.description}
      />

      {actionData?.error && (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>Couldn&rsquo;t install the team</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap">
            {actionData.error}
          </AlertDescription>
        </Alert>
      )}

      <Form method="post" className="space-y-6">
        <input type="hidden" name="intent" value="install" />
        <input type="hidden" name="project" value={selectedProjectId ?? ""} />

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Boxes className={`size-4 ${accentText.cyan}`} aria-hidden />
              Repository
            </CardTitle>
            <CardDescription>
              The team repository the agents are added to.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {projects.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No connected repositories yet.{" "}
                <Link to="/connect" className="underline underline-offset-4">
                  Connect one
                </Link>{" "}
                to install.
              </p>
            ) : (
              <Select
                value={selectedProjectId ?? undefined}
                onValueChange={(pid) =>
                  navigate(
                    `?${new URLSearchParams({
                      project: pid,
                      ...(returnTo ? { returnTo } : {}),
                    }).toString()}`,
                  )
                }
              >
                <SelectTrigger className="w-full max-w-sm">
                  <SelectValue placeholder="Pick a repository" />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {selectedProjectId && !isTeam && (
              <p className="text-sm text-destructive">
                This is a single-agent repository. A team needs a team
                repository.
              </p>
            )}
            {selectedProjectId && missingModelDefault && (
              <p className="text-sm text-destructive">
                Choose a connected workspace default model in{" "}
                <Link to="/settings/connections" className="underline">
                  Org settings
                </Link>{" "}
                first. New agents start on it.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className={`size-4 ${accentText.cyan}`} aria-hidden />
              Members
            </CardTitle>
            <CardDescription>
              One new agent per role. Rename any of them before installing.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {roster.map((m) => (
              <div
                key={m.role}
                className="grid gap-1.5 sm:grid-cols-3 sm:items-center"
              >
                <div className="sm:col-span-1">
                  <Label htmlFor={`name.${m.role}`}>{m.agentName}</Label>
                  <p className="text-xs text-muted-foreground">
                    Role: {m.role}
                  </p>
                </div>
                <Input
                  id={`name.${m.role}`}
                  name={`name.${m.role}`}
                  defaultValue={m.name}
                  className="sm:col-span-2 max-w-sm font-mono"
                />
              </div>
            ))}
            {conflicts.length > 0 && (
              <Alert variant="destructive">
                <AlertTitle>These names or files are taken</AlertTitle>
                <AlertDescription className="whitespace-pre-wrap font-mono text-xs">
                  {conflicts.join("\n")}
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={!canSubmit}>
            {busy ? "Installing…" : "Install team and continue to setup"}
          </Button>
          <p className="text-sm text-muted-foreground">
            Saved as unpublished changes. Setup walks you through the rest.
          </p>
        </div>
      </Form>
    </AppShell>
  );
}
