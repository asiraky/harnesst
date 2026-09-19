/**
 * Workspace settings (managed mode — PRD §7.5, ARCH §3.8), one module behind three tabs:
 *
 *   /settings              General     — workspace name, spend cap + kill-switch, usage
 *   /settings/connections  Connections — model providers, workspace default model, overrides
 *   /settings/audit        Audit       — the operational audit log
 *
 * (Members is its own module, settings.members.tsx.) The module is registered once per tab and
 * picks the section from the pathname, so every form and fetcher posts to the page it is on and
 * the loader/action stay in one place. Membership itself is managed by Better Auth's
 * organization plugin.
 */
import { getSessionAuth, sessionLoader } from "~/auth/session.server";
import {
  Building2,
  Cpu,
  Gauge,
  Plug,
  ScrollText,
  ShieldAlert,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  Form,
  Link,
  redirect,
  useFetcher,
  useLocation,
  useRevalidator,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import {
  LocalizedDateTime,
  LocalizedNumber,
} from "~/components/localized-values";
import { ModelSelection } from "~/components/model-select";
import { SettingsHeader, settingsSection } from "~/components/settings-tabs";
import { AppShell, PageHeader, accentText } from "~/components/shell";
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
  ensureWorkspace,
  requireWorkspaceAdmin,
  resolveActiveWorkspace,
  type WorkspaceInfo,
} from "~/auth/workspace.server";
import { listAudit, recordAudit } from "~/managed/audit.server";
import {
  getWorkspaceAssistantSelection,
  setWorkspaceAssistantSelection,
} from "~/org/workspace.server";
import { isReasoningEffort, type ReasoningEffort } from "~/models/reasoning";
import {
  listAgentModelOverrides,
  removeAgentModelOverrideRow,
  type AgentModelOverride,
} from "~/models/agent-model-config.server";
import {
  createApiKeyConnection,
  disconnectModelConnection,
  recoverDeletedCodexConnection,
  listModelConnections,
  renameModelConnection,
  type ModelConnection,
} from "~/models/provider-connections.server";
import {
  MODEL_PROVIDERS,
  isApiKeyProviderId,
  type ApiKeyProviderId,
} from "~/models/provider-reference";
import { findWorkspaceModel } from "~/models/union.server";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import {
  getSpendLimit,
  setSpendLimit,
  tokensUsedSince,
  type SpendLimit,
} from "~/managed/billing.server";
import { listProjects } from "~/db/queries.server";
import { listAccessibleProjectIds } from "~/auth/project-access.server";
import { getRuntime } from "~/seams/index.server";
import type { auditLog } from "~/db/schema";
import type { HarnesstMode } from "~/seams/types";
import { noindexMeta } from "~/lib/seo";
import { auth as betterAuth } from "~/lib/auth.server";
import { publicAuthErrorMessage } from "~/lib/auth-error.server";
import { invalidateOrganizationEnvironments } from "~/deploy/env-reconcile.server";
import type { Route } from "./+types/settings";

interface OrgSettingsView {
  org: WorkspaceInfo | null;
  mode: HarnesstMode;
  limit: SpendLimit | null;
  used: number;
  audit: (typeof auditLog.$inferSelect)[];
  /** Connected workspace default (null = no default). */
  assistantModel: string | null;
  assistantEffort: ReasoningEffort | null;
  /** Per-agent model overrides — the explicit exceptions to the workspace default. */
  agentOverrides: AgentOverrideView[];
  /** Connected model providers (issue #28) — display metadata only, never a token. */
  connections: ModelConnection[];
  /** Better Auth organization:update permission for the active workspace. */
  canManage: boolean;
}

/**
 * One listed override row. Two repos in a workspace may each pin the same agent name, so the row
 * carries the repo it belongs to — both to tell them apart and because removal keys it
 * (issue #344). `repoName` is null for a legacy row that belongs to no repo in particular.
 */
type AgentOverrideView = AgentModelOverride & { repoName: string | null };

async function canManageWorkspace(
  organizationId: string,
  headers: Headers,
): Promise<boolean> {
  const permission = await betterAuth.api.hasPermission({
    headers,
    body: {
      organizationId,
      permissions: { organization: ["update"] },
    },
  });
  return permission.success;
}

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }): Promise<OrgSettingsView> => {
      // Close the org-less hole: provision/adopt/choose a workspace before syncing.
      await ensureWorkspace(args.request, auth);
      const active = await resolveActiveWorkspace(auth);
      if (active) requireWorkspaceAdmin(active, "page");
      const org = active?.org;
      if (!org) {
        return {
          org: null,
          mode: getRuntime().mode,
          limit: null,
          used: 0,
          audit: [],
          assistantModel: null,
          assistantEffort: null,
          agentOverrides: [],
          connections: [],
          canManage: false,
        };
      }
      const [
        limit,
        used,
        audit,
        assistantSelection,
        agentOverrides,
        connections,
        canManage,
        orgProjects,
      ] = await Promise.all([
        getSpendLimit(org.id),
        tokensUsedSince(org.id),
        listAudit(org.id, 50),
        getWorkspaceAssistantSelection(org.id),
        listAgentModelOverrides(org.id),
        listModelConnections(org.id),
        canManageWorkspace(org.id, auth.requestHeaders),
        listProjects(org.id).catch(() => []),
      ]);
      // Repo-derived settings are scoped to the repos this admin can actually reach; an
      // override on an ungranted repo would otherwise reveal that repo's name and agents.
      const accessible = new Set(
        await listAccessibleProjectIds({
          userId: auth.user.id,
          workspaceRole: active.member.role,
          orgId: org.id,
        }),
      );
      const repoNames = new Map(
        orgProjects
          .filter((p) => accessible.has(p.id))
          .map((p) => [p.id, p.name]),
      );
      return {
        org,
        mode: getRuntime().mode,
        limit: limit ?? null,
        used,
        audit,
        assistantModel: assistantSelection.model,
        assistantEffort: assistantSelection.effort,
        agentOverrides: agentOverrides
          .filter((o) => accessible.has(o.projectId))
          .map((o) => ({
            ...o,
            repoName: repoNames.get(o.projectId) ?? null,
          })),
        connections,
        canManage,
      };
    },
    { ensureSignedIn: true },
  );

export async function action(args: ActionFunctionArgs) {
  const auth = await getSessionAuth(args);
  if (!auth.user) throw redirect("/login");
  const active = await resolveActiveWorkspace(auth);
  const org = active?.org;
  if (!org) return { error: "No organization." };
  requireWorkspaceAdmin(active, "api");
  if (!(await canManageWorkspace(org.id, auth.requestHeaders))) {
    throw new Response("Forbidden", { status: 403 });
  }

  const form = await args.request.formData();

  const intent = String(form.get("intent") ?? "");
  // Every tab posts to its own URL; land back on it rather than on a fixed one.
  const here = new URL(args.request.url).pathname.replace(/\.data$/, "");

  if (intent === "rename-workspace") {
    const name = String(form.get("name") ?? "").trim();
    if (!name) return { error: "Enter a workspace name." };
    try {
      await betterAuth.api.updateOrganization({
        body: { organizationId: org.id, data: { name } },
        headers: auth.requestHeaders,
      });
    } catch (error) {
      return {
        error: publicAuthErrorMessage(error, "Could not rename the workspace."),
      };
    }
    await recordAudit({
      orgId: org.id,
      actorUserId: auth.user.id,
      action: "workspace_renamed",
      meta: { name },
    });
    throw redirect(here);
  }

  if (intent === "connect-api-key") {
    const provider = String(form.get("provider") ?? "");
    const label = String(form.get("label") ?? "").trim();
    const apiKey = String(form.get("apiKey") ?? "").trim();
    if (!isApiKeyProviderId(provider)) {
      return { error: "Choose an API-key provider." };
    }
    if (!label) return { error: "Give the connection a name." };
    if (!apiKey) return { error: "Paste the provider API key." };
    try {
      const connection = await createApiKeyConnection({
        orgId: org.id,
        provider,
        label,
        apiKey,
        createdBy: auth.user.id,
        connectionId: String(form.get("connectionId") ?? "") || undefined,
      });
      await invalidateOrganizationEnvironments({
        orgId: org.id,
        createdBy: auth.user.id,
      });
      await recordAudit({
        orgId: org.id,
        actorUserId: auth.user.id,
        action: "model_provider_connected",
        target: connection.id,
        meta: { provider },
      });
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : "The provider could not validate that API key.",
      };
    }
    return { ok: true as const };
  }

  // ── Model provider connections (issue #28): rename / remove a connected provider ──
  if (intent === "rename-connection") {
    const id = String(form.get("connectionId") ?? "");
    const label = String(form.get("label") ?? "").trim();
    if (!id || !label) return { error: "Give the connection a name." };
    await renameModelConnection(org.id, id, label);
    await recordAudit({
      orgId: org.id,
      actorUserId: auth.user.id,
      action: "model_provider_renamed",
      target: id,
    });
    throw redirect(here);
  }

  if (intent === "remove-connection") {
    const id = String(form.get("connectionId") ?? "");
    if (!id) return { error: "No connection specified." };
    const connection = (await listModelConnections(org.id)).find(
      (row) => row.id === id,
    );
    await disconnectModelConnection(org.id, id);
    if (connection && connection.provider !== "codex")
      await invalidateOrganizationEnvironments({
        orgId: org.id,
        createdBy: auth.user.id,
      });
    await recordAudit({
      orgId: org.id,
      actorUserId: auth.user.id,
      action: "model_provider_disconnected",
      target: id,
    });
    throw redirect(here);
  }

  if (intent === "recover-connection") {
    try {
      await recoverDeletedCodexConnection({
        orgId: org.id,
        oldId: String(form.get("oldId") ?? "").trim(),
        connectionId: String(form.get("connectionId") ?? ""),
        verifiedBy: auth.user.id,
        verified: form.get("verified") === "yes",
      });
      return { ok: true as const };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Recovery failed.",
      };
    }
  }

  if (intent === "set-assistant-model") {
    const model = String(form.get("assistantModel") ?? "").trim();
    const effortValue = String(form.get("assistantEffort") ?? "").trim();
    const effort =
      effortValue && isReasoningEffort(effortValue) ? effortValue : null;
    if (effortValue && !effort)
      return { error: "Choose a valid reasoning effort." };
    const modelInfo = model ? await findWorkspaceModel(org.id, model) : null;
    if (model && !modelInfo) {
      return {
        error:
          "That model is not available from an active provider connection in this workspace.",
      };
    }
    if (effort && !modelInfo?.supportedEfforts?.includes(effort)) {
      return {
        error: "That reasoning effort is not supported by the selected model.",
      };
    }
    await setWorkspaceAssistantSelection(org.id, {
      model: model || null,
      effort,
    });
    await recordAudit({
      orgId: org.id,
      actorUserId: auth.user.id,
      action: "workspace_assistant_model_set",
      meta: { model: model || "(none)", effort: effort ?? "provider-default" },
    });
    throw redirect(here);
  }

  if (intent === "remove-agent-model-override") {
    const agentName = String(form.get("agentName") ?? "").trim();
    if (!agentName) return { error: "No agent specified." };
    // The full row key: a declared subagent's row lives under the same agent name, and two repos
    // in this workspace may each hold a row for the same name — remove exactly the listed one
    // (issue #344). `projectId` is `''` for a legacy, repo-less row.
    const subagentPath = String(form.get("subagentPath") ?? "").trim();
    const projectId = String(form.get("projectId") ?? "").trim();
    await removeAgentModelOverrideRow(org.id, {
      agentName,
      subagentPath,
      projectId,
    });
    await recordAudit({
      orgId: org.id,
      actorUserId: auth.user.id,
      action: "agent_model_override_removed",
      target: subagentPath ? `${agentName}/${subagentPath}` : agentName,
      meta: { projectId: projectId || "(any repo)" },
    });
    return { ok: true as const };
  }

  const capRaw = String(form.get("monthlyTokenCap") ?? "").trim();
  const monthlyTokenCap =
    capRaw === "" ? null : Math.max(0, Number(capRaw) || 0);
  const killSwitch = form.get("killSwitch") === "on";

  await setSpendLimit(org.id, { monthlyTokenCap, killSwitch });
  await recordAudit({
    orgId: org.id,
    actorUserId: auth.user.id,
    action: "spend_limit_change",
    meta: { monthlyTokenCap, killSwitch },
  });
  throw redirect(here);
}

export function meta() {
  return [{ title: "Settings · harnesst" }, ...noindexMeta];
}

export default function WorkspaceSettings({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const section = settingsSection(useLocation().pathname);
  const actionError =
    actionData && "error" in actionData ? actionData.error : null;
  const {
    user,
    org,
    mode,
    limit,
    used,
    audit,
    assistantModel,
    assistantEffort,
    agentOverrides,
    connections,
    canManage,
  } = loaderData;
  const modelFetcher = useFetcher<typeof action>();

  if (!org) {
    return (
      <AppShell userEmail={user?.email}>
        <PageHeader
          icon={Building2}
          accent="indigo"
          title="Settings"
          description="You're not scoped to an organization."
        />
        <Button variant="outline" asChild>
          <Link to="/dashboard">Back to dashboard</Link>
        </Button>
      </AppShell>
    );
  }

  return (
    <AppShell userEmail={user?.email}>
      <SettingsHeader
        section={section}
        description={
          <>
            {org.name} · mode <span className="font-mono">{mode}</span>
          </>
        }
      />

      <div className="space-y-6">
        {actionError && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
          >
            {actionError}
          </p>
        )}

        {section === "general" && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Building2
                  className={`size-4 ${accentText.indigo}`}
                  aria-hidden
                />
                Workspace
              </CardTitle>
              <CardDescription>
                The workspace name is visible to every member.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {canManage ? (
                <Form method="post" className="flex max-w-xl items-end gap-2">
                  <input type="hidden" name="intent" value="rename-workspace" />
                  <div className="flex-1 space-y-1.5">
                    <Label htmlFor="name">Workspace name</Label>
                    <Input
                      id="name"
                      name="name"
                      defaultValue={org.name}
                      autoComplete="off"
                    />
                  </div>
                  <Button type="submit">Save</Button>
                </Form>
              ) : (
                <p className="text-sm">{org.name}</p>
              )}
            </CardContent>
          </Card>
        )}

        {/* Connected model providers + workspace default */}
        {section === "connections" && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Cpu className={`size-4 ${accentText.blue}`} aria-hidden />
                Model providers
              </CardTitle>
              <CardDescription>
                Connect one or more provider accounts. API keys are injected
                directly into agent instances for their matching connection;
                Codex subscription traffic uses harnesst's OAuth gateway. Model
                pickers show only models from active connections.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Label className="flex items-center gap-2">
                    <Plug className="size-4" aria-hidden />
                    Connected providers
                  </Label>
                  {canManage && (
                    <div className="flex flex-wrap gap-2">
                      <ConnectApiKeyDialog />
                      <ConnectCodexDialog />
                    </div>
                  )}
                </div>
                {connections.length === 0 ? (
                  <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                    No model providers are connected. Connect OpenRouter,
                    Anthropic, OpenAI Platform, or an OpenAI Codex subscription
                    to make models available.
                  </div>
                ) : (
                  <ul className="divide-y rounded-lg border text-sm">
                    {connections.map((conn) => (
                      <ConnectionRow
                        key={conn.id}
                        conn={conn}
                        canManage={canManage}
                      />
                    ))}
                  </ul>
                )}
                {!canManage && (
                  <p className="text-xs text-muted-foreground">
                    Only workspace owners and admins can change provider
                    connections.
                  </p>
                )}
              </div>

              <div className="max-w-xl space-y-2 border-t pt-4">
                <div className="flex min-h-8 items-center justify-between gap-3">
                  <Label>Default model</Label>
                  {canManage && assistantModel && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={modelFetcher.state !== "idle"}
                      onClick={() =>
                        modelFetcher.submit(
                          {
                            intent: "set-assistant-model",
                            assistantModel: "",
                            assistantEffort: "",
                          },
                          { method: "post" },
                        )
                      }
                    >
                      Clear default
                    </Button>
                  )}
                </div>
                {canManage ? (
                  <ModelSelection
                    model={assistantModel}
                    effort={assistantEffort}
                    busy={modelFetcher.state !== "idle"}
                    onCommit={(model, effort) =>
                      modelFetcher.submit(
                        {
                          intent: "set-assistant-model",
                          assistantModel: model,
                          assistantEffort: effort ?? "",
                        },
                        { method: "post" },
                      )
                    }
                  />
                ) : (
                  <p className="font-mono text-sm">
                    {assistantModel
                      ? `${assistantModel} · ${assistantEffort ?? "provider default"}`
                      : "No default configured"}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Used by the authoring assistant and by every agent without an
                  override below. Running agents resolve this at each step, so a
                  change lands within about 30 seconds — no redeploy. A
                  workspace with no default has no implicit fallback: agents
                  error until a model is configured here.
                </p>
                {modelFetcher.data &&
                  "error" in modelFetcher.data &&
                  modelFetcher.data.error && (
                    <p className="text-sm text-destructive">
                      {modelFetcher.data.error}
                    </p>
                  )}
              </div>

              <AgentOverridesSection
                overrides={agentOverrides}
                canManage={canManage}
              />
            </CardContent>
          </Card>
        )}

        {/* Spend controls */}
        {section === "general" && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Gauge className={`size-4 ${accentText.amber}`} aria-hidden />
                Spend controls
              </CardTitle>
              <CardDescription>
                Tokens used (last 30 days):{" "}
                <span className={`font-medium ${accentText.indigo}`}>
                  <LocalizedNumber value={used} />
                </span>
                {limit?.monthlyTokenCap != null && (
                  <>
                    {" / "}
                    <LocalizedNumber value={limit.monthlyTokenCap} />
                  </>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {canManage ? (
                <Form method="post" className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="monthlyTokenCap">Monthly token cap</Label>
                    <Input
                      id="monthlyTokenCap"
                      name="monthlyTokenCap"
                      type="number"
                      min={0}
                      defaultValue={limit?.monthlyTokenCap ?? ""}
                      placeholder="unlimited"
                      className="w-48"
                    />
                  </div>
                  <Label className="flex items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/5 px-3 py-2 font-normal text-rose-700 dark:text-rose-400">
                    <ShieldAlert className="size-4 shrink-0" aria-hidden />
                    <input
                      type="checkbox"
                      name="killSwitch"
                      defaultChecked={limit?.killSwitch ?? false}
                      aria-label="Kill-switch (block all model calls for this tenant)"
                    />
                    Kill-switch (block all model calls for this tenant)
                  </Label>
                  <Button type="submit">Save</Button>
                </Form>
              ) : (
                <div className="space-y-2 text-sm">
                  <p>
                    Monthly token cap:{" "}
                    {limit?.monthlyTokenCap?.toLocaleString() ?? "unlimited"}
                  </p>
                  <p>Kill-switch: {limit?.killSwitch ? "on" : "off"}</p>
                  <p className="text-muted-foreground">
                    Only workspace owners and admins can change spend controls.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Audit log */}
        {section === "audit" && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ScrollText
                  className={`size-4 ${accentText.indigo}`}
                  aria-hidden
                />
                Audit log
              </CardTitle>
            </CardHeader>
            <CardContent>
              {audit.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No operations recorded yet.
                </p>
              ) : (
                <ul className="divide-y rounded-lg border text-sm">
                  {audit.map((a) => (
                    <li key={a.id} className="flex justify-between px-4 py-2">
                      <span>
                        <span className="font-medium">{a.action}</span>
                        {a.target && (
                          <span className="ml-2 font-mono text-muted-foreground">
                            {a.target}
                          </span>
                        )}
                      </span>
                      <span className="text-muted-foreground">
                        <LocalizedDateTime value={a.createdAt} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </AppShell>
  );
}

/**
 * Per-agent model overrides — the workspace's explicit exceptions to the default model. Each
 * row pins one target to a model; the X removes the pin so that target falls back to what it
 * inherits. A target is an agent, or a declared subagent shown as `<agent> › <path>` (issue
 * #344) — a subagent with no row of its own follows its parent and never appears here. Agents
 * resolve this map at runtime, so every change lands on running agents within seconds, with no
 * repo change and no redeploy.
 */
function AgentOverridesSection({
  overrides,
  canManage,
}: {
  overrides: AgentOverrideView[];
  canManage: boolean;
}) {
  return (
    <div className="max-w-xl space-y-3 border-t pt-4">
      <Label>Per-agent model overrides</Label>
      <p className="text-xs text-muted-foreground">
        Only targets explicitly pinned in Agent Settings appear here. A subagent
        with no pin of its own follows its parent agent.
      </p>
      {overrides.length === 0 ? (
        <div className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
          No overrides — every agent uses the default model.
        </div>
      ) : (
        <ul className="divide-y rounded-lg border">
          {overrides.map((override) => (
            <AgentOverrideRow
              key={`${override.projectId}\u0000${override.agentName}\u0000${override.subagentPath}`}
              override={override}
              canManage={canManage}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** One explicit override — managed in Agent Settings, with a shortcut to restore inheritance. */
function AgentOverrideRow({
  override,
  canManage,
}: {
  override: AgentOverrideView;
  canManage: boolean;
}) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2">
      <span className="min-w-28 font-mono text-sm">
        {override.agentName}
        {override.subagentPath && (
          <span className="text-muted-foreground">
            {" \u203a "}
            {override.subagentPath}
          </span>
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-sm text-muted-foreground">
          {override.model}
        </div>
        <div className="text-xs text-muted-foreground">
          {override.effort ?? "Provider default"} reasoning
          {override.repoName
            ? ` \u00b7 ${override.repoName}`
            : override.projectId
              ? " \u00b7 removed repo"
              : " \u00b7 any repo (legacy)"}
        </div>
      </div>
      {canManage && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() =>
            fetcher.submit(
              {
                intent: "remove-agent-model-override",
                agentName: override.agentName,
                subagentPath: override.subagentPath,
                projectId: override.projectId,
              },
              { method: "post" },
            )
          }
        >
          Use default
        </Button>
      )}
      {fetcher.data && "error" in fetcher.data && fetcher.data.error && (
        <p className="w-full text-sm text-destructive">{fetcher.data.error}</p>
      )}
    </li>
  );
}

/** One connected model provider — provider badge, inline rename, status, remove (issue #28). */
function ConnectionRow({
  conn,
  canManage,
}: {
  conn: ModelConnection;
  canManage: boolean;
}) {
  const rename = useFetcher();
  const [editing, setEditing] = useState(false);
  const active = conn.status === "active";
  return (
    <li
      id={`connection-${conn.id}`}
      className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
    >
      <div className="space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium">
            {MODEL_PROVIDERS[conn.provider].displayName}
          </span>
          {editing && canManage ? (
            <rename.Form
              method="post"
              className="flex items-center gap-1"
              onSubmit={() => setEditing(false)}
            >
              <input type="hidden" name="intent" value="rename-connection" />
              <input type="hidden" name="connectionId" value={conn.id} />
              <Input
                name="label"
                defaultValue={conn.label}
                aria-label="Connection name"
                className="h-7 w-40"
              />
              <Button type="submit" size="sm">
                Save
              </Button>
            </rename.Form>
          ) : (
            <span className="font-medium">{conn.label}</span>
          )}
          {canManage && !editing && (
            <button
              type="button"
              className="text-xs text-muted-foreground underline"
              onClick={() => setEditing(true)}
            >
              rename
            </button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Connection ID: <code>{conn.id}</code>
        </p>
        {conn.accountEmail && (
          <p className="text-xs text-muted-foreground">{conn.accountEmail}</p>
        )}
        {MODEL_PROVIDERS[conn.provider].authKind === "api-key" && (
          <p className="text-xs text-muted-foreground">
            API key configured (write-only)
          </p>
        )}
        {!active && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Reauthenticate to resume — this connection is{" "}
            {conn.status === "revoked" ? "disconnected" : conn.status}.
          </p>
        )}
      </div>
      {canManage && (
        <div className="flex items-center gap-2">
          {conn.provider === "codex" ? (
            <ConnectCodexDialog connection={conn} />
          ) : (
            <ConnectApiKeyDialog connection={conn} />
          )}
          {conn.provider === "codex" && active && (
            <RecoverConnectionDialog connection={conn} />
          )}
          <Form method="post">
            <input type="hidden" name="intent" value="remove-connection" />
            <input type="hidden" name="connectionId" value={conn.id} />
            <Button type="submit" variant="outline" size="sm">
              Disconnect
            </Button>
          </Form>
        </div>
      )}
    </li>
  );
}

/** Add a validated write-only OpenRouter, Anthropic, or OpenAI Platform key connection. */
function ConnectApiKeyDialog({ connection }: { connection?: ModelConnection }) {
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<ApiKeyProviderId>(
    (connection?.provider as ApiKeyProviderId) ?? "openrouter",
  );
  const fetcher = useFetcher<typeof action>();

  useEffect(() => {
    if (
      fetcher.state === "idle" &&
      fetcher.data &&
      "ok" in fetcher.data &&
      fetcher.data.ok
    ) {
      setOpen(false);
    }
  }, [fetcher.data, fetcher.state]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm">
          {connection ? "Reauthenticate" : "Connect API key"}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {connection
              ? `Reauthenticate ${connection.label}`
              : "Connect an API-key provider"}
          </DialogTitle>
          <DialogDescription>
            harnesst validates the key before sealing it. Keys are write-only
            and are sent directly to agent instances for this exact connection.
          </DialogDescription>
        </DialogHeader>
        <fetcher.Form method="post" className="space-y-4">
          <input type="hidden" name="intent" value="connect-api-key" />
          <input
            type="hidden"
            name="connectionId"
            value={connection?.id ?? ""}
          />
          {connection && (
            <input type="hidden" name="provider" value={connection.provider} />
          )}
          <div className="space-y-1.5">
            <Label htmlFor="provider">Provider</Label>
            <select
              disabled={!!connection}
              id="provider"
              name="provider"
              aria-label="Provider"
              value={provider}
              onChange={(event) =>
                setProvider(event.target.value as ApiKeyProviderId)
              }
              className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
            >
              <option value="openrouter">OpenRouter</option>
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI Platform</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="connectionLabel">Connection name</Label>
            <Input
              id="connectionLabel"
              defaultValue={connection?.label}
              name="label"
              required
              maxLength={80}
              placeholder={`e.g. ${MODEL_PROVIDERS[provider].displayName} production`}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="providerApiKey">
              {MODEL_PROVIDERS[provider].displayName} API key
            </Label>
            <SecretInput
              id="providerApiKey"
              name="apiKey"
              required
              revealLabel="API key"
              wrapperClassName="w-full"
              className="w-full"
              placeholder={
                provider === "openrouter" ? "sk-or-v1-…" : "Paste API key"
              }
            />
          </div>
          {fetcher.data && "error" in fetcher.data && fetcher.data.error && (
            <p role="alert" className="text-sm text-destructive">
              {fetcher.data.error}
            </p>
          )}
          <Button type="submit" disabled={fetcher.state !== "idle"}>
            {fetcher.state === "idle"
              ? connection
                ? "Update credentials"
                : "Connect provider"
              : "Validating…"}
          </Button>
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}

type CodexConnectResponse =
  | {
      attemptId: string;
      userCode: string;
      interval: number;
      verificationUrl: string;
    }
  | { pending: true }
  | { done: true }
  | { error: string };

/**
 * The "Connect OpenAI Codex" dialog (issue #28): request a device code, show the user the code +
 * verification URL, then poll until they authorize — closing and revalidating on success so the
 * connections list refreshes.
 */
function ConnectCodexDialog({ connection }: { connection?: ModelConnection }) {
  const [open, setOpen] = useState(false);
  const fetcher = useFetcher<CodexConnectResponse>();
  const revalidator = useRevalidator();
  const [device, setDevice] = useState<{
    attemptId: string;
    userCode: string;
    verificationUrl: string;
    interval: number;
  } | null>(null);
  const started = useRef(false);
  const cancel = useFetcher();
  const openRef = useRef(open);
  openRef.current = open;

  // Kick off the device-code request once per open.
  useEffect(() => {
    if (open && !started.current) {
      started.current = true;
      fetcher.submit(
        { intent: "start", connectionId: connection?.id ?? "" },
        { method: "post", action: "/api/connections/codex" },
      );
    }
    if (!open) {
      started.current = false;
      setDevice(null);
    }
    // fetcher is stable for the component's lifetime; re-running on it would resubmit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Latch the device code, complete on success — both driven by the fetcher response.
  useEffect(() => {
    const d = fetcher.data;
    if (!d) return;
    if ("attemptId" in d && d.attemptId) {
      if (!openRef.current) {
        cancel.submit(
          { intent: "cancel", attemptId: d.attemptId },
          { method: "post", action: "/api/connections/codex" },
        );
        return;
      }
      setDevice({
        attemptId: d.attemptId,
        userCode: d.userCode,
        verificationUrl: d.verificationUrl,
        interval: d.interval,
      });
    }
    if ("done" in d && d.done) {
      setOpen(false);
      setDevice(null);
      revalidator.revalidate();
    }
  }, [fetcher.data]);

  // Poll for authorization at the server-provided interval while the dialog is open.
  useEffect(() => {
    if (
      !open ||
      !device ||
      fetcher.state !== "idle" ||
      (fetcher.data && "error" in fetcher.data)
    )
      return;
    const timer = setTimeout(
      () => {
        fetcher.submit(
          {
            intent: "poll",
            attemptId: device.attemptId,
          },
          { method: "post", action: "/api/connections/codex" },
        );
      },
      Math.max(device.interval, 1) * 1000,
    );
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, device, fetcher.state, fetcher.data]);

  const error =
    fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && device)
          cancel.submit(
            { intent: "cancel", attemptId: device.attemptId },
            { method: "post", action: "/api/connections/codex" },
          );
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" size="sm">
          {connection ? "Reauthenticate" : "Connect OpenAI Codex"}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {connection
              ? `Reauthenticate ${connection.label}`
              : "Connect OpenAI Codex"}
          </DialogTitle>
          <DialogDescription>
            {connection
              ? "Sign in to the same OpenAI account. Your connection ID, models, effort, and sessions will stay unchanged."
              : "Sign in with your ChatGPT subscription. Reconnecting the same account restores its existing connection."}
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>
        ) : device ? (
          <div className="space-y-3">
            <p className="text-sm">Enter this code to authorize harnesst:</p>
            <p className="text-center font-mono text-3xl font-semibold tracking-widest">
              {device.userCode}
            </p>
            <p className="text-sm">
              Open{" "}
              <a
                href={device.verificationUrl}
                target="_blank"
                rel="noreferrer"
                className="font-medium underline"
              >
                {device.verificationUrl}
              </a>{" "}
              and enter the code. Waiting for you to authorize…
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Starting…</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RecoverConnectionDialog({
  connection,
}: {
  connection: ModelConnection;
}) {
  const fetcher = useFetcher<typeof action>();
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Recover deleted ID
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Recover a deleted Codex connection</DialogTitle>
          <DialogDescription>
            Restore old agent and session references using {connection.label}.
            The deleted account identity cannot be inferred. Verify the original
            account from your records before linking it.
          </DialogDescription>
        </DialogHeader>
        <fetcher.Form method="post" className="space-y-4">
          <input type="hidden" name="intent" value="recover-connection" />
          <input type="hidden" name="connectionId" value={connection.id} />
          <Label htmlFor={`old-${connection.id}`}>Deleted connection ID</Label>
          <Input
            id={`old-${connection.id}`}
            name="oldId"
            required
            pattern="[a-z]{12}"
            placeholder="12 lowercase letters"
          />
          <label className="flex gap-2 text-sm">
            <input type="checkbox" name="verified" value="yes" required />I
            verified that the deleted connection used the same OpenAI account as{" "}
            {connection.label} ({connection.accountEmail ?? connection.id}).
          </label>
          <p className="text-sm text-muted-foreground">
            This mapping is recorded in the audit log. Previously cleared
            selections cannot be reconstructed; references that still contain
            the deleted ID will work again.
          </p>
          {fetcher.data && "error" in fetcher.data && (
            <p role="alert" className="text-sm text-destructive">
              {fetcher.data.error}
            </p>
          )}
          {fetcher.data && "ok" in fetcher.data && (
            <p role="status">
              Recovery mapping saved. Existing references can resume.
            </p>
          )}
          <Button disabled={fetcher.state !== "idle"} type="submit">
            Restore references
          </Button>
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}
