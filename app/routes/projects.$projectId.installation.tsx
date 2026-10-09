import {
  redirect,
  Form,
  Link,
  useNavigation,
  useRevalidator,
  useFetcher,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import { useEffect, useRef } from "react";
import { getSessionAuth, sessionLoader } from "~/auth/session.server";
import { requireProject } from "~/project/guard.server";
import { listAgents } from "~/db/queries.server";
import { AppShell, PageHeader } from "~/components/shell";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  changeLedgerOrigin,
  connectSupabase,
  getProvisioning,
  privateState,
  savedLedgerInputs,
  startProvisioning,
} from "~/marketplace/provisioning.server";
import {
  ledgerAuthorization,
  prepareLedgerAuthorization,
} from "~/marketplace/ledger-authorization.server";
import { LEDGER_ROLES } from "~/marketplace/provisioning";
import {
  refFromUrl,
  SupabaseManagement,
} from "~/marketplace/supabase-provisioning.server";
import { installLedgerGitHub } from "~/marketplace/ledger-github.server";
import { enqueue } from "~/jobs/queue.server";
import { ensureWorkerStarted } from "~/jobs/worker.server";
import type { Route } from "./+types/projects.$projectId.installation";

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(args, async ({ auth }) => {
    const project = await requireProject(auth, args.params.projectId, {
      request: args.request,
    });
    const [row, saved] = await Promise.all([
      getProvisioning(project.id),
      savedLedgerInputs(project.id),
    ]);
    const state = row ? privateState(row) : {};
    let projects: { id: string; name: string }[] = [];
    let connectionError: string | null = null;
    if (state.token && row?.status !== "running") {
      try {
        projects = (
          await new SupabaseManagement(state.token).call("projects")
        ).map((p: any) => ({ id: p.id, name: p.name }));
      } catch {
        connectionError =
          "Supabase authorization has expired or is unavailable. Reconnect to continue.";
      }
    }
    let savedRef = "";
    try {
      savedRef = saved ? refFromUrl(saved.url) : "";
    } catch {
      /* Show project chooser for malformed saved URL. */
    }
    let mayi: { status: string; label?: string } = { status: "not_installed" };
    try {
      mayi = await ledgerAuthorization(project.id, "status");
    } catch {
      mayi = { status: "unavailable" };
    }
    return {
      mayi,
      project: { id: project.id, name: project.name, slug: project.slug },
      email: auth.user!.email,
      roster: (await listAgents(project.id)).map((a) => a.name),
      projects,
      connectionError,
      connected: !!state.token,
      savedKey: !!saved,
      ref: row?.projectRef ?? savedRef,
      origin: row?.publicOrigin ?? process.env.HARNESST_PUBLIC_ORIGIN ?? "",
      status: row?.status ?? "pending",
      step: row?.step ?? "Connect Supabase",
      error: row?.error,
      members:
        state.members ?? Object.fromEntries(LEDGER_ROLES.map((r) => [r, r])),
    };
  });
export async function action(args: ActionFunctionArgs) {
  const auth = await getSessionAuth(args);
  if (!auth.user) throw redirect("/login");
  const project = await requireProject(auth, args.params.projectId);
  const form = await args.request.formData();
  try {
    if (form.get("intent") === "mayi") {
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
    } else if (form.get("intent") === "connect") {
      await connectSupabase(project.id, String(form.get("token") ?? "").trim());
    } else if (form.get("intent") === "install") {
      const saved = await savedLedgerInputs(project.id);
      const ref = String(form.get("ref") ?? "");
      const enteredKey = String(form.get("publishableKey") ?? "").trim();
      const key =
        enteredKey || (saved && refFromUrl(saved.url) === ref ? saved.key : "");
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
    } else if (form.get("intent") === "origin") {
      await changeLedgerOrigin(project.id, String(form.get("origin") ?? ""));
    } else if (form.get("intent") === "github") {
      const repository = await installLedgerGitHub(
        project.id,
        String(form.get("repository") ?? ""),
      );
      return {
        error: null,
        message: `Ledger automation installed in ${repository}.`,
      };
    } else if (form.get("intent") === "verify") {
      await enqueue(
        "verify_bundle",
        { projectId: project.id, attempt: 0 },
        { maxAttempts: 1 },
      );
      ensureWorkerStarted();
    } else return { error: "Unknown installation action." };
    return { error: null };
  } catch (error) {
    if (error instanceof Response) throw error;
    return {
      error:
        error instanceof Error
          ? error.message
          : "Installation could not start.",
    };
  }
}
export default function Installation({
  loaderData: d,
  actionData,
}: Route.ComponentProps) {
  const mayi = useFetcher<typeof action>();
  const consentTab = useRef<Window | null>(null);
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  useEffect(() => {
    if (mayi.state !== "idle" || !mayi.data) return;
    if ("authorizationUrl" in mayi.data && mayi.data.authorizationUrl) {
      if (consentTab.current && !consentTab.current.closed)
        consentTab.current.location.replace(mayi.data.authorizationUrl);
      revalidator.revalidate();
    } else if (mayi.data.error) consentTab.current?.close();
    // Only handle a newly completed submission; revalidation must not reopen consent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mayi.data, mayi.state]);
  useEffect(() => {
    if (
      !["running", "activating", "provisioned"].includes(d.status) &&
      d.mayi.status !== "authorizing"
    )
      return;
    const timer = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 2000);
    return () => clearInterval(timer);
  }, [d.status, d.mayi.status, revalidator]);
  const busy =
    navigation.state !== "idle" || ["running", "activating"].includes(d.status);
  return (
    <AppShell>
      <PageHeader
        title="Finish bundle installation"
        description={d.project.name}
      />
      <div className="mx-auto max-w-2xl space-y-6 p-6">
        <p>
          Harnesst installs the ledger in your Supabase project, creates team
          identities and stores their credentials. No terminal or agent
          conversation is needed.
        </p>
        <div role="status" className="rounded-lg border p-4">
          <strong>{d.step}</strong>
          {d.status === "provisioned" && (
            <p>
              The database and credentials are installed. Agents still need
              deployment and callback verification before the team is ready.
            </p>
          )}
        </div>
        {(actionData?.error || d.error || d.connectionError) && (
          <p role="alert" className="text-destructive">
            {actionData?.error || d.error || d.connectionError}
          </p>
        )}
        {
          <>
            <Form method="post" className="space-y-3 rounded-lg border p-4">
              <input type="hidden" name="intent" value="connect" />
              <h2 className="font-semibold">
                1. Authorize Supabase installation
              </h2>
              <p>
                Your project’s publishable key cannot create tables or
                functions. Create an access token in{" "}
                <a
                  href="https://supabase.com/dashboard/account/tokens"
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  Supabase account settings
                </a>{" "}
                and enter it here. Harnesst encrypts it, never gives it to
                agents, and removes it after installation and the first May I
                connection succeed.
              </p>
              <Label htmlFor="token">Supabase access token</Label>
              <Input
                id="token"
                name="token"
                type="password"
                autoComplete="off"
                required
                disabled={busy}
              />
              <Button disabled={busy}>
                {d.connected ? "Reconnect Supabase" : "Connect Supabase"}
              </Button>
            </Form>
            {d.connected && !["provisioned", "ready"].includes(d.status) && (
              <Form method="post" className="space-y-4 rounded-lg border p-4">
                <input type="hidden" name="intent" value="install" />
                <h2 className="font-semibold">2. Install ledger</h2>
                <Label htmlFor="ref">Supabase project</Label>
                <select
                  id="ref"
                  name="ref"
                  defaultValue={d.ref}
                  required
                  disabled={busy}
                  className="w-full rounded border bg-background p-2"
                >
                  <option value="">Choose project</option>
                  {d.projects.map((p) => (
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
                    d.savedKey
                      ? "Use saved key for the matching project"
                      : "sb_publishable_…"
                  }
                  required={!d.savedKey}
                  disabled={busy}
                />
                <Label htmlFor="email">
                  Engineering and UAT approver email
                </Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  defaultValue={d.email}
                  required
                  disabled={busy}
                />
                <Label htmlFor="origin">Public harnesst address</Label>
                <Input
                  id="origin"
                  name="origin"
                  type="url"
                  defaultValue={d.origin}
                  placeholder="https://your-harnesst-host"
                  required
                  disabled={busy}
                />
                <p className="text-sm text-muted-foreground">
                  Supabase must reach this address to wake agents. In local
                  development, the harnesst host must have its HTTPS tunnel
                  running.
                </p>
                {LEDGER_ROLES.map((role) => (
                  <div key={role}>
                    <Label htmlFor={`member-${role}`}>{role} team member</Label>
                    <Input
                      id={`member-${role}`}
                      name={`member:${role}`}
                      defaultValue={d.members[role]}
                      list="members"
                      required
                      disabled={busy}
                    />
                  </div>
                ))}
                <datalist id="members">
                  {d.roster.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
                <p className="text-sm">
                  Use a dedicated Supabase project for this team. Installation
                  creates the ledger database objects. Connect May I next to
                  enable human approvals. Retrying preserves existing work and
                  keys.
                </p>
                <Button disabled={busy}>
                  {busy
                    ? "Installing…"
                    : d.status === "failed"
                      ? "Retry installation"
                      : "Install ledger"}
                </Button>
              </Form>
            )}
          </>
        }
        {["provisioned", "ready"].includes(d.status) && (
          <section className="space-y-3 rounded-lg border p-4">
            <h2 className="font-semibold">Connect May I</h2>
            <p>
              Authorize this team to request human approvals. May I controls who
              can approve.
            </p>
            <p role="status">
              {(
                {
                  connected: "Connected",
                  authorizing: "Waiting for authorization…",
                  needs_reconnect: "Reconnect required",
                  not_installed: "Not connected",
                  disconnected: "Not connected",
                  unavailable: "Connection status unavailable",
                } as Record<string, string>
              )[d.mayi.status] ?? d.mayi.status}
            </p>
            <mayi.Form
              method="post"
              onSubmit={() => {
                // Native POST navigations carry Origin:null under our no-referrer
                // policy. Submit with fetch, while opening the tab on the user gesture.
                consentTab.current = window.open("about:blank", "_blank");
                if (consentTab.current) consentTab.current.opener = null;
              }}
            >
              <input type="hidden" name="intent" value="mayi" />
              <Button disabled={busy || mayi.state !== "idle"}>
                {d.mayi.status === "connected" ||
                d.mayi.status === "needs_reconnect"
                  ? "Reconnect May I"
                  : "Connect May I"}
              </Button>
            </mayi.Form>
            {mayi.data?.error && (
              <p role="alert" className="text-destructive">
                {mayi.data.error}
              </p>
            )}
            {mayi.data &&
              "authorizationUrl" in mayi.data &&
              mayi.data.authorizationUrl && (
                <a
                  href={mayi.data.authorizationUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  Open May I authorization
                </a>
              )}
            <p className="text-sm text-muted-foreground">
              Authorization opens in a new tab. Return here afterward.
            </p>
            <Button variant="outline" onClick={() => revalidator.revalidate()}>
              Check connection
            </Button>
          </section>
        )}
        {["provisioned", "ready"].includes(d.status) && (
          <details>
            <summary>Update public address</summary>
            <p>
              Reconnect Supabase above, then enter the new public address.
              Harnesst preserves actor credentials.
            </p>
            <Form method="post" className="space-y-3">
              <input type="hidden" name="intent" value="origin" />
              <Label htmlFor="updated-origin">Public harnesst address</Label>
              <Input
                id="updated-origin"
                name="origin"
                type="url"
                defaultValue={d.origin}
                required
              />
              <Button disabled={busy}>Update address</Button>
            </Form>
          </details>
        )}
        {d.status === "provisioned" && (
          <Form method="post">
            <input type="hidden" name="intent" value="verify" />
            <Button disabled={busy}>Check deployment and callbacks</Button>
          </Form>
        )}
        {["provisioned", "ready"].includes(d.status) && (
          <Form method="post" className="space-y-3 rounded-lg border p-4">
            <input type="hidden" name="intent" value="github" />
            <h2 className="font-semibold">Connect product repository</h2>
            <p>
              Install the ledger workflow and encrypted Actions credentials.
              This creates two files on the repository’s default branch and
              enables automation. Infra’s GitHub App needs Contents, Workflows,
              Secrets and Variables write permissions.
            </p>
            <Label htmlFor="repository">Product repository</Label>
            <Input
              id="repository"
              name="repository"
              placeholder="organization/repository"
              required
            />
            <Button disabled={busy}>Install GitHub automation</Button>
            {actionData && "message" in actionData && (
              <p role="status">{actionData.message}</p>
            )}
          </Form>
        )}
        <Link to={`/repos/${d.project.slug}/deployment`} className="underline">
          Team deployment
        </Link>
      </div>
    </AppShell>
  );
}
