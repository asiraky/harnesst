/**
 * The setup wizard: one page per repo that walks through everything installed templates still
 * need: secrets, provisioner installs (e.g. a database), publishing, each agent's GitHub App,
 * OAuth connections and post-deploy verification. Same page whether one skill was installed into one
 * agent (`?member=`) or a whole team.
 *
 * The steps are derived from real state on every load (setup.server.ts → setup-plan.ts), so there
 * is no wizard progress to lose: leave for GitHub or Settings, come back, and the next step is
 * whatever is still missing. Settings remain the place to change things later.
 */
import { CheckCircle2, Circle, ExternalLink } from "lucide-react";
import { useEffect } from "react";
import {
  Form,
  Link,
  redirect,
  useFetcher,
  useNavigation,
  useRevalidator,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { getSessionAuth, sessionLoader } from "~/auth/session.server";
import { usePublishHref } from "~/components/publish";
import { AgentNav, AppShell, PageHeader } from "~/components/shell";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { SecretInput } from "~/components/ui/secret-input";
import { isWorkspaceAdmin } from "~/auth/roles";
import { appInstallUrl } from "~/github/app-manifest.server";
import { contextPath } from "~/lib/paths";
import { answerSecretStep, loadSetup, type SetupContext } from "~/marketplace/setup.server";
import type { SetupStep } from "~/marketplace/setup-plan";
import { requireProjectAccess, requireRepo } from "~/project/guard.server";
import {
  BUSY_STATUSES,
  isProvisionerId,
  provisionerDescriptor,
  type ProvisionerId,
} from "~/provisioners/descriptors";
import type { ConnectionLink, LinkOption } from "~/provisioners/link";
import { getProvisioner } from "~/provisioners/registry.server";
import {
  getProvisioning,
  linkProvisionerConnection,
  resolveProvisionerLink,
} from "~/provisioners/state.server";
import type { ProvisionerSetupContext } from "~/provisioners/types";
import { PROVISIONER_UI } from "~/provisioners/ui";
import { SERVICE_PROVIDERS } from "~/service-connections/providers";
import type { Route } from "./+types/projects.$projectId.setup";

const SETTINGS_CONNECTIONS = "/settings/connections";

interface ProvisionerView {
  status: string;
  link: ConnectionLink;
  options: LinkOption[];
  details: unknown;
}

async function provisionerContext(
  project: { id: string; orgId: string },
  setup: SetupContext,
  email: string,
  provisioner: ProvisionerId,
) {
  const row = await getProvisioning(project.id, provisioner);
  if (!row) return null;
  const { link, options } = await resolveProvisionerLink(project.id, provisioner, row);
  const ctx: ProvisionerSetupContext = {
    project,
    lock: setup.lock,
    userEmail: email,
    memberNames: setup.members.map((m) => m.name),
    link,
  };
  return { row, link, options, ctx };
}

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(args, async ({ auth }) => {
    const access = await requireProjectAccess(auth, args.params.projectId, "write", {
      request: args.request,
    });
    const project = requireRepo(access.project);
    const url = new URL(args.request.url);
    const member = url.searchParams.get("member");
    const setup = await loadSetup(project, { member });

    const provisioners: Partial<Record<ProvisionerId, ProvisionerView>> = {};
    for (const { provisioner } of setup.input.provisioning) {
      const p = await provisionerContext(project, setup, auth.user.email, provisioner);
      if (!p) continue;
      provisioners[provisioner] = {
        status: p.row.status,
        link: p.link,
        options: p.options,
        details: await getProvisioner(provisioner)
          .setupDetails(p.ctx, p.row)
          .catch(() => null),
      };
    }
    return {
      project: { id: project.id, name: project.name, slug: project.slug },
      member,
      isTeam: setup.isTeam,
      plan: setup.plan,
      memberNames: setup.members.map((m) => m.name),
      provisioners,
      // Linking a team to a workspace connection is a workspace-admin decision.
      canLinkConnections: isWorkspaceAdmin(access.active.member.role),
      email: auth.user.email,
      setupPath: `/repos/${project.slug}/setup${member ? `?member=${encodeURIComponent(member)}` : ""}`,
      deploymentPath: `${contextPath(project.id, setup.isTeam ? (member ?? undefined) : undefined)}/deployment`,
      installUrls: Object.fromEntries(
        setup.plan.steps.flatMap((s) =>
          s.kind === "github-app" && s.slug
            ? [[s.member, appInstallUrl(s.slug)]]
            : [],
        ),
      ) as Record<string, string>,
    };
  });

export async function action(args: ActionFunctionArgs) {
  const auth = await getSessionAuth(args);
  if (!auth.user) throw redirect("/login");
  const access = await requireProjectAccess(auth, args.params.projectId, "write");
  const project = requireRepo(access.project);
  const form = await args.request.formData();
  const intent = String(form.get("intent") ?? "");
  try {
    switch (intent) {
      case "secret": {
        const setup = await loadSetup(project, {
          member: (form.get("member") as string | null) || null,
        });
        return answerSecretStep({
          projectId: project.id,
          setup,
          name: String(form.get("name") ?? ""),
          value: String(form.get("value") ?? ""),
          userId: auth.user.id,
        });
      }
      case "link-connection": {
        const provisioner = form.get("provisioner");
        if (!isProvisionerId(provisioner)) return { error: "Unknown setup step." };
        if (!isWorkspaceAdmin(access.active.member.role))
          return { error: "Only workspace owners and admins can link connections." };
        await linkProvisionerConnection({
          projectId: project.id,
          orgId: project.orgId,
          provisioner,
          connectionId: String(form.get("connectionId") ?? ""),
        });
        return { error: null };
      }
      case "provision": {
        const provisioner = form.get("provisioner");
        if (!isProvisionerId(provisioner)) return { error: "Unknown setup step." };
        const setup = await loadSetup(project);
        const p = await provisionerContext(project, setup, auth.user.email ?? "", provisioner);
        if (!p) return { error: "Nothing installed needs this step." };
        await getProvisioner(provisioner).setupAction(
          p.ctx,
          String(form.get("op") ?? ""),
          form,
        );
        return { error: null };
      }
      default:
        return { error: "Unknown setup action." };
    }
  } catch (error) {
    if (error instanceof Response) throw error;
    return {
      error: error instanceof Error ? error.message : "Setup action failed.",
    };
  }
}

export function meta() {
  return [{ title: "Setup · harnesst" }];
}

type LoaderData = Route.ComponentProps["loaderData"];

function stepTitle(step: SetupStep): string {
  switch (step.kind) {
    case "secret":
      return `Set ${step.name}`;
    case "provision":
      return provisionerDescriptor(step.provisioner).title;
    case "publish":
      return "Publish";
    case "github-app":
      return `GitHub App for ${step.member}`;
    case "connection":
      return `Connect ${step.provider} for ${step.member}`;
    case "provision-verify":
      return provisionerDescriptor(step.provisioner).verifyTitle ?? "Verify";
  }
}

export default function Setup({
  loaderData: d,
  actionData,
}: Route.ComponentProps) {
  const revalidator = useRevalidator();
  const statuses = Object.values(d.provisioners).map((p) => p?.status ?? "");
  // Installing, activating, or installed and awaiting verification.
  const polling = statuses.some((s) => BUSY_STATUSES.includes(s) || s === "provisioned");

  // Poll while a provisioner runs; re-check on focus so returning from GitHub, Settings or an
  // OAuth tab shows the new state without a manual refresh.
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 2000);
    return () => clearInterval(timer);
  }, [polling, revalidator]);
  useEffect(() => {
    const onFocus = () => {
      if (revalidator.state === "idle") revalidator.revalidate();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [revalidator]);

  const { plan } = d;
  return (
    <AppShell
      nav={
        <AgentNav
          base={contextPath(d.project.id, null)}
          level={d.isTeam ? "repo" : "single"}
        />
      }
    >
      <PageHeader
        title={d.member ? `Set up ${d.member}` : "Set up"}
        description={`${d.project.name} · ${plan.done} of ${plan.total} done`}
      />
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        {actionData?.error && (
          <Alert variant="destructive">
            <AlertDescription className="whitespace-pre-wrap">
              {actionData.error}
            </AlertDescription>
          </Alert>
        )}
        {plan.total === 0 ? (
          <div className="rounded-lg border p-4">
            <p className="font-semibold">Nothing to set up for this repo.</p>
            <p className="text-sm text-muted-foreground">
              Steps appear here when something installed needs a secret, a
              connection or a service.
            </p>
          </div>
        ) : plan.next === null ? (
          <div className="rounded-lg border p-4">
            <p className="font-semibold">Setup is complete.</p>
            <p className="text-sm text-muted-foreground">
              Everything installed has what it needs.{" "}
              <Link to={d.deploymentPath} className="underline">
                Go to deployment
              </Link>
              .
            </p>
          </div>
        ) : null}
        <ol className="space-y-3">
          {plan.steps.map((step) => (
            <li key={step.id} className="rounded-lg border p-4">
              <div className="flex items-center gap-2">
                {step.done ? (
                  <CheckCircle2
                    className="size-4 text-emerald-600"
                    aria-hidden
                  />
                ) : (
                  <Circle
                    className="size-4 text-muted-foreground"
                    aria-hidden
                  />
                )}
                <h2 className="font-semibold">{stepTitle(step)}</h2>
                {plan.next?.id === step.id && <Badge>Next</Badge>}
              </div>
              {(!step.done ||
                step.kind === "provision" ||
                step.kind === "github-app") && (
                <div className="mt-3 space-y-3">
                  <StepBody step={step} d={d} />
                </div>
              )}
            </li>
          ))}
        </ol>
        <p className="text-sm text-muted-foreground">
          This page re-checks everything each time you open it.{" "}
          <button
            type="button"
            className="underline"
            onClick={() => revalidator.revalidate()}
          >
            Check again
          </button>
        </p>
      </div>
    </AppShell>
  );
}

function StepBody({ step, d }: { step: SetupStep; d: LoaderData }) {
  switch (step.kind) {
    case "secret":
      return <SecretStep step={step} d={d} />;
    case "provision":
      return <ProvisionStep step={step} d={d} />;
    case "publish":
      return <PublishStep step={step} />;
    case "github-app":
      return <GitHubStep step={step} d={d} />;
    case "connection":
      return <ConnectionStep step={step} d={d} />;
    case "provision-verify":
      return <ProvisionVerifyStep step={step} d={d} />;
  }
}

function SecretStep({
  step,
  d,
}: {
  step: Extract<SetupStep, { kind: "secret" }>;
  d: LoaderData;
}) {
  const fetcher = useFetcher<{ error: string | null }>();
  const shared = step.members.length > 1 || step.sharedExists;
  return (
    <fetcher.Form method="post" className="space-y-2">
      <input type="hidden" name="intent" value="secret" />
      <input type="hidden" name="name" value={step.name} />
      {d.member && <input type="hidden" name="member" value={d.member} />}
      {step.description && <p className="text-sm">{step.description}</p>}
      <p className="text-sm text-muted-foreground">
        Needed by {step.members.join(", ")}.{" "}
        {step.sharedExists
          ? "A shared value with this name already exists in this repository. Use it, or enter a new one to replace it for every agent that uses it."
          : shared
            ? "Saved once as a shared secret and attached to each of them."
            : "Saved for this agent only."}
        {step.sandbox && " Also available to the agent's sandbox (bash)."}
      </p>
      <Label htmlFor={`secret-${step.name}`} className="sr-only">
        {step.name}
      </Label>
      <SecretInput
        id={`secret-${step.name}`}
        name="value"
        revealLabel={step.name}
        required={!step.sharedExists}
        placeholder={
          step.sharedExists ? "Leave blank to use the shared value" : step.name
        }
      />
      <Button size="sm" disabled={fetcher.state !== "idle"}>
        {step.sharedExists ? "Use shared value" : "Save"}
      </Button>
      {fetcher.data?.error && (
        <p role="alert" className="text-sm text-destructive">
          {fetcher.data.error}
        </p>
      )}
    </fetcher.Form>
  );
}

function PublishStep({
  step,
}: {
  step: Extract<SetupStep, { kind: "publish" }>;
}) {
  const href = usePublishHref();
  return (
    <>
      <p className="text-sm">
        {step.members.length > 0
          ? `${step.members.join(", ")} ${step.members.length === 1 ? "becomes an agent" : "become agents"} when you publish. GitHub Apps and connections are set up per agent, so they come after this.`
          : "There are saved changes that aren't live yet."}
      </p>
      <Button asChild size="sm">
        <Link to={href} prefetch="none">
          Review and publish
        </Link>
      </Button>
    </>
  );
}

function GitHubStep({
  step,
  d,
}: {
  step: Extract<SetupStep, { kind: "github-app" }>;
  d: LoaderData;
}) {
  const createUrl = `/github/apps/new?project=${encodeURIComponent(d.project.id)}&agent=${encodeURIComponent(step.member)}&returnTo=${encodeURIComponent(d.setupPath)}`;
  const installUrl = d.installUrls[step.member];
  switch (step.state) {
    case "unpublished":
      return (
        <p className="text-sm text-muted-foreground">
          Publish first. The App belongs to the agent.
        </p>
      );
    case "create":
      return (
        <>
          <p className="text-sm">
            Each agent gets its own GitHub App, so its commits, comments and
            pull requests show up as that agent. GitHub asks you to confirm the
            App, then where to install it. Install it on the organization (or
            account) that owns the repositories this agent should work in.
          </p>
          <Button asChild size="sm">
            <a href={createUrl}>Create GitHub App</a>
          </Button>
        </>
      );
    case "install":
      return (
        <>
          <p className="text-sm">
            The App exists but isn&rsquo;t installed anywhere. Install it on the
            organization or account that owns the repositories this agent should
            work in.
          </p>
          {installUrl && (
            <Button asChild size="sm">
              <a href={installUrl} target="_blank" rel="noreferrer">
                Install on GitHub{" "}
                <ExternalLink className="size-3" aria-hidden />
              </a>
            </Button>
          )}
        </>
      );
    case "permissions":
      return (
        <>
          <p className="text-sm">
            This agent&rsquo;s templates need permissions the App doesn&rsquo;t
            have yet: <code>{step.missing.join(", ")}</code>. Add them in the
            App&rsquo;s permission settings, then accept the change on each
            installation.
          </p>
          <div className="flex flex-wrap gap-2">
            {step.settingsUrl && (
              <Button asChild size="sm" variant="outline">
                <a
                  href={`${step.settingsUrl}/permissions`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Edit App permissions{" "}
                  <ExternalLink className="size-3" aria-hidden />
                </a>
              </Button>
            )}
            {step.installations
              .filter((i) => i.missing.length > 0)
              .map((i) => (
                <Button key={i.account} asChild size="sm" variant="outline">
                  <a href={i.htmlUrl} target="_blank" rel="noreferrer">
                    Accept on {i.account}{" "}
                    <ExternalLink className="size-3" aria-hidden />
                  </a>
                </Button>
              ))}
          </div>
        </>
      );
    case "unknown":
      return (
        <p className="text-sm text-muted-foreground">
          GitHub couldn&rsquo;t be reached to check this App ({step.slug}).
          Check again in a moment.
        </p>
      );
    case "ready":
      return (
        <p className="text-sm text-muted-foreground">
          Installed on {step.installations.map((i) => i.account).join(", ")}.{" "}
          {installUrl && (
            <a
              href={installUrl}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              Install on another account or change repositories
            </a>
          )}
        </p>
      );
  }
}

function ConnectionStep({
  step,
  d,
}: {
  step: Extract<SetupStep, { kind: "connection" }>;
  d: LoaderData;
}) {
  if (!step.published)
    return (
      <p className="text-sm text-muted-foreground">
        Publish first. The connection belongs to the agent.
      </p>
    );
  const href =
    `/connections/${encodeURIComponent(step.provider)}/connect` +
    `?project=${encodeURIComponent(d.project.id)}` +
    `&agent=${encodeURIComponent(step.member)}` +
    `&returnTo=${encodeURIComponent(d.setupPath)}`;
  return (
    <Button asChild size="sm">
      <a href={href}>Connect {step.provider}</a>
    </Button>
  );
}

function stepProps(
  provisioner: ProvisionerId,
  d: LoaderData,
  needsUpdate: boolean,
) {
  const view = d.provisioners[provisioner];
  return {
    provisioner,
    details: view?.details ?? null,
    link: view?.link ?? ({ state: "none" } as ConnectionLink),
    busy: BUSY_STATUSES.includes(view?.status ?? ""),
    needsUpdate,
    email: d.email,
    memberNames: d.memberNames,
  };
}

function ProvisionStep({
  step,
  d,
}: {
  step: Extract<SetupStep, { kind: "provision" }>;
  d: LoaderData;
}) {
  const view = d.provisioners[step.provisioner];
  const Install = PROVISIONER_UI[step.provisioner].Install;
  return (
    <>
      {view && (
        <ConnectionLinkPanel
          provisioner={step.provisioner}
          link={view.link}
          options={view.options}
          canLink={d.canLinkConnections}
        />
      )}
      <Install {...stepProps(step.provisioner, d, step.needsUpdate)} />
    </>
  );
}

function ProvisionVerifyStep({
  step,
  d,
}: {
  step: Extract<SetupStep, { kind: "provision-verify" }>;
  d: LoaderData;
}) {
  const Verify = PROVISIONER_UI[step.provisioner].Verify;
  return Verify ? <Verify {...stepProps(step.provisioner, d, false)} /> : null;
}

/** Which workspace connection this team's provisioner uses, and what to do when there's none. */
function ConnectionLinkPanel({
  provisioner,
  link,
  options,
  canLink,
}: {
  provisioner: ProvisionerId;
  link: ConnectionLink;
  options: LinkOption[];
  canLink: boolean;
}) {
  const navigation = useNavigation();
  const provider = SERVICE_PROVIDERS[provisionerDescriptor(provisioner).connectionProvider];
  const name = provider.displayName;
  const chooser = canLink && options.length > 1 && (
    <Form method="post" className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="intent" value="link-connection" />
      <input type="hidden" name="provisioner" value={provisioner} />
      <div className="space-y-1">
        <Label htmlFor={`link-${provisioner}`}>{name} connection</Label>
        <select
          id={`link-${provisioner}`}
          name="connectionId"
          required
          defaultValue={link.state === "ready" || link.state === "reconnect" ? link.connection.id : ""}
          className="rounded border bg-background p-2 text-sm"
        >
          <option value="">Choose connection</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
              {o.status === "active" ? "" : ` (${o.status})`}
            </option>
          ))}
        </select>
      </div>
      <Button size="sm" variant="outline" disabled={navigation.state !== "idle"}>
        Use for this team
      </Button>
    </Form>
  );
  const settingsLink = (label: string) => (
    <Button asChild size="sm" variant="outline">
      <Link to={SETTINGS_CONNECTIONS}>{label}</Link>
    </Button>
  );
  switch (link.state) {
    case "ready":
      return (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Uses the workspace&rsquo;s <strong>{link.connection.label}</strong>{" "}
            {/* A label that already names the provider ("Supabase") would read twice. */}
            {link.connection.label.toLowerCase().includes(name.toLowerCase())
              ? ""
              : `${name} `}
            connection
            {link.linked ? "." : ", the only one in this workspace."}
          </p>
          {chooser}
        </div>
      );
    case "none":
      return (
        <div className="space-y-2">
          <p className="text-sm">
            This step needs a {name} connection.{" "}
            {canLink
              ? `Add one in Settings → Connections; harnesst keeps it encrypted and uses it only for this kind of setup and its updates.`
              : `Ask a workspace owner or admin to add one in Settings → Connections.`}
          </p>
          {canLink && settingsLink(`Add ${name} connection`)}
        </div>
      );
    case "choose":
      return (
        <div className="space-y-2">
          <p className="text-sm">
            This workspace has several {name} connections.{" "}
            {canLink
              ? "Choose the one this team uses."
              : "Ask a workspace owner or admin to choose the one this team uses."}
          </p>
          {chooser}
        </div>
      );
    case "reconnect":
      return (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-destructive">
            Reconnect {name}: the {link.connection.label} connection&rsquo;s token was rejected.
            {canLink
              ? " Replace it in Settings → Connections."
              : " Ask a workspace owner or admin to replace it in Settings → Connections."}
          </p>
          {canLink && settingsLink(`Reconnect ${name}`)}
          {chooser}
        </div>
      );
  }
}
