import { Bot, FolderGit2, Users } from "lucide-react";
import {
  data,
  Link,
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { sessionLoader } from "~/auth/session.server";
import { listAccessibleProjectIds } from "~/auth/project-access.server";
import {
  ensureWorkspace,
  isWorkspaceAdmin,
  resolveActiveWorkspace,
} from "~/auth/workspace.server";
import { AppShell, PageHeader, accentText } from "~/components/shell";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { listAgents, listProjects, type Project } from "~/db/queries.server";
import { auth } from "~/lib/auth.server";
import { noindexMeta } from "~/lib/seo";
import type { Route } from "./+types/dashboard";

/** A project annotated with its roster, so the dashboard can split teams from agents. */
interface ProjectCard {
  project: Project;
  /** Member names; `isTeam` when the repo uses the agents/* layout (PRD §7.9). */
  members: string[];
  isTeam: boolean;
}

// `ensureSignedIn: true` redirects anonymous visitors to the local sign-in. The inner
// loader only runs for authenticated users, so `auth` is always populated here.
export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }) => {
      // First org-less login: provision the user's workspace and replay (redirect).
      await ensureWorkspace(args.request, auth);
      const active = await resolveActiveWorkspace(auth);
      const org = active?.org ?? null;
      // The build surface lists the repos the viewer can WRITE to. Owners hold every repo;
      // everyone else (admins included) only the ones they were granted.
      const writable = active
        ? new Set(
            await listAccessibleProjectIds(
              {
                userId: auth.user.id,
                workspaceRole: active.member.role,
                orgId: active.org.id,
              },
              "write",
            ),
          )
        : new Set<string>();
      const canCreate = active ? isWorkspaceAdmin(active.member.role) : false;
      const projects = org
        ? (await listProjects(org.id)).filter((project) => writable.has(project.id))
        : [];
      const cards: ProjectCard[] = await Promise.all(
        projects.map(async (project) => {
          const roster = await listAgents(project.id);
          return {
            project,
            members: roster.map((a) => a.name),
            isTeam: project.layout === "team",
          };
        }),
      );
      return { org, cards, canCreate };
    },
    { ensureSignedIn: true },
  );

export async function action({ request }: ActionFunctionArgs) {
  // Only an explicit sign-out submission may end the session — a future same-origin form that
  // happens to POST to /dashboard must not sign the user out as a side effect.
  const form = await request.formData();
  if (String(form.get("intent") ?? "") !== "sign-out") {
    return data("Unknown action.", { status: 400 });
  }
  const response = await auth.api.signOut({
    headers: request.headers,
    asResponse: true,
  });
  return redirect("/", { headers: response.headers });
}

export function meta() {
  return [{ title: "Repositories · harnesst" }, ...noindexMeta];
}

export default function Dashboard({ loaderData }: Route.ComponentProps) {
  const { user, cards, canCreate } = loaderData;
  const teams = cards.filter((c) => c.isTeam);
  const singles = cards.filter((c) => !c.isTeam);

  return (
    <AppShell userEmail={user.email}>
      <PageHeader
        icon={FolderGit2}
        accent="brand"
        title="Repositories"
        description="A repository holds one agent, or a team of agents that work together."
        actions={
          canCreate ? (
            <Button asChild>
              <Link to="/connect">New repository</Link>
            </Button>
          ) : null
        }
      />

      {cards.length === 0 ? (
        <Card className="border-dashed">
          <CardHeader className="items-center py-12 text-center">
            <div className="mx-auto mb-1 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
              <FolderGit2 className="size-6" aria-hidden />
            </div>
            <CardTitle className="text-lg">No repositories yet</CardTitle>
            <CardDescription>
              {canCreate
                ? "Connect an existing eve repository or create a new one to get started."
                : "Ask a workspace admin to give you write access to a repository."}
            </CardDescription>
            {canCreate && (
              <Button asChild className="mt-4">
                <Link to="/connect">Connect a repository</Link>
              </Button>
            )}
          </CardHeader>
        </Card>
      ) : (
        <div className="space-y-8">
          {teams.length > 0 && (
            <section>
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
                <Users
                  className={`h-4 w-4 ${accentText.emerald}`}
                  aria-hidden
                />{" "}
                Teams
              </h2>
              <div className="grid gap-4 sm:grid-cols-2">
                {teams.map((c) => (
                  <TeamCard key={c.project.id} card={c} />
                ))}
              </div>
            </section>
          )}
          {singles.length > 0 && (
            <section>
              {teams.length > 0 && (
                <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
                  <Bot className={`h-4 w-4 ${accentText.brand}`} aria-hidden />{" "}
                  Agents
                </h2>
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                {singles.map((c) => (
                  <AgentCard key={c.project.id} project={c.project} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </AppShell>
  );
}

/** A team: multiple agents sharing one repository under the agents/* layout. */
export function TeamCard({ card }: { card: ProjectCard }) {
  const { project, members } = card;
  return (
    <Link to={`/repos/${project.slug}`} className="group">
      <Card className="h-full border-primary/20 transition-colors group-hover:border-ring/60">
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 truncate text-base">
              <Users
                className={`h-4 w-4 shrink-0 ${accentText.emerald}`}
                aria-hidden
              />
              {project.name}
            </CardTitle>
            <Badge className="shrink-0">
              Team · {members.length} agent{members.length === 1 ? "" : "s"}
            </Badge>
          </div>
          <CardDescription className="truncate">
            {project.repoOwner ? (
              <>
                <span className="font-mono">
                  {project.repoOwner}/{project.repoName}
                </span>
                {" · "}
                <span className="font-mono">{project.defaultBranch}</span>
              </>
            ) : (
              <>
                No repository linked ·{" "}
                <span className="font-mono">{project.defaultBranch}</span>
              </>
            )}
          </CardDescription>
        </CardHeader>
      </Card>
    </Link>
  );
}

function AgentCard({ project }: { project: Project }) {
  return (
    <Link to={`/repos/${project.slug}`} className="group">
      <Card className="h-full transition-colors group-hover:border-ring/60">
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 truncate text-base">
              <Bot
                className={`h-4 w-4 shrink-0 ${accentText.brand}`}
                aria-hidden
              />
              {project.name}
            </CardTitle>
            {project.repoOwner ? (
              <Badge variant="secondary" className="shrink-0 font-mono text-xs">
                {project.repoOwner}/{project.repoName}
              </Badge>
            ) : (
              <Badge variant="outline" className="shrink-0">
                no repo
              </Badge>
            )}
          </div>
          <CardDescription>
            Default branch{" "}
            <span className="font-mono">{project.defaultBranch}</span>
          </CardDescription>
        </CardHeader>
      </Card>
    </Link>
  );
}
