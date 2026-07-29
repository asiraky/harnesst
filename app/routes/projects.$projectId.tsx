/**
 * Project overview — the repo-backed config surface for the ACTIVE roster member (PRD §7.9).
 *
 * Single-agent repos are teams of one: no switcher, the surface reads from `agent/` exactly
 * as before the split. Team repos get a member switcher (AgentNav), per-member surfaces
 * rooted at `agents/<member>/agent/`, and roster CRUD — add/remove members save their file
 * set as drafts like every other edit; the roster row itself syncs when the publish lands.
 */
import { getSessionAuth, sessionLoader } from "~/auth/session.server";
import { Bot, Boxes, FileText, Terminal, Users, Workflow, X } from "lucide-react";
import { useMemo, useState } from "react";
import {
  Link,
  redirect,
  useNavigation,
  useSubmit,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { NewResourceDialog } from "~/components/new-resource-dialog";
import { usePublishHref } from "~/components/publish";
import { EmptyTeamState } from "~/components/empty-team-state";
import {
  AgentNav,
  AppShell,
  PageHeader,
  SectionHeader,
  accentChip,
  repoCrumbs,
} from "~/components/shell";
import { CATEGORY_META } from "~/components/resource-category";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  listAgentEnvironments,
  listReleases,
  type Agent,
} from "~/db/queries.server";
import {
  FreshnessBadge,
  releaseFreshness,
} from "~/components/deploy-freshness";
import { listDeployments, queueDeploy } from "~/deploy/controller.server";
import { listDrafts, stageDraft } from "~/drafts/drafts.server";
import { listAgentModelOverrides } from "~/models/agent-model-config.server";
import { buildAgentConfig, buildSubagentSummaries } from "~/eve/parse";
import {
  RESOURCE_KINDS,
  sandboxPath,
  slugifyResourceName,
} from "~/eve/templates";
import { AGENT_CATEGORIES, type AgentConfig, type SubagentSummary } from "~/eve/types";
import { memberScaffold } from "~/github/create.server";
import { getAgentSource } from "~/github/cached.server";
import { ensureWorkerStarted } from "~/jobs/worker.server";
import { contextPath } from "~/lib/paths";
import { RelativeTime } from "~/components/localized-values";
import { cn } from "~/lib/utils";
import { getWorkspaceAssistantModel } from "~/org/workspace.server";
import {
  agentFromParams,
  agentParamRedirect,
  resolveAgentContext,
  resolveSyncedAgentContext,
} from "~/project/agent-context.server";
import { agentRequiredSecretState } from "~/project/secrets.server";
import { overlayLock } from "~/marketplace/lock";
import { requireProject, requireRepo } from "~/project/guard.server";
import { isGithubReauthorizationError } from "~/github/installations.server";
import type { Project } from "~/db/queries.server";
import { noindexMeta } from "~/lib/seo";
import type { Route } from "./+types/projects.$projectId";

/** Roster card data for the team landing view. */
interface MemberSummary {
  name: string;
  model: string | null;
  tools: number;
  skills: number;
  schedules: number;
  channels: number;
  /** Read-only subagent children (issue #146): they run inside this member, not as roster peers. */
  subagents: SubagentSummary[];
  /** Template-required secrets still unset for this member (amber header badge, §7). */
  secretsMissing: number;
}

interface ProjectView {
  project: Project;
  roster: { name: string }[];
  active: Pick<Agent, "name" | "root"> | null;
  isTeam: boolean;
  /** True when the repo uses the team layout (agents/*) — enables roster CRUD. */
  teamLayout: boolean;
  /**
   * Which level of the hierarchy this request renders: the TEAM landing (roster-first,
   * no `?agent=`) or one MEMBER's config surface. Single-agent repos are always "member".
   */
  view: "team" | "member";
  /** Team landing: one summary per roster member. */
  members: MemberSummary[] | null;
  /** Team landing: whether the "this is a team" intro card was dismissed (cookie). */
  teamIntroDismissed: boolean;
  /** Member view: the active member's parsed config. */
  config: AgentConfig | null;
  error: string | null;
  /**
   * True when `error` is a GitHub reauthorization failure (installation missing/unverified) —
   * the repo can't be read until the App is reconnected, so the surface offers a Reconnect CTA
   * rather than dead-ending on the message.
   */
  needsReconnect: boolean;
  /** Paths with staged (unpublished) drafts, so the config surface can flag them. */
  draftPaths: string[];
  /** Member view: what's running per environment, for the header status line. */
  running: {
    envName: string;
    version: string;
    url: string | null;
    at: string;
    /** Whether this running version is the newest release for the member. */
    isLatest: boolean;
    /** The newest release's version label, shown when the running one is behind. */
    latestVersion: string;
  }[];
}

/**
 * Persists dismissal of the team-landing intro card (1yr, SameSite=Lax). Read server-side
 * in the loader — same pattern as the theme cookie — so dismissed users never see a flash.
 */
const TEAM_INTRO_COOKIE = "harnesst-team-intro-dismissed";

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }): Promise<ProjectView> => {
      const project = await requireProject(auth, args.params.projectId, {
        request: args.request,
      });

      if (
        !project.repoInstallationId ||
        !project.repoOwner ||
        !project.repoName
      ) {
        return {
          project,
          roster: [],
          active: null,
          isTeam: false,
          teamLayout: false,
          view: "member" as const,
          members: null,
          teamIntroDismissed: false,
          config: null,
          error: "This project has no connected repo.",
          needsReconnect: false,
          draftPaths: [],
          running: [],
        };
      }

      try {
        const [source, drafts] = await Promise.all([
          getAgentSource(project.repoInstallationId, {
            owner: project.repoOwner,
            repo: project.repoName,
          }),
          listDrafts(project.id),
        ]);

        // Self-heal the roster from the repo (external pushes don't always hit our webhook).
        const requestedAgent = agentFromParams(args.params);
        if (!requestedAgent) {
          const legacy = agentParamRedirect(args.request, project.id);
          if (legacy) throw legacy;
        }
        const { roster, active, isTeam } = await resolveSyncedAgentContext(
          project.id,
          requestedAgent,
          source.paths,
        );

        // Model badges are workspace configuration, resolved by agent name from the control
        // plane (per-agent override else the workspace default) — never parsed from agent.ts.
        const [orgDefaultModel, agentOverrides] = await Promise.all([
          getWorkspaceAssistantModel(project.orgId).catch(() => null),
          listAgentModelOverrides(project.orgId).catch(() => []),
        ]);
        const overrideModelByName = new Map(
          agentOverrides.map((o) => [o.agentName, o.model]),
        );
        const teamLayout = project.layout === "team";
        // The hierarchy: a team repo LANDS on the team (roster) view; a member's config
        // surface is a drill-in (?agent=<name>). Single-agent repos go straight to their
        // one member, exactly as before teams existed.
        const view =
          teamLayout && !requestedAgent
            ? ("team" as const)
            : ("member" as const);
        if (view === "member" && !active)
          throw redirect(`/repos/${project.id}`);
        const lock = overlayLock(
          source.files["harnesst-lock.json"] ?? null,
          drafts.map((d) => ({ path: d.path, content: d.content })),
        );
        const members =
          view === "team"
            ? await Promise.all(
                roster.map(async (a) => {
                  const c = buildAgentConfig(source, a.root);
                  const subagents = buildSubagentSummaries(source, a.root);
                  // "N secrets missing" (§7): template-required names still unset/unattached.
                  const requiredState = await agentRequiredSecretState({
                    projectId: project.id,
                    agentId: a.id,
                    memberName: a.name,
                    isTeam: true,
                    lock,
                  }).catch(() => ({ missing: [] }));
                  return {
                    name: a.name,
                    model: overrideModelByName.get(a.name) ?? orgDefaultModel,
                    tools: c.tools.length,
                    skills: c.skills.length,
                    schedules: c.schedules.length,
                    channels: c.channels.length,
                    subagents,
                    secretsMissing: requiredState.missing.length,
                  };
                }),
              )
            : null;
        const teamIntroDismissed = new RegExp(
          `(?:^|; )${TEAM_INTRO_COOKIE}=1`,
        ).test(args.request.headers.get("cookie") ?? "");

        const config =
          view === "member" && active
            ? buildAgentConfig(source, active.root)
            : null;
        const agentTsDraft = drafts.find(
          (d) =>
            active &&
            d.path === `${active.root}/agent.ts` &&
            d.content !== null,
        );
        // A staged agent.ts draft means the entrypoint exists even if the repo lacks it yet.
        if (config && agentTsDraft?.content) {
          config.hasAgentModule = true;
        }

        // Deploy status: what's running per environment (member header line).
        let running: ProjectView["running"] = [];
        const activeEnvs =
          view === "member" && active
            ? await listAgentEnvironments(active.id)
            : [];
        if (view === "member" && active) {
          // Newest-first releases for this member, so we can flag whether each
          // env is running the latest version (matches the deployment pipeline).
          const memberReleases = (await listReleases(project.id)).filter(
            (r) => r.agentId === active.id,
          );
          running = (
            await Promise.all(
              activeEnvs.map(async (env) => {
                const current = (await listDeployments(env.id)).find(
                  (d) => d.status === "live",
                );
                if (!current) return null;
                const f = releaseFreshness(current.releaseId, memberReleases);
                return {
                  envName: env.name,
                  version: current.version,
                  url: current.url,
                  at: current.createdAt.toISOString(),
                  isLatest: f?.isLatest ?? true,
                  latestVersion: f?.latestVersion ?? current.version,
                };
              }),
            )
          ).filter((r) => r !== null);
        }

        return {
          project,
          roster: roster.map((a) => ({ name: a.name })),
          active: active ? { name: active.name, root: active.root } : null,
          isTeam,
          teamLayout,
          view,
          members,
          teamIntroDismissed,
          config,
          error: null,
          needsReconnect: false,
          draftPaths: drafts.map((d) => d.path),
          running,
        };
      } catch (error) {
        if (error instanceof Response) throw error;
        return {
          project,
          roster: [],
          active: null,
          isTeam: false,
          teamLayout: false,
          view: "member" as const,
          members: null,
          teamIntroDismissed: false,
          config: null,
          error: (error as Error).message,
          needsReconnect: isGithubReauthorizationError(error),
          draftPaths: [],
          running: [],
        };
      }
    },
    { ensureSignedIn: true },
  );

export async function action(args: ActionFunctionArgs) {
  const auth = await getSessionAuth(args);
  if (!auth.user) throw redirect("/login");
  const project = requireRepo(
    await requireProject(auth, args.params.projectId),
  );

  const form = await args.request.formData();
  const intent = String(form.get("intent") ?? "");

  try {
    // Publishing lives on the Deployment tab — the repos/<id>/publish resource route
    // owns the pipeline. This route keeps retry-deploy and roster CRUD.

    // ── Retry a failed deploy (same release, same environment) ──
    if (intent === "retry-deploy") {
      ensureWorkerStarted();
      await queueDeploy({
        environmentId: String(form.get("environmentId")),
        releaseId: String(form.get("releaseId")),
        createdBy: auth.user.id,
      });
      return { ok: true as const };
    }

    // (Model and member removal moved to the Settings tab, M5.8.)

    // ── Add a team member: scaffold agents/<name>/ as a change-set ──
    if (intent === "add-member") {
      const name = slugifyResourceName(String(form.get("name") ?? ""));
      if (!name) return { error: "Agent name is required." };
      // "assistant" is reserved for harnesst's built-in project-level assistant agent.
      if (name === "assistant") {
        return {
          error: `"assistant" is reserved for harnesst's built-in assistant — pick another name.`,
        };
      }
      const { roster } = await resolveAgentContext(project.id, null);
      if (roster.some((a) => a.name === name)) {
        return { error: `An agent named "${name}" already exists.` };
      }
      // No model is baked into the scaffold: the member resolves the workspace's configured
      // model (or its own override) from harnesst at runtime, so it follows Org settings from
      // day one and model changes never touch the repo.
      // The scaffold is SAVED as drafts (§2.4: structural operations save their full file set
      // in one action) — the header Publish control takes the new agent live with everything
      // else, and the roster picks it up when the publish lands.
      for (const file of memberScaffold(name)) {
        await stageDraft({
          projectId: project.id,
          path: file.path,
          content: file.content,
          createdBy: auth.user.id,
        });
      }
      return { ok: true as const, member: name };
    }

    return { error: "Unknown action." };
  } catch (error) {
    if (error instanceof Response) throw error;
    return { error: (error as Error).message };
  }
}

export function meta() {
  return [{ title: "Project · harnesst" }, ...noindexMeta];
}

export default function ProjectDetail({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const {
    project,
    roster,
    active,
    isTeam,
    teamLayout,
    view,
    members,
    teamIntroDismissed,
    config,
    error,
    needsReconnect,
    draftPaths,
    running,
  } = loaderData;
  const publishHref = usePublishHref();
  const base = `/repos/${project.id}`;
  // The page's hierarchy level decides its tab set and where its links point (M5.8).
  const level = view === "team" ? "repo" : teamLayout ? "member" : "single";
  const ctx = contextPath(project.id, level === "member" ? active?.name : null);

  const repoLine =
    project.repoOwner && project.repoName ? (
      <span className="font-mono">
        {project.repoOwner}/{project.repoName} · {project.defaultBranch}
      </span>
    ) : (
      "no repo connected"
    );

  return (
    <AppShell
      breadcrumbs={repoCrumbs({
        projectId: project.id,
        repoName: project.name,
        isTeam: view === "member" && teamLayout,
        agentName: active?.name,
      })}
    >
      <AgentNav
        base={ctx}
        level={level}
        roster={roster}
        activeAgent={level === "member" ? active?.name : undefined}
      />
      {view === "team" ? (
        <PageHeader
          icon={Users}
          accent="brand"
          title={
            <span className="flex flex-wrap items-center gap-3">
              {project.name}
              <Badge>
                Team · {roster.length} agent{roster.length === 1 ? "" : "s"}
              </Badge>
            </span>
          }
          description={repoLine}
          actions={<AddMemberDialog />}
        />
      ) : (
        <PageHeader
          icon={Bot}
          accent="brand"
          title={teamLayout && active ? active.name : project.name}
          description={
            teamLayout ? (
              <span>
                Part of{" "}
                <Link
                  to={base}
                  className="font-medium underline underline-offset-4"
                >
                  {project.name}
                </Link>{" "}
                · {repoLine}
              </span>
            ) : (
              repoLine
            )
          }
        />
      )}
      {view === "member" && running.length > 0 && (
        <p className="-mt-4 mb-6 text-sm text-muted-foreground">
          {running.length === 1 ? (
            <>
              Running{" "}
              <span className="font-semibold text-foreground">
                {running[0].version}
              </span>{" "}
              <FreshnessBadge
                isLatest={running[0].isLatest}
                latestVersion={running[0].latestVersion}
                className="align-middle"
              />{" "}
              on {running[0].envName}
              {" · "}updated <RelativeTime value={running[0].at} />
              {/* `url` is instance-internal — its presence just gates the playground link. */}
              {running[0].url && (
                <>
                  {" · "}
                  <Link
                    to={`${ctx}/playground`}
                    className="underline underline-offset-4"
                  >
                    open
                  </Link>
                </>
              )}
            </>
          ) : (
            <>
              Running —{" "}
              {running.map((r, i) => (
                <span key={r.envName}>
                  {i > 0 && " · "}
                  {r.envName}:{" "}
                  <span className="font-semibold text-foreground">
                    {r.version}
                  </span>{" "}
                  <FreshnessBadge
                    isLatest={r.isLatest}
                    latestVersion={r.latestVersion}
                    className="align-middle"
                  />
                </span>
              ))}
            </>
          )}
          {" · "}
          <Link
            to={`${ctx}/deployment`}
            className="underline underline-offset-4"
          >
            View deployment →
          </Link>
        </p>
      )}

      {error && (
        <Alert className="mb-6" variant={needsReconnect ? "destructive" : "default"}>
          <AlertTitle>
            {needsReconnect
              ? "GitHub access needs reconnecting"
              : "Couldn’t read the repo"}
          </AlertTitle>
          <AlertDescription>
            {needsReconnect ? (
              <div className="space-y-3">
                <p>
                  harnesst can no longer read{" "}
                  <span className="font-mono">
                    {project.repoOwner}/{project.repoName}
                  </span>{" "}
                  — its GitHub App installation is missing or unverified.
                  Reconnect to re-authorize access.
                </p>
                <Button asChild size="sm">
                  <Link to="/connect">Reconnect GitHub</Link>
                </Button>
              </div>
            ) : (
              error
            )}
          </AlertDescription>
        </Alert>
      )}

      {actionData?.error && (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap">
            {actionData.error}
          </AlertDescription>
        </Alert>
      )}

      {actionData?.ok && "member" in actionData && (
        <Alert className="mb-6">
          <AlertTitle>{actionData.member} saved — not live yet</AlertTitle>
          <AlertDescription>
            The new agent&rsquo;s files are saved with your other changes.{" "}
            <Link
              to={publishHref}
              className="font-medium underline underline-offset-4"
            >
              Review &amp; publish →
            </Link>
          </AlertDescription>
        </Alert>
      )}

      {view === "member" && draftPaths.length > 0 && (
        <Alert className="mb-6">
          <AlertTitle>
            {draftPaths.length} saved change
            {draftPaths.length === 1 ? "" : "s"} not published yet
          </AlertTitle>
          <AlertDescription>
            {/* Link straight to the panel — this page has no Publish button of its own, and copy
                pointing at a control that isn't on screen sent people hunting. */}
            Nothing is live until you publish.{" "}
            <Link
              to={publishHref}
              className="font-medium underline underline-offset-4"
            >
              Review &amp; publish →
            </Link>
          </AlertDescription>
        </Alert>
      )}

      {view === "team" && members && (
        <TeamSurface
          base={base}
          members={members}
          introDismissed={teamIntroDismissed}
        />
      )}

      {view === "member" && config && active && (
        <AgentSurface
          config={config}
          ctx={ctx}
          root={active.root}
          draftPaths={draftPaths}
        />
      )}
    </AppShell>
  );
}

/**
 * The team landing view (PRD §7.9): the roster is the product surface. Each member is a
 * complete agent — own runtime, channels, schedules, credentials, releases — and this page
 * makes that hierarchy explicit before you drill into one member's config.
 */
function TeamSurface({
  base,
  members,
  introDismissed,
}: {
  base: string;
  members: MemberSummary[];
  introDismissed: boolean;
}) {
  const [showIntro, setShowIntro] = useState(!introDismissed);
  const dismissIntro = () => {
    document.cookie = `${TEAM_INTRO_COOKIE}=1; path=/; max-age=31536000; SameSite=Lax`;
    setShowIntro(false);
  };

  if (members.length === 0) {
    return <EmptyTeamState overviewHref={base} action={<AddMemberDialog />} />;
  }

  return (
    <div className="space-y-6">
      {showIntro && (
        <Card className="relative border-primary/20 bg-muted/30">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Dismiss"
            className="absolute right-2 top-2 h-7 w-7 text-muted-foreground"
            onClick={dismissIntro}
          >
            <X className="h-4 w-4" />
          </Button>
          <CardContent className="pt-6 pr-10 text-sm text-muted-foreground">
            <p>
              This is a{" "}
              <span className="font-medium text-foreground">team</span>: each
              one below is a complete agent with its own runtime, channels,
              schedules, secrets, and deployments. Agents are versioned
              independently, and one Publish takes every saved change live
              for the whole team at once.
            </p>
            <p className="mt-2">
              Teammates can delegate to each other: every agent gets{" "}
              <em>ask-teammate</em> and <em>tell-teammate</em> tools wired to
              the rest of the roster, so the
              team behaves like an organisation, not a folder of agents. Manage
              who can ask whom under{" "}
              <span className="font-medium text-foreground">
                Settings → Team collaboration
              </span>
              .
            </p>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {members.map((m) => (
          <Link
            key={m.name}
            to={`${base}/agents/${encodeURIComponent(m.name)}`}
            prefetch="intent"
            className="group"
          >
            <Card className="h-full transition-colors group-hover:border-ring/60">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="truncate text-base">{m.name}</CardTitle>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {m.secretsMissing > 0 && (
                      <Badge
                        variant="outline"
                        className="border-amber-500/60 text-xs text-amber-700 dark:text-amber-400"
                      >
                        {m.secretsMissing} secret
                        {m.secretsMissing === 1 ? "" : "s"} missing
                      </Badge>
                    )}
                    <Badge variant="secondary" className="font-mono text-xs">
                      {m.model ?? "no model"}
                    </Badge>
                  </span>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                  <li className="flex items-center gap-1.5">
                    <span
                      className="size-1.5 rounded-full bg-blue-500"
                      aria-hidden
                    />
                    {m.tools} tool{m.tools === 1 ? "" : "s"}
                  </li>
                  <li className="flex items-center gap-1.5">
                    <span
                      className="size-1.5 rounded-full bg-amber-500"
                      aria-hidden
                    />
                    {m.skills} skill{m.skills === 1 ? "" : "s"}
                  </li>
                  <li className="flex items-center gap-1.5">
                    <span
                      className="size-1.5 rounded-full bg-fuchsia-500"
                      aria-hidden
                    />
                    {m.subagents.length} subagent{m.subagents.length === 1 ? "" : "s"}
                  </li>
                  <li className="flex items-center gap-1.5">
                    <span
                      className="size-1.5 rounded-full bg-fuchsia-500"
                      aria-hidden
                    />
                    {m.schedules} schedule{m.schedules === 1 ? "" : "s"}
                  </li>
                  <li className="flex items-center gap-1.5">
                    <span
                      className="size-1.5 rounded-full bg-emerald-500"
                      aria-hidden
                    />
                    {m.channels} channel{m.channels === 1 ? "" : "s"}
                  </li>
                </ul>
                {m.subagents.length > 0 && (
                  <div className="mt-3 border-t pt-3">
                    <div className="mb-1.5 flex flex-wrap items-center gap-2">
                      <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                        <Workflow
                          className="size-3.5 text-fuchsia-500"
                          aria-hidden
                        />
                        Subagents
                      </span>
                      <Badge variant="outline" className="text-[10px]">
                        run inside {m.name}
                      </Badge>
                    </div>
                    <ul className="space-y-1">
                      {m.subagents.map((s) => (
                        <li
                          key={s.name}
                          className="flex items-baseline gap-2 text-sm"
                        >
                          <span className="shrink-0 font-mono">{s.name}</span>
                          {s.description && (
                            <span className="truncate text-xs text-muted-foreground">
                              {s.description}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}

/** "Add member" → saves a scaffold of agents/<name>/ as drafts (git-native roster CRUD). */
function AddMemberDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const slug = slugifyResourceName(name);
  const submit = useSubmit();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  const create = () => {
    if (!slug) return;
    setOpen(false);
    setName("");
    submit({ intent: "add-member", name: slug }, { method: "post" });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" disabled={busy}>
          Add agent
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add an agent</DialogTitle>
          <DialogDescription>
            Scaffolds a complete eve agent as saved changes — the agent joins
            the roster when you publish.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="new-member-name">Agent name</Label>
          <Input
            id="new-member-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                create();
              }
            }}
            placeholder="product-manager"
            autoFocus
          />
          <p className="text-xs text-muted-foreground">
            {slug ? (
              <>
                Creates <span className="font-mono">agents/{slug}/</span>
              </>
            ) : (
              "Names become kebab-case directory names."
            )}
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={create} disabled={!slug || busy}>
            Add agent
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One-line hint per category, so the config surface teaches the eve model as you scan it. */
const CATEGORY_HINTS: Record<string, string> = {
  tools: "TypeScript functions the agent can call",
  skills: "On-demand Markdown playbooks",
  subagents: "Specialist child agents this one delegates to",
  channels: "Entry points — HTTP, Slack, web chat",
  schedules: "Recurring cron-triggered runs",
  connections: "Typed external integrations",
};

/** How many items a category card previews before deferring to its list page. */
const CARD_PREVIEW_COUNT = 5;

function AgentSurface({
  config,
  ctx,
  root,
  draftPaths,
}: {
  config: AgentConfig;
  /** The member's base path (repo base for single-agent repos) — editor links hang off it. */
  ctx: string;
  /** Active member's agent directory ("agent" or "agents/<member>/agent"). */
  root: string;
  draftPaths: string[];
}) {
  const drafted = new Set(draftPaths);

  // Stable elements between renders (JSX props otherwise defeat memoized children).
  const instructionsStaged = drafted.has(`${root}/instructions.md`);
  const instructionsBadges = useMemo(
    () =>
      instructionsStaged ? (
        <Badge variant="outline" className="text-xs">
          saved
        </Badge>
      ) : null,
    [instructionsStaged],
  );

  // Sandbox is a singleton like instructions: the repo file wins; a staged NEW sandbox.ts
  // (draft not yet in the repo) still counts as a custom definition in progress.
  const sandboxFile = config.sandbox?.path ?? sandboxPath(root);
  const sandboxStaged = drafted.has(sandboxFile);
  const hasCustomSandbox = config.sandbox !== null || sandboxStaged;
  const sandboxBadges = useMemo(
    () =>
      sandboxStaged ? (
        <Badge variant="outline" className="text-xs">
          saved
        </Badge>
      ) : null,
    [sandboxStaged],
  );

  return (
    <div className="space-y-8">
      {/* Model moved to the Settings tab (M5.8). */}
      {/* Instructions — the always-on system prompt. */}
      <section>
        <SectionHeader
          icon={FileText}
          accent="blue"
          title="Instructions"
          badges={instructionsBadges}
          actions={
            <Button variant="outline" size="sm" asChild>
              <Link to={`${ctx}/edit/instructions`}>
                {config.instructions ? "Edit" : "Add instructions"}
              </Link>
            </Button>
          }
        />
        {config.instructions ? (
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/40 p-4 text-sm">
            {config.instructions}
          </pre>
        ) : (
          <p className="text-sm text-muted-foreground">
            No instructions.md yet — this Markdown becomes the agent&rsquo;s
            always-on system prompt.
          </p>
        )}
      </section>

      {/* Resources — at-a-glance cards; each category's list page is the management surface. */}
      <section>
        <SectionHeader icon={Boxes} accent="cyan" title="Resources" />
        <div className="grid gap-4 sm:grid-cols-2">
          {AGENT_CATEGORIES.map((cat) => {
            const meta = CATEGORY_META[cat.key];
            const CatIcon = meta.icon;
            const repoItems = config[cat.key];
            // Staged NEW files (drafts not yet in the repo) still belong in their category.
            const stagedNew = draftPaths.flatMap((p) =>
              p.startsWith(`${root}/${cat.dir}/`) &&
              !repoItems.some((i) => i.path === p)
                ? [{ path: p, name: p.split("/").pop()!, isDirectory: false }]
                : [],
            );
            const items = [...repoItems, ...stagedNew];
            const listTo = `${ctx}/resources/${cat.key}`;
            return (
              <Card key={cat.key}>
                <CardHeader className="space-y-1 pb-3">
                  <div className="flex items-center justify-between">
                    <Link to={listTo} className="group flex items-center gap-2">
                      <span
                        className={cn(
                          "flex size-6 shrink-0 items-center justify-center rounded-md",
                          accentChip[meta.accent],
                        )}
                      >
                        <CatIcon className="size-3.5" aria-hidden />
                      </span>
                      <CardTitle className="text-base underline-offset-4 group-hover:underline">
                        {cat.label}
                      </CardTitle>
                      <Badge variant="secondary">{items.length}</Badge>
                    </Link>
                    <NewResourceDialog
                      kind={RESOURCE_KINDS[cat.key]}
                      base={ctx}
                      root={root}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {CATEGORY_HINTS[cat.key]}
                  </p>
                </CardHeader>
                <CardContent className="pt-0">
                  {items.length === 0 ? (
                    <p className="text-sm text-muted-foreground">None</p>
                  ) : (
                    <ul className="space-y-1 text-sm">
                      {items.slice(0, CARD_PREVIEW_COUNT).map((item) => (
                        <li key={item.path} className="flex items-center gap-2">
                          {item.isDirectory ? (
                            <span className="font-mono text-muted-foreground">
                              {item.name}/
                            </span>
                          ) : (
                            <Link
                              to={`${ctx}/edit?path=${encodeURIComponent(item.path)}`}
                              className="font-mono underline-offset-4 hover:underline"
                            >
                              {item.name}
                            </Link>
                          )}
                          {drafted.has(item.path) && (
                            <Badge variant="outline" className="text-xs">
                              saved
                            </Badge>
                          )}
                        </li>
                      ))}
                      {items.length > CARD_PREVIEW_COUNT && (
                        <li className="text-xs text-muted-foreground">
                          +{items.length - CARD_PREVIEW_COUNT} more
                        </li>
                      )}
                    </ul>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

      {/* Sandbox — the isolated shell the agent's bash/file tools run in (one per agent). */}
      <section>
        <SectionHeader
          icon={Terminal}
          accent="brand"
          title="Sandbox"
          badges={sandboxBadges}
          actions={
            <Button variant="outline" size="sm" asChild>
              <Link to={`${ctx}/edit?path=${encodeURIComponent(sandboxFile)}`}>
                {hasCustomSandbox ? "Edit" : "Customize"}
              </Link>
            </Button>
          }
        />
        {hasCustomSandbox ? (
          <p className="text-sm text-muted-foreground">
            Custom definition at{" "}
            <span className="font-mono text-foreground">{sandboxFile}</span>
            {config.sandbox?.hasWorkspace && (
              <>
                {" "}
                · seeds files from{" "}
                <span className="font-mono">sandbox/workspace/</span>
              </>
            )}
            . Its bootstrap runs once and is snapshotted into a reusable
            template every session starts from.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Framework default — an isolated shell for the agent&rsquo;s bash and
            file tools. Customize it to preinstall CLIs at bootstrap or to
            forward secrets marked for the sandbox (Settings → Secrets).
          </p>
        )}
      </section>
    </div>
  );
}
