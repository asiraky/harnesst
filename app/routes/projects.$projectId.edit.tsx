/**
 * File editor (Author pillar, M1) — CodeMirror-backed, for any file under `agent/`.
 *
 * Reached from a resource link or the "New <kind>" dialog on the Overview. A file that exists
 * nowhere yet (no repo content, no draft) starts from its category's starter template
 * (~/eve/templates). Save formats code files with Prettier, then writes a draft
 * (refresh-proof, no git write); the header Publish control takes every saved change live
 * (issue #225).
 */
import { getSessionAuth, sessionLoader } from "~/auth/session.server";
import { Pencil } from "lucide-react";
import { useState } from "react";
import {
  Link,
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
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  resolveFileView,
  stageDraft,
  type FileView,
} from "~/drafts/drafts.server";
import { DEFAULT_SANDBOX_MODULE, RESOURCE_KINDS } from "~/eve/templates";
import { formatSource, isFormattable } from "~/lib/format";
import { contextPath } from "~/lib/paths";
import {
  agentFromParams,
  agentParamRedirect,
  memberFromPath,
  requireActiveAgent,
  resolveAgentContext,
} from "~/project/agent-context.server";
import {
  normalizeAgentPath,
  requireProject,
  requireRepo,
  type ConnectedProject,
} from "~/project/guard.server";
import type { Route } from "./+types/projects.$projectId.edit";

interface FileEditView {
  project: ConnectedProject;
  path: string;
  roster: { name: string }[];
  activeAgent: string;
  isTeam: boolean;
  content: string;
  /** File exists on the default branch. */
  exists: boolean;
  /** Content came from a category starter template (brand-new resource). */
  isNew: boolean;
  source: FileView["source"];
  stagedDeletion: boolean;
}

/** Starter content for a brand-new file, by its category directory (null if none applies). */
function templateFor(path: string): string | null {
  // The sandbox definition is a singleton directly under the agent root (both layouts), not
  // a category — a repo running the framework default starts from harnesst's scaffold, which is
  // behaviorally identical until a secret is exposed (HARNESST_SANDBOX_ENV convention).
  if (/^(?:agent|agents\/[^/]+\/agent)\/sandbox\.[cm]?[jt]s$/.test(path)) {
    return DEFAULT_SANDBOX_MODULE;
  }
  // Root agent (agent/<cat>/<name>) or a team member (agents/<m>/agent/<cat>/<name>) — §7.9.
  const m = path.match(
    /^(?:agent|agents\/[^/]+\/agent)\/([^/]+)\/([^/]+)\.[a-z]+$/,
  );
  if (!m) return null;
  const kind = Object.values(RESOURCE_KINDS).find((k) => k.key === m[1]);
  return kind ? kind.template(m[2]) : null;
}

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }): Promise<FileEditView> => {
      const project = requireRepo(
        await requireProject(auth, args.params.projectId, {
          request: args.request,
        }),
      );

      // The member is the path segment when present (member-level route); otherwise the
      // edited file's path implies it. Legacy ?agent= links 301 into the member path.
      const paramAgent = agentFromParams(args.params);
      if (!paramAgent) {
        const legacy = agentParamRedirect(args.request, project.id);
        if (legacy) throw legacy;
      }

      const url = new URL(args.request.url);
      const path = normalizeAgentPath(url.searchParams.get("path") ?? "");
      // No (valid) target — nothing to edit; back to the overview, where creation lives.
      if (!path) throw redirect(contextPath(project.id, paramAgent));

      // Markdown schedules get the structured editor (cron + message); ?raw=1 is its own
      // "advanced" escape hatch back to this code editor.
      if (
        /^(?:agent|agents\/[^/]+\/agent)\/schedules\/[^/]+\.md$/.test(path) &&
        !url.searchParams.get("raw")
      ) {
        throw redirect(
          `${contextPath(project.id, paramAgent)}/edit/schedule?path=${encodeURIComponent(path)}`,
        );
      }

      const [view, { roster, active, isTeam }] = await Promise.all([
        resolveFileView(project, path),
        resolveAgentContext(project.id, paramAgent ?? memberFromPath(path)),
      ]);
      requireActiveAgent(active, project.id);
      const template = view.content === null ? templateFor(path) : null;
      return {
        project,
        path,
        roster: roster.map((a) => ({ name: a.name })),
        activeAgent: active.name,
        isTeam,
        content: view.content ?? template ?? "",
        exists: view.existsInRepo,
        isNew: template !== null,
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
  const path = normalizeAgentPath(String(form.get("path") ?? ""));
  if (!path) return { error: "Invalid path — files must live under agent/." };
  const content = String(form.get("content") ?? "");

  try {
    await stageDraft({
      projectId: project.id,
      path,
      content,
      createdBy: auth.user.id,
    });
    return { ok: true as const };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

export function meta() {
  return [{ title: "Edit file · harnesst" }];
}

export default function EditFile({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  // Keyed by path so switching files remounts the editor with fresh state.
  return (
    <Editor
      key={loaderData.path}
      loaderData={loaderData}
      actionData={actionData}
    />
  );
}

function Editor({
  loaderData,
  actionData,
}: Pick<Route.ComponentProps, "loaderData" | "actionData">) {
  const { project, path, roster, activeAgent, isTeam, content, exists, isNew } =
    loaderData;
  const navigation = useNavigation();
  const submit = useSubmit();
  const saving = navigation.state !== "idle";

  const [value, setValue] = useState(content);
  const [formatError, setFormatError] = useState<string | null>(null);

  // Save = auto-format (code files; falls back to as-typed on syntax errors, which the lint
  // gutter already flags), then stage the draft.
  const save = async () => {
    let out = value;
    if (isFormattable(path)) {
      try {
        out = await formatSource(path, value);
        setValue(out);
        setFormatError(null);
      } catch {
        // unformattable (syntax error) — stage the draft as-is; drafts are WIP
      }
    }
    submit({ path, content: out }, { method: "post" });
  };

  const formatNow = async () => {
    try {
      setValue(await formatSource(path, value));
      setFormatError(null);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setFormatError(msg.split("\n")[0]);
    }
  };

  const ctx = contextPath(project.id, isTeam ? activeAgent : null);

  return (
    <AppShell
      breadcrumbs={repoCrumbs({
        projectId: project.id,
        repoName: project.name,
        isTeam,
        agentName: activeAgent,
        tail: [{ label: path.split("/").pop() }],
      })}
    >
      <AgentNav
        base={ctx}
        level={isTeam ? "member" : "single"}
        roster={roster}
        activeAgent={isTeam ? activeAgent : undefined}
      />
      <PageHeader
        icon={Pencil}
        accent="brand"
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span className="break-all font-mono text-xl">{path}</span>
            {!exists && <Badge variant="secondary">new</Badge>}
          </span>
        }
        description={
          isNew
            ? "Starting from a template — edit it, then Save to keep the new file until you publish."
            : "Save keeps the change here until you publish — Publish, on the Deployment tab, takes everything you've saved live."
        }
      />

      {actionData?.error && (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>Couldn&rsquo;t save the change</AlertTitle>
          <AlertDescription>{actionData.error}</AlertDescription>
        </Alert>
      )}
      <FileStateBanner
        saved={!!actionData?.ok}
        source={loaderData.source}
        stagedDeletion={loaderData.stagedDeletion}
      />

      <CodeEditor path={path} value={value} onChange={setValue} />
      {formatError && (
        <p className="mt-2 text-xs text-destructive">
          Can&rsquo;t format: {formatError}
        </p>
      )}
      <div className="mt-4 flex items-center gap-3">
        <Button onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
        {isFormattable(path) && (
          <Button variant="outline" onClick={formatNow} disabled={saving}>
            Format
          </Button>
        )}
        <Button variant="ghost" asChild>
          <Link to={ctx}>Cancel</Link>
        </Button>
      </div>
    </AppShell>
  );
}
