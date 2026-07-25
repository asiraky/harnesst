/**
 * Deployment — the whole pipeline on one tab (M5.8; Deploy + Review pillars, PRD §7.3/§7.4/§7.7).
 *
 * SHIP makes versions (Overview); this tab is everything after an edit exists:
 *   staged changes → change request → merge (cuts a version) → environments running versions.
 *
 * The TEAM is the deployment unit. Deploys ACT on an ENVIRONMENT and move the whole roster; the
 * only question a user answers is "which environment", never "which agent". Env CRUD and
 * deploy-a-version are therefore team-level. Skew across environments is fine (staging ahead of
 * prod); skew WITHIN an environment is eliminated.
 *
 * Two layouts over one module (route ids `deployment` + `member-deployment`), gated by a `canAct`
 * flag = the team-level acting surface:
 *  - REPO / TEAM view (team repos at /repos/:id/deployment): the acting surface — staged drafts
 *    grouped by member, change requests + Merge, an Environments card (one row per team env NAME
 *    with each member's running version) with team CRUD, and a Version history of TEAM versions
 *    (grouped by commit) with a per-environment Deploy that moves the whole team.
 *  - MEMBER view (team members at /repos/:id/agents/:name/deployment): OBSERVE-only for deploy
 *    concerns — the member's running versions and version history, no deploy/CRUD buttons (staged
 *    changes + change requests stay actionable everywhere; they're edit flow, not deploy flow).
 *  - SINGLE (single-agent repos at /repos/:id/deployment, level 'single'): a team of one, so it
 *    renders the member layout with canAct=true — the same team-scoped intents, roster of one.
 */
import { getSessionAuth, sessionLoader } from "~/auth/session.server";
import {
  Cable,
  FileStack,
  GitPullRequest,
  History,
  MessageSquare,
  Rocket,
  Server,
  type LucideIcon,
} from "lucide-react";
import { useRef, useState } from "react";
import {
  Form,
  Link,
  redirect,
  useFetcher,
  useNavigation,
  useSearchParams,
  useSubmit,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { ConfirmDialog } from "~/components/confirm-dialog";
import { EmptyTeamState } from "~/components/empty-team-state";
import {
  FreshnessBadge,
  releaseFreshness,
} from "~/components/deploy-freshness";
import {
  AgentNav,
  AppShell,
  PageHeader,
  accentChip,
  repoCrumbs,
  type Accent,
  type NavLevel,
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import {
  clearFailedDeployments,
  listDeployments,
  queueDeploy,
} from "~/deploy/controller.server";
import {
  createTeamEnvironment,
  deleteTeamEnvironment,
  listTeamEnvNames,
  renameTeamEnvironment,
} from "~/deploy/environments.server";
import { deployTeamVersion } from "~/deploy/ship.server";
import {
  listAgentEnvironments,
  listEnvironments,
  listReleases,
} from "~/db/queries.server";
import {
  discardDrafts,
  findOrphanedDrafts,
  listDrafts,
  stageDraft,
} from "~/drafts/drafts.server";
import { getAgentSource, getOpenChanges } from "~/github/cached.server";
import { fetchAgentSource } from "~/github/repo.server";
import {
  findStoredAppCredentialConflict,
  listAppCredentialRows,
  listAppInstallations,
  type AppInstallation,
} from "~/github/app-manifest.server";
import { closePullRequest } from "~/github/write.server";
import { getDiscordAppConfig } from "~/discord/config.server";
import { listConnectionsForAgent } from "~/discord/connections.server";
import {
  capabilityChoicesByProvider,
  setSelectedCapabilityGroups,
} from "~/capabilities/enablement";
import { getCapability } from "~/capabilities/registry.server";
import { getProviderOAuthConfig } from "~/connections/config.server";
import {
  connectionRowState,
  type ConnectionRowState,
} from "~/connections/oauth.server";
import { getProvider } from "~/connections/providers.server";
import { listGrantsForAgent } from "~/connections/grants.server";
import {
  discardConversationCheckoutByBranch,
  isConversationBranch,
} from "~/assistant/checkout-sync.server";
import { getRuntime } from "~/seams/index.server";
import { ensureWorkerStarted } from "~/jobs/worker.server";
import { enqueue } from "~/jobs/queue.server";
import {
  createTask,
  findRunningTask,
  listWorkspaceTasks,
  setTaskJob,
} from "~/tasks/tasks.server";
import { contextPath } from "~/lib/paths";
import { useLiveRevalidate } from "~/lib/use-live-revalidate";
import { cn } from "~/lib/utils";
import {
  overlayLock,
  requiredScopesByProvider,
  scopeGroupsByProvider,
  serializeLock,
  setSelectedGroups,
  type ScopeGroupChoice,
} from "~/marketplace/lock";
import {
  agentRequiredSecretState,
  cleanupOrphanedPendingSecrets,
} from "~/project/secrets.server";
import { listAgents } from "~/db/queries.server";
import { listSharedSecrets } from "~/seams/oss/secret-store";
import {
  DeploySecretsGuardDialog,
  type GuardMissingSecret,
} from "~/components/deploy-secrets-guard";
import { RelativeTime } from "~/components/localized-values";
import {
  agentFromParams,
  agentParamRedirect,
  memberFromPath,
  requireActiveAgent,
  resolveSyncedAgentContext,
} from "~/project/agent-context.server";
import { requireProject, requireRepo } from "~/project/guard.server";
import type {
  DeploymentWithRelease,
  DraftChange,
  Environment,
  Release,
} from "~/data/ports";
import type { ConnectedProject } from "~/project/guard.server";
import type { OpenChange } from "~/github/write.server";
import { DiffView } from "~/components/diff-view";
import type { Route } from "./+types/projects.$projectId.deployments";

/** One member's cell inside a team environment row: its env id + what's running there. */
interface TeamEnvMember {
  name: string;
  envId: string | null;
  deployments: DeploymentWithRelease[];
}
/** A team environment: one NAME, every member's row of that name. */
interface TeamEnvRow {
  name: string;
  members: TeamEnvMember[];
}
/** A team version: releases at one commit, across members (newest first). */
interface TeamVersionRow {
  gitSha: string;
  /** The first member's release version in the group (labels can differ per member). */
  version: string;
  changelog: string | null;
  createdAt: Date;
  /** Team env names currently running this version (any member's live deploy). */
  runningEnvNames: string[];
}

/** One shape for both layouts so the loader's branches unify (unused fields empty per branch). */
interface DeploymentData {
  project: ConnectedProject;
  roster: { name: string }[];
  activeAgent: string;
  isTeam: boolean;
  level: NavLevel;
  view: "repo" | "member";
  /** True where deploys/CRUD are acted on: the team (repo) view and single-agent repos. */
  canAct: boolean;
  /**
   * subjectKeys of this project's currently-running workspace tasks (issue #142) — e.g.
   * `["publish", "merge:12"]`. Drives the disabled "Publishing…/Merging…" button states without
   * threading full task rows; the persistent indicator (AppShell) shows the detail + progress.
   */
  runningTaskSubjects: string[];
  drafts: (DraftChange & { shared: boolean; orphaned: boolean })[];
  changes: OpenChange[];
  releases: Release[];
  envs: { env: Environment; deployments: DeploymentWithRelease[] }[];
  draftGroups: { owner: string; drafts: (DraftChange & { orphaned: boolean })[] }[];
  members: {
    name: string;
    latest: { version: string; gitSha: string; createdAt: Date } | null;
  }[];
  /** Team (repo) view: the team's env names, oldest first (the first is the primary). */
  teamEnvNames: string[];
  /** Team (repo) view: one row per env name, each member's running status. */
  teamEnvs: TeamEnvRow[];
  /** Team (repo) view: version history grouped by commit, newest first. */
  teamVersions: TeamVersionRow[];
  /** Deploy guard (§9): unmet template-required secrets (member-tagged in the team aggregate). */
  missingSecrets: GuardMissingSecret[];
  /** Deploy guard: the member whose settings the guard links to fix secrets on. */
  guardAgent: string;
  guardSettingsAction: string;
  /** Member/single view: Discord connect state when the agent has the marketplace Discord channel. */
  discordSetup: {
    enabled: boolean;
    /** Whether the operator has configured harnesst's shared Discord app (HARNESST_DISCORD_*). */
    configured: boolean;
    /** Member view: the agent's connected servers; null in the team view (setup is per member). */
    connections: Array<{
      id: string;
      guildId: string;
      guildName: string | null;
      commandName: string;
      environmentId: string;
    }> | null;
  };
  /**
   * Member/single view: the connector rows for this agent (issue #30) — the UNION of every provider
   * the lock REQUIRES and every existing grant, so a freshly installed connector with no grant yet
   * still shows a Connect button. This card is now the ONE place a connector is connected/reconnected;
   * installs no longer gate on it. Empty in the team (hint-only) view.
   */
  connections: Array<{
    /** Grant id when connected, else a synthetic `provider:<name>` key for the lock-derived row. */
    id: string;
    provider: string;
    /** Display name from the provider registry (capitalized id when unregistered). */
    label: string;
    /** Whether this harnesst installation's registry knows the provider — false → inert row. */
    registered: boolean;
    /** Whether the operator configured this provider's OAuth client — gates the connect action. */
    configured: boolean;
    accountEmail: string | null;
    /** What the provider GRANTED last time — a record only, never the Reconnect request template (§#30). */
    scopes: string;
    /** Grant status, or null when there's no grant yet (lock-derived row). */
    status: string | null;
    /**
     * The space-joined scopes a Connect/Reconnect must REQUEST for this provider, derived from the
     * install's lock snapshot (issue #30). Null when the lock carries no snapshot (old locks) — the
     * card then falls back to the stored grant `scopes`.
     */
    requiredScopes: string | null;
    /** Loader-computed row state — the server-only scope comparison stays out of the render path. */
    state: ConnectionRowState;
    /**
     * Selectable permission levels (issue #165) from the lock's scope-group snapshots, with their
     * current selection — drives the row's Permissions editor. Null when no install declares
     * groups for this provider (the permission surface isn't editable).
     */
    scopeGroups: ScopeGroupChoice[] | null;
    /**
     * Capability operation groups (issue #166) offered by the lock's snapshots, joined with the
     * registry's labels/risk and the current selection — the row's Operations editor. Enforced
     * PER CALL, so edits apply instantly (no reconnect, no redeploy). Null when the provider has
     * no capability surface.
     */
    capabilityGroups: Array<{
      id: string;
      label: string;
      description: string;
      risk: "read" | "write";
      selected: boolean;
    }> | null;
    /** Capability resource binding (issue #166) for display — "Connected to Acme Ltd". */
    resourceName: string | null;
    /** The capability's resource noun for copy, e.g. "organisation"; null when none declared. */
    resourceLabel: string | null;
    /** True when a capability grant still needs its resource picked (row links to the picker). */
    needsResource: boolean;
  }>;
  /** Member/single view: GitHub App setup when the agent has the marketplace GitHub channel. */
  githubSetup: {
    enabled: boolean;
    /** The agent's App slug (its @name) once created — links the card to GitHub's install picker. */
    appSlug: string | null;
    /** Where the App is installed (accounts + repo grants); null when it couldn't be fetched. */
    installations: AppInstallation[] | null;
  };
}

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }): Promise<DeploymentData> => {
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
      // issue #142: which merge/publish tasks are running now, so the buttons can show their
      // accepted/running state. The persistent indicator (AppShell) renders the full progress.
      const runningTaskSubjects = (await listWorkspaceTasks(project.id))
        .filter((t) => t.status === "running")
        .map((t) => t.subjectKey);
      const [allDrafts, changes, releaseRows, source] = await Promise.all([
        listDrafts(project.id),
        getOpenChanges(project.repoInstallationId, {
          owner: project.repoOwner,
          repo: project.repoName,
        }),
        listReleases(project.id),
        getAgentSource(project.repoInstallationId, {
          owner: project.repoOwner,
          repo: project.repoName,
        }),
      ]);
      const { roster, active, isTeam } = await resolveSyncedAgentContext(
        project.id,
        agentName,
        source.paths,
      );
      // Drafts stranded under a member root the roster/repo/selection no longer back (issue #67):
      // surfaced as orphaned (unchecked, discardable) and blocked at publish with attribution.
      const orphanedPaths = new Set(
        findOrphanedDrafts(roster, source.paths, allDrafts).map((d) => d.path),
      );
      const level: NavLevel = agentName ? "member" : isTeam ? "repo" : "single";
      const view = level === "repo" ? ("repo" as const) : ("member" as const);
      // The acting surface: the team (repo) view, and single-agent repos (a team of one).
      const canAct = level !== "member";

      if (view === "repo") {
        // Team acting surface: staged drafts grouped by member, plus the team's environments
        // (one NAME, every member's running status) and version history (grouped by commit).
        const nameById = new Map(roster.map((a) => [a.id, a.name]));
        const groups = new Map<string, typeof allDrafts>();
        for (const d of allDrafts) {
          const key = d.agentId
            ? (nameById.get(d.agentId) ?? memberFromPath(d.path) ?? "shared")
            : (memberFromPath(d.path) ?? "shared");
          groups.set(key, [...(groups.get(key) ?? []), d]);
        }
        const members = roster.map((a) => {
          const latest = releaseRows.find((r) => r.agentId === a.id);
          return {
            name: a.name,
            latest: latest
              ? {
                  version: latest.version,
                  gitSha: latest.gitSha,
                  createdAt: latest.createdAt,
                }
              : null,
          };
        });

        // Per member: its env rows joined to their deployments (reuse listDeployments).
        const teamEnvNames = await listTeamEnvNames(project.id);
        // One env query for the whole roster (grouped by agent) instead of one per
        // member — avoids N extra round-trips that grow with team size.
        const projectEnvs = await listEnvironments(project.id);
        const envsByAgent = new Map<string, typeof projectEnvs>();
        for (const env of projectEnvs) {
          envsByAgent.set(env.agentId, [
            ...(envsByAgent.get(env.agentId) ?? []),
            env,
          ]);
        }
        const perMember = await Promise.all(
          roster.map(async (a) => {
            const envRows = envsByAgent.get(a.id) ?? [];
            const envs = await Promise.all(
              envRows.map(async (env) => ({
                env,
                deployments: await listDeployments(env.id),
              })),
            );
            return { name: a.name, envs };
          }),
        );
        const teamEnvs: TeamEnvRow[] = teamEnvNames.map((name) => ({
          name,
          members: perMember.map((m) => {
            const match = m.envs.find((e) => e.env.name === name);
            return {
              name: m.name,
              envId: match?.env.id ?? null,
              deployments: match?.deployments ?? [],
            };
          }),
        }));
        // Which version each env is running (any member's live deploy), for version badges.
        const envRunningSha = new Map<string, string>();
        for (const te of teamEnvs) {
          for (const m of te.members) {
            const live = m.deployments.find((d) => d.status === "live");
            if (live) {
              envRunningSha.set(te.name, live.gitSha);
              break;
            }
          }
        }
        // Version history grouped by commit (releaseRows are newest-first; first per sha wins).
        const versionByCommit = new Map<string, TeamVersionRow>();
        for (const r of releaseRows) {
          if (versionByCommit.has(r.gitSha)) continue;
          versionByCommit.set(r.gitSha, {
            gitSha: r.gitSha,
            version: r.version,
            changelog: r.changelog,
            createdAt: r.createdAt,
            runningEnvNames: teamEnvNames.filter(
              (n) => envRunningSha.get(n) === r.gitSha,
            ),
          });
        }
        const teamVersions = [...versionByCommit.values()];

        // Deploy guard (§9), aggregated across members and member-tagged.
        let missingSecrets: GuardMissingSecret[] = [];
        try {
          const shared = await listSharedSecrets(project.id);
          const sharedNames = new Set(shared.map((s) => s.key));
          const lock = overlayLock(
            source.files["harnesst-lock.json"] ?? null,
            allDrafts.map((d) => ({ path: d.path, content: d.content })),
          );
          const perMemberSecrets = await Promise.all(
            roster.map(async (a) => {
              const state = await agentRequiredSecretState({
                projectId: project.id,
                agentId: a.id,
                memberName: a.name,
                isTeam,
                lock,
              });
              return state.missing.map((m) => ({
                ...m,
                sharedExists: sharedNames.has(m.name),
                member: a.name,
              }));
            }),
          );
          missingSecrets = perMemberSecrets.flat();
        } catch {
          missingSecrets = []; // secrets store unavailable — never block the pipeline view
        }
        const guardAgent = missingSecrets[0]?.member ?? roster[0]?.name ?? "";
        return {
          project,
          roster: roster.map((a) => ({ name: a.name })),
          activeAgent: active?.name ?? "",
          isTeam,
          level,
          view,
          canAct,
          runningTaskSubjects,
          draftGroups: [...groups.entries()].map(([owner, drafts]) => ({
            owner,
            drafts: drafts.map((d) => ({
              ...d,
              orphaned: orphanedPaths.has(d.path),
            })),
          })),
          changes,
          members,
          drafts: [],
          releases: [],
          envs: [],
          teamEnvNames,
          teamEnvs,
          teamVersions,
          missingSecrets,
          guardAgent,
          guardSettingsAction: `${contextPath(project.id, guardAgent)}/settings`,
          // Channel setup is per member — the team view has no setup cards.
          discordSetup: {
            enabled: false,
            configured: false,
            connections: null,
          },
          connections: [],
          githubSetup: {
            enabled: false,
            appSlug: null,
            installations: null,
          },
        };
      }

      // Member pipeline: this member's drafts + shared ones, its envs + versions.
      requireActiveAgent(active, project.id);
      const drafts = allDrafts.flatMap((d) =>
        d.agentId === active.id || d.agentId === null
          ? [{ ...d, shared: d.agentId === null, orphaned: orphanedPaths.has(d.path) }]
          : [],
      );
      const envRows = await listAgentEnvironments(active.id);
      const envs = await Promise.all(
        envRows.map(async (env) => ({
          env,
          deployments: await listDeployments(env.id),
        })),
      );
      // Deploy guard (§9): required-but-unset names for this member; dismissed never trigger.
      let missingSecrets: GuardMissingSecret[] = [];
      const activeHasChannelFile = (channel: string) =>
        source.paths.includes(`${active.root}/channels/${channel}.ts`) ||
        allDrafts.some(
          (d) =>
            d.content !== null &&
            d.path === `${active.root}/channels/${channel}.ts`,
        );
      let hasDiscordSetup = activeHasChannelFile("discord");
      let hasGithubSetup = activeHasChannelFile("github");
      // The effective lock for this agent (drafts overlaid) — drives both the missing-secret guard
      // and the Connections card's required-scope derivation (issue #30).
      const lock = overlayLock(
        source.files["harnesst-lock.json"] ?? null,
        allDrafts.map((d) => ({ path: d.path, content: d.content })),
      );
      // The lock attributes installs to a member name (team) or null (single-agent root) — mirror
      // lockSecretsForMember's mapping so the required-scope union covers the right installs.
      const activeMember = isTeam ? active.name : null;
      const requiredScopes = requiredScopesByProvider(lock, activeMember);
      // Selectable permission levels per provider (issue #165) — the Connections card's editor.
      const providerScopeGroups = scopeGroupsByProvider(lock, activeMember);
      // Capability operation groups per provider (issue #166) — the Operations editor's rows.
      const providerCapabilityChoices = capabilityChoicesByProvider(
        lock,
        activeMember,
      );
      try {
        const [state, shared] = await Promise.all([
          agentRequiredSecretState({
            projectId: project.id,
            agentId: active.id,
            memberName: active.name,
            isTeam,
            lock,
          }),
          listSharedSecrets(project.id),
        ]);
        const sharedNames = new Set(shared.map((s) => s.key));
        missingSecrets = state.missing.map((m) => ({
          ...m,
          sharedExists: sharedNames.has(m.name),
        }));
        if (state.all.some(isDiscordSecretRequirement)) {
          hasDiscordSetup = true;
        }
        if (state.all.some(isGitHubSecretRequirement)) {
          hasGithubSetup = true;
        }
      } catch {
        missingSecrets = []; // secrets store unavailable — never block the pipeline view
      }
      // The App's @name once the guided flow (or manual setup) stored it, plus where it's
      // installed — the setup card renders real state (accounts, repo grants) and guides
      // adding accounts, so the user never needs to know GitHub's install-page URL.
      // Discord: the servers this agent is connected to (issue #32) — the setup card lists them
      // and offers "Connect another server". Only when the operator configured the shared app.
      const discordConfigured = getDiscordAppConfig() !== null;
      let discordConnections: DeploymentData["discordSetup"]["connections"] =
        null;
      if (hasDiscordSetup && discordConfigured) {
        try {
          const rows = await listConnectionsForAgent(active.id);
          discordConnections = rows.map((c) => ({
            id: c.id,
            guildId: c.guildId,
            guildName: c.guildName,
            commandName: c.commandName,
            environmentId: c.environmentId,
          }));
        } catch {
          discordConnections = null; // store hiccup — the card falls back to the connect button
        }
      }
      // Connector rows for this agent (issue #30): the UNION of every provider the lock REQUIRES and
      // every existing grant. With the install wizard's connect gate gone, a freshly installed
      // connector has no grant yet — the lock-required provider still gets a row (Connect button), so
      // this card is the ONE place a connector is connected/reconnected.
      let connectionGrantRows: DeploymentData["connections"] = [];
      try {
        const grants = await listGrantsForAgent(active.id);
        const grantByProvider = new Map(grants.map((g) => [g.provider, g]));
        const providers = [
          ...new Set([...requiredScopes.keys(), ...grantByProvider.keys()]),
        ].sort();
        connectionGrantRows = providers.map((provider) => {
          const grant = grantByProvider.get(provider);
          const req = requiredScopes.get(provider);
          // The scopes a Connect/Reconnect must REQUEST, from the install's lock snapshot (issue #30).
          // Null when the lock has no snapshot for this provider (old locks) → the card falls back to
          // the grant's stored scopes.
          const requiredScopeStr = req && req.length > 0 ? req.join(" ") : null;
          // Present-but-empty snapshot (issue #173): every permission group deselected. Deploys
          // skip this provider's injection and connect refuses, so the row renders "disabled".
          const permissionsDisabled = req !== undefined && req.length === 0;
          // Registry + operator config are per provider (issue #163): an unregistered provider
          // renders inert, an unconfigured one renders without a connect action. Providers with
          // dynamic client registration (issue #167) need no operator client — Connect registers
          // one per grant — so they count as configured.
          const def = getProvider(provider);
          // Stale callback coverage (issue #167): a per-grant registered client is IMMUTABLE with
          // exact-match callback URIs, so an environment created AFTER the grant was made can't
          // receive callbacks — a reconnect registers a fresh client covering the new set.
          // `createdAt` is refreshed on reconnect (grants.server.ts) and untouched by rotation.
          // It is a SOUND watermark: the connect callback refuses any flow during which an
          // environment appeared (connect-flow.server.ts), so every environment older than the
          // grant is covered by its client.
          const staleClientCoverage =
            def?.clientRegistration !== undefined &&
            grant?.clientId != null &&
            envRows.some((env) => env.createdAt > grant.createdAt);
          // Capability surface (issue #166): the lock's offered groups joined with the
          // registry's labels/risk. Ids the registry doesn't define render nothing (a stale
          // template naming a removed group has no operation behind it anyway).
          const capability = def ? getCapability(def.id) : null;
          const choices = providerCapabilityChoices.get(provider);
          const capabilityGroups =
            capability && choices && choices.length > 0
              ? choices.flatMap((choice) => {
                  const group = capability.operationGroups.find(
                    (g) => g.id === choice.id,
                  );
                  if (!group) return [];
                  return [
                    {
                      id: choice.id,
                      label: group.label,
                      description: group.description,
                      risk: group.risk,
                      selected: choice.selected,
                    },
                  ];
                })
              : null;
          return {
            id: grant?.id ?? `provider:${provider}`,
            provider,
            label:
              def?.label ?? provider.charAt(0).toUpperCase() + provider.slice(1),
            registered: def !== null,
            configured: def
              ? def.clientRegistration !== undefined ||
                getProviderOAuthConfig(def) !== null
              : false,
            accountEmail: grant?.accountEmail ?? null,
            scopes: grant?.scopes ?? "",
            status: grant?.status ?? null,
            requiredScopes: requiredScopeStr,
            state: connectionRowState({
              hasGrant: grant !== undefined,
              grantStatus: grant?.status ?? null,
              requiredScopes: requiredScopeStr,
              grantScopes: grant?.scopes ?? "",
              staleClientCoverage,
              permissionsDisabled,
            }),
            scopeGroups: providerScopeGroups.get(provider) ?? null,
            capabilityGroups: capabilityGroups?.length ? capabilityGroups : null,
            resourceName: grant?.resourceName ?? null,
            resourceLabel: capability?.resource?.label ?? null,
            needsResource:
              capability?.resource !== undefined &&
              grant?.status === "active" &&
              !grant.resourceId,
          };
        });
      } catch {
        connectionGrantRows = []; // store hiccup — the card simply doesn't render
      }
      let githubAppSlug: string | null = null;
      let githubInstallations: AppInstallation[] | null = null;
      if (hasGithubSetup) {
        const secretRef = (key: string) => ({
          projectId: project.id,
          agentId: active.id,
          environmentId: null,
          key,
        });
        try {
          githubAppSlug = await getRuntime().secrets.get(
            secretRef("GITHUB_APP_SLUG"),
          );
          if (githubAppSlug) {
            const [appId, privateKey] = await Promise.all([
              getRuntime().secrets.get(secretRef("GITHUB_APP_ID")),
              getRuntime().secrets.get(secretRef("GITHUB_APP_PRIVATE_KEY")),
            ]);
            if (appId && privateKey) {
              githubInstallations = await listAppInstallations({
                appId,
                privateKey,
              });
            }
          }
        } catch {
          githubInstallations = null; // GitHub/secrets hiccup — the card falls back to a link
        }
      }
      return {
        project,
        roster: roster.map((a) => ({ name: a.name })),
        activeAgent: active.name,
        isTeam,
        level,
        view,
        canAct,
        runningTaskSubjects,
        drafts,
        changes,
        releases: releaseRows.filter((r) => r.agentId === active.id),
        envs,
        draftGroups: [],
        members: [],
        teamEnvNames: [],
        teamEnvs: [],
        teamVersions: [],
        missingSecrets,
        guardAgent: active.name,
        guardSettingsAction: `${contextPath(
          project.id,
          level === "member" ? active.name : null,
        )}/settings`,
        discordSetup: {
          enabled: hasDiscordSetup,
          configured: discordConfigured,
          connections: discordConnections,
        },
        connections: connectionGrantRows,
        githubSetup: {
          enabled: hasGithubSetup,
          appSlug: githubAppSlug,
          installations: githubInstallations,
        },
      };
    },
    { ensureSignedIn: true },
  );

/** §4.4 abandonment sweep: drop held pending secrets whose install can no longer ship. */
async function sweepPendingSecrets(projectId: string): Promise<void> {
  try {
    const [roster, drafts] = await Promise.all([
      listAgents(projectId),
      listDrafts(projectId),
    ]);
    await cleanupOrphanedPendingSecrets({
      projectId,
      rosterNames: roster.map((a) => a.name),
      draftPaths: drafts.map((d) => d.path),
    });
  } catch (error) {
    console.warn("[secrets] pending-secret sweep failed:", error);
  }
}

export async function action(args: ActionFunctionArgs) {
  const auth = await getSessionAuth(args);
  if (!auth.user) throw redirect("/login");
  const project = requireRepo(
    await requireProject(auth, args.params.projectId),
  );
  const form = await args.request.formData();
  const intent = String(form.get("intent") ?? "");
  const back = `${contextPath(project.id, agentFromParams(args.params))}/deployment`;
  const repo = { owner: project.repoOwner, repo: project.repoName };

  try {
    // ── Change-set intents (repo-scoped; from either view) ──
    if (intent === "publish") {
      const paths = form.getAll("path").map(String);
      const title = String(form.get("title") ?? "");
      // Cheap synchronous validation stays inline; the build gate + PR run on the queue (issue #142)
      // so the request returns immediately and progress streams into the workspace indicator.
      if (paths.length === 0) {
        return { error: "No staged changes selected to publish." };
      }
      ensureWorkerStarted();
      // Dedupe: one publish task at a time per project (a second click re-attaches to the first).
      const existing = await findRunningTask(project.id, "publish");
      if (existing) return { ok: true as const, taskId: existing.id };
      const plural = paths.length === 1 ? "" : "s";
      const task = await createTask({
        projectId: project.id,
        kind: "publish_change",
        subjectKey: "publish",
        label: title.trim()
          ? `Publishing “${title.trim()}”`
          : `Publishing ${paths.length} staged change${plural}`,
        originUrl: back,
        createdBy: auth.user.id,
      });
      const jobId = await enqueue(
        "publish_change",
        {
          projectId: project.id,
          taskId: task.id,
          paths,
          title,
          createdBy: auth.user.id,
        },
        { maxAttempts: 1 },
      );
      await setTaskJob(task.id, jobId);
      return { ok: true as const, taskId: task.id };
    }
    if (intent === "discard") {
      await discardDrafts(project.id, [String(form.get("path"))]);
      // Install abandonment (§4.4): a discarded new-member install can leave held pending
      // secrets orphaned — sweep names with no roster row and no remaining member drafts.
      await sweepPendingSecrets(project.id);
      throw redirect(back);
    }
    if (intent === "delete-change") {
      const pullNumber = Number(form.get("pullNumber"));
      const branch = String(form.get("branch") ?? "") || undefined;
      if (!pullNumber) return { error: "Missing change to delete." };
      await closePullRequest(
        project.repoInstallationId,
        repo,
        pullNumber,
        branch,
      );
      // An assistant conversation branch is discarded with its PR — drop the checkout link row.
      if (isConversationBranch(branch))
        await discardConversationCheckoutByBranch(branch!);
      // Closing an unmerged change is the other abandonment path — same sweep (§4.4).
      await sweepPendingSecrets(project.id);
      throw redirect(back);
    }
    if (intent === "merge") {
      const pullNumber = Number(form.get("pullNumber"));
      const branch = String(form.get("branch") ?? "") || undefined;
      const title = String(form.get("title") ?? "");
      if (!pullNumber) return { error: "Missing change to merge." };
      // The pre-merge build gate + GitHub merge + roster sync now run on the queue (issue #142) so
      // the request returns at once; the workspace indicator streams progress and surfaces a
      // build-gate failure (nothing merges) rather than blocking the HTTP request on docker. The
      // gate builds EVERY affected member root, recomputed SERVER-side in the runner from the PR's
      // changed files (issue #137) — no client-posted root.
      ensureWorkerStarted();
      const subjectKey = `merge:${pullNumber}`;
      const existing = await findRunningTask(project.id, subjectKey);
      if (existing) return { ok: true as const, taskId: existing.id };
      const task = await createTask({
        projectId: project.id,
        kind: "merge_change",
        subjectKey,
        label: `Merging change #${pullNumber}`,
        originUrl: back,
        createdBy: auth.user.id,
      });
      const jobId = await enqueue(
        "merge_change",
        {
          projectId: project.id,
          taskId: task.id,
          pullNumber,
          branch,
          title,
          createdBy: auth.user.id,
          backUrl: back,
        },
        { maxAttempts: 1 },
      );
      await setTaskJob(task.id, jobId);
      return { ok: true as const, taskId: task.id };
    }

    // ── Connection permissions (issue #165): rewrite the lock's scope-group selection ──
    // The selection is CONFIG living in harnesst-lock.json, so editing it stages a draft of the lock
    // (published/merged with the pipeline like any install). Widening flips the Connections row
    // to needs-reconnect via the existing scope-coverage state; narrowing keeps the row connected
    // but the redirect carries a hint to reconnect for a freshly narrowed grant.
    if (intent === "connection-permissions") {
      const provider = String(form.get("provider") ?? "");
      const selected = form.getAll("group").map(String);
      if (!provider) return { error: "Missing connection provider." };
      // Action reads raw (never the cache) — a stale lock composed into a write could clobber
      // a newer selection or install.
      const [source, drafts] = await Promise.all([
        fetchAgentSource(project.repoInstallationId, repo),
        listDrafts(project.id),
      ]);
      const { active, isTeam } = await resolveSyncedAgentContext(
        project.id,
        agentFromParams(args.params),
        source.paths,
      );
      requireActiveAgent(active, project.id);
      const member = isTeam ? active.name : null;
      const lock = overlayLock(
        source.files["harnesst-lock.json"] ?? null,
        drafts.map((d) => ({ path: d.path, content: d.content })),
      );
      const before = requiredScopesByProvider(lock, member).get(provider) ?? [];
      const { lock: nextLock, changed } = setSelectedGroups(
        lock,
        member,
        provider,
        selected,
      );
      if (!changed) return { ok: true as const };
      await stageDraft({
        projectId: project.id,
        path: "harnesst-lock.json",
        content: serializeLock(nextLock),
        createdBy: auth.user.id,
      });
      const after =
        requiredScopesByProvider(nextLock, member).get(provider) ?? [];
      const beforeSet = new Set(before);
      const afterSet = new Set(after);
      const widened = after.some((s) => !beforeSet.has(s));
      const narrowed = !widened && before.some((s) => !afterSet.has(s));
      const query = new URLSearchParams({ permissions: provider });
      if (narrowed) query.set("narrowed", "1");
      throw redirect(`${back}?${query.toString()}`);
    }

    // ── Capability operations (issue #166): rewrite the lock's capability-group selection ──
    // Same lock-draft staging as connection-permissions, but the payoff is different: the
    // capability route reads the DRAFT-OVERLAID lock per call, so the change is enforced at the
    // agent's very next call — no reconnect, no redeploy (nothing is baked into a token).
    if (intent === "capability-permissions") {
      const provider = String(form.get("provider") ?? "");
      const selected = form.getAll("group").map(String);
      if (!provider) return { error: "Missing connection provider." };
      // Action reads raw (never the cache) — a stale lock composed into a write could clobber
      // a newer selection or install.
      const [source, drafts] = await Promise.all([
        fetchAgentSource(project.repoInstallationId, repo),
        listDrafts(project.id),
      ]);
      const { active, isTeam } = await resolveSyncedAgentContext(
        project.id,
        agentFromParams(args.params),
        source.paths,
      );
      requireActiveAgent(active, project.id);
      const member = isTeam ? active.name : null;
      const lock = overlayLock(
        source.files["harnesst-lock.json"] ?? null,
        drafts.map((d) => ({ path: d.path, content: d.content })),
      );
      const { lock: nextLock, changed } = setSelectedCapabilityGroups(
        lock,
        member,
        provider,
        selected,
      );
      if (!changed) return { ok: true as const };
      await stageDraft({
        projectId: project.id,
        path: "harnesst-lock.json",
        content: serializeLock(nextLock),
        createdBy: auth.user.id,
      });
      throw redirect(`${back}?${new URLSearchParams({ operations: provider })}`);
    }

    // ── Environment CRUD (team-level: create/rename/delete a NAME across the whole roster) ──
    if (intent === "env-create") {
      await createTeamEnvironment({
        projectId: project.id,
        name: String(form.get("name") ?? ""),
        orgId: project.orgId,
        createdBy: auth.user.id,
      });
      return { ok: true as const };
    }
    if (intent === "env-rename") {
      await renameTeamEnvironment({
        projectId: project.id,
        from: String(form.get("from") ?? ""),
        to: String(form.get("to") ?? form.get("name") ?? ""),
        orgId: project.orgId,
        createdBy: auth.user.id,
      });
      return { ok: true as const };
    }
    if (intent === "env-delete") {
      await deleteTeamEnvironment({
        projectId: project.id,
        name: String(form.get("name") ?? ""),
        orgId: project.orgId,
        createdBy: auth.user.id,
      });
      return { ok: true as const };
    }

    // ── Deploys ──
    // deploy-team-version moves the WHOLE team to a version (by commit) in one environment —
    // the single code path for the team view, single-agent repos, and rollback (deploying an
    // older commit reuses its image; a rebuild forces a fresh build).
    if (intent === "deploy-team-version") {
      ensureWorkerStarted();
      // Issue #26: two agents holding the same GitHub App identity (slug/App ID) means at
      // most one of them ever hears its @mentions — refuse the deploy with names attached.
      // Fingerprint comparison only; no secret is decrypted.
      const credRows = await listAppCredentialRows(project.id);
      for (const credAgentId of new Set(credRows.map((r) => r.agentId))) {
        const conflict = findStoredAppCredentialConflict(credRows, credAgentId);
        if (conflict) {
          const self = credRows.find(
            (r) => r.agentId === credAgentId,
          )!.agentName;
          return {
            error:
              `Agents "${self}" and "${conflict.agentName}" share the same GitHub App ` +
              `(${conflict.key}). Every agent needs its own App — create one from the ` +
              "agent's Deployment tab (Create GitHub App), then deploy again.",
          };
        }
      }
      const rebuild = String(form.get("rebuild") ?? "") === "1";
      // A member with no release at this commit (e.g. added after this historical version)
      // can't move — surface those names so a partial roll never silently skews versions.
      const { skipped } = await deployTeamVersion({
        projectId: project.id,
        gitSha: String(form.get("gitSha") ?? ""),
        envName: String(form.get("env") ?? ""),
        rollback: !rebuild,
        rebuild,
        createdBy: auth.user.id,
      });
      return { ok: true as const, skipped: skipped.map((s) => s.agentName) };
    }
    // retry re-queues a single member env's failed deploy (keyed by environmentId — an
    // operational fix that stays harmless in every view).
    if (intent === "retry") {
      ensureWorkerStarted();
      await queueDeploy({
        environmentId: String(form.get("environmentId")),
        releaseId: String(form.get("releaseId")),
        rollback: true,
        createdBy: auth.user.id,
      });
      return { ok: true as const };
    }
    if (intent === "clear-failed") {
      await clearFailedDeployments(String(form.get("environmentId")));
      return { ok: true as const };
    }
    return { error: "Unknown action." };
  } catch (error) {
    if (error instanceof Response) throw error;
    return { error: (error as Error).message };
  }
}

export function meta() {
  return [{ title: "Deployment · harnesst" }];
}

type LoaderData = Route.ComponentProps["loaderData"];
type Env = LoaderData["envs"][number]["env"];
type DeploymentRow = LoaderData["envs"][number]["deployments"][number];
type ReleaseRow = LoaderData["releases"][number];
type EnvState = { env: Env; deployments: DeploymentRow[] };
type DraftRow = LoaderData["drafts"][number];
type ChangeRow = LoaderData["changes"][number];

const IN_FLIGHT = new Set(["queued", "pending", "building"]);
const DISCORD_SECRET_NAMES = new Set([
  "DISCORD_APPLICATION_ID",
  "DISCORD_PUBLIC_KEY",
]);
const GITHUB_SECRET_NAMES = new Set([
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_APP_SLUG",
]);

function isDiscordSecretRequirement(secret: { name: string }): boolean {
  return DISCORD_SECRET_NAMES.has(secret.name);
}

function isGitHubSecretRequirement(secret: { name: string }): boolean {
  return GITHUB_SECRET_NAMES.has(secret.name);
}

function PublishStatus({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <div
      className="mt-3 rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      Publishing in the background — checking the build and opening a change
      request. Progress shows in the task bar at the top of the page; you can
      keep working.
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-border">
        <div className="harnesst-loading-line bg-primary/60" />
      </div>
    </div>
  );
}

/** The deployment an environment is currently running (post-M5.6 there is at most one). */
function runningOf(deployments: DeploymentRow[]): DeploymentRow | undefined {
  return deployments.find((d) => d.status === "live");
}

/** A tinted glyph square marking a pipeline card's role — keeps the surfaces scannable. */
function CardGlyph({
  icon: Icon,
  accent,
}: {
  icon: LucideIcon;
  accent: Accent;
}) {
  return (
    <span
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-md",
        accentChip[accent],
      )}
    >
      <Icon className="size-3.5" aria-hidden />
    </span>
  );
}

export default function Deployment({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { project, roster, activeAgent, isTeam, level, view } = loaderData;
  const memberBase = contextPath(
    project.id,
    level === "member" ? activeAgent : null,
  );
  const [params] = useSearchParams();
  const justReleased = params.get("released");
  const justInstalled = params.get("installed");
  // Connection connect/reconnect outcome (issue #69): the Google callback redirects back here with
  // `connected` and, when the agent was live, a `redeploy` result the auto-redeploy produced.
  const connected = params.get("connected");
  const redeploy = params.get("redeploy");
  const redeployError = params.get("redeployError");
  // Registry label from the Connections rows (the callback just upserted a grant, so the row
  // exists); raw id only if the row is somehow gone.
  const connectedLabel = connected
    ? (loaderData.connections.find((c) => c.provider === connected)?.label ??
      connected)
    : connected;
  // Permission-selection edit outcome (issue #165): the connection-permissions action redirects
  // back here with the provider and, when the selection only shrank, a `narrowed` flag.
  const permissionsEdited = params.get("permissions");
  const permissionsNarrowed = params.get("narrowed") === "1";
  const permissionsLabel = permissionsEdited
    ? (loaderData.connections.find((c) => c.provider === permissionsEdited)
        ?.label ?? permissionsEdited)
    : null;
  // Capability-operations edit outcome (issue #166): the capability-permissions action redirects
  // back here with the provider. No "narrowed" variant — enforcement is per call in harnesst, so both
  // directions apply at the agent's next call.
  const operationsEdited = params.get("operations");
  const operationsLabel = operationsEdited
    ? (loaderData.connections.find((c) => c.provider === operationsEdited)
        ?.label ?? operationsEdited)
    : null;

  // Progress: re-fetch faster while any deployment is pending/building. A slower
  // baseline poll runs regardless, so a deploy STARTED after this page loaded is
  // picked up on its own rather than staying stale until a manual refresh, and
  // the tail-end clear can't be missed either (issue #41).
  // A draining sibling (a superseded version finishing in-flight turns after a redeploy — issue
  // #81) keeps the page revalidating too, so the "winding down" note clears once the drain stops.
  // Kept separate from IN_FLIGHT, whose other call sites mean specifically "pending/building".
  const inFlight =
    loaderData.envs.some(({ deployments }) =>
      deployments.some((d) => IN_FLIGHT.has(d.status) || d.status === "draining"),
    ) ||
    // A running merge/publish task (issue #142) keeps the page polling so drafts/change requests
    // and the button states walk to their resolved values as the queued job finishes.
    loaderData.runningTaskSubjects.length > 0;
  useLiveRevalidate({ active: inFlight });

  return (
    <AppShell
      breadcrumbs={repoCrumbs({
        projectId: project.id,
        repoName: project.name,
        isTeam: level === "member",
        agentName: activeAgent,
        tail: [{ label: "Deployment" }],
      })}
    >
      <AgentNav
        base={memberBase}
        level={level}
        roster={roster}
        activeAgent={level === "member" ? activeAgent : undefined}
      />
      <PageHeader
        icon={Rocket}
        accent="emerald"
        title={
          level === "member" ? `Deployment — ${activeAgent}` : "Deployment"
        }
        description={
          view === "repo"
            ? "The team's pipeline: staged changes by agent, change requests (merging cuts a version for every agent), and each agent's latest version."
            : "The pipeline for this agent: staged changes become a change request; merging cuts a version; each environment runs one version. Rollback is just deploying an older version again."
        }
      />

      {justReleased &&
        (view === "repo" ? (
          <PostMergeDeployBanner
            version={justReleased}
            teamVersions={loaderData.teamVersions}
            teamEnvNames={loaderData.teamEnvNames}
            guard={{
              missing: loaderData.missingSecrets,
              activeAgent: loaderData.guardAgent,
              settingsAction: loaderData.guardSettingsAction,
            }}
          />
        ) : (
          <Alert className="mb-6">
            <AlertTitle>{justReleased} is ready</AlertTitle>
            <AlertDescription>
              {loaderData.canAct
                ? `Your change was merged and cut as version ${justReleased}. Deploy it to an environment from the version history below.`
                : `Your change was merged and cut as version ${justReleased}. Deploy it to the whole team from the repo's Deployment tab.`}
            </AlertDescription>
          </Alert>
        ))}

      {justInstalled && (
        <Alert className="mb-6">
          <AlertTitle>{justInstalled} install staged</AlertTitle>
          <AlertDescription>
            Review and publish it with your other staged changes below.
          </AlertDescription>
        </Alert>
      )}

      {connected &&
        (redeploy === "error" ? (
          <Alert variant="destructive" className="mb-6">
            <AlertTitle>
              {connectedLabel} connected, but the redeploy couldn&apos;t be started
            </AlertTitle>
            <AlertDescription className="whitespace-pre-wrap">
              {redeployError}. The connection is saved — redeploy the current version manually from
              the version history below.
            </AlertDescription>
          </Alert>
        ) : redeploy === "queued" ? (
          <Alert className="mb-6">
            <AlertTitle>{connectedLabel} connected — applying the new credentials</AlertTitle>
            <AlertDescription>
              The running version is redeploying so the new credentials take effect. Watch the
              Environments card below for progress.
            </AlertDescription>
          </Alert>
        ) : redeploy === "staged" ? (
          <Alert className="mb-6">
            <AlertTitle>{connectedLabel} connected</AlertTitle>
            <AlertDescription>
              You have staged changes, so the running version wasn&apos;t redeployed automatically.
              Ship your staged changes to deploy them with the new credentials, or redeploy the
              current version from the version history below.
            </AlertDescription>
          </Alert>
        ) : (
          <Alert className="mb-6">
            <AlertTitle>{connectedLabel} connected</AlertTitle>
            <AlertDescription>
              The connection is saved. Deploy the current version to start
              using it.
            </AlertDescription>
          </Alert>
        ))}

      {permissionsEdited &&
        (permissionsNarrowed ? (
          <Alert className="mb-6">
            <AlertTitle>{permissionsLabel} permissions reduced</AlertTitle>
            <AlertDescription>
              The selection is staged to harnesst-lock.json — publish it with your
              other changes. The existing grant still covers the smaller set,
              so nothing breaks; reconnect from the Connections card to
              re-issue the grant with only the selected permissions.
            </AlertDescription>
          </Alert>
        ) : (
          <Alert className="mb-6">
            <AlertTitle>{permissionsLabel} permissions updated</AlertTitle>
            <AlertDescription>
              The selection is staged to harnesst-lock.json — publish it with your
              other changes. If permissions were added, the connection needs a
              reconnect (see the Connections card below) before it covers the
              new set.
            </AlertDescription>
          </Alert>
        ))}

      {operationsEdited && (
        <Alert className="mb-6">
          <AlertTitle>{operationsLabel} operations updated</AlertTitle>
          <AlertDescription>
            The selection is staged to harnesst-lock.json and harnesst enforces it on
            every call, so it already applies — the agent&rsquo;s next call
            sees the new list. Publish the staged change with your other edits
            to make it permanent.
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

      {view === "repo" ? (
        <>
          {roster.length === 0 && (
            <EmptyTeamState overviewHref={`/repos/${project.id}`} />
          )}
          {(roster.length > 0 ||
            loaderData.changes.length > 0 ||
            loaderData.draftGroups.length > 0) && (
            <TeamRollup loaderData={loaderData} />
          )}
        </>
      ) : (
        <MemberPipeline loaderData={loaderData} />
      )}
    </AppShell>
  );
}

/* ────────────────────────────── member pipeline ────────────────────────────── */

function MemberPipeline({ loaderData }: { loaderData: LoaderData }) {
  const {
    project,
    drafts,
    changes,
    releases,
    envs,
    activeAgent,
    isTeam,
    canAct,
    runningTaskSubjects,
  } = loaderData;
  // Where "open" on a running deployment points: the agent's playground, not the instance's
  // internal URL (a 127.0.0.1:<port> that's unreachable from a browser).
  const playgroundPath = `${contextPath(project.id, isTeam ? activeAgent : null)}/playground`;

  return (
    <>
      <StagedChangesCard
        drafts={drafts}
        isTeam={isTeam}
        publishRunning={runningTaskSubjects.includes("publish")}
      />
      <ChangeRequests
        changes={changes}
        isTeam={isTeam}
        runningTaskSubjects={runningTaskSubjects}
      />
      <EnvironmentsCard
        envs={envs}
        canAct={canAct}
        releases={releases}
        playgroundPath={playgroundPath}
      />
      <VersionHistory
        releases={releases}
        envs={envs}
        canAct={canAct}
        guard={{
          missing: loaderData.missingSecrets,
          activeAgent: loaderData.guardAgent,
          settingsAction: loaderData.guardSettingsAction,
        }}
      />
      <ChannelsCard
        discord={loaderData.discordSetup}
        github={loaderData.githubSetup}
        envs={envs}
        projectId={loaderData.project.id}
        agentName={activeAgent}
      />
      <ConnectionsCard
        connections={loaderData.connections}
        projectId={loaderData.project.id}
        agentName={activeAgent}
      />
    </>
  );
}

/**
 * Auth-brokered connections (issues #30, #163): the ONE place a connector's OAuth account is
 * connected and reconnected — installs no longer gate on it, so a row exists for every provider the
 * lock REQUIRES, even before any grant. Each row routes to /connections/<provider>/connect
 * (returnTo = this Deployment tab) and, per its loader-derived state, offers Connect (no grant), a
 * subtle Reconnect (covered), or a primary Reconnect (under-scoped / expired / revoked). A provider
 * this installation's registry doesn't know renders inert. Each row is symmetric: the badge alone
 * carries the state; the detail line under it says WHO the grant is (account · resource) plus the
 * state's follow-up — it never restates "connected". The Channels card shares this language.
 */
function ConnectionsCard({
  connections,
  projectId,
  agentName,
}: {
  connections: LoaderData["connections"];
  projectId: string;
  agentName: string;
}) {
  if (connections.length === 0) return null;
  const returnTo = `${contextPath(projectId, agentName)}/deployment`;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardGlyph icon={Cable} accent="violet" />
          <CardTitle className="text-base">Connections</CardTitle>
        </div>
        <CardDescription>
          Accounts this agent is authorized to act on. Connect a new one, or
          reconnect if a grant expires, is revoked, or is missing permissions.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {connections.map((c) => {
          // The server re-derives requested scopes from this agent's effective lock (falling back
          // to its stored grant only for old locks). Never put an authority-bearing scope list in
          // this browser-controlled URL.
          const connectUrl =
            `/connections/${encodeURIComponent(c.provider)}/connect` +
            `?project=${encodeURIComponent(projectId)}` +
            `&agent=${encodeURIComponent(agentName)}` +
            `&returnTo=${encodeURIComponent(returnTo)}`;
          // The symmetric detail line: identity (account · resource) — state follow-up. The badge
          // above already says the state, so the line never repeats "connected".
          const detail = (() => {
            if (c.state === "not-connected") return "No account connected yet.";
            if (c.state === "disabled" && c.status === null)
              return "Every permission is deselected — select at least one below, then connect.";
            const identity =
              [c.accountEmail, c.resourceName].filter(Boolean).join(" · ") ||
              "Connected account";
            const note =
              c.state === "under-scoped"
                ? "missing permissions this connector needs; reconnect to grant them."
                : c.state === "needs-reconnect"
                  ? "an environment was added after this connection was made; reconnect so its callbacks are registered."
                  : c.state === "inactive"
                    ? "reconnect to restore access."
                    : c.state === "disabled"
                      ? "every permission is deselected, so new deploys won't include this connection. The stored grant is not revoked; reselect permissions below to re-enable it."
                      : null;
            return note ? `${identity} — ${note}` : identity;
          })();
          return (
            <div key={c.id} className="rounded-lg border px-3 py-2">
              <div className="flex items-center justify-between gap-3">
                <div className="grid gap-0.5">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{c.label}</span>
                    {c.state === "not-connected" ? (
                      <Badge variant="outline">not connected</Badge>
                    ) : c.state === "inactive" ? (
                      <Badge variant="warning">{c.status}</Badge>
                    ) : c.state === "under-scoped" ? (
                      <Badge variant="warning">missing permissions</Badge>
                    ) : c.state === "needs-reconnect" ? (
                      <Badge variant="warning">reconnect needed</Badge>
                    ) : c.state === "disabled" ? (
                      <Badge variant="warning">permissions disabled</Badge>
                    ) : (
                      <Badge variant="success">connected</Badge>
                    )}
                  </div>
                  {/* The resource binding (issue #166) rides the same line as the account —
                      "email · Acme Ltd" — instead of a second "Connected to …" line. */}
                  <span className="text-xs text-muted-foreground">
                    {detail}
                  </span>
                  {c.needsResource && (
                    <span className="text-xs text-amber-600 dark:text-amber-400">
                      Almost there — pick which {c.resourceLabel ?? "resource"}{" "}
                      this agent works in.
                    </span>
                  )}
                </div>
                {!c.registered ? (
                  <span className="text-xs text-muted-foreground">
                    not supported by this harnesst installation
                  </span>
                ) : c.needsResource ? (
                  // An unbound capability grant is unusable — finishing the binding is the
                  // one action that matters, so it takes the primary slot over Reconnect.
                  <Button asChild variant="default" size="sm">
                    <Link
                      to={
                        `/connections/${encodeURIComponent(c.provider)}/resource` +
                        `?project=${encodeURIComponent(projectId)}` +
                        `&agent=${encodeURIComponent(agentName)}` +
                        `&returnTo=${encodeURIComponent(returnTo)}`
                      }
                    >
                      Choose {c.resourceLabel ?? "resource"}
                    </Link>
                  </Button>
                ) : c.state === "disabled" ? (
                  // Connect/Reconnect would refuse (nothing to authorize — issue #173), so no
                  // button; re-enabling happens in the Permissions editor below.
                  <span className="text-xs text-muted-foreground">
                    reselect permissions to enable
                  </span>
                ) : c.configured ? (
                  // A covered grant is done — only a subtle Reconnect link. Every other state is a
                  // to-do (connect, re-scope, or re-auth) and gets the primary button (issue #30).
                  c.state === "connected" ? (
                    <Link
                      to={connectUrl}
                      className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    >
                      Reconnect
                    </Link>
                  ) : (
                    <Button asChild variant="default" size="sm">
                      <Link to={connectUrl}>
                        {c.state === "not-connected"
                          ? `Connect ${c.label}`
                          : "Reconnect"}
                      </Link>
                    </Button>
                  )
                ) : (
                  <span className="text-xs text-muted-foreground">
                    operator config missing
                  </span>
                )}
              </div>
              {/* Permission levels (issue #165): show the current selection; editing rewrites
                  `selectedGroups` in the lock. Widening flips the row to needs-reconnect via the
                  scope-coverage state; narrowing keeps it connected with a reconnect hint. */}
              {c.scopeGroups && c.scopeGroups.length > 0 && (
                <details className="mt-2 border-t pt-2">
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    Permissions:{" "}
                    {c.scopeGroups
                      .filter((g) => g.selected)
                      .map((g) => g.label)
                      .join(", ") || "none selected"}
                  </summary>
                  <Form method="post" className="mt-3 grid gap-2">
                    <input
                      type="hidden"
                      name="intent"
                      value="connection-permissions"
                    />
                    <input type="hidden" name="provider" value={c.provider} />
                    {c.scopeGroups.map((g) => (
                      <Label
                        key={g.id}
                        className="flex items-start gap-2 text-sm font-normal"
                      >
                        <input
                          type="checkbox"
                          name="group"
                          value={g.id}
                          defaultChecked={g.selected}
                          className="mt-0.5 size-4 accent-primary"
                        />
                        <span className="grid gap-0.5">
                          <span className="font-medium">{g.label}</span>
                          <span className="text-xs text-muted-foreground">
                            {g.description}
                          </span>
                        </span>
                      </Label>
                    ))}
                    <div className="flex items-center gap-3">
                      <Button type="submit" size="sm" variant="secondary">
                        Update permissions
                      </Button>
                      <span className="text-xs text-muted-foreground">
                        Adding permissions requires a reconnect; after removing
                        some, reconnect to re-issue the grant with only the
                        selected permissions.
                      </span>
                    </div>
                  </Form>
                </details>
              )}
              {/* Capability operations (issue #166): what harnesst will EXECUTE for this agent.
                  Enforced per call by the capability route (never baked into a token), so an
                  edit applies at the agent's very next call — no reconnect, no redeploy. */}
              {c.capabilityGroups && c.capabilityGroups.length > 0 && (
                <details className="mt-2 border-t pt-2">
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    Operations:{" "}
                    {c.capabilityGroups
                      .filter((g) => g.selected)
                      .map((g) => g.label)
                      .join(", ") || "none enabled"}
                  </summary>
                  <Form method="post" className="mt-3 grid gap-2">
                    <input
                      type="hidden"
                      name="intent"
                      value="capability-permissions"
                    />
                    <input type="hidden" name="provider" value={c.provider} />
                    {c.capabilityGroups.map((g) => (
                      <Label
                        key={g.id}
                        className="flex items-start gap-2 text-sm font-normal"
                      >
                        <input
                          type="checkbox"
                          name="group"
                          value={g.id}
                          defaultChecked={g.selected}
                          className="mt-0.5 size-4 accent-primary"
                        />
                        <span className="grid gap-0.5">
                          <span className="flex items-center gap-2 font-medium">
                            {g.label}
                            {g.risk === "write" && (
                              <Badge
                                variant="outline"
                                className="border-amber-500/50 text-amber-600 dark:text-amber-400"
                              >
                                write
                              </Badge>
                            )}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {g.description}
                          </span>
                        </span>
                      </Label>
                    ))}
                    <div className="flex items-center gap-3">
                      <Button type="submit" size="sm" variant="secondary">
                        Update operations
                      </Button>
                      <span className="text-xs text-muted-foreground">
                        harnesst enforces this list on every call — changes apply
                        at the agent&rsquo;s next call, no reconnect needed.
                      </span>
                    </div>
                  </Form>
                </details>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

/** Stage 1: this member's unpublished drafts (+ shared files, which affect everyone). */
function StagedChangesCard({
  drafts,
  isTeam,
  publishRunning,
}: {
  drafts: DraftRow[];
  isTeam: boolean;
  /** issue #142: a queued publish task is running — disable the button and show the note. */
  publishRunning: boolean;
}) {
  const navigation = useNavigation();
  const submit = useSubmit();
  const busy = navigation.state !== "idle" && navigation.formData != null;
  const activeIntent = busy
    ? String(navigation.formData!.get("intent") ?? "")
    : null;
  const publishing = activeIntent === "publish" || publishRunning;

  return (
    <Card className="mb-6">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <CardGlyph icon={FileStack} accent="amber" />
          <CardTitle className="text-base">Staged changes</CardTitle>
          <Badge variant="secondary">{drafts.length}</Badge>
        </div>
      </CardHeader>
      <CardContent>
        {drafts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing staged. Edits you save — instructions, model, any agent file
            — collect here until you publish them (or ship them with the Quick
            deploy button in the tab row).
          </p>
        ) : (
          <Form method="post">
            <input type="hidden" name="intent" value="publish" />
            <ul className="divide-y rounded-lg border text-sm">
              {drafts.map((d) => (
                <li key={d.id} className="flex items-center gap-3 px-3 py-2">
                  <input
                    type="checkbox"
                    name="path"
                    value={d.path}
                    defaultChecked={!d.orphaned}
                    className="size-4 accent-primary"
                    aria-label={`Include ${d.path}`}
                  />
                  <span
                    className={`min-w-0 flex-1 truncate font-mono text-xs ${
                      d.content === null
                        ? "line-through decoration-destructive/60"
                        : ""
                    }`}
                  >
                    {d.path}
                  </span>
                  {d.orphaned && <Badge variant="destructive">orphaned</Badge>}
                  {d.content === null && (
                    <Badge
                      variant="outline"
                      className="text-destructive border-destructive/40"
                    >
                      delete
                    </Badge>
                  )}
                  {d.shared && isTeam && (
                    <Badge variant="outline">
                      shared · affects all agents
                    </Badge>
                  )}
                  <span className="shrink-0 text-xs text-muted-foreground">
                    <RelativeTime value={d.updatedAt} />
                  </span>
                  <ConfirmDialog
                    trigger={
                      <Button
                        variant="ghost"
                        size="sm"
                        type="button"
                        disabled={busy}
                      >
                        Discard
                      </Button>
                    }
                    title={`Discard staged change to ${d.path}?`}
                    description={
                      d.content === null
                        ? "Undoes the staged deletion — the file stays in the repository."
                        : "The unpublished edit is deleted. The file itself is untouched — only the staged draft is lost."
                    }
                    confirmLabel="Discard"
                    onConfirm={() =>
                      submit(
                        { intent: "discard", path: d.path },
                        { method: "post" },
                      )
                    }
                  />
                </li>
              ))}
            </ul>
            {drafts.some((d) => d.orphaned) && (
              <p className="mt-2 text-xs text-muted-foreground">
                Orphaned changes belong to an agent that&rsquo;s no longer on the
                team. They&rsquo;re unchecked and can&rsquo;t be published —
                discard them.
              </p>
            )}
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Input
                name="title"
                placeholder="Change title (optional)"
                className="h-9 w-full sm:w-72"
              />
              <Button type="submit" disabled={busy || publishRunning}>
                {publishing
                  ? "Publishing…"
                  : "Publish selected as change request"}
              </Button>
            </div>
            <PublishStatus active={publishing} />
          </Form>
        )}
      </CardContent>
    </Card>
  );
}

/** Stage 2: open change requests (repo-wide — a merge cuts a version for every member). */
function ChangeRequests({
  changes,
  isTeam,
  runningTaskSubjects = [],
}: {
  changes: ChangeRow[];
  isTeam: boolean;
  /** subjectKeys of running workspace tasks — a `merge:<n>` here keeps that card's button busy. */
  runningTaskSubjects?: string[];
}) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" && navigation.formData != null;
  const activeIntent = busy
    ? String(navigation.formData!.get("intent") ?? "")
    : null;
  const mergingNumber =
    activeIntent === "merge"
      ? Number(navigation.formData!.get("pullNumber"))
      : null;
  const deletingNumber =
    activeIntent === "delete-change"
      ? Number(navigation.formData!.get("pullNumber"))
      : null;

  if (changes.length === 0) return null;
  return (
    <div className="mb-6">
      <div className="mb-3 flex items-center gap-2">
        <CardGlyph icon={GitPullRequest} accent="brand" />
        <h2 className="text-lg font-semibold">Open change requests</h2>
        {isTeam && (
          <span className="text-xs text-muted-foreground">
            repo-wide — merging cuts a version for every agent
          </span>
        )}
      </div>
      <div className="space-y-4">
        {changes.map((c) => (
          <ChangeCard
            key={c.number}
            change={c}
            busy={busy}
            merging={
              mergingNumber === c.number ||
              runningTaskSubjects.includes(`merge:${c.number}`)
            }
            deleting={deletingNumber === c.number}
          />
        ))}
      </div>
    </div>
  );
}

function ChangeCard({
  change,
  busy,
  merging,
  deleting,
}: {
  change: ChangeRow;
  busy: boolean;
  merging: boolean;
  deleting: boolean;
}) {
  const submit = useSubmit();
  const conflicted = change.mergeable === false;
  const checking = change.mergeable === null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-base">
              {change.title}{" "}
              <span className="font-mono text-sm font-normal text-muted-foreground">
                #{change.number}
              </span>
            </CardTitle>
            {change.body && (
              <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                {change.body}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <MergeabilityBadge conflicted={conflicted} checking={checking} />
            <ConfirmDialog
              trigger={
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  disabled={busy}
                >
                  {deleting ? "Deleting…" : "Delete"}
                </Button>
              }
              title={`Delete change request #${change.number}?`}
              description="It will be closed without merging and its staged edits discarded. GitHub keeps the closed change request, so this can be restored there if needed."
              confirmLabel="Delete"
              onConfirm={() =>
                submit(
                  {
                    intent: "delete-change",
                    pullNumber: String(change.number),
                    branch: change.branch,
                  },
                  { method: "post" },
                )
              }
            />
            <Form method="post">
              <input type="hidden" name="intent" value="merge" />
              <input type="hidden" name="pullNumber" value={change.number} />
              <input type="hidden" name="branch" value={change.branch} />
              <input type="hidden" name="title" value={change.title} />
              <Button
                type="submit"
                size="sm"
                disabled={busy || conflicted || merging}
              >
                {merging ? "Merging…" : "Merge"}
              </Button>
            </Form>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {change.files.length === 0 ? (
          <p className="text-sm text-muted-foreground">No file changes.</p>
        ) : (
          <ul className="divide-y rounded-lg border text-sm">
            {change.files.map((f) => (
              <li key={f.path} className="px-3 py-1.5">
                {f.patch ? (
                  <details className="group">
                    <summary className="flex cursor-pointer items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
                      <span className="truncate font-mono text-xs group-open:font-medium">
                        {f.path}
                      </span>
                      <span className="flex shrink-0 items-center gap-2 font-mono text-xs">
                        <span className="text-emerald-600 dark:text-emerald-400">
                          +{f.additions}
                        </span>
                        <span className="text-destructive">−{f.deletions}</span>
                      </span>
                    </summary>
                    <div className="mt-2">
                      <DiffView patch={f.patch} />
                    </div>
                  </details>
                ) : (
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate font-mono text-xs">{f.path}</span>
                    <span className="flex shrink-0 items-center gap-2 font-mono text-xs">
                      <span className="text-emerald-600 dark:text-emerald-400">
                        +{f.additions}
                      </span>
                      <span className="text-destructive">−{f.deletions}</span>
                    </span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {conflicted && (
          <p className="mt-3 text-xs text-destructive">
            Conflicts with the current default branch — re-stage the files from
            a fresh edit.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function MergeabilityBadge({
  conflicted,
  checking,
}: {
  conflicted: boolean;
  checking: boolean;
}) {
  if (checking) return <Badge variant="warning">checking…</Badge>;
  if (conflicted) return <Badge variant="destructive">conflicts</Badge>;
  return <Badge variant="success">ready</Badge>;
}

/* ────────────────────────────── team rollup ────────────────────────────── */

function TeamRollup({ loaderData }: { loaderData: LoaderData }) {
  const {
    project,
    draftGroups,
    changes,
    members,
    teamEnvs,
    teamVersions,
    runningTaskSubjects,
  } = loaderData;
  const navigation = useNavigation();
  const submit = useSubmit();
  const anyOrphaned = draftGroups.some((g) => g.drafts.some((d) => d.orphaned));
  const totalDrafts = draftGroups.reduce((n, g) => n + g.drafts.length, 0);
  const memberNames = new Set(members.map((m) => m.name));
  const busy = navigation.state !== "idle" && navigation.formData != null;
  const activeIntent = busy
    ? String(navigation.formData!.get("intent") ?? "")
    : null;
  const publishRunning = runningTaskSubjects.includes("publish");
  const publishing = activeIntent === "publish" || publishRunning;

  return (
    <>
      <Card className="mb-6">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <CardGlyph icon={FileStack} accent="amber" />
            <CardTitle className="text-base">Staged changes</CardTitle>
            <Badge variant="secondary">{totalDrafts}</Badge>
          </div>
        </CardHeader>
        <CardContent>
          {totalDrafts === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing staged anywhere. Agents' edits collect here until
              published.
            </p>
          ) : (
            <Form method="post" className="space-y-4">
              <input type="hidden" name="intent" value="publish" />
              {draftGroups.map((g) => (
                <div key={g.owner}>
                  <p className="mb-1 text-sm font-medium">
                    {g.owner === "shared" ? (
                      <>
                        shared{" "}
                        <span className="font-normal text-muted-foreground">
                          · affects all agents
                        </span>
                      </>
                    ) : memberNames.has(g.owner) ? (
                      <Link
                        to={`${contextPath(project.id, g.owner)}/deployment`}
                        className="underline-offset-4 hover:underline"
                      >
                        {g.owner}
                      </Link>
                    ) : (
                      <>
                        {g.owner}{" "}
                        <Badge variant="outline" className="align-middle">
                          new agent
                        </Badge>
                      </>
                    )}
                  </p>
                  <ul className="divide-y rounded-lg border text-sm">
                    {g.drafts.map((d) => (
                      <li
                        key={d.id}
                        className="flex items-center gap-3 px-3 py-1.5"
                      >
                        <input
                          type="checkbox"
                          name="path"
                          value={d.path}
                          defaultChecked={!d.orphaned}
                          className="size-4 accent-primary"
                          aria-label={`Include ${d.path}`}
                        />
                        <span
                          className={`min-w-0 flex-1 truncate font-mono text-xs ${
                            d.content === null
                              ? "line-through decoration-destructive/60"
                              : ""
                          }`}
                        >
                          {d.path}
                        </span>
                        {d.orphaned && (
                          <Badge variant="destructive">orphaned</Badge>
                        )}
                        {d.content === null && (
                          <Badge
                            variant="outline"
                            className="text-destructive border-destructive/40"
                          >
                            delete
                          </Badge>
                        )}
                        <span className="shrink-0 text-xs text-muted-foreground">
                          <RelativeTime value={d.updatedAt} />
                        </span>
                        <ConfirmDialog
                          trigger={
                            <Button
                              variant="ghost"
                              size="sm"
                              type="button"
                              disabled={busy}
                            >
                              Discard
                            </Button>
                          }
                          title={`Discard staged change to ${d.path}?`}
                          description={
                            d.content === null
                              ? "Undoes the staged deletion — the file stays in the repository."
                              : "The unpublished edit is deleted. The file itself is untouched — only the staged draft is lost."
                          }
                          confirmLabel="Discard"
                          onConfirm={() =>
                            submit(
                              { intent: "discard", path: d.path },
                              { method: "post" },
                            )
                          }
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {anyOrphaned && (
                <p className="text-xs text-muted-foreground">
                  Orphaned changes belong to an agent that&rsquo;s no longer on
                  the team. They&rsquo;re unchecked and can&rsquo;t be published
                  — discard them.
                </p>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <Input
                  name="title"
                  placeholder="Change title (optional)"
                  className="h-9 w-full sm:w-72"
                />
                <Button type="submit" disabled={busy || publishRunning}>
                  {publishing
                    ? "Publishing…"
                    : "Publish selected as change request"}
                </Button>
              </div>
              <PublishStatus active={publishing} />
            </Form>
          )}
        </CardContent>
      </Card>

      <ChangeRequests
        changes={changes}
        isTeam
        runningTaskSubjects={runningTaskSubjects}
      />

      <TeamEnvironmentsCard teamEnvs={teamEnvs} project={project} />
      <TeamVersionHistory
        teamVersions={teamVersions}
        teamEnvNames={loaderData.teamEnvNames}
        guard={{
          missing: loaderData.missingSecrets,
          activeAgent: loaderData.guardAgent,
          settingsAction: loaderData.guardSettingsAction,
        }}
      />
    </>
  );
}

/* ─────────────────────── team environments + versions ─────────────────────── */

/**
 * The team's environments: one row per env NAME, and under it each member's running version /
 * in-flight / failed state. Team CRUD (create/rename/delete a NAME) fans out across the roster —
 * the dialogs say so. retry/clear-failed stay keyed by the member's environmentId.
 */
function TeamEnvironmentsCard({
  teamEnvs,
  project,
}: {
  teamEnvs: TeamEnvRow[];
  project: ConnectedProject;
}) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const error =
    fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;

  return (
    <Card className="mb-6">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            <CardGlyph icon={Server} accent="emerald" />
            <CardTitle className="text-base">Environments</CardTitle>
          </span>
          <EnvNameDialog
            intent="env-create"
            trigger={
              <Button size="sm" variant="outline" disabled={busy}>
                New environment
              </Button>
            }
            title="New environment"
            description="A separate place to run the team — every agent gets a matching environment, with its own running version and environment-scoped secrets. Deploy into it from the version history."
            confirmLabel="Create"
          />
        </div>
      </CardHeader>
      <CardContent>
        {error && (
          <Alert variant="destructive" className="mb-4">
            <AlertTitle>Couldn&rsquo;t update environments</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {teamEnvs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No environments yet.</p>
        ) : (
          <div className="space-y-4">
            {teamEnvs.map((te) => (
              <div key={te.name} className="rounded-lg border">
                <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
                  <span className="font-medium">{te.name}</span>
                  <span className="flex items-center gap-1">
                    <EnvNameDialog
                      intent="env-rename"
                      from={te.name}
                      initialName={te.name}
                      trigger={
                        <Button size="sm" variant="ghost" disabled={busy}>
                          Rename
                        </Button>
                      }
                      title={`Rename ${te.name}?`}
                      description="Renames this environment for every agent — deploys, secrets, and history stay attached, only the name changes. Applies across the whole team."
                      confirmLabel="Rename"
                    />
                    <ConfirmDialog
                      trigger={
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          disabled={busy}
                        >
                          Delete
                        </Button>
                      }
                      title={`Delete environment "${te.name}"?`}
                      description={`Deletes "${te.name}" for EVERY agent — stops anything running there and permanently removes its deployment history and environment-scoped secrets. Agent-wide secrets and versions are untouched.`}
                      confirmLabel="Delete"
                      onConfirm={() =>
                        fetcher.submit(
                          { intent: "env-delete", name: te.name },
                          { method: "post" },
                        )
                      }
                    />
                  </span>
                </div>
                <ul className="divide-y text-sm">
                  {te.members.map((m) => (
                    <TeamEnvMemberRow
                      key={m.name}
                      member={m}
                      projectId={project.id}
                      fetcher={fetcher}
                      busy={busy}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** One member's status inside a team environment row: running version, in-flight, failed. */
function TeamEnvMemberRow({
  member,
  projectId,
  fetcher,
  busy,
}: {
  member: TeamEnvMember;
  projectId: string;
  fetcher: ReturnType<typeof useFetcher<typeof action>>;
  busy: boolean;
}) {
  const running = runningOf(member.deployments);
  const pending = member.deployments.find((d) => IN_FLIGHT.has(d.status));
  const draining = member.deployments.find((d) => d.status === "draining");
  const failed = member.deployments.find((d) => d.status === "failed");
  const failedCount = member.deployments.filter(
    (d) => d.status === "failed",
  ).length;

  return (
    <li className="px-4 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link
          to={contextPath(projectId, member.name)}
          className="min-w-32 font-mono text-xs underline-offset-4 hover:underline"
        >
          {member.name}
        </Link>
        {running ? (
          <>
            <span className="flex items-center gap-1.5 font-semibold text-emerald-600 dark:text-emerald-400">
              <span
                className="size-1.5 rounded-full bg-emerald-500"
                aria-hidden
              />
              {running.version}
            </span>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              {running.gitSha.slice(0, 7)}
            </code>
            <span className="text-muted-foreground">
              deployed <RelativeTime value={running.createdAt} />
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">Nothing deployed</span>
        )}
      </div>
      {pending && (
        <p className="mt-1 text-sm text-muted-foreground">
          <span className="font-medium text-amber-600 dark:text-amber-400">
            {pending.version}{" "}
            {pending.status === "building" ? "building" : "queued"}…
          </span>{" "}
          switches over once healthy
          {running ? `; ${running.version} keeps serving` : ""}.
        </p>
      )}
      {draining && (
        <p className="mt-1 text-sm text-muted-foreground">
          {draining.version} winding down — finishing in-flight work before shutdown.
        </p>
      )}
      {failed && member.envId && (
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-destructive">
          <span className="size-1.5 rounded-full bg-destructive" aria-hidden />
          <span>
            {failed.version} failed to deploy
            {running ? ` — ${running.version} still running` : ""}
          </span>
          {failed.errorDetail && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-help text-xs underline underline-offset-2">
                  why?
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-sm">
                {failed.errorDetail}
              </TooltipContent>
            </Tooltip>
          )}
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="retry" />
            <input type="hidden" name="environmentId" value={member.envId} />
            <input type="hidden" name="releaseId" value={failed.releaseId} />
            <Button type="submit" size="sm" variant="ghost" disabled={busy}>
              Retry
            </Button>
          </fetcher.Form>
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="clear-failed" />
            <input type="hidden" name="environmentId" value={member.envId} />
            <Button type="submit" size="sm" variant="ghost" disabled={busy}>
              Dismiss{failedCount > 1 ? ` ${failedCount} failures` : ""}
            </Button>
          </fetcher.Form>
        </div>
      )}
    </li>
  );
}

/**
 * The team's version history: versions grouped by commit, newest first, badged with the
 * environments running them. "Deploy" per environment moves the WHOLE team to that version —
 * direction-neutral (deploying an older version IS the rollback). The deploy guard triggers when
 * ANY member has missing required secrets.
 */
function TeamVersionHistory({
  teamVersions,
  teamEnvNames,
  guard,
}: {
  teamVersions: TeamVersionRow[];
  teamEnvNames: string[];
  guard: DeployGuard;
}) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const skipped =
    (fetcher.data && "skipped" in fetcher.data ? fetcher.data.skipped : []) ??
    [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <CardGlyph icon={History} accent="indigo" />
          <CardTitle className="text-base">Version history</CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        {skipped.length > 0 && (
          <Alert className="mb-4">
            <AlertTitle>
              Some agents stayed on their current version
            </AlertTitle>
            <AlertDescription>
              {skipped.join(", ")} had no build at this commit, so they were
              left behind. Ship them a version to bring the team back in sync.
            </AlertDescription>
          </Alert>
        )}
        {teamVersions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No versions yet. Use Quick deploy in the tab row to deploy the
            repository, or merge a change request above.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border text-sm">
            {teamVersions.map((v) => (
              <li key={v.gitSha} className="flex items-center gap-2 px-4 py-2">
                <span className="w-10 shrink-0 font-semibold">{v.version}</span>
                <span className="flex shrink-0 items-center gap-1">
                  {v.runningEnvNames.map((name) => (
                    <Badge key={name} variant="secondary">
                      {name}
                    </Badge>
                  ))}
                </span>
                <code className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                  {v.gitSha.slice(0, 7)}
                </code>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {v.changelog}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  <RelativeTime value={v.createdAt} />
                </span>
                <TeamDeployControl
                  version={v}
                  teamEnvNames={teamEnvNames}
                  busy={busy}
                  guard={guard}
                  onDeploy={(env, gitSha, rebuild) =>
                    fetcher.submit(
                      {
                        intent: "deploy-team-version",
                        env,
                        gitSha,
                        ...(rebuild ? { rebuild: "1" } : {}),
                      },
                      { method: "post" },
                    )
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The per-version team deploy affordance: pick an environment (a menu when >1) and move the whole
 * team there. Confirm copy says "moves the whole team to <version> in <env>". Redeploy (fresh
 * build) when the version already runs in that env; deploy otherwise — both are the same move.
 */
export function TeamDeployControl({
  version,
  teamEnvNames,
  busy,
  guard,
  onDeploy,
  primary,
  deployLabel,
  redeployLabel,
}: {
  version: TeamVersionRow;
  teamEnvNames: string[];
  busy: boolean;
  guard: DeployGuard;
  onDeploy: (envName: string, gitSha: string, rebuild: boolean) => void;
  /** Render a filled, larger primary CTA (issue #147 post-merge banner) instead of the compact secondary control. */
  primary?: boolean;
  /** Override the "Deploy" label (e.g. "Deploy version v7"). */
  deployLabel?: string;
  /** Override the "Redeploy" label when the version already runs in the target env. */
  redeployLabel?: string;
}) {
  const [target, setTarget] = useState<string | null>(null);
  const [guardEnv, setGuardEnv] = useState<string | null>(null);
  const guarded = guard.missing.length > 0;
  const runningHere = (name: string) => version.runningEnvNames.includes(name);
  const run = (name: string) =>
    onDeploy(name, version.gitSha, runningHere(name));

  const confirmFor = (name: string) =>
    runningHere(name)
      ? {
          title: `Redeploy ${version.version} to ${name}?`,
          description: `Rebuilds a fresh image from this version's commit and moves the whole team's ${name} over once healthy. The current instances keep serving until then.`,
        }
      : {
          title: `Deploy ${version.version} to ${name}?`,
          description: `Moves the whole team to ${version.version} in ${name}. Each agent's ${name} switches over once healthy; the current version keeps serving until then. To switch back, deploy the previous version again.`,
        };

  const pick = (name: string) =>
    guarded ? setGuardEnv(name) : setTarget(name);

  if (teamEnvNames.length === 0) return null;
  const single = teamEnvNames.length === 1 ? teamEnvNames[0] : null;

  return (
    <>
      {single ? (
        <Button
          size={primary ? "default" : "sm"}
          variant={
            primary ? "default" : runningHere(single) ? "outline" : "secondary"
          }
          disabled={busy}
          onClick={() => pick(single)}
        >
          {primary && <Rocket className="h-4 w-4" aria-hidden />}
          {runningHere(single)
            ? (redeployLabel ?? "Redeploy")
            : (deployLabel ?? "Deploy")}
        </Button>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size={primary ? "default" : "sm"}
              variant={primary ? "default" : "secondary"}
              disabled={busy}
            >
              {primary && <Rocket className="h-4 w-4" aria-hidden />}
              {`${primary ? (deployLabel ?? "Deploy") : "Deploy"} ▾`}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {teamEnvNames.map((name) => (
              <DropdownMenuItem key={name} onSelect={() => pick(name)}>
                {runningHere(name)
                  ? `Redeploy in ${name}`
                  : `Deploy to ${name}`}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {target && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setTarget(null);
          }}
          title={confirmFor(target).title}
          description={confirmFor(target).description}
          confirmLabel={runningHere(target) ? "Redeploy" : "Deploy"}
          variant="default"
          onConfirm={() => {
            run(target);
            setTarget(null);
          }}
        />
      )}
      {guardEnv && (
        <DeploySecretsGuardDialog
          open
          onOpenChange={(open) => {
            if (!open) setGuardEnv(null);
          }}
          missing={guard.missing}
          activeAgent={guard.activeAgent}
          settingsAction={guard.settingsAction}
          deployLabel={runningHere(guardEnv) ? "Redeploy" : "Deploy"}
          onDeploy={() => {
            run(guardEnv);
            setGuardEnv(null);
          }}
        />
      )}
    </>
  );
}

/**
 * Post-merge "ready" banner on the repo (team) view (issue #147): merging a change request cuts a
 * version for the whole team, so the banner offers a one-click deploy of that version instead of
 * making the user hunt through version history. It reuses {@link TeamDeployControl} verbatim for env
 * selection, the deploy guard, and confirm dialogs — no new env logic here. When there's no
 * environment to deploy to (`teamEnvNames` empty), it degrades to text only.
 */
export function PostMergeDeployBanner({
  version,
  teamVersions,
  teamEnvNames,
  guard,
}: {
  version: string;
  teamVersions: TeamVersionRow[];
  teamEnvNames: string[];
  guard: DeployGuard;
}) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const target =
    teamVersions.find((v) => v.version === version) ?? teamVersions[0] ?? null;

  return (
    <Alert className="mb-6">
      <AlertTitle>{version} is ready</AlertTitle>
      <AlertDescription>
        The merge cut version {version} for every agent — deploy the whole team
        in one click.
      </AlertDescription>
      {target && teamEnvNames.length > 0 && (
        <div className="mt-2">
          <TeamDeployControl
            version={target}
            teamEnvNames={teamEnvNames}
            busy={busy}
            guard={guard}
            primary
            deployLabel={`Deploy version ${target.version}`}
            redeployLabel={`Redeploy version ${target.version}`}
            onDeploy={(env, gitSha, rebuild) =>
              fetcher.submit(
                {
                  intent: "deploy-team-version",
                  env,
                  gitSha,
                  ...(rebuild ? { rebuild: "1" } : {}),
                },
                { method: "post" },
              )
            }
          />
        </div>
      )}
    </Alert>
  );
}

/* ─────────────────────── environments + versions (member) ─────────────────────── */

/**
 * The environments — independent peers, one identical row each: what's running, in-flight
 * progress, the latest failure (retry/dismiss), and rename/delete. Superseded/stopped
 * deployment rows are deliberately absent — the version history is the durable record.
 */
function EnvironmentsCard({
  envs,
  canAct,
  releases,
  playgroundPath,
}: {
  envs: EnvState[];
  canAct: boolean;
  releases: ReleaseRow[];
  playgroundPath: string;
}) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const error =
    fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;

  return (
    <Card className="mb-6">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            <CardGlyph icon={Server} accent="emerald" />
            <CardTitle className="text-base">Environments</CardTitle>
          </span>
          {canAct && (
            <EnvNameDialog
              intent="env-create"
              trigger={
                <Button size="sm" variant="outline" disabled={busy}>
                  New environment
                </Button>
              }
              title="New environment"
              description="A separate place to run the team — every agent gets a matching environment, with its own running version and its own environment-scoped secrets. Deploy into it from the version history."
              confirmLabel="Create"
            />
          )}
        </div>
      </CardHeader>
      <CardContent>
        {error && (
          <Alert variant="destructive" className="mb-4">
            <AlertTitle>Couldn&rsquo;t update environments</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <ul className="divide-y rounded-lg border text-sm">
          {envs.map(({ env, deployments }) => {
            const running = runningOf(deployments);
            const pending = deployments.find((d) => IN_FLIGHT.has(d.status));
            const draining = deployments.find((d) => d.status === "draining");
            const failed = deployments.find((d) => d.status === "failed");
            const failedCount = deployments.filter(
              (d) => d.status === "failed",
            ).length;
            return (
              <li key={env.id} className="px-4 py-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="min-w-32 font-medium">{env.name}</span>
                  {running ? (
                    <>
                      <span className="flex items-center gap-1.5 font-semibold text-emerald-600 dark:text-emerald-400">
                        <span
                          className="size-1.5 rounded-full bg-emerald-500"
                          aria-hidden
                        />
                        {running.version}
                      </span>
                      {(() => {
                        const f = releaseFreshness(running.releaseId, releases);
                        return f ? (
                          <FreshnessBadge
                            isLatest={f.isLatest}
                            latestVersion={f.latestVersion}
                          />
                        ) : null;
                      })()}
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                        {running.gitSha.slice(0, 7)}
                      </code>
                      <span className="text-muted-foreground">
                        deployed <RelativeTime value={running.createdAt} />
                      </span>
                      {/* `url` isn't the link target (it's an instance-internal address) — its
                          presence is the "there's a reachable instance to talk to" signal gating
                          the playground link. */}
                      {running.url && (
                        <Link
                          to={playgroundPath}
                          className="underline underline-offset-4"
                        >
                          open
                        </Link>
                      )}
                    </>
                  ) : (
                    <span className="text-muted-foreground">
                      Nothing deployed — use Quick deploy in the tab row, or
                      Deploy a version below.
                    </span>
                  )}
                  {canAct && (
                    <span className="ml-auto flex items-center gap-1">
                      <EnvNameDialog
                        intent="env-rename"
                        from={env.name}
                        initialName={env.name}
                        trigger={
                          <Button size="sm" variant="ghost" disabled={busy}>
                            Rename
                          </Button>
                        }
                        title={`Rename ${env.name}?`}
                        description="Renames this environment for every agent — deploys, secrets, and history stay attached, only the name changes. Applies across the whole team."
                        confirmLabel="Rename"
                      />
                      <ConfirmDialog
                        trigger={
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive hover:text-destructive"
                            disabled={busy}
                          >
                            Delete
                          </Button>
                        }
                        title={`Delete environment "${env.name}"?`}
                        description={`Deletes "${env.name}" for EVERY agent — stops anything running there and permanently removes its deployment history and environment-scoped secrets. Agent-wide secrets and versions are untouched.${running ? ` ${running.version} is running here and will be taken down.` : ""}`}
                        confirmLabel="Delete"
                        onConfirm={() =>
                          fetcher.submit(
                            { intent: "env-delete", name: env.name },
                            { method: "post" },
                          )
                        }
                      />
                    </span>
                  )}
                </div>
                {pending && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    <span className="font-medium text-amber-600 dark:text-amber-400">
                      {pending.version}{" "}
                      {pending.status === "building" ? "building" : "queued"}…
                    </span>{" "}
                    switches over once healthy
                    {running ? `; ${running.version} keeps serving` : ""}.
                  </p>
                )}
                {draining && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {draining.version} winding down — finishing in-flight work before
                    shutdown.
                  </p>
                )}
                {failed && (
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-destructive">
                    <span
                      className="size-1.5 rounded-full bg-destructive"
                      aria-hidden
                    />
                    <span>
                      {failed.version} failed to deploy
                      {running ? ` — ${running.version} still running` : ""}
                    </span>
                    {failed.errorDetail && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="cursor-help text-xs underline underline-offset-2">
                            why?
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-sm">
                          {failed.errorDetail}
                        </TooltipContent>
                      </Tooltip>
                    )}
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="retry" />
                      <input
                        type="hidden"
                        name="environmentId"
                        value={env.id}
                      />
                      <input
                        type="hidden"
                        name="releaseId"
                        value={failed.releaseId}
                      />
                      <Button
                        type="submit"
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                      >
                        Retry
                      </Button>
                    </fetcher.Form>
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="clear-failed" />
                      <input
                        type="hidden"
                        name="environmentId"
                        value={env.id}
                      />
                      <Button
                        type="submit"
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                      >
                        Dismiss
                        {failedCount > 1 ? ` ${failedCount} failures` : ""}
                      </Button>
                    </fetcher.Form>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

/**
 * Channels — where this agent listens and answers, one card with one row per channel, sharing the
 * Connections card's visual language (name + state badge, a muted detail line, the one action that
 * matters in the right slot). Discord (issue #32) connects through harnesst's shared app; GitHub
 * (issue #26) through the agent's OWN GitHub App via the Manifest flow. A Discord row without the
 * operator's shared app (HARNESST_DISCORD_*) is hidden — a row whose only content is "this isn't
 * available" is noise.
 */
function ChannelsCard({
  discord,
  github,
  envs,
  projectId,
  agentName,
}: {
  discord: LoaderData["discordSetup"];
  github: LoaderData["githubSetup"];
  envs: EnvState[];
  projectId: string;
  agentName: string;
}) {
  const showDiscord = discord.enabled && discord.configured;
  const showGithub = github.enabled;
  if (!showDiscord && !showGithub) return null;

  return (
    <Card className="mb-6 mt-6">
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardGlyph icon={MessageSquare} accent="brand" />
          <CardTitle className="text-base">Channels</CardTitle>
        </div>
        <CardDescription>
          Where this agent listens and answers. Connect a channel, then add
          more servers or accounts to it any time.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {showDiscord && (
          <DiscordChannelRow
            setup={discord}
            projectId={projectId}
            agentName={agentName}
          />
        )}
        {showGithub && (
          <GitHubChannelRow
            setup={github}
            envs={envs}
            projectId={projectId}
            agentName={agentName}
          />
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The Discord channel row (issue #32): one-click connect through harnesst's shared Discord app — one
 * authorization screen, then harnesst registers a `/<agent-name>` slash command and routes
 * interactions automatically; no portal, no secrets. Connected servers list under the row.
 */
function DiscordChannelRow({
  setup,
  projectId,
  agentName,
}: {
  setup: LoaderData["discordSetup"];
  projectId: string;
  agentName: string;
}) {
  const connectUrl = `/discord/connect?project=${encodeURIComponent(projectId)}&agent=${encodeURIComponent(agentName)}`;
  const connections = setup.connections ?? [];
  const connected = connections.length > 0;
  const plural = connections.length === 1 ? "" : "s";

  return (
    <div className="rounded-lg border px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="grid gap-0.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Discord</span>
            {connected ? (
              <Badge variant="success">connected</Badge>
            ) : (
              <Badge variant="outline">not connected</Badge>
            )}
          </div>
          <span className="text-xs text-muted-foreground">
            {connected
              ? `Connected to ${connections.length} server${plural} — answers there as a slash command.`
              : `Answers as the /${agentName} slash command in any server you connect.`}
          </span>
        </div>
        {connected ? (
          // A connected channel is done — only a subtle add-another link, mirroring the
          // Connections card's covered-grant Reconnect.
          <Link
            to={connectUrl}
            className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Connect another server
          </Link>
        ) : (
          <Button asChild variant="default" size="sm">
            <Link to={connectUrl}>Connect Discord</Link>
          </Button>
        )}
      </div>
      {connected && (
        <ul className="mt-2 space-y-1 border-t pt-2 text-sm">
          {connections.map((c) => (
            <li key={c.id} className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">
                {c.guildName ?? `Server ${c.guildId}`}
              </span>
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                /{c.commandName}
              </code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The GitHub channel row (issue #26): the agent listens through its OWN GitHub App. Connect runs
 * the Manifest flow — harnesst registers the App, stores its secrets (including the webhook URL), and
 * sends the user to GitHub to pick the repositories it watches. Installations list under the row.
 */
function GitHubChannelRow({
  setup,
  envs,
  projectId,
  agentName,
}: {
  setup: LoaderData["githubSetup"];
  envs: EnvState[];
  projectId: string;
  agentName: string;
}) {
  const createUrl = `/github/apps/new?project=${encodeURIComponent(projectId)}&agent=${encodeURIComponent(agentName)}${
    envs[0]?.env.id ? `&env=${encodeURIComponent(envs[0].env.id)}` : ""
  }`;
  const installUrl = setup.appSlug
    ? `https://github.com/apps/${encodeURIComponent(setup.appSlug)}/installations/new`
    : null;
  const connected = setup.appSlug !== null;
  const installs = setup.installations;
  // Same identity — note shape as the Connections rows: WHO the channel is (@slug), then the
  // state's follow-up.
  const detail = !connected
    ? "Answers @mentions in issues and pull requests on the repositories you install it on."
    : installs === null
      ? `@${setup.appSlug} — couldn't reach GitHub to list where it's installed.`
      : installs.length === 0
        ? `@${setup.appSlug} — not installed on any account yet, so it can't see any repositories.`
        : `@${setup.appSlug} — answers @mentions on the repositories it's installed on.`;

  return (
    <div className="rounded-lg border px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="grid gap-0.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">GitHub</span>
            {connected ? (
              <Badge variant="success">connected</Badge>
            ) : (
              <Badge variant="outline">not connected</Badge>
            )}
          </div>
          <span className="text-xs text-muted-foreground">{detail}</span>
        </div>
        {!connected ? (
          <Button asChild variant="default" size="sm">
            <Link to={createUrl}>Connect GitHub</Link>
          </Button>
        ) : installUrl && installs !== null && installs.length === 0 ? (
          // An App installed nowhere sees nothing — installing is the one action that matters,
          // so it takes the primary slot over Reconnect.
          <Button asChild variant="default" size="sm">
            <a href={installUrl} target="_blank" rel="noreferrer">
              Install the App
            </a>
          </Button>
        ) : (
          <Link
            to={createUrl}
            className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Reconnect
          </Link>
        )}
      </div>
      {connected && installUrl && installs === null && (
        <p className="mt-2 border-t pt-2 text-xs text-muted-foreground">
          <a
            href={installUrl}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            Manage installations on GitHub
          </a>
        </p>
      )}
      {connected && installUrl && installs !== null && installs.length > 0 && (
        <div className="mt-2 border-t pt-2">
          <ul className="space-y-1 text-sm">
            {installs.map((inst) => (
              <li
                key={`${inst.accountType}:${inst.account}`}
                className="flex flex-wrap items-baseline gap-x-2"
              >
                <span className="font-medium">{inst.account}</span>
                <span className="text-xs text-muted-foreground">
                  {inst.accountType === "Organization"
                    ? "organization"
                    : "personal account"}
                  {" · "}
                  {inst.repositorySelection === "all"
                    ? "all repositories"
                    : "selected repositories"}
                </span>
                {inst.htmlUrl && (
                  <a
                    href={inst.htmlUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs underline underline-offset-2"
                  >
                    change repositories
                  </a>
                )}
              </li>
            ))}
          </ul>
          <a
            href={installUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-block text-xs underline underline-offset-2"
          >
            Add another account or organization
          </a>
        </div>
      )}
    </div>
  );
}

/**
 * Every version, newest first, badged with the environments it's running on. "Deploy" is
 * deliberately direction-neutral — deploying an older version IS the rollback (cutover on
 * health; a built image starts in seconds).
 */
/** Deploy-guard context threaded to each version's deploy control (§9). */
interface DeployGuard {
  missing: GuardMissingSecret[];
  activeAgent: string;
  settingsAction: string;
}

function VersionHistory({
  releases,
  envs,
  canAct,
  guard,
}: {
  releases: ReleaseRow[];
  envs: EnvState[];
  canAct: boolean;
  guard: DeployGuard;
}) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  // A team of one still deploys through the TEAM path: address the target by env NAME + commit.
  const deploy = (envName: string, gitSha: string) =>
    fetcher.submit(
      { intent: "deploy-team-version", env: envName, gitSha },
      { method: "post" },
    );
  const redeploy = (envName: string, gitSha: string) =>
    fetcher.submit(
      { intent: "deploy-team-version", env: envName, gitSha, rebuild: "1" },
      { method: "post" },
    );
  // Which environments each release is running on, for the rows' badges.
  const runningEnvNames = new Map<string, string[]>();
  for (const { env, deployments } of envs) {
    const running = runningOf(deployments);
    if (!running) continue;
    runningEnvNames.set(running.releaseId, [
      ...(runningEnvNames.get(running.releaseId) ?? []),
      env.name,
    ]);
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <CardGlyph icon={History} accent="indigo" />
          <CardTitle className="text-base">Version history</CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        {!canAct && (
          <p className="mb-3 text-sm text-muted-foreground">
            Deploys happen at the team level — use the team Deployment tab.
          </p>
        )}
        {releases.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No versions yet. Use Quick deploy in the tab row to deploy the
            repository, or merge a change request above.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border text-sm">
            {releases.map((r, i) => (
              <li key={r.id} className="flex items-center gap-2 px-4 py-2">
                <span className="w-10 shrink-0 font-semibold">{r.version}</span>
                <span className="flex shrink-0 items-center gap-1">
                  {i === 0 && <Badge variant="success">Latest</Badge>}
                  {(runningEnvNames.get(r.id) ?? []).map((name) => (
                    <Badge key={name} variant="secondary">
                      {name}
                    </Badge>
                  ))}
                </span>
                <code className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                  {r.gitSha.slice(0, 7)}
                </code>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {r.changelog}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  <RelativeTime value={r.createdAt} />
                </span>
                {canAct && (
                  <DeployControl
                    release={r}
                    envs={envs}
                    busy={busy}
                    guard={guard}
                    onDeploy={deploy}
                    onRedeploy={redeploy}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The per-version deploy affordance. One environment: a plain Deploy button, or Redeploy
 * when the version is already running there. Several: one menu with deploy/redeploy actions
 * per environment. Every deploy confirms — the dialog names the target (the realistic
 * multi-env mistake) and teaches that switching back is just another deploy.
 */
function DeployControl({
  release,
  envs,
  busy,
  guard,
  onDeploy,
  onRedeploy,
}: {
  release: ReleaseRow;
  envs: EnvState[];
  busy: boolean;
  guard: DeployGuard;
  onDeploy: (envName: string, gitSha: string) => void;
  onRedeploy: (envName: string, gitSha: string) => void;
}) {
  type DeployMode = "deploy" | "redeploy";
  const [target, setTarget] = useState<{
    envState: EnvState;
    mode: DeployMode;
  } | null>(null);
  // §9 deploy guard: required secrets still missing → the guard dialog replaces the plain
  // confirm (fix inline, deploy anyway, or cancel). Dismissed requirements never reach here.
  const [guardTarget, setGuardTarget] = useState<{
    envState: EnvState;
    mode: DeployMode;
  } | null>(null);
  const guarded = guard.missing.length > 0;
  const runningHere = (s: EnvState) =>
    runningOf(s.deployments)?.releaseId === release.id;
  const run = (s: EnvState, mode: DeployMode) =>
    mode === "redeploy"
      ? onRedeploy(s.env.name, release.gitSha)
      : onDeploy(s.env.name, release.gitSha);

  const confirmFor = (s: EnvState, mode: DeployMode) => {
    const current = runningOf(s.deployments);
    if (mode === "redeploy") {
      return {
        title: `Redeploy ${release.version} to ${s.env.name}?`,
        description: `Builds a fresh image from this version's commit and switches ${s.env.name} over once it's healthy. The current instance keeps serving until then.`,
      };
    }
    return {
      title: `Deploy ${release.version} to ${s.env.name}?`,
      description: current
        ? `${s.env.name} switches to ${release.version} once it's healthy; ${current.version} keeps serving until then. To switch back, deploy ${current.version} again.`
        : `${release.version} will start running on ${s.env.name}.`,
    };
  };

  if (envs.length === 1) {
    const only = envs[0];
    const mode = runningHere(only) ? "redeploy" : "deploy";
    const copy = confirmFor(only, mode);
    if (guarded) {
      return (
        <>
          <Button
            size="sm"
            variant={mode === "redeploy" ? "outline" : "secondary"}
            disabled={busy}
            onClick={() => setGuardTarget({ envState: only, mode })}
          >
            {mode === "redeploy" ? "Redeploy" : "Deploy"}
          </Button>
          {guardTarget && (
            <DeploySecretsGuardDialog
              open
              onOpenChange={(open) => {
                if (!open) setGuardTarget(null);
              }}
              missing={guard.missing}
              activeAgent={guard.activeAgent}
              settingsAction={guard.settingsAction}
              deployLabel={
                guardTarget.mode === "redeploy" ? "Redeploy" : "Deploy"
              }
              onDeploy={() => {
                run(guardTarget.envState, guardTarget.mode);
                setGuardTarget(null);
              }}
            />
          )}
        </>
      );
    }
    return (
      <ConfirmDialog
        trigger={
          <Button
            size="sm"
            variant={mode === "redeploy" ? "outline" : "secondary"}
            disabled={busy}
          >
            {mode === "redeploy" ? "Redeploy" : "Deploy"}
          </Button>
        }
        title={copy.title}
        description={copy.description}
        confirmLabel={mode === "redeploy" ? "Redeploy" : "Deploy"}
        variant="default"
        onConfirm={() => run(only, mode)}
      />
    );
  }

  const everywhere = envs.every(runningHere);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="secondary" disabled={busy}>
            {everywhere ? "Redeploy" : "Deploy"} ▾
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {envs.map((s) => {
            const mode = runningHere(s)
              ? ("redeploy" as const)
              : ("deploy" as const);
            return (
              <DropdownMenuItem
                key={s.env.id}
                onSelect={() =>
                  guarded
                    ? setGuardTarget({ envState: s, mode })
                    : setTarget({ envState: s, mode })
                }
              >
                {mode === "redeploy"
                  ? `Redeploy in ${s.env.name}`
                  : `Deploy to ${s.env.name}`}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      {target && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setTarget(null);
          }}
          title={confirmFor(target.envState, target.mode).title}
          description={confirmFor(target.envState, target.mode).description}
          confirmLabel={target.mode === "redeploy" ? "Redeploy" : "Deploy"}
          variant="default"
          onConfirm={() => {
            run(target.envState, target.mode);
            setTarget(null);
          }}
        />
      )}
      {guardTarget && (
        <DeploySecretsGuardDialog
          open
          onOpenChange={(open) => {
            if (!open) setGuardTarget(null);
          }}
          missing={guard.missing}
          activeAgent={guard.activeAgent}
          settingsAction={guard.settingsAction}
          deployLabel={guardTarget.mode === "redeploy" ? "Redeploy" : "Deploy"}
          onDeploy={() => {
            run(guardTarget.envState, guardTarget.mode);
            setGuardTarget(null);
          }}
        />
      )}
    </>
  );
}

/**
 * Shared name dialog for team env create/rename — one text field. Create posts `name`; rename
 * posts `from` (the current name) + `to`. Both apply across every member (team-level CRUD).
 */
function EnvNameDialog({
  intent,
  trigger,
  title,
  description,
  confirmLabel,
  from,
  initialName,
}: {
  intent: "env-create" | "env-rename";
  trigger: React.ReactNode;
  title: string;
  description: string;
  confirmLabel: string;
  /** The current name being renamed (rename only). */
  from?: string;
  initialName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(initialName ?? "");
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const error =
    fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;
  // Stay open until OUR submission settles — success closes, an error (e.g. duplicate
  // name) shows inline so the human can fix the name and retry. The close happens inline
  // on the render where fetcher.data changes (no effect, no stale-frame flash).
  const [prevData, setPrevData] = useState(fetcher.data);
  if (fetcher.data !== prevData) {
    setPrevData(fetcher.data);
    if (open && fetcher.data && "ok" in fetcher.data && fetcher.data.ok) {
      setOpen(false);
      if (intent === "env-create") setName("");
    }
  }
  const submit = () => {
    if (!name.trim()) return;
    fetcher.submit(
      intent === "env-rename"
        ? { intent, from: from ?? "", to: name.trim() }
        : { intent, name: name.trim() },
      { method: "post" },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="space-y-1.5">
          <Label htmlFor={`env-name-${intent}-${from ?? "new"}`}>Name</Label>
          <Input
            id={`env-name-${intent}-${from ?? "new"}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="staging"
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!name.trim() || busy}>
            {busy ? "Saving…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
