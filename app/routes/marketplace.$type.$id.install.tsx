/**
 * Recruit — the install wizard (PRD §7.8, Milestone 6 phase 2). "Install = a change-set": this
 * page turns a catalog template into staged drafts on the target's working set, then hands off
 * to the publish pipeline behind the header Publish control (it does NOT touch git itself).
 *
 * SSR, searchParams-driven — the URL IS the wizard state (`?project&member&newMember`), so every
 * choice is a plain GET navigation with no client state machine and the loader re-derives the
 * whole plan on each step. The plan PREVIEW the loader returns is advisory; the action re-plans
 * from scratch server-side (never trusting the preview) before it stages anything.
 *
 * Target shapes (PRD §7.8): tool/skill/subagent install INTO an existing member; an agent
 * installs AS a new team member (team repos only). Deliberately punted here: agent → a new
 * standalone repo, and agent → subagent of an existing agent.
 */
import { getSessionAuth, sessionLoader } from "~/auth/session.server";
import { Boxes, Download, KeyRound, Layers, ShieldCheck } from "lucide-react";
import { useState } from "react";
import {
  Form,
  Link,
  data,
  redirect,
  useNavigate,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { COPY } from "~/components/secrets-card";

import { TYPE_META, TypeBadge } from "~/components/marketplace-type-badge";
import { AppShell, PageHeader, accentText } from "~/components/shell";
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
import { Input } from "~/components/ui/input";
import { SecretInput } from "~/components/ui/secret-input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  ensureWorkspace,
  requireBackOfHouse,
  resolveActiveWorkspace,
} from "~/auth/workspace.server";
import { selectedCapabilityGroupIds } from "~/capabilities/enablement";
import { getCapability } from "~/capabilities/registry.server";
import type { Agent } from "~/data/ports";
import { invalidateAgentEnvironments } from "~/deploy/env-reconcile.server";
import { stageDeletions, stageDraft, listDrafts } from "~/drafts/drafts.server";
import { ZOD_PACKAGE, ZOD_VERSION } from "~/eve/agentModule";
import { getAgentSource } from "~/github/cached.server";
import { fetchAgentSource, readAgentFile } from "~/github/repo.server";
import { contextPath } from "~/lib/paths";
import {
  catalogProviderEvidence,
  catalogLocator,
  describeDependencies,
  packageJsonPathForRoot,
  planInstall,
  templateProviderForTarget,
  type DependencyDecision,
  type InstallTarget,
} from "~/marketplace/install.server";
import {
  findInstall,
  overlayLock,
  providerExplanation,
  selectedGroupIds,
  type HarnesstLock,
} from "~/marketplace/lock";
import {
  resolveTemplate,
  type ResolvedInclude,
} from "~/marketplace/compose.server";
import {
  findAppCredentialConflict,
  listAppCredentialRows,
} from "~/github/app-manifest.server";
import {
  planInstallSecretOps,
  writePendingSecret,
  type InstallSecretOp,
} from "~/project/secrets.server";
import { listSharedSecrets, setAttachment } from "~/seams/oss/secret-store";
import { decodeKey, fingerprint, seal } from "~/seams/oss/secretbox";
import {
  TEMPLATE_TYPES,
  isTemplateSlug,
  type AuthScopeGroup,
  type TemplateManifest,
  type TemplateType,
} from "~/marketplace/manifest";
import { listProjects } from "~/db/queries.server";
import { resolveSyncedAgentContext } from "~/project/agent-context.server";
import { requireProject, requireRepo } from "~/project/guard.server";
import { getRuntime } from "~/seams/index.server";
import { getWorkspaceAssistantSelection } from "~/org/workspace.server";
import { ownsWorkspaceModelReference } from "~/models/union.server";
import type { Route } from "./+types/marketplace.$type.$id.install";

/** Narrow a URL param to a TemplateType, 404-ing on anything else. */
function parseType(param: string | undefined): TemplateType {
  if (TEMPLATE_TYPES.includes(param as TemplateType))
    return param as TemplateType;
  throw data("Unknown template type", { status: 404 });
}

/** An agent template lands as a NEW member; everything else installs into an existing one. */
function isAgentTemplate(type: TemplateType): boolean {
  return type === "agent";
}

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

/**
 * Resolve a selected roster name to an install target. The single-agent repo's root agent is
 * recorded in the lock as `member: null` (its name is cosmetic); team members carry their name.
 */
function resolveMemberTarget(
  roster: Agent[],
  isTeam: boolean,
  selectedName: string | null,
): { target: Extract<InstallTarget, { kind: "member" }>; agent: Agent } | null {
  if (!selectedName) return null;
  const agent = roster.find((a) => a.name === selectedName);
  if (!agent) return null;
  return {
    agent,
    target: {
      kind: "member",
      memberName: isTeam ? agent.name : null,
      root: agent.root,
    },
  };
}

interface PreviewData {
  files: string[];
  deletions: string[];
  conflicts: string[];
  canKeepExistingFiles: boolean;
  /** Occupied custom paths a register-and-keep would preserve byte-for-byte (issue #177). */
  preservedFiles: string[];
  warnings: string[];
  deps: DependencyDecision[];
  secrets: Array<{
    name: string;
    description?: string;
    sandbox?: boolean;
    provisioned?: boolean;
    generated?: boolean;
  }>;
  isUpdate: boolean;
  /** Templates bundled by reference (composition) — rendered as a "Bundled from the catalog" card. */
  includes: ResolvedInclude[];
  /**
   * Selectable permission levels per provider (issue #165) — rendered as the Permissions card
   * (checkbox list, defaults pre-ticked); the selection lands in the lock's auth snapshot.
   */
  authGroups: Array<{ provider: string; scopeGroups: AuthScopeGroup[] }>;
  /**
   * Selectable capability operation groups per provider (issue #166) — the Operations card.
   * Labels/descriptions/risk joined from harnesst's capability registry; the selection lands in the
   * lock's `selectedCapabilityGroups` and is enforced per call (changeable later, instantly).
   */
  capabilityGroups: Array<{
    provider: string;
    groups: Array<{
      id: string;
      label: string;
      description: string;
      risk: "read" | "write";
      default: boolean;
    }>;
  }>;
}

/**
 * The providers with selectable permission levels on a resolved template (issue #165). On an
 * UPDATE, the existing install's stored selection wins over the template defaults as the
 * pre-ticked state (`default` doubles as "pre-ticked" for the wizard's checkboxes) — updating a
 * template must never silently re-scope a connection the installer already narrowed or widened.
 */
function templateAuthGroups(
  template: {
    manifest: TemplateManifest;
    auths: Array<{ provider: string; scopeGroups?: AuthScopeGroup[] }>;
  },
  lock: HarnesstLock,
  member: string | null,
): PreviewData["authGroups"] {
  const existing = findInstall(lock, template.manifest.id, member);
  return template.auths.flatMap((a) => {
    if (!a.scopeGroups || a.scopeGroups.length === 0) return [];
    const stored = existing?.auth?.find(
      (e) => e.provider === a.provider && e.scopeGroups,
    );
    if (!stored) return [{ provider: a.provider, scopeGroups: a.scopeGroups }];
    const selected = new Set(selectedGroupIds(stored));
    return [
      {
        provider: a.provider,
        scopeGroups: a.scopeGroups.map((g) => ({
          ...g,
          default: selected.has(g.id),
        })),
      },
    ];
  });
}

/**
 * The providers with selectable capability operation groups on a resolved template (issue #166),
 * with labels/risk joined from the registry. On an UPDATE the stored selection wins as the
 * pre-ticked state, mirroring `templateAuthGroups`. Groups the registry doesn't know are dropped
 * (nothing selectable to render); an unknown provider renders nothing.
 */
function templateCapabilityGroups(
  template: {
    manifest: TemplateManifest;
    auths: Array<{ provider: string; capabilityGroups?: string[] }>;
  },
  lock: HarnesstLock,
  member: string | null,
): PreviewData["capabilityGroups"] {
  const existing = findInstall(lock, template.manifest.id, member);
  return template.auths.flatMap((a) => {
    const offered = a.capabilityGroups ?? [];
    if (offered.length === 0) return [];
    const definition = getCapability(a.provider);
    if (!definition) return [];
    const stored = existing?.auth?.find(
      (e) => e.provider === a.provider && e.capabilityGroups,
    );
    const selected = stored
      ? new Set(selectedCapabilityGroupIds(stored))
      : null;
    const groups = offered.flatMap((id) => {
      const group = definition.operationGroups.find((g) => g.id === id);
      if (!group) return [];
      return [
        {
          id,
          label: group.label,
          description: group.description,
          risk: group.risk,
          default: selected ? selected.has(id) : (group.default ?? false),
        },
      ];
    });
    return groups.length > 0 ? [{ provider: a.provider, groups }] : [];
  });
}

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }) => {
      const type = parseType(args.params.type);
      const id = args.params.id!;
      if (!isTemplateSlug(id)) throw data("Unknown template", { status: 404 });
      await ensureWorkspace(args.request, auth);
      const active = await resolveActiveWorkspace(auth);
      // Back of house is admin/owner-only (D10); front-of-house members live at `/`.
      if (active) requireBackOfHouse(active, "page");
      const org = active?.org;

      // Resolve composition (includes) up front: the plan, the file preview, the dep/secret
      // merge — everything downstream operates on the flattened template, exactly as it installs.
      let template;
      try {
        template = await resolveTemplate(getRuntime().catalog, type, id);
      } catch (error) {
        console.warn(`[install] template ${type}/${id} failed to load:`, error);
        throw data(`Template ${type}/${id} isn't in the catalog.`, {
          status: 404,
        });
      }

      const url = new URL(args.request.url);
      const projectId = url.searchParams.get("project");
      const selectedMember = url.searchParams.get("member");
      const newMemberName = url.searchParams.get("newMember");

      // Only connected repos can host an install.
      const all = org ? await listProjects(org.id) : [];
      const projects = all
        .filter((p) => p.repoInstallationId && p.repoOwner && p.repoName)
        .map((p) => ({ id: p.id, name: p.name }));

      const base = {
        org,
        type,
        manifest: template.manifest as TemplateManifest,
        projects,
        selectedProjectId: projectId,
        projectName: null as string | null,
        roster: [] as { name: string }[],
        isTeam: false,
        newMemberTemplate: isAgentTemplate(type),
        singleAgentInvalid: false,
        missingModelDefault: false,
        selectedMember,
        newMemberName,
        preview: null as PreviewData | null,
        provider: null as {
          id: string;
          type: TemplateType;
          name: string;
          version: string;
          explanation: string;
        } | null,
        /** Project-level shared secret names — powers the three-way choice (§9). */
        sharedNames: [] as string[],
      };

      if (!projectId) return base;

      // Tenancy: never trust the id — requireProject scopes it to the org.
      const project = requireRepo(await requireProject(auth, projectId));
      const repo = { owner: project.repoOwner, repo: project.repoName };
      const [source, drafts, workspaceModel] = await Promise.all([
        getAgentSource(project.repoInstallationId, repo),
        listDrafts(project.id),
        isAgentTemplate(type)
          ? activeWorkspaceDefaultModel(project.orgId)
          : Promise.resolve({ model: null, effort: null }),
      ]);
      const ctx = await resolveSyncedAgentContext(
        project.id,
        null,
        source.paths,
      );
      base.projectName = project.name;
      base.isTeam = ctx.isTeam;
      base.missingModelDefault =
        isAgentTemplate(type) && workspaceModel.model === null;
      base.roster = ctx.roster.map((a) => ({ name: a.name }));
      if ((template.manifest.secrets?.length ?? 0) > 0) {
        try {
          base.sharedNames = [
            ...new Set((await listSharedSecrets(project.id)).map((s) => s.key)),
          ];
        } catch {
          base.sharedNames = []; // secrets store unavailable — the step degrades to value/skip
        }
      }

      const registry = catalogLocator();
      const draftPaths = drafts.map((d) => ({
        path: d.path,
        content: d.content,
      }));
      const lock = overlayLock(
        source.files["harnesst-lock.json"] ?? null,
        draftPaths,
      );

      if (isAgentTemplate(type)) {
        // Agent → new team member. Single-agent repos can't gain a peer member here.
        if (!ctx.isTeam) {
          base.singleAgentInvalid = true;
          return base;
        }
        if (!workspaceModel.model) return base;
        if (!newMemberName) return base;
        const plan = planInstall({
          template,
          registry,
          repoPaths: source.paths,
          drafts: draftPaths,
          packageJson: null,
          lock,
          rosterNames: ctx.roster.map((a) => a.name),
          model: workspaceModel.model,
          effort: workspaceModel.effort,
          target: { kind: "new-member", name: newMemberName },
        });
        base.preview = {
          files: plan.writes
            .filter((w) => w.path !== "harnesst-lock.json")
            .map((w) => w.path),
          deletions: plan.deletions,
          conflicts: plan.conflicts,
          canKeepExistingFiles: plan.canKeepExistingFiles,
          preservedFiles: plan.preservedFiles,
          warnings: plan.warnings,
          deps: describeDependencies(
            { eve: "latest", [ZOD_PACKAGE]: ZOD_VERSION },
            template.manifest.dependencies,
          ),
          secrets: plan.secrets,
          isUpdate: plan.isUpdate,
          includes: template.includes,
          // A new member has no existing install — the template defaults pre-tick.
          authGroups: templateAuthGroups(template, lock, newMemberName),
          capabilityGroups: templateCapabilityGroups(
            template,
            lock,
            newMemberName,
          ),
        };
        return base;
      }

      // Tool/skill/subagent → into an existing member.
      const resolved = resolveMemberTarget(
        ctx.roster,
        ctx.isTeam,
        selectedMember,
      );
      if (!resolved) return base;

      const catalogProviders = await catalogProviderEvidence(
        getRuntime().catalog,
        lock,
      );
      const provider = templateProviderForTarget(
        lock,
        template,
        resolved.target,
        catalogProviders,
      );
      if (provider && provider.via !== "direct") {
        base.provider = {
          id: provider.install.id,
          type: provider.install.type,
          name: provider.install.name,
          version: provider.install.version,
          explanation: providerExplanation(provider.install),
        };
        return base;
      }

      // The target's current package.json (a staged draft wins) — needed only for the dep
      // merge, so skip the read entirely when the template ships no dependencies.
      const hasDeps =
        !!template.manifest.dependencies &&
        Object.keys(template.manifest.dependencies).length > 0;
      const pkgPath = packageJsonPathForRoot(resolved.target.root);
      const pkgDraft = drafts.find((d) => d.path === pkgPath);
      const packageJson = !hasDeps
        ? null
        : pkgDraft !== undefined
          ? pkgDraft.content
          : await readAgentFile(project.repoInstallationId, repo, pkgPath);

      const planArgs = {
        template,
        registry,
        repoPaths: source.paths,
        drafts: draftPaths,
        packageJson,
        lock,
        target: resolved.target,
      };
      let plan = planInstall(planArgs);
      // The user resolves occupied template paths by clicking "Register and keep existing files",
      // which re-plans server-side WITH keepExistingFiles. Preview THAT plan (issue #177) so the
      // approved change-set matches: preserved paths are spliced out of the "+" files list and the
      // "kept unchanged / left unmanaged" note surfaces, instead of listing them as writes.
      if (plan.canKeepExistingFiles) {
        plan = planInstall({ ...planArgs, keepExistingFiles: true });
      }
      let currentDeps: Record<string, string> | null = null;
      try {
        currentDeps = packageJson
          ? ((JSON.parse(packageJson).dependencies as Record<string, string>) ??
            {})
          : null;
      } catch {
        currentDeps = null;
      }
      base.preview = {
        files: plan.writes
          .filter((w) => w.path !== "harnesst-lock.json")
          .map((w) => w.path),
        deletions: plan.deletions,
        conflicts: plan.conflicts,
        canKeepExistingFiles: plan.canKeepExistingFiles,
        preservedFiles: plan.preservedFiles,
        warnings: plan.warnings,
        deps: describeDependencies(currentDeps, template.manifest.dependencies),
        secrets: plan.secrets,
        isUpdate: plan.isUpdate,
        includes: template.includes,
        authGroups: templateAuthGroups(
          template,
          lock,
          resolved.target.memberName,
        ),
        capabilityGroups: templateCapabilityGroups(
          template,
          lock,
          resolved.target.memberName,
        ),
      };
      return base;
    },
    { ensureSignedIn: true },
  );

export async function action(args: ActionFunctionArgs) {
  const auth = await getSessionAuth(args);
  if (!auth.user) throw redirect("/login");
  const type = parseType(args.params.type);
  const id = args.params.id!;
  if (!isTemplateSlug(id)) throw data("Unknown template", { status: 404 });

  const form = await args.request.formData();
  if (String(form.get("intent")) !== "install") {
    return { error: "Unknown action." };
  }
  const projectId = String(form.get("project") ?? "");

  try {
    const project = requireRepo(await requireProject(auth, projectId));
    const repo = { owner: project.repoOwner, repo: project.repoName };
    // ACTIONS read raw — a stale read composed into a write could clobber newer content. The
    // resolver re-flattens composition server-side by construction (never trusting the preview).
    const [template, source, drafts, workspaceModel] = await Promise.all([
      resolveTemplate(getRuntime().catalog, type, id),
      fetchAgentSource(project.repoInstallationId, repo),
      listDrafts(project.id),
      isAgentTemplate(type)
        ? activeWorkspaceDefaultModel(project.orgId)
        : Promise.resolve({ model: null, effort: null }),
    ]);
    const ctx = await resolveSyncedAgentContext(project.id, null, source.paths);
    const registry = catalogLocator();
    const draftPaths = drafts.map((d) => ({
      path: d.path,
      content: d.content,
    }));
    const lock = overlayLock(
      source.files["harnesst-lock.json"] ?? null,
      draftPaths,
    );

    let target: InstallTarget;
    let secretAgent: Agent | null = null;

    if (isAgentTemplate(type)) {
      if (!ctx.isTeam) {
        return {
          error:
            "Agent templates install as a new agent — this is a single-agent repo.",
        };
      }
      const name = String(form.get("newMember") ?? "").trim();
      if (!name) return { error: "Name the new agent." };
      if (!workspaceModel.model) {
        return {
          error:
            "Choose a connected workspace default model in Org settings before installing an agent template.",
        };
      }
      target = { kind: "new-member", name };
    } else {
      const selectedName = String(form.get("member") ?? "");
      const resolved = resolveMemberTarget(
        ctx.roster,
        ctx.isTeam,
        selectedName,
      );
      if (!resolved) return { error: "Pick an agent to install into." };
      target = resolved.target;
      secretAgent = resolved.agent;
    }

    const catalogProviders =
      target.kind === "member"
        ? await catalogProviderEvidence(getRuntime().catalog, lock)
        : [];

    // The target's package.json: a STAGED DRAFT wins over the branch copy — merging over the
    // branch would silently drop dependencies a previously staged install already added.
    let packageJson: string | null = null;
    if (secretAgent && target.kind === "member") {
      const pkgPath = packageJsonPathForRoot(target.root);
      const pkgDraft = drafts.find((d) => d.path === pkgPath);
      packageJson =
        pkgDraft !== undefined
          ? pkgDraft.content
          : await readAgentFile(project.repoInstallationId, repo, pkgPath);
    }

    // Scope-group selection (issue #165): the Permissions card posts one `scopegroupsfor` marker
    // per provider it rendered plus a `scopegroup:<provider>` value per ticked box, so "none
    // ticked" is distinguishable from "no card rendered" (→ template defaults). Ids are validated
    // against the template's own groups inside the planner — the form is browser-controlled.
    const authSelections: Record<string, string[]> = {};
    for (const provider of form.getAll("scopegroupsfor").map(String)) {
      authSelections[provider] = form
        .getAll(`scopegroup:${provider}`)
        .map(String);
    }
    // Providers the form posted nothing for keep an existing install's stored selection (an
    // update must never silently re-scope to the template defaults); first installs fall back
    // to the defaults inside the planner.
    const existingInstall = findInstall(
      lock,
      template.manifest.id,
      target.kind === "new-member" ? target.name : target.memberName,
    );
    for (const a of template.auths) {
      if (!a.scopeGroups?.length || a.provider in authSelections) continue;
      const stored = existingInstall?.auth?.find(
        (e) => e.provider === a.provider && e.scopeGroups,
      );
      if (stored) authSelections[a.provider] = selectedGroupIds(stored);
    }

    // Capability-group selection (issue #166): same marker convention as scope groups —
    // one `capgroupsfor` per rendered provider plus a `capgroup:<provider>` per ticked box.
    // Unposted providers keep an existing install's stored selection; first installs fall
    // back to the registry defaults inside the planner.
    const capabilitySelections: Record<string, string[]> = {};
    for (const provider of form.getAll("capgroupsfor").map(String)) {
      capabilitySelections[provider] = form
        .getAll(`capgroup:${provider}`)
        .map(String);
    }
    for (const a of template.auths) {
      if (!a.capabilityGroups?.length || a.provider in capabilitySelections) {
        continue;
      }
      const stored = existingInstall?.auth?.find(
        (e) => e.provider === a.provider && e.capabilityGroups,
      );
      if (stored) {
        capabilitySelections[a.provider] = selectedCapabilityGroupIds(stored);
      }
    }

    // Re-plan server-side; NEVER trust the preview. Non-file conflicts stage nothing; an explicit
    // keep-existing submission may preserve occupied template paths and register around them.
    const plan = planInstall({
      template,
      registry,
      repoPaths: source.paths,
      drafts: draftPaths,
      packageJson,
      lock,
      catalogProviders,
      rosterNames: ctx.roster.map((a) => a.name),
      model: workspaceModel.model,
      effort: workspaceModel.effort,
      target,
      authSelections,
      capabilitySelections,
      keepExistingFiles:
        String(form.get("conflictResolution") ?? "") === "keep-existing",
    });
    if (plan.conflicts.length > 0) {
      return {
        error: `Can't install — ${plan.conflicts.length} file(s) already exist and aren't from this template:\n${plan.conflicts.join("\n")}`,
      };
    }

    // Connecting the OAuth account is a DEPLOYMENT concern, not an install one (issue #30): staging
    // never gates on a grant. A freshly installed connector has no grant yet — the user connects it
    // from the Deployment tab's Connections card, which the lock snapshot drives.

    // Secrets are PLANNED before anything is staged so a refused install stages nothing.
    let secretOps: InstallSecretOp[] = [];
    if ((template.manifest.secrets?.length ?? 0) > 0) {
      let sharedNames: string[] = [];
      try {
        sharedNames = (await listSharedSecrets(project.id)).map((s) => s.key);
      } catch {
        sharedNames = [];
      }
      secretOps = planInstallSecretOps({
        secrets: template.manifest.secrets ?? [],
        form,
        sharedNames,
      });

      // Issue #26: a GitHub App is an agent's @mention identity — two agents in one project
      // sharing a slug/App ID is ambiguous (one webhook URL per App). The manifest flow can't
      // produce this, but the manual fallback lets the same credentials be pasted twice.
      const setValue = (name: string) => {
        const op = secretOps.find((o) => o.kind === "set" && o.name === name);
        return op?.kind === "set" ? op.value : undefined;
      };
      const slug = setValue("GITHUB_APP_SLUG");
      const appId = setValue("GITHUB_APP_ID");
      if (slug || appId) {
        const conflict = findAppCredentialConflict(
          await listAppCredentialRows(project.id),
          secretAgent?.id ?? null,
          { slug, appId },
        );
        if (conflict) {
          return {
            error:
              `Another agent in this project ("${conflict.agentName}") already uses this GitHub App ` +
              `(${conflict.key} matches). Every agent needs its own GitHub App — create one for this ` +
              "agent with the guided flow on its Deployment tab, or paste different credentials.",
          };
        }
      }
    }

    for (const write of plan.writes) {
      await stageDraft({
        projectId: project.id,
        path: write.path,
        content: write.content,
        createdBy: auth.user.id,
      });
    }
    if (plan.deletions.length > 0) {
      await stageDeletions({
        projectId: project.id,
        paths: plan.deletions,
        createdBy: auth.user.id,
      });
    }

    // Secrets step (§9): one enabled step for every template kind. The pure planner decided
    // each secret's fate from the form above (shared-attach / value / skip); values never
    // persist anywhere but the sealed stores.
    if (secretOps.length > 0) {
      const ops = secretOps;
      if (secretAgent) {
        // Member install: the agent row exists — write agent-wide values (sandbox set
        // atomically) and attachment rows directly.
        const secrets = getRuntime().secrets;
        for (const op of ops) {
          if (op.kind === "set") {
            await secrets.set(
              {
                projectId: project.id,
                agentId: secretAgent.id,
                environmentId: null,
                key: op.name,
              },
              op.value,
              { sandboxExposed: op.sandbox, updatedBy: auth.user.id },
            );
          } else if (op.kind === "attach") {
            await setAttachment({
              projectId: project.id,
              agentId: secretAgent.id,
              key: op.name,
              attached: true,
              sandboxExposed: op.sandbox,
              createdBy: auth.user.id,
            });
          }
        }
        if (ops.some((op) => op.kind === "set" || op.kind === "attach")) {
          await invalidateAgentEnvironments({
            agentIds: [secretAgent.id],
            createdBy: auth.user.id,
          });
        }
      } else if (target.kind === "new-member") {
        // New-member install (§4.4): no agent row until the member ships — hold values
        // SEALED in pending_secrets and record shared-attach choices; the ship-time roster
        // sync migrates them, and abandonment cleanup discards them.
        const hasWork = ops.some((op) => op.kind !== "skip");
        if (hasWork) {
          const key = decodeKey(process.env.HARNESST_SECRETS_KEY);
          for (const op of ops) {
            if (op.kind === "set") {
              await writePendingSecret({
                projectId: project.id,
                memberName: target.name,
                key: op.name,
                sealed: seal(key, op.value),
                fingerprint: fingerprint(op.value),
                sandboxExposed: op.sandbox,
                attachShared: false,
                createdBy: auth.user.id,
              });
            } else if (op.kind === "attach") {
              await writePendingSecret({
                projectId: project.id,
                memberName: target.name,
                key: op.name,
                sealed: { ciphertext: "", iv: "", authTag: "" },
                fingerprint: null,
                sandboxExposed: op.sandbox,
                attachShared: true,
                createdBy: auth.user.id,
              });
            }
          }
        }
      }
    }

    const memberName =
      target.kind === "new-member" ? null : (target.memberName ?? undefined);
    throw redirect(
      `${contextPath(project.id, memberName ?? undefined)}/deployment?installed=${encodeURIComponent(id)}`,
    );
  } catch (error) {
    if (error instanceof Response) throw error;
    return { error: (error as Error).message };
  }
}

export function meta() {
  return [{ title: "Install · Marketplace · harnesst" }];
}

export default function InstallWizard({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const {
    user,
    type,
    manifest,
    projects,
    selectedProjectId,
    projectName,
    roster,
    isTeam,
    newMemberTemplate,
    singleAgentInvalid,
    missingModelDefault,
    selectedMember,
    newMemberName,
    preview,
    provider,
    sharedNames,
  } = loaderData;
  const navigate = useNavigate();

  const backTo = `/marketplace/${type}/${manifest.id}`;
  const hasConflicts = (preview?.conflicts.length ?? 0) > 0;
  // Issue #47: provisioned secrets are set by a guided harnesst flow (e.g. Create GitHub App on the
  // Deployment tab) — the wizard never collects them. Only the user-supplied ones get inputs; the
  // provisioned ones get a single muted note so the user isn't led to think they must provide them.
  // Issue #163: generated secrets are minted by harnesst at first deploy — never collected either.
  const userSecrets = (preview?.secrets ?? []).filter(
    (s) => !s.provisioned && !s.generated,
  );
  const provisionedSecrets = (preview?.secrets ?? []).filter(
    (s) => s.provisioned,
  );
  const targetChosen = newMemberTemplate ? !!newMemberName : !!selectedMember;
  const canSubmit =
    !!selectedProjectId &&
    targetChosen &&
    !hasConflicts &&
    !singleAgentInvalid &&
    !missingModelDefault;
  const canRegisterExisting =
    !!selectedProjectId &&
    targetChosen &&
    !!preview?.canKeepExistingFiles &&
    !singleAgentInvalid &&
    !missingModelDefault;

  /** Navigate to this route with an updated query, preserving the rest. */
  const go = (patch: Record<string, string | null>) => {
    const params = new URLSearchParams();
    if (selectedProjectId) params.set("project", selectedProjectId);
    if (selectedMember) params.set("member", selectedMember);
    if (newMemberName) params.set("newMember", newMemberName);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) params.delete(k);
      else params.set(k, v);
    }
    navigate(`?${params.toString()}`);
  };

  return (
    <AppShell userEmail={user.email}>
      <div className="mb-4">
        <Link
          to={backTo}
          prefetch="intent"
          className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          ← {manifest.name}
        </Link>
      </div>

      <PageHeader
        icon={TYPE_META[manifest.type].icon}
        accent={TYPE_META[manifest.type].accent}
        title={
          <span className="flex items-center gap-3">
            Install {manifest.name}
            <TypeBadge type={manifest.type} />
          </span>
        }
        description={manifest.description}
      />

      {actionData?.error && (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>Couldn&rsquo;t save the install</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap">
            {actionData.error}
          </AlertDescription>
        </Alert>
      )}

      <div className="space-y-6">
        {/* 1 — Target */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Boxes className={`size-4 ${accentText.cyan}`} aria-hidden />
              Target
            </CardTitle>
            <CardDescription>
              Where this {type} lands. Selecting keeps the choice in the URL.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-1.5">
              <Label>Repository</Label>
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
                  onValueChange={(id) =>
                    navigate(`?project=${encodeURIComponent(id)}`)
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
            </div>

            {selectedProjectId && !newMemberTemplate && (
              <div className="grid gap-1.5">
                <Label>Agent</Label>
                <Select
                  value={selectedMember ?? undefined}
                  onValueChange={(name) => go({ member: name })}
                >
                  <SelectTrigger className="w-full max-w-sm">
                    <SelectValue placeholder="Pick an agent to install into" />
                  </SelectTrigger>
                  <SelectContent>
                    {roster.map((m) => (
                      <SelectItem key={m.name} value={m.name}>
                        {m.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {provider && (
              <Alert>
                <AlertTitle>Already installed through a bundle</AlertTitle>
                <AlertDescription>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span>{provider.explanation}</span>
                    <Button type="button" size="sm" disabled>
                      Install
                    </Button>
                  </div>
                </AlertDescription>
              </Alert>
            )}

            {selectedProjectId && newMemberTemplate && singleAgentInvalid && (
              <Alert>
                <AlertTitle>Not a valid target</AlertTitle>
                <AlertDescription>
                  <span className="font-medium">{projectName}</span> is a
                  single-agent repository. Agent templates install as a new
                  agent in a <span className="font-medium">team</span> repo. Add
                  this to a team, or (punted) install it as its own new repo.
                </AlertDescription>
              </Alert>
            )}

            {selectedProjectId &&
              newMemberTemplate &&
              !singleAgentInvalid &&
              missingModelDefault && (
                <Alert>
                  <AlertTitle>Choose a workspace model first</AlertTitle>
                  <AlertDescription>
                    Agent templates need a connected, provider-qualified model.
                    Select a default in{" "}
                    <Link to="/org/settings" className="underline">
                      Org settings
                    </Link>{" "}
                    before installing this agent.
                  </AlertDescription>
                </Alert>
              )}

            {selectedProjectId && newMemberTemplate && !singleAgentInvalid && (
              <Form method="get" className="grid max-w-sm gap-1.5">
                <input type="hidden" name="project" value={selectedProjectId} />
                <Label htmlFor="newMember">New agent name</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="newMember"
                    name="newMember"
                    defaultValue={newMemberName ?? ""}
                    placeholder="deployer"
                    className="font-mono"
                  />
                  <Button type="submit" variant="secondary">
                    Set
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Lowercase, digits, single hyphens — becomes{" "}
                  <span className="font-mono">agents/&lt;name&gt;/</span>.
                </p>
              </Form>
            )}
          </CardContent>
        </Card>

        {/* 2 — Composition (only when the template bundles others by reference) */}
        {preview && preview.includes.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Layers className={`size-4 ${accentText.indigo}`} aria-hidden />
                Bundled from the catalog
              </CardTitle>
              <CardDescription>
                These templates are materialized into the target agent as part
                of this install — you don&rsquo;t install them separately.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2 text-sm">
                {preview.includes.map((inc) => (
                  <li
                    key={`${inc.type}/${inc.id}`}
                    className="flex items-center gap-2"
                  >
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {inc.name}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">
                      v{inc.version}
                    </span>
                    <TypeBadge type={inc.type} />
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        {/* 3 — What this installs */}
        {preview && (
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Download
                    className={`size-4 ${accentText.emerald}`}
                    aria-hidden
                  />
                  What this installs
                </CardTitle>
                {preview.isUpdate && <Badge variant="warning">update</Badge>}
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              {preview.conflicts.length > 0 && (
                <Alert variant="destructive">
                  <AlertTitle>Blocked by conflicts</AlertTitle>
                  <AlertDescription>
                    <p className="mb-2">
                      These target files already exist and can’t be preserved
                      automatically. Resolve them before installing:
                    </p>
                    <ul className="space-y-1 font-mono text-xs">
                      {preview.conflicts.map((c) => (
                        <li key={c}>{c}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}

              {preview.preservedFiles.length > 0 && (
                <Alert>
                  <AlertTitle>Existing code detected</AlertTitle>
                  <AlertDescription>
                    <p className="mb-2">
                      These template paths already contain code. Registering
                      keeps them byte-for-byte and leaves them unmanaged (a
                      later uninstall won’t delete them):
                    </p>
                    <ul className="space-y-1 font-mono text-xs">
                      {preview.preservedFiles.map((c) => (
                        <li key={c}>{c}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}

              <div>
                <h3 className="mb-2 text-sm font-medium">Files</h3>
                <ul className="divide-y rounded-lg border text-sm">
                  {preview.files.map((f) => (
                    <li
                      key={f}
                      className="flex items-center gap-2 px-3 py-1.5 font-mono text-xs"
                    >
                      <span
                        className="text-emerald-600 dark:text-emerald-400"
                        aria-hidden
                      >
                        +
                      </span>
                      {f}
                    </li>
                  ))}
                </ul>
              </div>

              {preview.deletions.length > 0 && (
                <div>
                  <h3 className="mb-2 text-sm font-medium">
                    Removed by this update
                  </h3>
                  <ul className="divide-y rounded-lg border text-sm">
                    {preview.deletions.map((f) => (
                      <li
                        key={f}
                        className="flex items-center gap-2 px-3 py-1.5 font-mono text-xs"
                      >
                        <span
                          className="text-rose-600 dark:text-rose-400"
                          aria-hidden
                        >
                          −
                        </span>
                        <span className="line-through decoration-destructive/60">
                          {f}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {preview.deps.length > 0 && (
                <div>
                  <h3 className="mb-2 text-sm font-medium">npm dependencies</h3>
                  <ul className="space-y-1 text-sm">
                    {preview.deps.map((d) => (
                      <li key={d.name} className="flex items-center gap-2">
                        <span className="font-mono text-xs">
                          {d.name}
                          <span className="text-muted-foreground">
                            {" "}
                            {d.range}
                          </span>
                        </span>
                        <DepBadge status={d.status} />
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {preview.warnings.length > 0 && (
                <Alert>
                  <AlertTitle>Review before publishing</AlertTitle>
                  <AlertDescription>
                    <ul className="space-y-1">
                      {preview.warnings.map((w) => (
                        <li key={w}>{w}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        )}

        {/* 4 — Secrets + submit */}
        {preview && (
          <Form method="post">
            <input type="hidden" name="intent" value="install" />
            <input
              type="hidden"
              name="project"
              value={selectedProjectId ?? ""}
            />
            {newMemberTemplate ? (
              <input
                type="hidden"
                name="newMember"
                value={newMemberName ?? ""}
              />
            ) : (
              <input type="hidden" name="member" value={selectedMember ?? ""} />
            )}

            {/* Issue #165: selectable permission levels (scope groups) — the checkbox selection
                lands in the lock's auth snapshot and drives what the OAuth consent requests. */}
            {preview.authGroups.length > 0 && (
              <Card className="mb-6">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <ShieldCheck
                      className={`size-4 ${accentText.emerald}`}
                      aria-hidden
                    />
                    Permissions
                  </CardTitle>
                  <CardDescription>
                    Choose what this connection may do. The account is
                    authorized later from the agent&rsquo;s Deployment tab, and
                    the selection can be changed there too (adding permissions
                    asks for a reconnect).
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                  {preview.authGroups.map((auth) => (
                    <div key={auth.provider} className="grid gap-2">
                      <input
                        type="hidden"
                        name="scopegroupsfor"
                        value={auth.provider}
                      />
                      {preview.authGroups.length > 1 && (
                        <Label className="text-xs uppercase text-muted-foreground">
                          {auth.provider}
                        </Label>
                      )}
                      {auth.scopeGroups.map((g) => (
                        <Label
                          key={g.id}
                          className="flex items-start gap-2 text-sm font-normal"
                        >
                          <input
                            type="checkbox"
                            name={`scopegroup:${auth.provider}`}
                            value={g.id}
                            defaultChecked={g.default ?? false}
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
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Issue #166: capability operation groups — what the control plane will EXECUTE for
                this agent. Enforced per call by harnesst (not baked into a token), so the selection
                can be changed later from the Deployment tab with instant effect. */}
            {preview.capabilityGroups.length > 0 && (
              <Card className="mb-6">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <ShieldCheck
                      className={`size-4 ${accentText.emerald}`}
                      aria-hidden
                    />
                    Operations
                  </CardTitle>
                  <CardDescription>
                    Choose which operations harnesst may perform for this agent.
                    harnesst holds the credential and enforces this list on
                    every call — you can change it any time from the
                    agent&rsquo;s Deployment tab, with instant effect.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                  {preview.capabilityGroups.map((cap) => (
                    <div key={cap.provider} className="grid gap-2">
                      <input
                        type="hidden"
                        name="capgroupsfor"
                        value={cap.provider}
                      />
                      {preview.capabilityGroups.length > 1 && (
                        <Label className="text-xs uppercase text-muted-foreground">
                          {cap.provider}
                        </Label>
                      )}
                      {cap.groups.map((g) => (
                        <Label
                          key={g.id}
                          className="flex items-start gap-2 text-sm font-normal"
                        >
                          <input
                            type="checkbox"
                            name={`capgroup:${cap.provider}`}
                            value={g.id}
                            defaultChecked={g.default}
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
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Issue #47: gate on userSecrets, not preview.secrets — a template whose secrets are
                all provisioned (e.g. the GitHub channel) shows no Secrets card at all. */}
            {userSecrets.length > 0 && (
              <Card className="mb-6">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <KeyRound
                      className={`size-4 ${accentText.amber}`}
                      aria-hidden
                    />
                    Secrets
                  </CardTitle>
                  <CardDescription>
                    {newMemberTemplate
                      ? `This agent needs ${userSecrets.length} secret${userSecrets.length === 1 ? "" : "s"}. Enter them now — they'll be attached when the agent goes live. Values are encrypted write-only.`
                      : "Stored per-agent, agent-wide. Values are encrypted write-only. Leave blank to set later in Settings."}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                  {userSecrets.map((s) => (
                    <InstallSecretField
                      key={s.name}
                      secret={s}
                      sharedExists={sharedNames.includes(s.name)}
                    />
                  ))}
                  {newMemberTemplate && userSecrets.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {COPY.installDeferral}
                    </p>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Issue #47: provisioned secrets are set by guided setup, not entered here — a single
                muted line, no card and no key icon, so they read as informational, not a to-do. */}
            {provisionedSecrets.length > 0 && (
              <p className="mb-6 text-xs text-muted-foreground">
                <span className="font-mono">
                  {provisionedSecrets.map((s) => s.name).join(", ")}
                </span>{" "}
                are set automatically during guided setup on the agent&rsquo;s
                Deployment tab after install — nothing to enter here.
              </p>
            )}

            <div className="flex items-center gap-3">
              {preview.canKeepExistingFiles ? (
                <Button
                  type="submit"
                  name="conflictResolution"
                  value="keep-existing"
                  disabled={!canRegisterExisting}
                >
                  Register and keep existing files
                </Button>
              ) : (
                <Button type="submit" disabled={!canSubmit}>
                  Save install
                </Button>
              )}
              <span className="text-sm text-muted-foreground">
                {preview.canKeepExistingFiles
                  ? "Preserves your code and saves the lock, missing files, and dependencies. Preserved files stay unmanaged."
                  : "Saves the install with your other changes — publish from the header to take it live."}
              </span>
            </div>
          </Form>
        )}
      </div>
    </AppShell>
  );
}

/**
 * One manifest secret in the install step (§9): a three-way choice when a project-level shared
 * secret with the same name exists (use shared — the default, prevents token sprawl / enter a
 * value / skip), or a value input with a Skip affordance otherwise. Emits hidden fields the
 * action's planInstallSecretOps reads: `secretmode:<name>`, `secret:<name>`,
 * `secretsandbox:<name>`. Sandbox is pre-checked from the manifest and always editable.
 */
function InstallSecretField({
  secret,
  sharedExists,
}: {
  secret: { name: string; description?: string; sandbox?: boolean };
  sharedExists: boolean;
}) {
  const [mode, setMode] = useState<"shared" | "value" | "skip">(
    sharedExists ? "shared" : "value",
  );
  const [value, setValue] = useState("");
  const [sandbox, setSandbox] = useState(secret.sandbox ?? false);

  return (
    <div className="grid max-w-md gap-1.5">
      <Label className="font-mono text-xs">{secret.name}</Label>
      {secret.description && (
        <p className="text-xs text-muted-foreground">{secret.description}</p>
      )}
      <input type="hidden" name={`secretmode:${secret.name}`} value={mode} />
      <input
        type="hidden"
        name={`secretsandbox:${secret.name}`}
        value={sandbox ? "1" : "0"}
      />

      {sharedExists ? (
        <div className="space-y-1.5">
          <Label className="flex items-center gap-2 text-sm font-normal">
            <input
              type="radio"
              name={`secretchoice:${secret.name}`}
              checked={mode === "shared"}
              onChange={() => setMode("shared")}
            />
            Use project-level {secret.name} (recommended)
          </Label>
          <Label className="flex items-center gap-2 text-sm font-normal">
            <input
              type="radio"
              name={`secretchoice:${secret.name}`}
              checked={mode === "value"}
              onChange={() => setMode("value")}
            />
            Enter a value for this agent
          </Label>
          {mode === "value" && (
            <SecretInput
              name={`secret:${secret.name}`}
              placeholder="value (write-only)"
              revealLabel="value"
              wrapperClassName="ml-6 w-full sm:w-72"
              className="w-full font-mono"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
          <Label className="flex items-center gap-2 text-sm font-normal">
            <input
              type="radio"
              name={`secretchoice:${secret.name}`}
              checked={mode === "skip"}
              onChange={() => setMode("skip")}
            />
            Skip — I&rsquo;ll add it later
          </Label>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <SecretInput
            name={`secret:${secret.name}`}
            placeholder="value (write-only)"
            revealLabel="value"
            wrapperClassName="w-full min-w-0 sm:w-72"
            className="w-full font-mono"
            value={mode === "skip" ? "" : value}
            disabled={mode === "skip"}
            onChange={(e) => setValue(e.target.value)}
          />
          <button
            type="button"
            className="text-xs text-muted-foreground underline-offset-4 hover:underline"
            onClick={() => setMode(mode === "skip" ? "value" : "skip")}
          >
            {mode === "skip" ? "Enter a value" : "Skip"}
          </button>
        </div>
      )}

      {mode !== "skip" && (
        <Label className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
          <input
            type="checkbox"
            checked={sandbox}
            onChange={(e) => setSandbox(e.target.checked)}
          />
          Expose to sandbox shell
          {secret.sandbox && <span>· Requested by template</span>}
        </Label>
      )}
    </div>
  );
}

function DepBadge({ status }: { status: DependencyDecision["status"] }) {
  if (status === "add") return <Badge variant="success">add</Badge>;
  if (status === "keep")
    return <Badge variant="outline">already present</Badge>;
  return <Badge variant="destructive">range conflict</Badge>;
}
