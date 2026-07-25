/**
 * Project overview — the repo-backed config surface for the ACTIVE roster member (PRD §7.9).
 *
 * Single-agent repos are teams of one: no switcher, the surface reads from `agent/` exactly
 * as before the split. Team repos get a member switcher (AgentNav), per-member surfaces
 * rooted at `agents/<member>/agent/`, and roster CRUD — add/remove members land as
 * change-sets (branch → PR) like every other edit; the roster row itself syncs on merge.
 */
import { getSessionAuth, sessionLoader } from "~/auth/session.server";
import { Bot, Boxes, FileText, Terminal, Users, Workflow, X } from "lucide-react";
import { useMemo, useState } from "react";
import {
  Link,
  data,
  redirect,
  useFetcher,
  useNavigation,
  useSubmit,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { NewResourceDialog } from "~/components/new-resource-dialog";
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
import { listDrafts } from "~/drafts/drafts.server";
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
import { proposeChange } from "~/github/write.server";
import { ensureWorkerStarted } from "~/jobs/worker.server";
import { contextPath } from "~/lib/paths";
import { useLiveRevalidate } from "~/lib/use-live-revalidate";
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

/** One member's deploy progress after a Ship — a ship moves the whole team (drives the banner). */
interface ShipStatusRow {
  agentName: string;
  version: string;
  status: string;
  url: string | null;
  errorDetail: string | null;
  environmentId: string;
  releaseId: string;
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
  /** Deploy progress for a just-shipped commit (?shipped=<sha>&env=<name>&skipped=a,b). */
  ship: { env: string; rows: ShipStatusRow[]; skipped: string[] } | null;
}

/**
 * Persists dismissal of the team-landing intro card (1yr, SameSite=Lax). Read server-side
 * in the loader — same pattern as the theme cookie — so dismissed users never see a flash.
 */
const TEAM_INTRO_COOKIE = "eden-team-intro-dismissed";

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
          ship: null,
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
          source.files["eden-lock.json"] ?? null,
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

        // Deploy status: what's running per environment (member header line) and — after a
        // Ship — per-member deploy progress for the shipped commit, so the banner survives
        // refreshes (state lives in the DB). The "running" line is member-scoped; the ?shipped
        // banner runs at BOTH levels so it works from the team landing and a member Overview
        // alike.
        let running: ProjectView["running"] = [];
        let ship: ProjectView["ship"] = null;
        // Cache the active member's envs so the member-scope shipped-row lookup reuses them.
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

        const url = new URL(args.request.url);
        const shippedSha = url.searchParams.get("shipped");
        if (shippedSha) {
          // At team view there's no single active member to default the env from, so fall back
          // to the ?env param or "default".
          const shipEnv =
            url.searchParams.get("env") ?? activeEnvs[0]?.name ?? "default";
          const shipSkipped = (url.searchParams.get("skipped") ?? "")
            .split(",")
            .filter(Boolean);
          // Members are independent — resolve their env + deployment rows concurrently.
          const rows = (
            await Promise.all(
              roster.map(async (member): Promise<ShipStatusRow | null> => {
                const memberEnvs =
                  view === "member" && member.id === active?.id
                    ? activeEnvs
                    : await listAgentEnvironments(member.id);
                const env = memberEnvs.find((e) => e.name === shipEnv);
                if (!env) return null;
                // Newest-first list; the first row at the shipped commit is the ship's
                // deploy (or its retry). Members untouched by the ship have no such row.
                const match = (await listDeployments(env.id)).find(
                  (d) => d.gitSha === shippedSha,
                );
                if (!match) return null;
                return {
                  agentName: member.name,
                  version: match.version,
                  status: match.status,
                  url: match.url,
                  errorDetail: match.errorDetail,
                  environmentId: env.id,
                  releaseId: match.releaseId,
                };
              }),
            )
          ).filter((r): r is ShipStatusRow => r !== null);
          if (rows.length > 0)
            ship = { env: shipEnv, rows, skipped: shipSkipped };
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
          ship,
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
          ship: null,
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
  const repo = { owner: project.repoOwner, repo: project.repoName };

  try {
    // Publishing lives in the header Publish control — the repos/<id>/publish resource route
    // owns the pipeline. This route keeps retry-deploy and roster CRUD, plus the ?shipped
    // banner its loader builds.

    // ── Retry a failed shipped deploy (same release, same environment) ──
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
      // "assistant" is reserved for Eden's built-in project-level assistant agent.
      if (name === "assistant") {
        return {
          error: `"assistant" is reserved for eden's built-in assistant — pick another name.`,
        };
      }
      const { roster } = await resolveAgentContext(project.id, null);
      if (roster.some((a) => a.name === name)) {
        return { error: `An agent named "${name}" already exists.` };
      }
      // No model is baked into the scaffold: the member resolves the workspace's configured
      // model (or its own override) from Eden at runtime, so it follows Org settings from
      // day one and model changes never touch the repo.
      const change = await proposeChange(project.repoInstallationId, repo, {
        base: project.defaultBranch,
        branch: `eden/add-member-${name}`,
        files: memberScaffold(name),
        title: `Add agent: ${name}`,
        body:
          `Scaffolds a new eve agent at \`agents/${name}/\` (instructions, agent.ts, a ` +
          `default sandbox, an example tool, package.json). eden picks the agent up on merge.`,
      });
      return {
        ok: true as const,
        changeUrl: change.pullRequestUrl,
        member: name,
      };
    }

    return { error: "Unknown action." };
  } catch (error) {
    if (error instanceof Response) throw error;
    return { error: (error as Error).message };
  }
}

export function meta() {
  return [{ title: "Project · eden" }, ...noindexMeta];
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
    ship,
  } = loaderData;
  const base = `/repos/${project.id}`;
  // The page's hierarchy level decides its tab set and where its links point (M5.8).
  const level = view === "team" ? "repo" : teamLayout ? "member" : "single";
  const ctx = contextPath(project.id, level === "member" ? active?.name : null);

  // Keep the deploy banner fresh without a manual refresh. Poll faster while a
  // ship is pending/building so the banner walks to live/failed; a slower baseline
  // poll runs regardless so a deploy STARTED after this page loaded is still
  // picked up rather than sitting stale until a manual refresh (issue #41).
  const shipInFlight = !!ship?.rows.some((r) =>
    ["queued", "pending", "building"].includes(r.status),
  );
  useLiveRevalidate({ active: shipInFlight });

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
                  eden can no longer read{" "}
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

      {ship && (
        <ShipProgress
          ship={ship}
          dismissTo={ctx}
          projectId={project.id}
          isTeam={isTeam}
        />
      )}

      {actionData?.ok && "changeUrl" in actionData && (
        <Alert className="mb-6">
          <AlertTitle>Change request opened</AlertTitle>
          <AlertDescription>
            The roster updates when the change merges.{" "}
            <Link
              to={`${ctx}/deployment`}
              className="font-medium underline underline-offset-4"
            >
              Review it on the Deployment tab →
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
            Publish {draftPaths.length === 1 ? "it" : "them"} with the Publish button in the
            header when you're ready.
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
              schedules, secrets, and deployments. Agents are versioned and
              deployed independently, and changes to several agents ship
              atomically in one change request.
            </p>
            <p className="mt-2">
              Teammates can delegate to each other: every agent gets an{" "}
              <em>ask-teammate</em> tool wired to the rest of the roster, so the
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

/** "Add member" → a change-set scaffolding agents/<name>/ (git-native roster CRUD). */
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
            Scaffolds a complete eve agent and opens a change request — the
            agent joins the roster when it merges.
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
            Open change request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Deploy progress for a shipped commit. Driven purely from deployment rows (via ?shipped=),
 * so it survives refreshes and walks pending → building → live/failed with the poller.
 */
function ShipProgress({
  ship,
  dismissTo,
  projectId,
  isTeam,
}: {
  ship: { env: string; rows: ShipStatusRow[]; skipped: string[] };
  dismissTo: string;
  projectId: string;
  isTeam: boolean;
}) {
  const retry = useFetcher();
  const failed = ship.rows.filter((r) => r.status === "failed");
  const allLive = ship.rows.every((r) => r.status === "live");
  const version = ship.rows[0]?.version ?? "";
  const single = ship.rows.length === 1;

  return (
    <Alert
      variant={failed.length > 0 ? "destructive" : "default"}
      className="mb-6"
    >
      <AlertTitle>
        {allLive
          ? `${version} is running on ${ship.env}`
          : failed.length > 0
            ? `${version} couldn't deploy to ${ship.env} — the previous version is still running`
            : `Shipping ${version} to ${ship.env}…`}
      </AlertTitle>
      <AlertDescription>
        <div className="mt-1 space-y-2">
          {ship.rows.map((r) => (
            <div
              key={r.environmentId}
              className="flex flex-wrap items-center gap-x-2 gap-y-1"
            >
              {!single && (
                <Link
                  to={contextPath(projectId, r.agentName)}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {r.agentName}:
                </Link>
              )}
              <ShipSteps status={r.status} version={r.version} />
              {/* `url` isn't the link target (it's an instance-internal address) — its
                  presence is the "there's a reachable instance" signal gating the
                  playground link. */}
              {r.status === "live" && r.url && (
                <Link
                  to={`${contextPath(projectId, isTeam ? r.agentName : null)}/playground`}
                  className="underline underline-offset-4"
                >
                  open
                </Link>
              )}
              {r.status === "failed" && (
                <retry.Form method="post">
                  <input type="hidden" name="intent" value="retry-deploy" />
                  <input
                    type="hidden"
                    name="environmentId"
                    value={r.environmentId}
                  />
                  <input type="hidden" name="releaseId" value={r.releaseId} />
                  <Button
                    type="submit"
                    size="sm"
                    variant="outline"
                    disabled={retry.state !== "idle"}
                  >
                    {retry.state !== "idle" ? "Retrying…" : "Retry"}
                  </Button>
                </retry.Form>
              )}
            </div>
          ))}
          {ship.skipped.length > 0 && (
            <p className="text-xs">
              Not deployed for{" "}
              {ship.skipped.map((name, i) => (
                <span key={name}>
                  {i > 0 && ", "}
                  <Link
                    to={contextPath(projectId, name)}
                    className="underline underline-offset-4"
                  >
                    {name}
                  </Link>
                </span>
              ))}{" "}
              — no environment named{" "}
              <span className="font-mono">{ship.env}</span>.
            </p>
          )}
          {failed.map(
            (r) =>
              r.errorDetail && (
                <p
                  key={`err-${r.environmentId}`}
                  className="whitespace-pre-wrap font-mono text-xs"
                >
                  {r.errorDetail}
                </p>
              ),
          )}
          {(allLive || failed.length > 0) && (
            <p>
              <Link
                to={dismissTo}
                className="text-xs underline underline-offset-4"
              >
                Dismiss
              </Link>
            </p>
          )}
        </div>
      </AlertDescription>
    </Alert>
  );
}

/** The pipeline as PM-readable steps: the sync stages are done by construction. */
function ShipSteps({ status, version }: { status: string; version: string }) {
  const stage =
    status === "live"
      ? "Running ✓"
      : status === "failed"
        ? "Failed ✗"
        : status === "building"
          ? "Building…"
          : status === "stopped" || status === "draining"
            ? "Superseded"
            : "Queued…";
  return (
    <span className="text-sm">
      Published ✓ <span className="text-muted-foreground">→</span> {version}{" "}
      created ✓ <span className="text-muted-foreground">→</span> {stage}
    </span>
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
          staged
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
          staged
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
                              staged
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
