/**
 * Settings — configuration that isn't the agent's repo-backed behavior (M5.8).
 *
 * Two levels share this module (route ids `settings` + `member-settings`):
 *  - MEMBER sections (team members at /agents/:name/settings; included for single-agent
 *    repos): Model (saved into agent.ts like any edit), Secrets (per-member + per-
 *    environment, write-only values), Marketplace installs, and the member danger zone
 *    (remove agent — saves the deletion of its directory for the next publish).
 *  - REPO sections (team repos at /repos/:id/settings; appended for single-agent repos):
 *    Marketplace installs, General (the GitHub connection), Run ingestion tokens, and the repo
 *    danger zone — Delete repository, a FULL harnesst-side teardown (instances stopped and
 *    destroyed, every row cascaded). The GitHub repository itself is never touched.
 */
import { getSessionAuth, sessionLoader } from "~/auth/session.server";
import {
  AlertTriangle,
  Boxes,
  Cpu,
  FolderGit2,
  KeyRound,
  Pencil,
  Settings2,
} from "lucide-react";
import { useMemo, useState } from "react";
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
import semver from "semver";

import { ConfirmDialog } from "~/components/confirm-dialog";
import { usePublishHref } from "~/components/publish";
import { EmptyTeamState } from "~/components/empty-team-state";
import { LocalizedDate } from "~/components/localized-values";
import { ModelSelection } from "~/components/model-select";
import {
  AgentNav,
  AppShell,
  PageHeader,
  SectionHeader,
  repoCrumbs,
  type NavLevel,
} from "~/components/shell";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import type { Environment } from "~/data/ports";
import { deleteRepository } from "~/deploy/repository.server";
import { listAgentEnvironments } from "~/db/queries.server";
import {
  createIngestToken,
  listIngestTokens,
} from "~/observability/store.server";
import { listDrafts, stageDeletions, stageDraft } from "~/drafts/drafts.server";
import { EMPTY_TEAM_MARKER } from "~/eve/parse";
import { getAgentSource } from "~/github/cached.server";
import { fetchAgentSource, readAgentFile } from "~/github/repo.server";
import { contextPath } from "~/lib/paths";
import {
  catalogLocator,
  packageJsonPathForRoot,
  planInstall,
  planUninstall,
} from "~/marketplace/install.server";
import { overlayLock, renameMember, serializeLock } from "~/marketplace/lock";
import { slugifyResourceName } from "~/eve/templates";
import {
  resolveTemplate,
  type ResolvedTemplate,
} from "~/marketplace/compose.server";
import type { TemplateType } from "~/marketplace/manifest";
import { resolveAgentModel } from "~/models/agent-model-config.server";
import { stageModelChange } from "~/models/stage-model.server";
import { ownsWorkspaceModelReference } from "~/models/union.server";
import { getWorkspaceAssistantSelection } from "~/org/workspace.server";
import { isReasoningEffort, type ReasoningEffort } from "~/models/reasoning";
import {
  agentFromParams,
  agentParamRedirect,
  requireActiveAgent,
  resolveAgentContext,
  resolveSyncedAgentContext,
} from "~/project/agent-context.server";
import { requireProject, requireRepo } from "~/project/guard.server";
import type { ConnectedProject } from "~/project/guard.server";
import { getRuntime } from "~/seams/index.server";
import {
  listAgentSecretRows,
  listAttachments,
  listDismissedRequirements,
  listSharedAttachments,
  listSharedSecrets,
  type SecretRow,
} from "~/seams/oss/secret-store";
import {
  computeRequiredSecrets,
  handleSecretIntent,
  lockSecretsForMember,
  type RequiredSecretComputed,
  type SecretIntentInput,
} from "~/project/secrets.server";
import { SecretsCard } from "~/components/secrets-card";
import { SharedSecretsSection } from "~/components/shared-secrets-section";
import { TeamLinksSection } from "~/components/team-links-section";
import type { Route } from "./+types/projects.$projectId.settings";

/** The fetcher-JSON secret intents delegated to ~/project/secrets.server (§6). */
const SECRET_INTENTS = new Set<string>([
  "secret-set",
  "secret-replace",
  "secret-delete",
  "secret-expose",
  "secret-attach",
  "secret-detach",
  "secret-dismiss",
  "shared-secret-set",
  "shared-secret-delete",
  "shared-secret-expose-default",
]);

const ALL = "all";

interface SettingsView {
  project: ConnectedProject;
  roster: { name: string }[];
  activeAgent: string;
  isTeam: boolean;
  level: NavLevel;
  showMember: boolean;
  showRepo: boolean;
  /** Member: whether the active member can be removed from a team. */
  canRemoveMember: boolean;
  /** Member: whether the active agent can be renamed (any member/single-agent, self view). */
  canRenameMember: boolean;
  /** Member: a saved-but-unpublished rename target, or null. */
  pendingName: string | null;
  /** Member: current model (staged draft wins) + staging state. */
  model: string | null;
  effort: ReasoningEffort | null;
  modelInherited: boolean;
  hasAgentModule: boolean;
  modelStaged: boolean;
  /** Member: secrets scope state. */
  envs: Environment[];
  scope: { environmentId: string | null; label: string };
  /** All of this member's secret rows, across every env (env switching is client-side, §6). */
  secrets: SecretRow[];
  secretsConfigured: boolean;
  secretsError: string | null;
  /** Member: unmet template requirements (lock secrets − set ∪ attached ∪ dismissed, §9). */
  requiredSecrets: RequiredSecretComputed[];
  /** Member: requirements the human dismissed (recoverable). */
  dismissedSecrets: RequiredSecretComputed[];
  /** Member: every name any lock entry requires (powers the detach warning). */
  requiredSecretNames: string[];
  /** Project-level shared secrets + this member's attachments (§7 shared group). */
  sharedSecrets: {
    key: string;
    environmentId: string | null;
    fingerprint: string | null;
    updatedAt: string;
    sandboxExposed: boolean;
  }[];
  attachments: { key: string; sandboxExposed: boolean }[];
  /** Repo: the Shared Secrets section (§8) — rows + per-agent usage for blast radius. */
  repoShared: RepoSharedSecret[];
  /** Marketplace installs in the current settings scope. */
  installs: InstallDisplay[];
  /** Repo: ingest tokens. */
  tokens: {
    id: string;
    name: string;
    createdAt: string;
    lastUsedAt: string | null;
  }[];
  /** Repo (team only): the directed collaboration matrix — members + touched override rows. */
  teamMembers: { id: string; name: string }[];
  teamLinks: { fromAgentId: string; toAgentId: string; enabled: boolean }[];
}

/** One shared secret as the repo-level section shows it (§8). */
export interface RepoSharedSecret {
  key: string;
  environmentId: string | null;
  fingerprint: string | null;
  updatedAt: string;
  /** The shared default — seeds new attachments only, never retro-applied. */
  sandboxExposed: boolean;
  /** Attached members + their per-attachment sandbox flag ("Used by N agents ▾"). */
  usedBy: {
    agentName: string;
    sandboxExposed: boolean;
    /** This member's templates require the name — deleting marks it missing (§11.4). */
    requiredByTemplate: boolean;
  }[];
}

/** A marketplace install as Settings shows it: provenance + update availability. */
interface InstallDisplay {
  id: string;
  type: TemplateType;
  name: string;
  version: string;
  /** Owning member; null = the single-agent repo's root agent. */
  member: string | null;
  /** Files uninstall would delete (from the lock). */
  files: string[];
  /** npm packages uninstall leaves for the reviewer to prune. */
  depsLeft: string[];
  /** The newer catalog version when an update is available, else null. */
  update: string | null;
  /** Current catalog version matches, but the installed lock is missing flattened catalog content. */
  repair: boolean;
}

/** Resolve the `?env=` param to an environmentId (null == agent-wide), validated. */
function resolveScope(
  raw: string | null,
  envs: Environment[],
): { environmentId: string | null; label: string } {
  if (!raw || raw === ALL)
    return { environmentId: null, label: "All environments" };
  const env = envs.find((e) => e.id === raw);
  return env
    ? { environmentId: env.id, label: env.name }
    : { environmentId: null, label: "All environments" };
}

/**
 * Build install display rows from the effective lock, tagging each with the newer catalog version
 * when one exists. The catalog is optional; when it is unavailable, rows simply show no updates.
 */
function buildInstalls(
  lock: ReturnType<typeof overlayLock>,
  index: { id: string; type: TemplateType; version: string }[],
  resolved: Map<string, ResolvedTemplate>,
  keep: (member: string | null) => boolean,
): InstallDisplay[] {
  return lock.installs.reduce<InstallDisplay[]>((rows, entry) => {
    if (!keep(entry.member)) return rows;
    const row = index.find((r) => r.id === entry.id && r.type === entry.type);
    const template = resolved.get(`${entry.type}/${entry.id}`);
    let update: string | null = null;
    try {
      if (row && semver.gt(row.version, entry.version)) update = row.version;
    } catch {
      update = null;
    }
    const root = entry.member ? `agents/${entry.member}/agent` : "agent";
    const expectedFiles = new Set(
      (template?.manifest.files ?? []).map((file) => `${root}/${file}`),
    );
    // Deliberately-preserved paths (issue #177) aren't lock-owned but DO exist on disk — count
    // them as present so a registered install isn't flagged as permanently drifted / needing repair.
    const installedFiles = new Set([
      ...entry.files,
      ...(entry.preservedFiles ?? []),
    ]);
    const missingFiles =
      expectedFiles.size > 0 &&
      [...expectedFiles].some((file) => !installedFiles.has(file));
    const expectedIncludes = template?.includes ?? [];
    const installedIncludes = entry.includes ?? [];
    const missingIncludes =
      expectedIncludes.length > 0 &&
      expectedIncludes.some(
        (include) =>
          !installedIncludes.some(
            (installed) =>
              installed.type === include.type &&
              installed.id === include.id &&
              installed.hash === include.hash,
          ),
      );
    rows.push({
      id: entry.id,
      type: entry.type,
      name: entry.name,
      version: entry.version,
      member: entry.member,
      files: entry.files,
      depsLeft: Object.keys(entry.dependencies ?? {}),
      update,
      repair: !update && (missingFiles || missingIncludes),
    });
    return rows;
  }, []);
}

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }): Promise<SettingsView> => {
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
      const repo = { owner: project.repoOwner, repo: project.repoName };
      const [source, drafts] = await Promise.all([
        getAgentSource(project.repoInstallationId, repo),
        listDrafts(project.id),
      ]);
      const { roster, active, isTeam } = await resolveSyncedAgentContext(
        project.id,
        agentName,
        source.paths,
      );
      if (agentName && !active) throw redirect(`/repos/${project.id}`);
      const level: NavLevel = agentName ? "member" : isTeam ? "repo" : "single";
      const showMember = level !== "repo";
      const showRepo = level !== "member";
      const draftPaths = drafts.map((d) => ({
        path: d.path,
        content: d.content,
      }));
      const lock = overlayLock(
        source.files["harnesst-lock.json"] ?? null,
        draftPaths,
      );
      let index: { id: string; type: TemplateType; version: string }[] = [];
      const resolvedTemplates = new Map<string, ResolvedTemplate>();
      if (lock.installs.length > 0) {
        try {
          const catalog = getRuntime().catalog;
          index = (await catalog.index()).templates;
          await Promise.all(
            lock.installs.map(async (entry) => {
              try {
                const template = await resolveTemplate(
                  catalog,
                  entry.type,
                  entry.id,
                );
                resolvedTemplates.set(`${entry.type}/${entry.id}`, template);
              } catch (error) {
                console.warn(
                  `[settings] catalog template ${entry.type}/${entry.id} unavailable:`,
                  error,
                );
              }
            }),
          );
        } catch (error) {
          console.warn("[settings] catalog index unavailable:", error);
        }
      }

      const base: SettingsView = {
        project,
        roster: roster.map((a) => ({ name: a.name })),
        activeAgent: active?.name ?? "",
        isTeam,
        level,
        showMember,
        showRepo,
        canRemoveMember: showMember && isTeam && active?.root !== "agent",
        canRenameMember: showMember && active !== null,
        pendingName: showMember ? (active?.pendingName ?? null) : null,
        model: null,
        effort: null,
        modelInherited: false,
        hasAgentModule: false,
        modelStaged: false,
        envs: [],
        scope: { environmentId: null, label: "All environments" },
        secrets: [],
        secretsConfigured: true,
        secretsError: null,
        requiredSecrets: [],
        dismissedSecrets: [],
        requiredSecretNames: [],
        sharedSecrets: [],
        attachments: [],
        repoShared: [],
        installs: buildInstalls(
          lock,
          index,
          resolvedTemplates,
          level === "repo"
            ? () => true
            : (member) =>
                member === active?.name || (member === null && !isTeam),
        ),
        tokens: [],
        teamMembers: [],
        teamLinks: [],
      };

      if (showMember && active) {
        const agentTsPath = `${active.root}/agent.ts`;
        const [envs, resolved] = await Promise.all([
          listAgentEnvironments(active.id),
          resolveAgentModel(project.orgId, active.name).catch(() => null),
        ]);
        // Model + effort are workspace configuration, resolved from harnesst's control plane by
        // agent name (the `harnesstAgentModel('<name>')` identity the running agent resolves itself
        // by) — never parsed out of agent.ts. An explicit per-agent override wins; otherwise the
        // shown value is the workspace default ("inherited default").
        base.model = resolved?.model ?? null;
        base.effort = resolved?.effort ?? null;
        base.modelInherited = resolved?.source === "workspace-default";
        const agentTsStaged = drafts.some(
          (d) => d.path === agentTsPath && d.content !== null,
        );
        base.hasAgentModule = source.paths.includes(agentTsPath) || agentTsStaged;
        base.modelStaged = agentTsStaged;
        base.envs = envs;
        base.scope = resolveScope(
          new URL(args.request.url).searchParams.get("env"),
          envs,
        );
        try {
          // Every row across all envs — the card filters client-side by env pill (§6/§7) —
          // plus the shared/attachment/dismissal state the four card groups render from.
          const [secrets, shared, attachments, dismissedNames] =
            await Promise.all([
              listAgentSecretRows(project.id, active.id),
              listSharedSecrets(project.id),
              listAttachments(active.id),
              listDismissedRequirements(active.id),
            ]);
          base.secrets = secrets;
          base.sharedSecrets = shared.map((s) => ({
            key: s.key,
            environmentId: s.environmentId,
            fingerprint: s.fingerprint,
            updatedAt: s.updatedAt,
            sandboxExposed: s.sandboxExposed,
          }));
          base.attachments = attachments;

          // Required rows (§9): lock entries owned by this member, minus set/attached/dismissed.
          const lockSecrets = lockSecretsForMember(lock, active.name, isTeam);
          const computed = computeRequiredSecrets({
            lockSecrets,
            setNames: secrets.map((s) => s.key),
            attachedNames: attachments.map((a) => a.key),
            dismissedNames,
          });
          base.requiredSecrets = computed.missing;
          base.dismissedSecrets = computed.dismissed;
          base.requiredSecretNames = computed.all.map((r) => r.name);
        } catch (error) {
          base.secretsConfigured = false;
          base.secretsError = (error as Error).message;
        }
      }
      if (showRepo) {
        // Shared Secrets section (§8) — visible for team AND single-agent repos (a team of
        // one still benefits when it grows). Usage rows carry each member's per-attachment
        // sandbox flag and whether its templates require the name (delete blast radius).
        try {
          const [shared, attachmentRows] = await Promise.all([
            listSharedSecrets(project.id),
            listSharedAttachments(project.id),
          ]);
          const requiredByMember = new Map(
            roster.map((a) => [
              a.name,
              new Set(
                lockSecretsForMember(lock, a.name, isTeam).flatMap((e) =>
                  e.secrets.map((s) => s.name),
                ),
              ),
            ]),
          );
          base.repoShared = shared.map((s) => ({
            key: s.key,
            environmentId: s.environmentId,
            fingerprint: s.fingerprint,
            updatedAt: s.updatedAt,
            sandboxExposed: s.sandboxExposed,
            usedBy: attachmentRows.reduce<RepoSharedSecret["usedBy"]>(
              (used, a) => {
                if (a.key === s.key) {
                  used.push({
                    agentName: a.agentName,
                    sandboxExposed: a.sandboxExposed,
                    requiredByTemplate:
                      requiredByMember.get(a.agentName)?.has(s.key) ?? false,
                  });
                }
                return used;
              },
              [],
            ),
          }));
        } catch (error) {
          console.warn("[settings] shared secrets unavailable:", error);
        }
        const tokens = await listIngestTokens(project.id);
        base.tokens = tokens.map((t) => ({
          id: t.id,
          name: t.name,
          createdAt: new Date(t.createdAt).toISOString(),
          lastUsedAt: t.lastUsedAt
            ? new Date(t.lastUsedAt).toISOString()
            : null,
        }));
        // Team collaboration matrix (D4): only meaningful with more than one member.
        if (isTeam && roster.length > 1) {
          base.teamMembers = roster.map((a) => ({ id: a.id, name: a.name }));
          const links = await getRuntime().data.agentLinks.listByProject(
            project.id,
          );
          base.teamLinks = links.map((l) => ({
            fromAgentId: l.fromAgentId,
            toAgentId: l.toAgentId,
            enabled: l.enabled,
          }));
        }
      }
      return base;
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
  const back = `${contextPath(project.id, agentFromParams(args.params))}/settings`;
  const repo = { owner: project.repoOwner, repo: project.repoName };

  try {
    // ── Model: stage agent.ts for the active member (same rails as every edit) ──
    if (intent === "set-model") {
      const model = String(form.get("model") ?? "").trim();
      if (!model) return { error: "Pick or enter a model." };
      const effortValue = String(form.get("effort") ?? "").trim();
      const effort =
        effortValue && isReasoningEffort(effortValue) ? effortValue : null;
      if (effortValue && !effort)
        return { error: "Choose a valid reasoning effort." };
      const { active } = await resolveAgentContext(
        project.id,
        String(form.get("agent") ?? "") || null,
      );
      requireActiveAgent(active, project.id);
      const result = await stageModelChange({
        project,
        root: active.root,
        model,
        effort,
        createdBy: auth.user.id,
      });
      if (!result.ok) return { error: result.error };
      return { ok: true as const, mode: result.mode };
    }

    // ── Marketplace installs: update / uninstall stage reviewable repo changes ──
    if (intent === "update-install") {
      const type = String(form.get("type") ?? "") as TemplateType;
      const id = String(form.get("id") ?? "");
      const member = String(form.get("member") ?? "") || null;
      const mode =
        String(form.get("mode") ?? "") === "repair" ? "repaired" : "updated";
      if (!type || !id) return { error: "Missing install to update." };
      // Actions read raw — a stale read merged into a write could clobber newer content.
      const [template, source, drafts] = await Promise.all([
        resolveTemplate(getRuntime().catalog, type, id),
        fetchAgentSource(project.repoInstallationId, repo),
        listDrafts(project.id),
      ]);
      const { roster, active } = await resolveSyncedAgentContext(
        project.id,
        member,
        source.paths,
      );
      requireActiveAgent(active, project.id);
      const draftPaths = drafts.map((d) => ({
        path: d.path,
        content: d.content,
      }));
      const lock = overlayLock(
        source.files["harnesst-lock.json"] ?? null,
        draftPaths,
      );
      // A staged package.json draft wins over the branch copy — otherwise a second staged
      // install/update could silently drop dependencies added by the first.
      const pkgPath = packageJsonPathForRoot(active.root);
      const pkgDraft = drafts.find((d) => d.path === pkgPath);
      const packageJson =
        pkgDraft !== undefined
          ? pkgDraft.content
          : await readAgentFile(project.repoInstallationId, repo, pkgPath);
      let installModel: string | null = null;
      let installEffort: ReasoningEffort | null = null;
      if (template.manifest.type === "agent") {
        // The agent's configured model is workspace state, resolved by name from the control
        // plane — not read from agent.ts. Fall back to the workspace default only when that
        // resolved model points at a connection that is no longer usable.
        const resolved = await resolveAgentModel(
          project.orgId,
          active.name,
        ).catch(() => null);
        if (
          resolved &&
          (await ownsWorkspaceModelReference(project.orgId, resolved.model))
        ) {
          installModel = resolved.model;
          installEffort = resolved.effort;
        } else {
          const workspaceSelection = await getWorkspaceAssistantSelection(
            project.orgId,
          ).catch(() => ({ model: null, effort: null }));
          installModel =
            workspaceSelection.model &&
            (await ownsWorkspaceModelReference(
              project.orgId,
              workspaceSelection.model,
            ))
              ? workspaceSelection.model
              : null;
          installEffort = installModel ? workspaceSelection.effort : null;
        }
        if (!installModel) {
          return {
            error:
              "Choose a connected workspace default model before updating this agent template.",
          };
        }
      }
      const plan = planInstall({
        template,
        registry: catalogLocator(),
        repoPaths: source.paths,
        drafts: draftPaths,
        packageJson,
        lock,
        rosterNames: roster.map((a) => a.name),
        model: installModel,
        effort: installEffort,
        target: { kind: "member", memberName: member, root: active.root },
      });
      if (plan.conflicts.length > 0) {
        return {
          error: `Update blocked — these files were changed locally:\n${plan.conflicts.join("\n")}`,
        };
      }
      await Promise.all(
        plan.writes.map((w) =>
          stageDraft({
            projectId: project.id,
            path: w.path,
            content: w.content,
            createdBy: auth.user.id,
          }),
        ),
      );
      if (plan.deletions.length > 0) {
        await stageDeletions({
          projectId: project.id,
          paths: plan.deletions,
          createdBy: auth.user.id,
        });
      }
      throw redirect(`${back}?${mode}=${encodeURIComponent(id)}`);
    }
    if (intent === "uninstall") {
      const id = String(form.get("id") ?? "");
      const member = String(form.get("member") ?? "") || null;
      if (!id) return { error: "Missing install to remove." };
      const [source, drafts] = await Promise.all([
        fetchAgentSource(project.repoInstallationId, repo),
        listDrafts(project.id),
      ]);
      const draftPaths = drafts.map((d) => ({
        path: d.path,
        content: d.content,
      }));
      const lock = overlayLock(
        source.files["harnesst-lock.json"] ?? null,
        draftPaths,
      );
      const plan = planUninstall({
        lock,
        id,
        memberName: member,
        repoPaths: source.paths,
      });
      if (plan.notFound) {
        return { error: "That install isn't recorded in harnesst-lock.json." };
      }
      if (plan.deletions.length > 0) {
        await stageDeletions({
          projectId: project.id,
          paths: plan.deletions,
          createdBy: auth.user.id,
        });
      }
      await Promise.all(
        plan.writes.map((write) =>
          stageDraft({
            projectId: project.id,
            path: write.path,
            content: write.content,
            createdBy: auth.user.id,
          }),
        ),
      );
      throw redirect(`${back}?uninstalled=${encodeURIComponent(id)}`);
    }

    // ── Secrets (per-member + per-environment; values write-only) ──
    // All secret mutations are fetcher-JSON: NO redirect (kills the full-page-reload jank,
    // gripes #1–#3). The decisions live in ~/project/secrets.server (unit-tested); this branch
    // only parses the form and resolves the member + environment scope.
    if (SECRET_INTENTS.has(intent)) {
      // shared-* intents address the project-level scope; member intents resolve the agent.
      let agentId: string | null = null;
      let environmentId: string | null = null;
      if (!intent.startsWith("shared-")) {
        const { active } = await resolveAgentContext(
          project.id,
          String(form.get("agent") ?? "") || null,
        );
        requireActiveAgent(active, project.id);
        const envs = await listAgentEnvironments(active.id);
        agentId = active.id;
        environmentId = resolveScope(
          String(form.get("env") ?? ALL),
          envs,
        ).environmentId;
      }
      return handleSecretIntent(
        {
          intent: intent as SecretIntentInput["intent"],
          projectId: project.id,
          agentId,
          environmentId,
          key: String(form.get("key") ?? ""),
          value: form.has("value") ? String(form.get("value")) : undefined,
          // `exposed` present → set atomically at creation (gripe #3); absent → untouched.
          exposed: form.has("exposed")
            ? form.get("exposed") === "1"
            : undefined,
          dismissed: form.has("dismissed")
            ? form.get("dismissed") === "1"
            : undefined,
          userId: auth.user.id,
        },
        { secrets: getRuntime().secrets },
      );
    }

    // ── Team collaboration matrix: toggle a directed can-ask override (D4) ──
    // Default-allow: an absent row = allowed; unchecking writes enabled=false. JSON in/out
    // (fetcher), so a toggle never navigates. Both members are validated against the roster.
    if (intent === "link-toggle") {
      const fromAgentId = String(form.get("from") ?? "");
      const toAgentId = String(form.get("to") ?? "");
      const enabled = form.get("enabled") === "1";
      if (!fromAgentId || !toAgentId || fromAgentId === toAgentId) {
        return { error: "Pick two different agents." };
      }
      const { roster } = await resolveAgentContext(project.id, null);
      const ids = new Set(roster.map((a) => a.id));
      if (!ids.has(fromAgentId) || !ids.has(toAgentId)) {
        return { error: "Unknown agent." };
      }
      await getRuntime().data.agentLinks.set({
        projectId: project.id,
        fromAgentId,
        toAgentId,
        enabled,
      });
      return { ok: true as const };
    }

    // ── Member danger zone: remove agent (saves the deletion of its directory) ──
    // The deletion is SAVED as drafts (§2.4: structural operations save their full file set in
    // one action); the header Publish control takes it live, and the roster row goes when the
    // publish's roster sync sees the directory gone.
    if (intent === "remove-member") {
      const name = String(form.get("name") ?? "");
      const { roster } = await resolveAgentContext(project.id, null);
      const member = roster.find((a) => a.name === name);
      if (!member || member.root === "agent") {
        return { error: "Only agents (agents/<name>/) can be removed." };
      }
      const source = await fetchAgentSource(project.repoInstallationId, repo);
      const memberDir = `agents/${name}/`;
      const paths = source.paths.filter((p) => p.startsWith(memberDir));
      if (paths.length === 0)
        return { error: `No files found under ${memberDir}.` };
      await stageDeletions({
        projectId: project.id,
        paths,
        createdBy: auth.user.id,
      });
      // Keep the team layout detectable when the last member goes: the marker README says
      // "this repo is a team" even with zero agents/ directories.
      if (!source.paths.includes(EMPTY_TEAM_MARKER)) {
        await stageDraft({
          projectId: project.id,
          path: EMPTY_TEAM_MARKER,
          content:
            "# Agents\n\nAdd each agent under `agents/<name>/` as a complete eve project.\n",
          createdBy: auth.user.id,
        });
      }
      return { ok: true as const, removalSaved: name };
    }

    // ── Member: rename agent ──
    // Root single-agent: the name is decoupled from the directory, so the rename is INSTANT (a
    // DB update, no repo change). Team member: the name IS the `agents/<name>/` directory, so
    // the rename SAVES the full directory move as drafts (§2.4: structural operations save
    // their file set in one action) and the Publish pipeline lands it; the roster sync maps the
    // row in place (pendingName) once the published tree shows the new directory.
    if (intent === "rename-member") {
      const newName = slugifyResourceName(String(form.get("name") ?? ""));
      if (!newName) return { error: "New name is required." };
      if (newName === "assistant") {
        return {
          error: `"assistant" is reserved for harnesst's built-in assistant — pick another name.`,
        };
      }
      const { roster, active } = await resolveAgentContext(
        project.id,
        String(form.get("agent") ?? "") || null,
      );
      requireActiveAgent(active, project.id);
      if (newName === active.name) {
        return { error: "That's already this agent's name." };
      }
      // Collide against both live roster names and any other member's pending rename target.
      const taken = roster.some(
        (a) =>
          a.id !== active.id &&
          (a.name === newName || a.pendingName === newName),
      );
      if (taken) {
        return { error: `An agent named "${newName}" already exists.` };
      }
      const drafts = await listDrafts(project.id);
      if (active.pendingName) {
        // A saved rename is still waiting to publish. If its saved files were discarded, the
        // mark is stale — clear it and let this rename proceed; otherwise the earlier rename
        // must publish (or be discarded) first.
        const pendingDir = `agents/${active.pendingName}/`;
        const stillSaved = drafts.some(
          (d) => d.path.startsWith(pendingDir) && d.content !== null,
        );
        if (stillSaved) {
          return {
            error: `A rename to "${active.pendingName}" is already saved — publish it, or discard its saved changes, then rename again.`,
          };
        }
        await getRuntime().data.agents.setPendingName(active.id, null);
      }

      // Root single-agent: rename in place, no repo change.
      if (active.root === "agent") {
        await getRuntime().data.agents.rename(active.id, {
          name: newName,
          root: "agent",
        });
        return { ok: true as const, renamed: newName };
      }

      // Team member: save the whole `agents/<old>/` → `agents/<new>/` move as drafts. A saved
      // edit under the old directory rides along (its content moves, its old path deletes) —
      // the publish must land the tree the user last saw, not the repo's stale copy.
      const oldName = active.name;
      const source = await fetchAgentSource(project.repoInstallationId, repo);
      const oldDir = `agents/${oldName}/`;
      const newDir = `agents/${newName}/`;
      const draftByPath = new Map(drafts.map((d) => [d.path, d]));
      const oldPaths = new Set(
        source.paths.filter((p) => p.startsWith(oldDir)),
      );
      for (const d of drafts) {
        if (!d.path.startsWith(oldDir)) continue;
        // A saved deletion stays a deletion at the old path; everything else moves.
        if (d.content === null) oldPaths.delete(d.path);
        else oldPaths.add(d.path);
      }
      if (oldPaths.size === 0) {
        return { error: `No files found under ${oldDir}.` };
      }
      const paths = [...oldPaths];
      const contents = await Promise.all(
        paths.map(
          (p) =>
            draftByPath.get(p)?.content ??
            readAgentFile(project.repoInstallationId, repo, p),
        ),
      );
      const moves: { from: string; content: string }[] = [];
      paths.forEach((p, i) => {
        const content = contents[i];
        if (content === null) return; // unreadable/binary — leave it in place.
        // The member package.json carries `"name": "<member>"` — retarget it to the new name.
        let destContent = content;
        if (p === `${oldDir}package.json`) {
          try {
            const pkg = JSON.parse(content);
            pkg.name = newName;
            destContent = JSON.stringify(pkg, null, 2) + "\n";
          } catch {
            // Leave a malformed package.json as-is; it shows in the publish panel's diff.
          }
        }
        moves.push({ from: p, content: destContent });
      });

      // Mark the rename in-flight BEFORE saving the file set: if saving dies halfway, the mark
      // plus the partial drafts are recoverable (publish the rest, or discard — the stale-mark
      // self-heal above clears a mark whose saved files are gone).
      await getRuntime().data.agents.setPendingName(active.id, newName);
      for (const move of moves) {
        await stageDraft({
          projectId: project.id,
          path: `${newDir}${move.from.slice(oldDir.length)}`,
          content: move.content,
          createdBy: auth.user.id,
        });
      }
      await stageDeletions({
        projectId: project.id,
        paths: moves.map((m) => m.from),
        createdBy: auth.user.id,
      });

      // harnesst-lock.json lives at the repo root: retag this member's installs old → new. Overlay
      // any saved lock draft so an unpublished install/uninstall isn't clobbered.
      const lockRaw =
        draftByPath.get("harnesst-lock.json")?.content ??
        source.files["harnesst-lock.json"] ??
        null;
      if (lockRaw) {
        const rewritten = renameMember(overlayLock(lockRaw, []), oldName, newName);
        if (rewritten.changed) {
          await stageDraft({
            projectId: project.id,
            path: "harnesst-lock.json",
            content: serializeLock(rewritten.lock),
            createdBy: auth.user.id,
          });
        }
      }
      return { ok: true as const, renameSaved: newName };
    }

    // ── Repo: ingest tokens ──
    if (intent === "create-token") {
      const token = await createIngestToken(
        project.id,
        String(form.get("name") || "ingest"),
      );
      return { ok: true as const, token };
    }

    // ── Repo danger zone: full harnesst-side teardown ──
    if (intent === "delete-repository") {
      const confirm = String(form.get("confirm") ?? "");
      if (confirm !== project.name) {
        return {
          error: `Type the repository name ("${project.name}") to confirm.`,
        };
      }
      await deleteRepository({
        projectId: project.id,
        createdBy: auth.user.id,
      });
      throw redirect("/dashboard");
    }

    return { error: "Unknown action." };
  } catch (error) {
    if (error instanceof Response) throw error;
    return { error: (error as Error).message };
  }
}

export function meta() {
  return [{ title: "Settings · harnesst" }];
}

export default function Settings({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const {
    project,
    roster,
    activeAgent,
    isTeam,
    level,
    showMember,
    showRepo,
    canRemoveMember,
    canRenameMember,
    pendingName,
  } = loaderData;
  const publishHref = usePublishHref();
  const base = contextPath(project.id, level === "member" ? activeAgent : null);
  const [params] = useSearchParams();
  const justUpdated = params.get("updated");
  const justRepaired = params.get("repaired");
  const justUninstalled = params.get("uninstalled");
  const newToken =
    actionData && "token" in actionData
      ? (actionData.token as string | null)
      : null;
  const renameSaved =
    actionData && "renameSaved" in actionData
      ? (actionData.renameSaved as string)
      : null;
  const removalSaved =
    actionData && "removalSaved" in actionData
      ? (actionData.removalSaved as string)
      : null;
  const renamed =
    actionData && "renamed" in actionData
      ? (actionData.renamed as string)
      : null;
  const navigation = useNavigation();
  const deletingRepository =
    navigation.state !== "idle" &&
    navigation.formData?.get("intent") === "delete-repository";

  return (
    <AppShell
      breadcrumbs={repoCrumbs({
        projectId: project.id,
        repoName: project.name,
        isTeam: level === "member",
        agentName: activeAgent,
        tail: [{ label: "Settings" }],
      })}
    >
      <AgentNav
        base={base}
        level={level}
        roster={roster}
        activeAgent={level === "member" ? activeAgent : undefined}
      />
      <PageHeader
        icon={Settings2}
        accent="brand"
        title={level === "member" ? `Settings — ${activeAgent}` : "Settings"}
        description={
          level === "repo"
            ? "Repository-wide configuration. Each agent's model and secrets live in the agent's own Settings."
            : showRepo
              ? "This agent's runtime configuration and the repository connection."
              : "This agent's runtime configuration — model, credentials, and team collaboration."
        }
      />

      {actionData && "error" in actionData && actionData.error && (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap">
            {actionData.error}
          </AlertDescription>
        </Alert>
      )}
      {deletingRepository && (
        <Alert className="mb-6">
          <AlertTitle>Deleting repository</AlertTitle>
          <AlertDescription>
            Cleaning up deployments and harnesst data. This can take a few
            minutes; you&apos;ll be sent back to the Dashboard when it finishes.
          </AlertDescription>
        </Alert>
      )}
      {renamed && (
        <Alert className="mb-6">
          <AlertTitle>Renamed to {renamed}</AlertTitle>
          <AlertDescription>
            This agent&rsquo;s name is updated across harnesst.
          </AlertDescription>
        </Alert>
      )}
      {renameSaved && (
        <Alert className="mb-6">
          <AlertTitle>Rename to {renameSaved} saved</AlertTitle>
          <AlertDescription>
            The directory move is saved with your other changes — nothing is
            renamed until you publish.{" "}
            <Link
              to={publishHref}
              className="font-medium underline underline-offset-4"
            >
              Review &amp; publish →
            </Link>
          </AlertDescription>
        </Alert>
      )}
      {removalSaved && (
        <Alert className="mb-6">
          <AlertTitle>Removal of {removalSaved} saved</AlertTitle>
          <AlertDescription>
            The deletion is saved with your other changes — nothing is removed
            until you publish.{" "}
            <Link
              to={publishHref}
              className="font-medium underline underline-offset-4"
            >
              Review &amp; publish →
            </Link>
          </AlertDescription>
        </Alert>
      )}
      {(justUpdated || justRepaired || justUninstalled) && (
        <Alert className="mb-6">
          <AlertTitle>
            {justUpdated
              ? `${justUpdated} update saved`
              : justRepaired
                ? `${justRepaired} repair saved`
                : `${justUninstalled} uninstall saved`}
          </AlertTitle>
          <AlertDescription>
            Review and publish it from the Deployment tab.
          </AlertDescription>
        </Alert>
      )}

      {isTeam && roster.length === 0 && (
        <div className="mb-10">
          <EmptyTeamState overviewHref={`/repos/${project.id}`} />
        </div>
      )}

      <div className="space-y-10">
        {showMember && <ModelSection loaderData={loaderData} />}
        {showMember && (
          <SecretsCard
            activeAgent={activeAgent}
            isTeam={isTeam}
            envs={loaderData.envs.map((e) => ({ id: e.id, name: e.name }))}
            secrets={loaderData.secrets}
            initialEnvId={loaderData.scope.environmentId}
            secretsConfigured={loaderData.secretsConfigured}
            secretsError={loaderData.secretsError}
            required={loaderData.requiredSecrets.map((r) => ({
              ...r,
              sharedExists: loaderData.sharedSecrets.some(
                (s) => s.key === r.name,
              ),
            }))}
            dismissed={loaderData.dismissedSecrets.map((d) => ({
              name: d.name,
              sources: d.sources,
            }))}
            shared={loaderData.sharedSecrets}
            attachments={loaderData.attachments}
            requiredNames={loaderData.requiredSecretNames}
          />
        )}
        {showRepo && (
          <SharedSecretsSection
            projectId={project.id}
            isTeam={isTeam}
            shared={loaderData.repoShared}
          />
        )}
        {showRepo && loaderData.teamMembers.length > 1 && (
          <TeamLinksSection
            members={loaderData.teamMembers}
            links={loaderData.teamLinks}
          />
        )}
        <MarketplaceInstallsSection loaderData={loaderData} />
        {canRenameMember && (
          <RenameSection
            activeAgent={activeAgent}
            isTeam={isTeam}
            pendingName={pendingName}
          />
        )}
        {showRepo && <GeneralSection project={project} />}
        {showRepo && (
          <IngestSection loaderData={loaderData} newToken={newToken} />
        )}
        {(canRemoveMember || showRepo) && (
          <DangerSection
            project={project}
            activeAgent={activeAgent}
            canRemoveMember={canRemoveMember}
            showRepo={showRepo}
            isTeam={isTeam}
          />
        )}
      </div>
    </AppShell>
  );
}

/** Model — the one runtime setting; saving stages agent.ts like any other edit. */
function ModelSection({
  loaderData,
}: {
  loaderData: Route.ComponentProps["loaderData"];
}) {
  const {
    model,
    effort,
    modelInherited,
    hasAgentModule,
    modelStaged,
    activeAgent,
  } = loaderData;
  const fetcher = useFetcher<{
    ok?: boolean;
    error?: string;
    mode?: "staged" | "applied";
  }>();
  const modelBadges = useMemo(
    () => (
      <>
        {modelStaged && (
          <Badge variant="outline" className="text-xs">
            saved
          </Badge>
        )}
        {modelInherited && (
          <Badge variant="outline" className="text-xs">
            inherited default
          </Badge>
        )}
        {!hasAgentModule && (
          <Badge variant="outline" className="text-xs">
            no agent.ts — picking one scaffolds it
          </Badge>
        )}
      </>
    ),
    [modelStaged, modelInherited, hasAgentModule],
  );
  return (
    <section>
      <SectionHeader
        icon={Cpu}
        accent="blue"
        title="Model"
        badges={modelBadges}
      />
      <ModelSelection
        model={model}
        effort={effort}
        busy={fetcher.state !== "idle"}
        onCommit={(m, nextEffort) =>
          fetcher.submit(
            {
              intent: "set-model",
              model: m,
              effort: nextEffort ?? "",
              agent: activeAgent,
            },
            { method: "post" },
          )
        }
      />
      {fetcher.data?.error && (
        <p className="mt-2 text-sm text-destructive">{fetcher.data.error}</p>
      )}
      {fetcher.data?.ok && (
        <p className="mt-2 text-sm text-muted-foreground">
          {fetcher.data.mode === "applied"
            ? "Saved — the agent picks this up on its next step, no redeploy needed."
            : "Saved — publish it from the Deployment tab."}
        </p>
      )}
    </section>
  );
}

/**
 * Marketplace provenance from harnesst-lock.json. Updates and uninstalls save normal repo changes;
 * the header Publish control is the review/publish surface for those saved files.
 */
function MarketplaceInstallsSection({
  loaderData,
}: {
  loaderData: Route.ComponentProps["loaderData"];
}) {
  const { project, installs, level } = loaderData;
  const submit = useSubmit();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" && navigation.formData != null;
  const showOwner = level === "repo";
  const installsBadge = useMemo(
    () => <Badge variant="secondary">{installs.length}</Badge>,
    [installs.length],
  );

  return (
    <section>
      <SectionHeader
        icon={Boxes}
        accent="cyan"
        title="Marketplace installs"
        badges={installsBadge}
      />
      <Card>
        <CardContent className="py-4">
          {installs.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No marketplace installs recorded for this scope.
            </p>
          ) : (
            <ul className="divide-y rounded-lg border text-sm">
              {installs.map((install) => (
                <li
                  key={`${install.member ?? "root"}:${install.type}/${install.id}`}
                  className="flex flex-wrap items-center gap-3 px-3 py-2"
                >
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {install.name}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">
                    v{install.version}
                  </span>
                  <Badge variant="outline">{install.type}</Badge>
                  {showOwner &&
                    (install.member ? (
                      <Link
                        to={`${contextPath(project.id, install.member)}/settings`}
                        className="text-xs underline-offset-4 hover:underline"
                      >
                        {install.member}
                      </Link>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        shared
                      </span>
                    ))}
                  {install.update && (
                    <Form method="post">
                      <input
                        type="hidden"
                        name="intent"
                        value="update-install"
                      />
                      <input type="hidden" name="type" value={install.type} />
                      <input type="hidden" name="id" value={install.id} />
                      <input
                        type="hidden"
                        name="member"
                        value={install.member ?? ""}
                      />
                      <Button
                        type="submit"
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                      >
                        Update to {install.update}
                      </Button>
                    </Form>
                  )}
                  {install.repair && (
                    <Form method="post">
                      <input
                        type="hidden"
                        name="intent"
                        value="update-install"
                      />
                      <input type="hidden" name="mode" value="repair" />
                      <input type="hidden" name="type" value={install.type} />
                      <input type="hidden" name="id" value={install.id} />
                      <input
                        type="hidden"
                        name="member"
                        value={install.member ?? ""}
                      />
                      <Button
                        type="submit"
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                      >
                        Repair install
                      </Button>
                    </Form>
                  )}
                  <ConfirmDialog
                    trigger={
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        disabled={busy}
                      >
                        Uninstall
                      </Button>
                    }
                    title={`Uninstall ${install.name}?`}
                    description={
                      `Saves the deletion of ${install.files.length} file${install.files.length === 1 ? "" : "s"}:\n` +
                      install.files.join("\n") +
                      (install.depsLeft.length > 0
                        ? `\n\nnpm packages left for review: ${install.depsLeft.join(", ")}`
                        : "")
                    }
                    confirmLabel="Uninstall"
                    onConfirm={() =>
                      submit(
                        {
                          intent: "uninstall",
                          id: install.id,
                          member: install.member ?? "",
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
    </section>
  );
}

/** The GitHub connection this repository is built on (read-mostly). */
function GeneralSection({
  project,
}: {
  project: {
    name: string;
    repoOwner: string;
    repoName: string;
    defaultBranch: string;
  };
}) {
  return (
    <section>
      <SectionHeader icon={FolderGit2} accent="indigo" title="General" />
      <Card>
        <CardContent className="space-y-1 py-4 text-sm">
          <p>
            <span className="text-muted-foreground">Repository:</span>{" "}
            <a
              href={`https://github.com/${project.repoOwner}/${project.repoName}`}
              className="font-mono underline underline-offset-4"
              target="_blank"
              rel="noreferrer"
            >
              {project.repoOwner}/{project.repoName}
            </a>
          </p>
          <p>
            <span className="text-muted-foreground">Default branch:</span>{" "}
            <span className="font-mono">{project.defaultBranch}</span>
          </p>
        </CardContent>
      </Card>
    </section>
  );
}

/** Ingest tokens — BYO instances use these to ship run telemetry back to harnesst. */
function IngestSection({
  loaderData,
  newToken,
}: {
  loaderData: Route.ComponentProps["loaderData"];
  newToken: string | null;
}) {
  const { tokens } = loaderData;
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";
  return (
    <section>
      <SectionHeader icon={KeyRound} accent="amber" title="Run ingestion" />
      <p className="mb-3 text-sm text-muted-foreground">
        BYO instances send telemetry to{" "}
        <span className="font-mono">/api/ingest/runs</span> with one of these
        tokens.
      </p>
      {newToken && (
        <Alert className="mb-4">
          <AlertTitle>New token — copy now, shown once</AlertTitle>
          <AlertDescription>
            <code className="font-mono break-all">{newToken}</code>
          </AlertDescription>
        </Alert>
      )}
      {tokens.length > 0 && (
        <ul className="mb-4 space-y-1 text-sm text-muted-foreground">
          {tokens.map((t) => (
            <li key={t.id}>
              {t.name} · created <LocalizedDate value={t.createdAt} />
              {t.lastUsedAt ? (
                <>
                  {" · "}last used <LocalizedDate value={t.lastUsedAt} />
                </>
              ) : (
                " · never used"
              )}
            </li>
          ))}
        </ul>
      )}
      <Form method="post" className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="intent" value="create-token" />
        <Input
          name="name"
          placeholder="production instance"
          className="w-full sm:max-w-xs"
        />
        <Button type="submit" disabled={busy}>
          Create ingest token
        </Button>
      </Form>
    </section>
  );
}

/**
 * Rename this agent. Root single-agent repos rename instantly (the name is decoupled from the
 * directory); a team member's rename saves the `agents/<name>/` directory move with the other
 * changes, and the row is renamed in place when the publish lands — so environments, versions,
 * secrets and history are preserved either way.
 */
function RenameSection({
  activeAgent,
  isTeam,
  pendingName,
}: {
  activeAgent: string;
  isTeam: boolean;
  pendingName: string | null;
}) {
  const navigation = useNavigation();
  const busy =
    navigation.state !== "idle" &&
    navigation.formData?.get("intent") === "rename-member";
  return (
    <section>
      <SectionHeader icon={Pencil} accent="brand" title="Name" />
      {pendingName ? (
        <Card>
          <CardContent className="py-4 text-sm">
            <p className="font-medium">Rename to {pendingName} saved</p>
            <p className="text-muted-foreground">
              The directory move is saved with your other changes. The rename
              applies when you publish; discarding its saved changes cancels
              it.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="space-y-3 py-4">
            <Form method="post" className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="intent" value="rename-member" />
              <input type="hidden" name="agent" value={activeAgent} />
              <Input
                name="name"
                placeholder={activeAgent}
                defaultValue=""
                autoComplete="off"
                className="w-full sm:max-w-xs"
                aria-label="New agent name"
              />
              <Button type="submit" variant="outline" disabled={busy}>
                {busy ? "Renaming…" : "Rename"}
              </Button>
            </Form>
            <p className="text-sm text-muted-foreground">
              {isTeam
                ? `Saves a move of agents/${activeAgent}/ to the new name with your other changes — nothing is renamed until you publish. Environments, versions, secrets and history are preserved. Mentions of "${activeAgent}" in other agents' instructions or tools are not rewritten automatically.`
                : "Applies immediately across harnesst. The agent's repository directory is unaffected."}
            </p>
          </CardContent>
        </Card>
      )}
    </section>
  );
}

/** Destructive actions, deliberately last and deliberately loud. */
function DangerSection({
  project,
  activeAgent,
  canRemoveMember,
  showRepo,
  isTeam,
}: {
  project: { id: string; name: string };
  activeAgent: string;
  canRemoveMember: boolean;
  showRepo: boolean;
  isTeam: boolean;
}) {
  const submit = useSubmit();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const deletingRepository =
    busy && navigation.formData?.get("intent") === "delete-repository";

  return (
    <section>
      <SectionHeader icon={AlertTriangle} accent="rose" title="Danger zone" />
      <Card className="border-destructive/40">
        <CardContent className="divide-y py-0">
          {canRemoveMember && (
            <div className="flex flex-wrap items-center justify-between gap-3 py-4">
              <div>
                <p className="text-sm font-medium">
                  Remove {activeAgent} from the team
                </p>
                <p className="text-sm text-muted-foreground">
                  Saves the deletion of{" "}
                  <span className="font-mono">agents/{activeAgent}/</span> with
                  your other changes. Nothing is removed until you publish, and
                  git can restore it after.
                </p>
              </div>
              <ConfirmDialog
                trigger={
                  <Button variant="outline" disabled={busy}>
                    Remove agent
                  </Button>
                }
                title={`Remove ${activeAgent} from the team?`}
                description={`Saves the deletion of agents/${activeAgent}/. Nothing is removed until you publish, and git can restore it after.`}
                confirmLabel="Save removal"
                onConfirm={() =>
                  submit(
                    { intent: "remove-member", name: activeAgent },
                    { method: "post" },
                  )
                }
              />
            </div>
          )}
          {showRepo && (
            <div className="flex flex-wrap items-center justify-between gap-3 py-4">
              <div>
                <p className="text-sm font-medium">
                  Delete this repository from harnesst
                </p>
                <p className="text-sm text-muted-foreground">
                  Stops and destroys every running instance, then permanently
                  deletes {isTeam ? "all agents' " : "the agent's "}
                  versions, environments, secrets, drafts, and run history from
                  harnesst. The GitHub repository itself is not touched.
                </p>
              </div>
              <DeleteRepositoryDialog
                projectName={project.name}
                busy={busy}
                deleting={deletingRepository}
              />
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

/** Typed-name confirm for the full teardown — the one action that can't be undone. */
function DeleteRepositoryDialog({
  projectName,
  busy,
  deleting,
}: {
  projectName: string;
  busy: boolean;
  deleting: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const submit = useSubmit();
  const confirm = () => {
    if (typed !== projectName) return;
    submit({ intent: "delete-repository", confirm: typed }, { method: "post" });
    setOpen(false);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setTyped("");
      }}
    >
      <DialogTrigger asChild>
        <Button variant="destructive" disabled={busy}>
          {deleting ? "Deleting…" : "Delete repository"}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Delete &ldquo;{projectName}&rdquo; from harnesst?
          </DialogTitle>
          <DialogDescription>
            This stops everything that&rsquo;s running and permanently deletes
            all harnesst data for this repository — versions, environments,
            secrets, drafts, run history. It cannot be undone. The GitHub
            repository itself is not touched.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="delete-repo-confirm">
            Type <span className="font-mono font-semibold">{projectName}</span>{" "}
            to confirm
          </Label>
          <Input
            id="delete-repo-confirm"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={projectName}
            autoComplete="off"
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={typed !== projectName}
            onClick={confirm}
          >
            Delete repository
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
