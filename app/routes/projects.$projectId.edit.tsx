/**
 * File editor (Author pillar, M1) — CodeMirror-backed, for any file under `agent/`.
 *
 * Reached from a resource link or the "New <kind>" dialog on the agent page. A file that exists
 * nowhere yet (no repo content, no draft) starts from its category's starter template
 * (~/eve/templates). Save formats code files with Prettier, then writes a draft
 * (refresh-proof, no git write); the header Publish control takes every saved change live
 * (issue #225).
 *
 * The file is always confined to the CONFIGURATION TARGET the URL names (issue #344): the
 * subagent addressed by `:subPath`, else the member addressed by `:agentName`, else — for legacy
 * repo-level links — the member the path itself implies. The editable-path allowlist is
 * repo-global, so without that confinement one member's editor would happily write into another
 * member's (or another subagent's) tree via a hand-edited `?path=`.
 */
import { getSessionAuth, sessionLoader } from "~/auth/session.server";
import { Pencil } from "lucide-react";
import { useState } from "react";
import {
  data,
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
import { contextPath, subagentContextPath } from "~/lib/paths";
import {
  agentFromParams,
  agentParamRedirect,
  memberFromPath,
} from "~/project/agent-context.server";
import {
  resolveRouteTarget,
  subagentSegmentsFromParams,
  type ConfigTarget,
} from "~/project/config-target.server";
import {
  confineToRoot,
  isRootManifestPath,
  normalizeAgentPath,
  platformPathRefusal,
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
  /** The nested subagent chain this editor is scoped to (empty at a member/repo target). */
  subagentPath: string[];
  isTeam: boolean;
  content: string;
  /** File exists on the default branch. */
  exists: boolean;
  /** Content came from a category starter template (brand-new resource). */
  isNew: boolean;
  source: FileView["source"];
  stagedDeletion: boolean;
}

/**
 * Starter content for a brand-new file, by its position under the RESOLVED agent root — which is
 * `agent`, `agents/<member>/agent`, or any declared subagent root beneath one of those. Deriving
 * it from the target rather than from a layout regex is what makes a subagent's `tools/x.ts`
 * start from the tool template just like its parent's (issue #344).
 */
function templateFor(path: string, root: string): string | null {
  if (!path.startsWith(`${root}/`)) return null;
  const rest = path.slice(root.length + 1);
  // The sandbox definition is a singleton directly under the agent root (both layouts), not
  // a category — a repo running the framework default starts from harnesst's scaffold, which is
  // behaviorally identical until a secret is exposed (HARNESST_SANDBOX_ENV convention).
  if (/^sandbox\.[cm]?[jt]s$/.test(rest)) return DEFAULT_SANDBOX_MODULE;
  const m = rest.match(/^([^/]+)\/([^/]+)\.[a-z]+$/);
  if (!m) return null;
  const kind = Object.values(RESOURCE_KINDS).find((k) => k.key === m[1]);
  return kind ? kind.template(m[2]) : null;
}

/**
 * The path this request may touch: inside the target's root, or one of the repo-root manifests a
 * change-set is allowed to carry (those belong to the deployment, so only an agent target gets
 * them). Null means "well-formed, but not yours".
 */
function confineToTarget(target: ConfigTarget, path: string): string | null {
  const confined = confineToRoot(target.root, path);
  if (confined) return confined;
  return target.kind === "agent" && isRootManifestPath(path) ? path : null;
}

const OUTSIDE_TARGET = "That file is outside this agent.";

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
      const subSegments = subagentSegmentsFromParams(args.params);
      if (!paramAgent && !subSegments) {
        const legacy = agentParamRedirect(args.request, project.id);
        if (legacy) throw legacy;
      }

      const url = new URL(args.request.url);
      const requested = url.searchParams.get("path") ?? "";
      // A link into `harnesst/` is a well-formed path we refuse on purpose (issue #254) — say
      // so, instead of bouncing to the agent page as if the link were malformed.
      const refusal = platformPathRefusal(requested);
      if (refusal) throw data(refusal, { status: 403 });
      const requestedPath = normalizeAgentPath(requested);
      // No (valid) target — nothing to edit; back to the agent page, where creation lives.
      if (!requestedPath) throw redirect(contextPath(project.id, paramAgent));

      const { roster, active, isTeam, target } = await resolveRouteTarget(
        project,
        args.params,
        memberFromPath(requestedPath),
      );
      const path = confineToTarget(target, requestedPath);
      if (!path) throw data(OUTSIDE_TARGET, { status: 403 });
      const ctx = subagentContextPath(
        project.id,
        isTeam ? active.name : null,
        subSegments ?? [],
      );

      // Markdown schedules get the structured editor (cron + message); ?raw=1 is its own
      // "advanced" escape hatch back to this code editor. Schedules are root-only, so a
      // subagent target never has one.
      const schedules = `${target.root}/schedules/`;
      if (
        target.kind === "agent" &&
        path.startsWith(schedules) &&
        path.endsWith(".md") &&
        !path.slice(schedules.length).includes("/") &&
        !url.searchParams.get("raw")
      ) {
        throw redirect(`${ctx}/edit/schedule?path=${encodeURIComponent(path)}`);
      }

      const view = await resolveFileView(project, path);
      const template = view.content === null ? templateFor(path, target.root) : null;
      return {
        project,
        path,
        roster: roster.map((a) => ({ name: a.name })),
        activeAgent: active.name,
        subagentPath: subSegments ?? [],
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
  const raw = String(form.get("path") ?? "");
  const refusal = platformPathRefusal(raw);
  if (refusal) return { error: refusal };
  const requestedPath = normalizeAgentPath(raw);
  if (!requestedPath) {
    return { error: "Invalid path — files must live under agent/." };
  }
  // The target comes from the URL, never from the posted path: `normalizeAgentPath` alone would
  // accept any member's file, so the save has to be confined to the target this page addresses.
  const { target } = await resolveRouteTarget(
    project,
    args.params,
    memberFromPath(requestedPath),
  );
  const path = confineToTarget(target, requestedPath);
  if (!path) return { error: OUTSIDE_TARGET };
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
  const {
    project,
    path,
    roster,
    activeAgent,
    subagentPath,
    isTeam,
    content,
    exists,
    isNew,
  } = loaderData;
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
        tail: [{ label: path.split("/").pop() }],
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
