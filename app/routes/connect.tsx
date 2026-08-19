/**
 * Connect pillar (M0): install the GitHub App, pick an eve repo, create a project.
 *
 * Flow:
 *  1. No installation yet -> show "Install on GitHub" with signed, one-use state.
 *  2. Setup callback binds its untrusted installation id, then GitHub user OAuth proves ownership.
 *  3. User submits a repo -> validate it's an eve repo (`agent/` present) -> create project ->
 *     redirect to its read-only view.
 *
 * Set the GitHub App's "Setup URL" to `<host>/connect` so step 2 lands here.
 */
import { getSessionAuth, sessionLoader } from "~/auth/session.server";
import {
  Form,
  Link,
  redirect,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { useState } from "react";
import { Download, FolderGit2, Plug, Plus } from "lucide-react";

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
import { Label } from "~/components/ui/label";
import { createProject } from "~/db/queries.server";
import {
  ensureWorkspace,
  requireBackOfHouse,
  resolveActiveWorkspace,
  type WorkspaceInfo,
} from "~/auth/workspace.server";
import { ensureProjectTeam } from "~/auth/teams.server";
import {
  getGitHubConfig,
  getInstallUrl,
  githubUserAuthorizeUrl,
} from "~/github/client.server";
import { createEveRepo } from "~/github/create.server";
import {
  listKnownInstallations,
  resolveInstallationGrantForOrg,
} from "~/github/installations.server";
import {
  bindGitHubInstallationCandidate,
  createGitHubInstallState,
  pkceChallenge,
  verifyGitHubInstallState,
} from "~/github/install-state.server";
import { warmAgentSource } from "~/github/cached.server";
import {
  fetchAgentSource,
  listInstallationRepos,
  type InstallationRepo,
} from "~/github/repo.server";
import { detectAgentRoots, hasTeamLayout, isEveRepo } from "~/eve/parse";
import { slugifyResourceName } from "~/eve/templates";
import { noindexMeta } from "~/lib/seo";
import { publicOrigin } from "~/lib/ingress";
import type { Route } from "./+types/connect";

type GithubConnectState =
  | { state: "no-org" }
  | { state: "install"; installUrl: string }
  | {
      state: "pick";
      installationGrantId: string;
      repos: InstallationRepo[];
      /** Installation's org/user — prefills "create" even when zero repos are shared. */
      accountLogin: string | null;
      /** Always offered so another GitHub org/account can be added. */
      installUrl: string;
    }
  | { state: "unconfigured"; message: string };

interface ConnectView {
  org: WorkspaceInfo | null;
  github: GithubConnectState;
}

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }): Promise<ConnectView> => {
      // First org-less login: provision the user's workspace and replay (redirect).
      await ensureWorkspace(args.request, auth);
      const active = await resolveActiveWorkspace(auth);
      // Back of house is admin/owner-only (D10); front-of-house members live at `/`.
      if (active) requireBackOfHouse(active, "page");
      const org = active?.org;
      if (!org) return { org: null, github: { state: "no-org" as const } };

      const url = new URL(args.request.url);

      try {
        const fromRedirect = url.searchParams.get("installation_id");
        const setupToken = url.searchParams.get("state");
        if (fromRedirect || setupToken) {
          if (!fromRedirect || !/^\d+$/.test(fromRedirect) || !setupToken) {
            throw new Error(
              "This GitHub setup callback is invalid. Start the installation again from Connect.",
            );
          }
          const state = verifyGitHubInstallState(setupToken);
          if (!state) {
            throw new Error(
              "This GitHub setup link is invalid or expired. Start the installation again from Connect.",
            );
          }
          if (
            state.userId !== auth.user.id ||
            state.sessionId !== auth.session.id
          ) {
            throw new Error(
              "This GitHub installation was started in a different harnesst session. Start again from Connect.",
            );
          }
          if (state.orgId !== org.id || auth.organizationId !== org.id) {
            throw new Error(
              "This GitHub installation was started in a different workspace. Switch back and start again from Connect.",
            );
          }
          const verifier = await bindGitHubInstallationCandidate({
            nonce: state.nonce,
            userId: auth.user.id,
            sessionId: auth.session.id,
            orgId: org.id,
            installationId: fromRedirect,
          });
          if (!verifier) {
            throw new Error(
              "This GitHub setup link is invalid, expired, or has already been used. Start again from Connect.",
            );
          }
          const config = getGitHubConfig();
          throw redirect(
            githubUserAuthorizeUrl({
              clientId: config.clientId,
              state: setupToken,
              redirectUri: `${publicOrigin(args.request)}/github/installations/callback`,
              codeChallenge: pkceChallenge(verifier),
            }),
          );
        }

        const created = await createGitHubInstallState({
          userId: auth.user.id,
          sessionId: auth.session.id,
          orgId: org.id,
        });
        const installUrl = getInstallUrl(created.state);
        const known = await listKnownInstallations(org.id);
        for (const installation of known) {
          try {
            const repos = await listInstallationRepos(installation.grantId);
            return {
              org,
              github: {
                state: "pick" as const,
                installationGrantId: installation.grantId,
                repos,
                accountLogin: installation.accountLogin,
                installUrl,
              },
            };
          } catch {
            // A transient GitHub error must never delete a verified authorization grant.
          }
        }
        return { org, github: { state: "install" as const, installUrl } };
      } catch (error) {
        if (error instanceof Response) throw error;
        return {
          org,
          github: {
            state: "unconfigured" as const,
            message: (error as Error).message,
          },
        };
      }
    },
    { ensureSignedIn: true },
  );

/**
 * Best-effort repo-team creation (FOH D9): `ensureProjectTeam` also runs lazily from the
 * invite action and the FOH loader, so a Better Auth hiccup here must not fail the connect
 * flow the user is mid-way through.
 */
async function ensureRepoTeam(
  orgId: string,
  project: { id: string; name: string; teamId: string | null },
): Promise<void> {
  try {
    await ensureProjectTeam(orgId, project);
  } catch (error) {
    console.warn(
      `[connect] Could not create the repo team for ${project.id} (${(error as Error)?.message ?? "unknown error"}); continuing.`,
    );
  }
}

export async function action(args: ActionFunctionArgs) {
  const auth = await getSessionAuth(args);
  if (!auth.user) throw redirect("/login");

  const active = await resolveActiveWorkspace(auth);
  if (!active)
    return { error: "You must belong to an organization to connect a repo." };
  requireBackOfHouse(active, "api");
  const org = active.org;

  const form = await args.request.formData();
  const installationGrantId = String(form.get("installationGrantId") ?? "");
  if (!installationGrantId)
    return { error: "Missing installation authorization." };
  try {
    await resolveInstallationGrantForOrg(org.id, installationGrantId);
  } catch (error) {
    return { error: (error as Error).message };
  }
  const intent = String(form.get("intent") ?? "connect");

  // ── Create a new repo + scaffold (eve init) ──
  if (intent === "create") {
    const owner = String(form.get("owner") ?? "").trim();
    const name = String(form.get("name") ?? "").trim();
    const layout =
      form.get("layout") === "team" ? ("team" as const) : ("single" as const);
    const agentName =
      layout === "single"
        ? slugifyResourceName(String(form.get("agentName") ?? ""))
        : "";
    if (!owner || !name)
      return { error: "Owner and repository name are required." };
    if (layout === "single" && !agentName)
      return { error: "Agent name is required." };
    try {
      // No model is chosen or baked at creation: the scaffolded agent resolves the
      // workspace's configured model at runtime (Org settings → Default model, or a
      // per-agent override there). An unconfigured workspace gets a readable runtime
      // error pointing at Org settings — configuring it later needs no repo change.
      const repo = await createEveRepo(installationGrantId, {
        owner,
        name,
        layout,
        ...(layout === "single" ? { agentName } : {}),
      });
      const project = await createProject({
        orgId: org.id,
        name,
        repoOwner: repo.owner,
        repoName: repo.repo,
        repoInstallationId: installationGrantId,
        defaultBranch: repo.defaultBranch,
        layout,
        // The scaffold's roster is known without re-reading the repo (§7.9).
        roster: layout === "team" ? [] : [{ name: agentName, root: "agent" }],
      });
      await ensureRepoTeam(org.id, project);
      throw redirect(`/repos/${project.slug}`);
    } catch (error) {
      if (error instanceof Response) throw error;
      return { error: (error as Error).message };
    }
  }

  // ── Connect an existing repo ──
  const owner = String(form.get("owner") ?? "");
  const repo = String(form.get("repo") ?? "");
  const defaultBranch = String(form.get("defaultBranch") ?? "main");
  if (!owner || !repo) return { error: "Missing repo selection." };

  // Re-list server-side: hidden owner/repo fields are untrusted browser input.
  let availableRepos: InstallationRepo[];
  try {
    availableRepos = await listInstallationRepos(installationGrantId);
  } catch (error) {
    return {
      error: `Could not list repositories: ${(error as Error).message}`,
    };
  }
  const selected = availableRepos.find(
    (candidate) => candidate.owner === owner && candidate.repo === repo,
  );
  if (!selected) {
    return {
      error: `${owner}/${repo} is not available through this GitHub installation.`,
    };
  }

  // Validate it's an eve project before we persist anything.
  let source;
  try {
    source = await fetchAgentSource(installationGrantId, { owner, repo });
  } catch (error) {
    return {
      error: `Could not read ${owner}/${repo}: ${(error as Error).message}`,
    };
  }
  if (!isEveRepo(source.paths)) {
    return {
      error: `${owner}/${repo} doesn't look like an eve project — no \`agent/\` directory, agents, or \`agents/README.md\` empty-team marker found.`,
    };
  }

  const project = await createProject({
    orgId: org.id,
    name: repo,
    repoOwner: owner,
    repoName: repo,
    repoInstallationId: installationGrantId,
    defaultBranch: source.ref || selected.defaultBranch || defaultBranch,
    layout: hasTeamLayout(source.paths) ? "team" : "single",
    // Detected roster: one member per agent root (single repos are a team of one).
    roster: detectAgentRoots(source.paths).map((r) => ({
      name: r.name,
      root: r.root,
    })),
  });

  await ensureRepoTeam(org.id, project);

  // We just read the source to validate — warm the cache so the first project load is instant.
  warmAgentSource(installationGrantId, { owner, repo }, source);

  throw redirect(`/repos/${project.slug}`);
}

export function meta() {
  return [{ title: "New repository · harnesst" }, ...noindexMeta];
}

export default function Connect({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { org, github } = loaderData;
  const navigation = useNavigation();
  // Busy is per-FORM, not global: only the clicked button changes label, and it stays busy
  // through the whole navigation (action + redirect + next page's loader) — the redirect
  // target reads the repo from GitHub, which takes a beat; going idle early reads as broken.
  const busyData = navigation.state !== "idle" ? navigation.formData : null;
  const busyIntent = busyData
    ? String(busyData.get("intent") ?? "connect")
    : null;
  const busyRepo = busyData
    ? `${busyData.get("owner")}/${busyData.get("repo")}`
    : null;
  const [layout, setLayout] = useState<"single" | "team">("single");

  return (
    <AppShell>
      <PageHeader
        icon={Plug}
        accent="brand"
        title="New repository"
        description="A repository holds one agent or a team of agents. Connect an existing repo, or scaffold a fresh one."
        actions={
          <Button variant="ghost" asChild>
            <Link to="/dashboard">← Back</Link>
          </Button>
        }
      />

      {actionData?.error && (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>Couldn&rsquo;t connect</AlertTitle>
          <AlertDescription>{actionData.error}</AlertDescription>
        </Alert>
      )}

      {github.state === "unconfigured" && (
        <Alert className="mb-6">
          <AlertTitle>GitHub connection unavailable</AlertTitle>
          <AlertDescription>{github.message}</AlertDescription>
        </Alert>
      )}

      {github.state === "install" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Download
                className={`size-4 shrink-0 ${accentText.brand}`}
                aria-hidden
              />
              Install the GitHub App
            </CardTitle>
            <CardDescription>
              Install harnesst on the account that owns your eve repository,
              then pick the repo to connect. You control which repositories it
              can access — selecting none is fine too, if you only want harnesst
              to create new repos for you.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <a href={github.installUrl}>Install on GitHub</a>
            </Button>
          </CardContent>
        </Card>
      )}

      {github.state === "pick" && (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FolderGit2
                  className={`size-4 shrink-0 ${accentText.brand}`}
                  aria-hidden
                />
                Connect an existing repository
              </CardTitle>
              <CardDescription>
                Repositories the GitHub App can access. harnesst validates that
                the repo is an eve project before connecting.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {github.repos.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No repositories are shared with the app yet — that&rsquo;s
                  fine if you only want harnesst to create repos for you. Create
                  a new repository below, or{" "}
                  <a
                    href={github.installUrl}
                    className="font-medium underline underline-offset-4"
                  >
                    grant the app access
                  </a>{" "}
                  to an existing eve repo on GitHub.
                </p>
              ) : (
                <ul className="divide-y rounded-lg border">
                  {github.repos.map((r) => (
                    <li
                      key={r.fullName}
                      className="flex items-center justify-between gap-3 px-4 py-3"
                    >
                      <div className="flex items-center gap-2 truncate">
                        <span className="truncate font-mono text-sm">
                          {r.fullName}
                        </span>
                        {r.private && (
                          <Badge variant="secondary" className="text-xs">
                            private
                          </Badge>
                        )}
                      </div>
                      <Form method="post">
                        <input
                          type="hidden"
                          name="installationGrantId"
                          value={github.installationGrantId}
                        />
                        <input type="hidden" name="owner" value={r.owner} />
                        <input type="hidden" name="repo" value={r.repo} />
                        <input
                          type="hidden"
                          name="defaultBranch"
                          value={r.defaultBranch}
                        />
                        <Button
                          size="sm"
                          variant="secondary"
                          type="submit"
                          disabled={busyData != null}
                        >
                          {busyIntent === "connect" && busyRepo === r.fullName
                            ? "Connecting…"
                            : "Connect"}
                        </Button>
                      </Form>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Plus
                  className={`size-4 shrink-0 ${accentText.emerald}`}
                  aria-hidden
                />
                Create a new repository
              </CardTitle>
              <CardDescription>
                Creates a repository in your organization and scaffolds it — a
                single agent (<span className="font-mono">agent/</span>) or a
                team of agents (
                <span className="font-mono">agents/&lt;name&gt;/agent/</span>
                ).
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Form method="post" className="space-y-4">
                <input type="hidden" name="intent" value="create" />
                <input
                  type="hidden"
                  name="installationGrantId"
                  value={github.installationGrantId}
                />
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-4 has-[:checked]:border-primary has-[:checked]:bg-muted/40">
                    <input
                      type="radio"
                      name="layout"
                      value="single"
                      checked={layout === "single"}
                      onChange={() => setLayout("single")}
                      className="mt-1 accent-primary"
                    />
                    <span>
                      <span className="block text-sm font-medium">
                        Single agent
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        One agent, one runtime. The repo root holds{" "}
                        <span className="font-mono">agent/</span>.
                      </span>
                    </span>
                  </label>
                  <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-4 has-[:checked]:border-primary has-[:checked]:bg-muted/40">
                    <input
                      type="radio"
                      name="layout"
                      value="team"
                      checked={layout === "team"}
                      onChange={() => setLayout("team")}
                      className="mt-1 accent-primary"
                    />
                    <span>
                      <span className="block text-sm font-medium">Team</span>
                      <span className="block text-xs text-muted-foreground">
                        A monorepo of agents under{" "}
                        <span className="font-mono">agents/</span> — each agent
                        has its own runtime, channels, schedules, and secrets.
                      </span>
                    </span>
                  </label>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="name">Repository name</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="owner"
                      name="owner"
                      aria-label="GitHub organization"
                      defaultValue={
                        github.accountLogin ?? github.repos[0]?.owner ?? ""
                      }
                      placeholder="org"
                      className="w-full min-w-0 sm:w-40"
                    />
                    <span className="text-muted-foreground">/</span>
                    <Input
                      id="name"
                      name="name"
                      placeholder={layout === "team" ? "my-team" : "my-agent"}
                      className="w-full min-w-0 font-mono sm:w-56"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Created on GitHub as{" "}
                    <span className="font-mono">
                      {github.accountLogin ?? github.repos[0]?.owner ?? "org"}/
                      {layout === "team" ? "my-team" : "my-agent"}
                    </span>
                    .
                  </p>
                </div>
                {layout === "single" && (
                  <div className="space-y-1.5">
                    <Label htmlFor="agentName">Agent's name</Label>
                    <Input
                      id="agentName"
                      name="agentName"
                      placeholder="product-manager"
                      className="w-full font-mono sm:w-72"
                    />
                    <p className="text-xs text-muted-foreground">
                      Your agent's name. Its code lives at{" "}
                      <span className="font-mono">agent/</span> in the
                      repository.
                    </p>
                  </div>
                )}
                <Button type="submit" disabled={busyData != null}>
                  {busyIntent === "create"
                    ? "Creating & opening…"
                    : "Create & scaffold"}
                </Button>
              </Form>
            </CardContent>
          </Card>

          <p className="text-sm text-muted-foreground">
            Missing a repository?{" "}
            <a
              href={github.installUrl}
              className="font-medium underline underline-offset-4"
            >
              Install the GitHub App on another organization
            </a>{" "}
            or grant it access to more repos.
          </p>
        </div>
      )}
    </AppShell>
  );
}
