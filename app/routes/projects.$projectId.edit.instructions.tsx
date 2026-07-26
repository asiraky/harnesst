/**
 * Structured editor: agent instructions (Author pillar, M1).
 *
 * Save writes a draft (refresh-proof, no git write) and does nothing else; the header Publish
 * control takes every saved change live in one action (issue #225). The loader overlays any
 * saved draft over the repo content.
 */
import { getSessionAuth, sessionLoader } from "~/auth/session.server";
import { FileText } from "lucide-react";
import { useState } from "react";
import {
  Link,
  data,
  redirect,
  useNavigation,
  useSubmit,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { CodeEditor } from "~/components/code-editor";
import { FileStateBanner } from "~/components/file-state-banner";
import { AgentNav, AppShell, PageHeader, repoCrumbs } from "~/components/shell";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { resolveActiveWorkspace } from "~/auth/workspace.server";
import { getProject } from "~/db/queries.server";
import { requireProject, requireRepo } from "~/project/guard.server";
import { resolveFileView, stageDraft } from "~/drafts/drafts.server";
import { contextPath } from "~/lib/paths";
import {
  agentFromParams,
  agentParamRedirect,
  requireActiveAgent,
  resolveAgentContext,
} from "~/project/agent-context.server";
import type { Route } from "./+types/projects.$projectId.edit.instructions";

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }) => {
      // Passing the request opts into cross-workspace deep-link auto-switch + org-less
      // provisioning (issue #56); requireRepo narrows to a connected repo as before.
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
      const { roster, active, isTeam } = await resolveAgentContext(
        project.id,
        agentName,
      );
      requireActiveAgent(active, project.id);
      const path = `${active.root}/instructions.md`;

      // Show the latest intended value: saved draft → repo.
      const view = await resolveFileView(
        {
          id: project.id,
          repoInstallationId: project.repoInstallationId,
          repoOwner: project.repoOwner,
          repoName: project.repoName,
        },
        path,
      );

      return {
        project,
        path,
        roster: roster.map((a) => ({ name: a.name })),
        activeAgent: active.name,
        isTeam,
        instructions: view.content ?? "",
        source: view.source,
        stagedDeletion: view.stagedDeletion,
      };
    },
    { ensureSignedIn: true },
  );

export async function action(args: ActionFunctionArgs) {
  const auth = await getSessionAuth(args);
  if (!auth.user) throw redirect("/login");

  const activeWorkspace = await resolveActiveWorkspace(auth);
  const org = activeWorkspace?.org;
  if (!org) return { error: "You must belong to an organization." };

  const project = await getProject(org.id, args.params.projectId!);
  if (!project?.repoInstallationId || !project.repoOwner || !project.repoName) {
    return { error: "Project has no connected repo." };
  }

  const form = await args.request.formData();
  const content = String(form.get("content") ?? "");
  const { active } = await resolveAgentContext(
    project.id,
    String(form.get("agent") ?? "") || null,
  );
  requireActiveAgent(active, project.id);

  try {
    await stageDraft({
      projectId: project.id,
      path: `${active.root}/instructions.md`,
      content,
      createdBy: auth.user.id,
    });
    return { ok: true as const };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

export function meta() {
  return [{ title: "Edit instructions · harnesst" }];
}

export default function EditInstructions({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const {
    project,
    path,
    roster,
    activeAgent,
    isTeam,
    instructions,
    source,
  } = loaderData;
  const navigation = useNavigation();
  const submit = useSubmit();
  const saving = navigation.state !== "idle";
  const [value, setValue] = useState(instructions);

  // Back to the member's overview on teams; the repo overview on single-agent repos.
  const ctx = contextPath(project.id, isTeam ? activeAgent : null);

  return (
    <AppShell
      breadcrumbs={repoCrumbs({
        projectId: project.id,
        repoName: project.name,
        isTeam,
        agentName: activeAgent,
        tail: [{ label: "Instructions" }],
      })}
    >
      <AgentNav
        base={ctx}
        level={isTeam ? "member" : "single"}
        roster={roster}
        activeAgent={isTeam ? activeAgent : undefined}
      />
      <PageHeader
        icon={FileText}
        accent="blue"
        title={
          isTeam ? `Edit instructions — ${activeAgent}` : "Edit instructions"
        }
        description="Save keeps the change here until you publish — the Publish button in the header takes everything you've saved live."
      />

      {actionData?.error && (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>Couldn&rsquo;t save the change</AlertTitle>
          <AlertDescription>{actionData.error}</AlertDescription>
        </Alert>
      )}

      <FileStateBanner
        saved={!!actionData?.ok}
        source={source}
        stagedDeletion={loaderData.stagedDeletion}
      />

      <CodeEditor path={path} value={value} onChange={setValue} />
      <div className="mt-4 flex items-center gap-3">
        <Button
          onClick={() =>
            submit({ content: value, agent: activeAgent }, { method: "post" })
          }
          disabled={saving}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button variant="ghost" asChild>
          <Link to={ctx}>Cancel</Link>
        </Button>
      </div>
    </AppShell>
  );
}
