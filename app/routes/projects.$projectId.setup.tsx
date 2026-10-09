/**
 * The setup wizard: one page per repo that walks through everything installed templates still
 * need: secrets, the ledger database, publishing, each agent's GitHub App, OAuth connections,
 * May I approvals and wake verification. Same page whether one skill was installed into one
 * agent (`?member=`) or a whole team.
 *
 * The steps are derived from real state on every load (setup.server.ts → setup-plan.ts), so there
 * is no wizard progress to lose: leave for GitHub or Supabase, come back, and the next step is
 * whatever is still missing. Settings remain the place to change things later.
 */
import { CheckCircle2, Circle, ExternalLink } from "lucide-react";
import { useEffect, useRef } from "react";
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
import { AppShell, PageHeader } from "~/components/shell";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { appInstallUrl } from "~/github/app-manifest.server";
import { enqueue } from "~/jobs/queue.server";
import { ensureWorkerStarted } from "~/jobs/worker.server";
import { contextPath } from "~/lib/paths";
import {
  ledgerAuthorization,
  prepareLedgerAuthorization,
} from "~/marketplace/ledger-authorization.server";
import { teamRoster } from "~/marketplace/lock";
import { LEDGER_ROLES } from "~/marketplace/provisioning";
import {
  changeLedgerOrigin,
  connectSupabase,
  getProvisioning,
  privateState,
  savedLedgerInputs,
  startProvisioning,
} from "~/marketplace/provisioning.server";
import { answerSecretStep, loadSetup } from "~/marketplace/setup.server";
import type { SetupStep } from "~/marketplace/setup-plan";
import {
  refFromUrl,
  SupabaseManagement,
} from "~/marketplace/supabase-provisioning.server";
import { requireProject, requireRepo } from "~/project/guard.server";
import type { Route } from "./+types/projects.$projectId.setup";

async function ledgerDetails(
  projectId: string,
  rosterDefaults: Record<string, string>,
) {
  const [row, saved] = await Promise.all([
    getProvisioning(projectId),
    savedLedgerInputs(projectId),
  ]);
  if (!row) return null;
  const state = privateState(row);
  let projects: { id: string; name: string }[] = [];
  let connectionError: string | null = null;
  if (state.token && row.status !== "running") {
    try {
      projects = (
        await new SupabaseManagement(state.token).call("projects")
      ).map((p: { id: string; name: string }) => ({ id: p.id, name: p.name }));
    } catch {
      connectionError =
        "Supabase authorization has expired or is unavailable. Reconnect to continue.";
    }
  }
  let savedRef = "";
  try {
    savedRef = saved ? refFromUrl(saved.url) : "";
  } catch {
    /* Show the project chooser for a malformed saved URL. */
  }
  return {
    projects,
    connectionError,
    connected: !!state.token,
    savedKey: !!saved,
    ref: row.projectRef ?? savedRef,
    origin: row.publicOrigin ?? process.env.HARNESST_PUBLIC_ORIGIN ?? "",
    status: row.status,
    step: row.step ?? "Connect Supabase",
    error: row.error,
    members: state.members ?? rosterDefaults,
  };
}

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(args, async ({ auth }) => {
    const project = requireRepo(
      await requireProject(auth, args.params.projectId, {
        request: args.request,
      }),
    );
    const url = new URL(args.request.url);
    const member = url.searchParams.get("member");
    const setup = await loadSetup(project, { member });

    // Ledger roles default to the team install's role → member map, else to the role names.
    const roster = teamRoster(setup.lock)?.roster ?? [];
    const rosterDefaults = Object.fromEntries(
      LEDGER_ROLES.map((role) => [
        role,
        roster.find((r) => r.role === role)?.member ?? role,
      ]),
    );
    const ledger = setup.input.ledger
      ? await ledgerDetails(project.id, rosterDefaults)
      : null;
    return {
      project: { id: project.id, name: project.name, slug: project.slug },
      member,
      isTeam: setup.isTeam,
      plan: setup.plan,
      memberNames: setup.members.map((m) => m.name),
      ledger,
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
  const project = requireRepo(
    await requireProject(auth, args.params.projectId),
  );
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
      case "connect":
        await connectSupabase(
          project.id,
          String(form.get("token") ?? "").trim(),
        );
        return { error: null };
      case "install": {
        const saved = await savedLedgerInputs(project.id);
        const ref = String(form.get("ref") ?? "");
        const enteredKey = String(form.get("publishableKey") ?? "").trim();
        const key =
          enteredKey ||
          (saved && refFromUrl(saved.url) === ref ? saved.key : "");
        await startProvisioning({
          projectId: project.id,
          ref,
          publishableKey: key,
          email: String(form.get("email") ?? ""),
          origin: String(form.get("origin") ?? ""),
          members: Object.fromEntries(
            LEDGER_ROLES.map((r) => [r, String(form.get(`member:${r}`) ?? "")]),
          ),
        });
        ensureWorkerStarted();
        return { error: null };
      }
      case "origin":
        await changeLedgerOrigin(project.id, String(form.get("origin") ?? ""));
        return { error: null };
      case "mayi": {
        const row = await getProvisioning(project.id);
        if (
          !row ||
          !privateState(row).mayiComponentsReady ||
          form.get("prepare") === "true"
        )
          await prepareLedgerAuthorization(project.id);
        const result = await ledgerAuthorization(
          project.id,
          "start",
          `HARNESST — ${project.name}`.slice(0, 100),
        );
        return { error: null, authorizationUrl: result.url as string };
      }
      case "verify":
        await enqueue(
          "verify_bundle",
          { projectId: project.id, attempt: 0 },
          { maxAttempts: 1 },
        );
        ensureWorkerStarted();
        return { error: null };
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

const MAYI_LABEL: Record<string, string> = {
  connected: "Connected",
  authorizing: "Waiting for authorization…",
  needs_reconnect: "Reconnect required",
  not_installed: "Not connected",
  disconnected: "Not connected",
  unavailable: "Connection status unavailable",
};

function stepTitle(step: SetupStep): string {
  switch (step.kind) {
    case "secret":
      return `Set ${step.name}`;
    case "ledger":
      return "Install the ledger database";
    case "publish":
      return "Publish";
    case "github-app":
      return `GitHub App for ${step.member}`;
    case "connection":
      return `Connect ${step.provider} for ${step.member}`;
    case "mayi":
      return "Connect May I approvals";
    case "wakes":
      return "Check deployment and callbacks";
  }
}

export default function Setup({
  loaderData: d,
  actionData,
}: Route.ComponentProps) {
  const revalidator = useRevalidator();
  const ledgerBusy = ["running", "activating"].includes(d.ledger?.status ?? "");
  const waitingOnMayi = d.plan.steps.some(
    (s) => s.kind === "mayi" && s.status === "authorizing",
  );
  const ledgerPolling = ["running", "activating", "provisioned"].includes(
    d.ledger?.status ?? "",
  );

  // Poll while the ledger installs or May I waits; re-check on focus so returning from GitHub,
  // Supabase or an OAuth tab shows the new state without a manual refresh.
  useEffect(() => {
    if (!ledgerPolling && !waitingOnMayi) return;
    const timer = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 2000);
    return () => clearInterval(timer);
  }, [ledgerPolling, waitingOnMayi, revalidator]);
  useEffect(() => {
    const onFocus = () => {
      if (revalidator.state === "idle") revalidator.revalidate();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [revalidator]);

  const { plan } = d;
  return (
    <AppShell>
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
        {plan.total === 0 || plan.next === null ? (
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
                step.kind === "ledger" ||
                step.kind === "github-app") && (
                <div className="mt-3 space-y-3">
                  <StepBody step={step} d={d} busy={ledgerBusy} />
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

function StepBody({
  step,
  d,
  busy,
}: {
  step: SetupStep;
  d: LoaderData;
  busy: boolean;
}) {
  switch (step.kind) {
    case "secret":
      return <SecretStep step={step} d={d} />;
    case "ledger":
      return <LedgerStep d={d} busy={busy} />;
    case "publish":
      return <PublishStep step={step} />;
    case "github-app":
      return <GitHubStep step={step} d={d} />;
    case "connection":
      return <ConnectionStep step={step} d={d} />;
    case "mayi":
      return <MayIStep status={step.status} busy={busy} />;
    case "wakes":
      return <WakesStep d={d} busy={busy} />;
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
      <Input
        id={`secret-${step.name}`}
        name="value"
        type="password"
        autoComplete="off"
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

function LedgerStep({ d, busy }: { d: LoaderData; busy: boolean }) {
  const navigation = useNavigation();
  const l = d.ledger;
  if (!l) return null;
  const disabled = busy || navigation.state !== "idle";
  const installed = ["provisioned", "ready"].includes(l.status);
  return (
    <>
      <p role="status" className="text-sm">
        <strong>{l.step}</strong>
      </p>
      {(l.error || l.connectionError) && (
        <p role="alert" className="text-sm text-destructive">
          {l.error || l.connectionError}
        </p>
      )}
      {!installed && (
        <Form method="post" className="space-y-2">
          <input type="hidden" name="intent" value="connect" />
          <p className="text-sm">
            The ledger is the team&rsquo;s work tracker, in a Supabase project
            you own. Create an access token in{" "}
            <a
              href="https://supabase.com/dashboard/account/tokens"
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              Supabase account settings
            </a>{" "}
            and enter it here. Harnesst encrypts it, never gives it to agents,
            and removes it after installation and the first May I connection
            succeed.
          </p>
          <Label htmlFor="token">Supabase access token</Label>
          <Input
            id="token"
            name="token"
            type="password"
            autoComplete="off"
            required
            disabled={disabled}
          />
          <Button size="sm" disabled={disabled}>
            {l.connected ? "Reconnect Supabase" : "Connect Supabase"}
          </Button>
        </Form>
      )}
      {l.connected && !installed && (
        <Form method="post" className="space-y-2">
          <input type="hidden" name="intent" value="install" />
          <Label htmlFor="ref">Supabase project</Label>
          <select
            id="ref"
            name="ref"
            defaultValue={l.ref}
            required
            disabled={disabled}
            className="w-full rounded border bg-background p-2"
          >
            <option value="">Choose project</option>
            {l.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.id})
              </option>
            ))}
          </select>
          <Label htmlFor="publishableKey">Project publishable key</Label>
          <Input
            id="publishableKey"
            name="publishableKey"
            type="password"
            autoComplete="off"
            placeholder={
              l.savedKey
                ? "Use saved key for the matching project"
                : "sb_publishable_…"
            }
            required={!l.savedKey}
            disabled={disabled}
          />
          <Label htmlFor="email">Engineering and UAT approver email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            defaultValue={d.email}
            required
            disabled={disabled}
          />
          <Label htmlFor="origin">Public harnesst address</Label>
          <Input
            id="origin"
            name="origin"
            type="url"
            defaultValue={l.origin}
            placeholder="https://your-harnesst-host"
            required
            disabled={disabled}
          />
          <p className="text-sm text-muted-foreground">
            Supabase must reach this address to wake agents. In local
            development, the harnesst host must have its HTTPS tunnel running.
          </p>
          {LEDGER_ROLES.map((role) => (
            <div key={role}>
              <Label htmlFor={`member-${role}`}>{role} agent</Label>
              <Input
                id={`member-${role}`}
                name={`member:${role}`}
                defaultValue={l.members[role]}
                list="setup-members"
                required
                disabled={disabled}
              />
            </div>
          ))}
          <datalist id="setup-members">
            {d.memberNames.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          <p className="text-sm text-muted-foreground">
            Use a dedicated Supabase project for this team. Retrying preserves
            existing work and keys.
          </p>
          <Button size="sm" disabled={disabled}>
            {disabled
              ? "Installing…"
              : l.status === "failed"
                ? "Retry installation"
                : "Install ledger"}
          </Button>
        </Form>
      )}
      {installed && (
        <details className="text-sm">
          <summary>Update public address</summary>
          <p className="mt-2">
            Reconnect Supabase first if its token was removed, then enter the
            new address. Harnesst preserves actor credentials.
          </p>
          <Form method="post" className="mt-2 space-y-2">
            <input type="hidden" name="intent" value="origin" />
            <Label htmlFor="updated-origin">Public harnesst address</Label>
            <Input
              id="updated-origin"
              name="origin"
              type="url"
              defaultValue={l.origin}
              required
            />
            <Button size="sm" disabled={disabled}>
              Update address
            </Button>
          </Form>
        </details>
      )}
    </>
  );
}

function MayIStep({ status, busy }: { status: string; busy: boolean }) {
  const mayi = useFetcher<{
    error: string | null;
    authorizationUrl?: string;
  }>();
  const consentTab = useRef<Window | null>(null);
  const revalidator = useRevalidator();
  useEffect(() => {
    if (mayi.state !== "idle" || !mayi.data) return;
    if (mayi.data.authorizationUrl) {
      if (consentTab.current && !consentTab.current.closed)
        consentTab.current.location.replace(mayi.data.authorizationUrl);
      revalidator.revalidate();
    } else if (mayi.data.error) consentTab.current?.close();
    // Only handle a newly completed submission; revalidation must not reopen consent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mayi.data, mayi.state]);
  return (
    <>
      <p className="text-sm">
        Agents ask a human before risky steps (merging, production deploys). May
        I delivers those requests and controls who can approve. Status:{" "}
        {MAYI_LABEL[status] ?? status}.
      </p>
      <mayi.Form
        method="post"
        onSubmit={() => {
          // Native POST navigations carry Origin:null under our no-referrer policy. Submit with
          // fetch, while opening the tab on the user gesture.
          consentTab.current = window.open("about:blank", "_blank");
          if (consentTab.current) consentTab.current.opener = null;
        }}
      >
        <input type="hidden" name="intent" value="mayi" />
        <Button size="sm" disabled={busy || mayi.state !== "idle"}>
          {status === "needs_reconnect" ? "Reconnect May I" : "Connect May I"}
        </Button>
      </mayi.Form>
      {mayi.data?.error && (
        <p role="alert" className="text-sm text-destructive">
          {mayi.data.error}
        </p>
      )}
      {mayi.data?.authorizationUrl && (
        <a
          href={mayi.data.authorizationUrl}
          target="_blank"
          rel="noreferrer"
          className="text-sm underline"
        >
          Open May I authorization
        </a>
      )}
    </>
  );
}

function WakesStep({ d, busy }: { d: LoaderData; busy: boolean }) {
  const navigation = useNavigation();
  if (d.ledger?.status !== "provisioned")
    return (
      <p className="text-sm text-muted-foreground">
        Available once the ledger is installed and the agents are published.
      </p>
    );
  return (
    <Form method="post" className="space-y-2">
      <input type="hidden" name="intent" value="verify" />
      <p className="text-sm">
        Checks that every agent is deployed and that the ledger can wake each of
        them.
      </p>
      <Button size="sm" disabled={busy || navigation.state !== "idle"}>
        Check deployment and callbacks
      </Button>
    </Form>
  );
}
