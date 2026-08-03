/**
 * Structured editor: agent instructions (Author pillar, M1).
 *
 * Save writes a draft (refresh-proof, no git write) and does nothing else; the header Publish
 * control takes every saved change live in one action (issue #225). The loader overlays any
 * saved draft over the repo content.
 *
 * The file edited is `<target root>/instructions.md`, where the target is whatever the URL names
 * — a member, or a declared subagent under `/sub/:subPath` (issue #344). Loader AND action derive
 * it the same way: the action no longer trusts a posted `agent` field, which would have let one
 * member's page overwrite another's instructions.
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
import { requireProject, requireRepo } from "~/project/guard.server";
import { resolveFileView, stageDraft } from "~/drafts/drafts.server";
import { subagentContextPath } from "~/lib/paths";
import {
  agentFromParams,
  agentParamRedirect,
} from "~/project/agent-context.server";
import {
  resolveRouteTarget,
  subagentSegmentsFromParams,
} from "~/project/config-target.server";
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
      const subSegments = subagentSegmentsFromParams(args.params);
      if (!agentName && !subSegments) {
        const legacy = agentParamRedirect(args.request, project.id);
        if (legacy) throw legacy;
      }
      const { roster, active, isTeam, target } = await resolveRouteTarget(
        project,
        args.params,
      );
      const path = `${target.root}/instructions.md`;

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
        subagentPath: subSegments ?? [],
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

  const project = requireRepo(
    await requireProject(auth, args.params.projectId),
  );

  const form = await args.request.formData();
  const content = String(form.get("content") ?? "");
  // The target is the URL's, never the form's.
  const { target } = await resolveRouteTarget(project, args.params);

  try {
    await stageDraft({
      projectId: project.id,
      path: `${target.root}/instructions.md`,
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
    subagentPath,
    isTeam,
    instructions,
    source,
  } = loaderData;
  const navigation = useNavigation();
  const submit = useSubmit();
  const saving = navigation.state !== "idle";
  const [value, setValue] = useState(instructions);

  // Back to the target's own overview — the subagent's, the member's, or the repo's.
  const ctx = subagentContextPath(
    project.id,
    isTeam ? activeAgent : null,
    subagentPath,
  );

  return (
    <AppShell
      breadcrumbs={repoCrumbs({
        projectId: project.id,
        repoName: project.name,
        isTeam,
        agentName: activeAgent,
        subagentPath,
        tail: [{ label: "Instructions" }],
      })}
    >
      <AgentNav
        base={ctx}
        level={
          subagentPath.length > 0 ? "subagent" : isTeam ? "member" : "single"
        }
        roster={roster}
        activeAgent={isTeam ? activeAgent : undefined}
      />
      <PageHeader
        icon={FileText}
        accent="blue"
        title={
          subagentPath.length > 0
            ? `Edit instructions — ${subagentPath[subagentPath.length - 1]}`
            : isTeam
              ? `Edit instructions — ${activeAgent}`
              : "Edit instructions"
        }
        description="Save keeps the change here until you publish — Publish, on the Deployment tab, takes everything you've saved live."
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
            submit({ content: value }, { method: "post" })
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
