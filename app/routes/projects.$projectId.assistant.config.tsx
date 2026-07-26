/**
 * Assistant configuration — the user layer over `.harnesst/assistant/**`.
 * Editing here STAGES drafts through the normal Changes flow; the fixed harnesst-owned layer
 * (instructions + tools) is shown read-only so the assistant is inspectable. Config takes effect
 * after the change is published + merged, which restarts the instance (refresh-on-merge).
 */
import { getSessionAuth, sessionLoader } from "~/auth/session.server";
import { Lock, Sparkles } from "lucide-react";
import {
  Link,
  redirect,
  useFetcher,
  useSearchParams,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import {
  assistantFixedLayer,
  ensureAssistantAgent,
} from "~/assistant/instance.server";
import { MarkdownText } from "~/components/chat";
import { ModelSelection } from "~/components/model-select";
import { AppShell, PageHeader, repoCrumbs } from "~/components/shell";
import { Alert, AlertDescription } from "~/components/ui/alert";
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
import { Separator } from "~/components/ui/separator";
import { Textarea } from "~/components/ui/textarea";
import { resolveFileView, stageDraft } from "~/drafts/drafts.server";
import { ASSISTANT_CONFIG_ROOT } from "~/eve/parse";
import { buildScheduleFile, parseScheduleFile } from "~/eve/scheduleFile";
import { slugifyResourceName } from "~/eve/templates";
import { getAgentSource } from "~/github/cached.server";
import { requireProject, requireRepo } from "~/project/guard.server";
import { getWorkspaceAssistantSelection } from "~/org/workspace.server";
import { findWorkspaceModel } from "~/models/union.server";
import { isReasoningEffort, type ReasoningEffort } from "~/models/reasoning";
import type { Route } from "./+types/projects.$projectId.assistant.config";

const INSTRUCTIONS = `${ASSISTANT_CONFIG_ROOT}/instructions.md`;
const MODEL_FILE = `${ASSISTANT_CONFIG_ROOT}/assistant.json`;

function skillPath(slug: string) {
  return `${ASSISTANT_CONFIG_ROOT}/skills/${slug}.md`;
}
function schedulePath(slug: string) {
  return `${ASSISTANT_CONFIG_ROOT}/schedules/${slug}.md`;
}
function basenameSlug(path: string) {
  return path.split("/").pop()?.replace(/\.md$/, "") ?? "";
}

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }) => {
      const project = requireRepo(
        await requireProject(auth, args.params.projectId, {
          request: args.request,
        }),
      );
      const url = new URL(args.request.url);
      const editSkill = url.searchParams.get("skill");
      const editSchedule = url.searchParams.get("schedule");

      const [source, instructionsView, modelView, fixed, workspaceSelection] =
        await Promise.all([
          getAgentSource(project.repoInstallationId, {
            owner: project.repoOwner,
            repo: project.repoName,
          }),
          resolveFileView(project, INSTRUCTIONS),
          resolveFileView(project, MODEL_FILE),
          assistantFixedLayer(),
          getWorkspaceAssistantSelection(project.orgId).catch(() => ({
            model: null,
            effort: null,
          })),
        ]);
      // An unset project override inherits only the connected workspace default. There is no
      // implicit provider/model when the workspace has no connection.
      const inheritedModel = workspaceSelection.model;
      const inheritedEffort = workspaceSelection.effort;

      const prefix = `${ASSISTANT_CONFIG_ROOT}/`;
      const skills = source.paths
        .filter((p) => p.startsWith(`${prefix}skills/`) && p.endsWith(".md"))
        .map(basenameSlug)
        .sort();
      const schedules = source.paths
        .filter((p) => p.startsWith(`${prefix}schedules/`) && p.endsWith(".md"))
        .map(basenameSlug)
        .sort();

      let model: string | null = null;
      let effort: ReasoningEffort | null = null;
      if (modelView.content) {
        try {
          const parsed = JSON.parse(modelView.content) as {
            model?: unknown;
            effort?: unknown;
          };
          model =
            typeof parsed.model === "string" && parsed.model.trim()
              ? parsed.model.trim()
              : null;
          effort =
            model && isReasoningEffort(parsed.effort) ? parsed.effort : null;
        } catch {
          model = null;
          effort = null;
        }
      }

      const editingSkill =
        editSkill != null
          ? {
              slug: editSkill,
              content:
                (await resolveFileView(project, skillPath(editSkill)))
                  .content ?? "",
            }
          : null;
      const editingSchedule =
        editSchedule != null
          ? parseScheduleFile(
              (await resolveFileView(project, schedulePath(editSchedule)))
                .content ?? "",
            )
          : null;

      return {
        project,
        instructions: instructionsView.content ?? "",
        model,
        effort,
        inheritedModel,
        inheritedEffort,
        skills,
        schedules,
        fixed,
        editSkillSlug: editSkill,
        editingSkillContent: editingSkill?.content ?? "",
        editScheduleSlug: editSchedule,
        editingSchedule,
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
  // Ensure the assistant agent row exists so these drafts attribute to it (agentForPath).
  await ensureAssistantAgent(project.id);

  const form = await args.request.formData();
  const intent = String(form.get("intent"));
  const createdBy = auth.user.id;
  const stage = (path: string, content: string | null) =>
    stageDraft({ projectId: project.id, path, content, createdBy });

  switch (intent) {
    case "save-instructions": {
      await stage(INSTRUCTIONS, String(form.get("content") ?? ""));
      return { ok: true, saved: "instructions" as const };
    }
    case "save-model": {
      const model = String(form.get("model") ?? "").trim();
      const rawEffort = String(form.get("effort") ?? "").trim();
      const effort = isReasoningEffort(rawEffort) ? rawEffort : null;
      const modelInfo = model
        ? await findWorkspaceModel(project.orgId, model)
        : null;
      if (model && !modelInfo) {
        return {
          error:
            "That model is not available from an active provider connection in this workspace.",
        };
      }
      if (rawEffort && !effort) {
        return { error: "That reasoning effort is not recognized." };
      }
      if (effort && !modelInfo?.supportedEfforts?.includes(effort)) {
        return {
          error:
            "That reasoning effort is not supported by the selected model.",
        };
      }
      await stage(
        MODEL_FILE,
        model
          ? `${JSON.stringify({ model, ...(effort ? { effort } : {}) }, null, 2)}\n`
          : null,
      );
      return { ok: true, saved: "model" as const };
    }
    case "save-skill": {
      const slug = slugifyResourceName(String(form.get("name") ?? ""));
      if (!slug) return { error: "Give the skill a name." };
      const description = String(form.get("description") ?? "").trim();
      const body = String(form.get("body") ?? "").trim();
      const content = `---\ndescription: ${description || "A skill for the assistant."}\n---\n\n${body}\n`;
      await stage(skillPath(slug), content);
      throw redirect(`/repos/${project.id}/assistant/config`);
    }
    case "delete-skill": {
      await stage(skillPath(String(form.get("slug"))), null);
      throw redirect(`/repos/${project.id}/assistant/config`);
    }
    case "save-schedule": {
      const slug = slugifyResourceName(String(form.get("name") ?? ""));
      if (!slug) return { error: "Give the schedule a name." };
      const cron = String(form.get("cron") ?? "").trim();
      const message = String(form.get("message") ?? "").trim();
      if (!cron) return { error: "A schedule needs a cron expression." };
      await stage(
        schedulePath(slug),
        buildScheduleFile({ cron, message, extraFrontmatter: [] }),
      );
      throw redirect(`/repos/${project.id}/assistant/config`);
    }
    case "delete-schedule": {
      await stage(schedulePath(String(form.get("slug"))), null);
      throw redirect(`/repos/${project.id}/assistant/config`);
    }
    default:
      return { error: "Unknown action." };
  }
}

export function meta() {
  return [{ title: "Assistant configuration · harnesst" }];
}

export default function AssistantConfig({ loaderData }: Route.ComponentProps) {
  const {
    project,
    instructions,
    model,
    effort,
    inheritedModel,
    inheritedEffort,
    skills,
    schedules,
    fixed,
    editSkillSlug,
    editingSkillContent,
    editScheduleSlug,
    editingSchedule,
  } = loaderData;
  const [, setSearchParams] = useSearchParams();

  return (
    <AppShell
      breadcrumbs={repoCrumbs({
        projectId: project.id,
        repoName: project.name,
        tail: [
          { label: "Assistant", to: `/repos/${project.id}/assistant` },
          { label: "Configure" },
        ],
      })}
    >
      <div className="mx-auto w-full max-w-3xl space-y-8 px-4 py-8 sm:px-6">
        <PageHeader
          icon={Sparkles}
          accent="brand"
          title="Configure the assistant"
          description="Tailor the assistant to this repo. Changes stage as drafts — they take effect after you publish + merge them on the Deployment tab, which restarts the assistant."
          actions={
            <Button asChild variant="outline" size="sm">
              <Link to={`/repos/${project.id}/assistant`}>Back to chat</Link>
            </Button>
          }
        />

        {/* Instructions: the fixed built-in layer (read-only) + the editable project layer */}
        <Card>
          <CardHeader>
            <CardTitle>Instructions</CardTitle>
            <CardDescription>
              The assistant always starts with harnesst's built-in instructions
              (shown below, read-only). Anything you add is appended under a
              “Project instructions” marker — so you don't need to repeat what's
              already covered here.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Lock className="size-3.5 text-muted-foreground" aria-hidden />
                <span className="text-sm font-medium">
                  Built-in instructions
                </span>
                <Badge variant="secondary" className="text-xs">
                  read-only
                </Badge>
              </div>
              <div className="max-h-80 overflow-auto rounded-lg border bg-muted/40 p-4 text-sm">
                {fixed.instructions ? (
                  <MarkdownText text={fixed.instructions} />
                ) : (
                  <p className="text-muted-foreground">
                    The built-in instructions could not be loaded.
                  </p>
                )}
              </div>
              {fixed.tools.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  <span className="text-xs text-muted-foreground">
                    Built-in tools:
                  </span>
                  {fixed.tools.map((t) => (
                    <Badge
                      key={t}
                      variant="outline"
                      className="font-mono text-xs"
                    >
                      {t}
                    </Badge>
                  ))}
                </div>
              )}
            </div>

            <Separator />

            <form method="post" className="space-y-3">
              <input type="hidden" name="intent" value="save-instructions" />
              <div className="space-y-1.5">
                <Label htmlFor="project-instructions">
                  Your project instructions
                </Label>
                <p className="text-xs text-muted-foreground">
                  Repo-specific conventions, priorities, and gotchas — added on
                  top of the built-in layer above.
                </p>
              </div>
              <Textarea
                id="project-instructions"
                name="content"
                defaultValue={instructions}
                rows={8}
                placeholder="e.g. This team ships to Cloudflare. Prefer wrangler over bespoke tools…"
                className="font-mono text-sm"
              />
              <Button type="submit" size="sm">
                Stage instructions
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Model override */}
        <Card>
          <CardHeader>
            <CardTitle>Model</CardTitle>
            <CardDescription>
              Optional per-project model override. Search the live catalog and
              pick one — leave it unset to use the workspace default. Applies
              without an image rebuild.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ModelField
              projectId={project.id}
              model={model}
              effort={effort}
              inheritedModel={inheritedModel}
              inheritedEffort={inheritedEffort}
            />
          </CardContent>
        </Card>

        {/* Skills */}
        <Card>
          <CardHeader>
            <CardTitle>Skills</CardTitle>
            <CardDescription>
              Progressive-disclosure knowledge the assistant loads on demand.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {skills.length > 0 && (
              <ul className="space-y-1.5">
                {skills.map((slug) => (
                  <li
                    key={slug}
                    className="flex items-center justify-between gap-2 text-sm"
                  >
                    <button
                      type="button"
                      className="font-mono underline-offset-4 hover:underline"
                      onClick={() => setSearchParams({ skill: slug })}
                    >
                      {slug}.md
                    </button>
                    <form method="post">
                      <input type="hidden" name="intent" value="delete-skill" />
                      <input type="hidden" name="slug" value={slug} />
                      <Button type="submit" variant="ghost" size="sm">
                        Delete
                      </Button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
            <form method="post" className="space-y-3 border-t pt-4">
              <input type="hidden" name="intent" value="save-skill" />
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="skill-name">Name</Label>
                  <Input
                    id="skill-name"
                    name="name"
                    defaultValue={editSkillSlug ?? ""}
                    placeholder="deploying-to-cloudflare"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="skill-desc">Description</Label>
                  <Input
                    id="skill-desc"
                    name="description"
                    placeholder="When to use this skill"
                  />
                </div>
              </div>
              <Textarea
                name="body"
                rows={6}
                defaultValue={stripFrontmatter(editingSkillContent)}
                placeholder="Markdown guidance…"
                className="font-mono text-sm"
              />
              <Button type="submit" size="sm">
                {editSkillSlug ? "Update skill" : "Add skill"}
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Schedules */}
        <Card>
          <CardHeader>
            <CardTitle>Schedules</CardTitle>
            <CardDescription>
              Cron-triggered runs. The message is delivered to the assistant
              when the schedule fires.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {schedules.length > 0 && (
              <ul className="space-y-1.5">
                {schedules.map((slug) => (
                  <li
                    key={slug}
                    className="flex items-center justify-between gap-2 text-sm"
                  >
                    <button
                      type="button"
                      className="font-mono underline-offset-4 hover:underline"
                      onClick={() => setSearchParams({ schedule: slug })}
                    >
                      {slug}.md
                    </button>
                    <form method="post">
                      <input
                        type="hidden"
                        name="intent"
                        value="delete-schedule"
                      />
                      <input type="hidden" name="slug" value={slug} />
                      <Button type="submit" variant="ghost" size="sm">
                        Delete
                      </Button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
            <form method="post" className="space-y-3 border-t pt-4">
              <input type="hidden" name="intent" value="save-schedule" />
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="sched-name">Name</Label>
                  <Input
                    id="sched-name"
                    name="name"
                    defaultValue={editScheduleSlug ?? ""}
                    placeholder="daily-digest"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="sched-cron">Cron</Label>
                  <Input
                    id="sched-cron"
                    name="cron"
                    defaultValue={editingSchedule?.cron ?? ""}
                    placeholder="0 9 * * *"
                    className="font-mono text-sm"
                  />
                </div>
              </div>
              <Textarea
                name="message"
                rows={4}
                defaultValue={editingSchedule?.message ?? ""}
                placeholder="Message delivered when the schedule fires…"
                className="text-sm"
              />
              <Button type="submit" size="sm">
                {editScheduleSlug ? "Update schedule" : "Add schedule"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Alert>
          <AlertDescription>
            Staged config appears on the Deployment tab. Publish + merge it to
            apply — that restarts the assistant with your changes.
          </AlertDescription>
        </Alert>
      </div>
    </AppShell>
  );
}

/**
 * The per-project model override, using the same catalog-backed picker as agent Settings so the
 * user searches models instead of remembering an id. Committing stages the `assistant.json` draft
 * (empty value clears it → back to the workspace default).
 */
function ModelField({
  projectId,
  model,
  effort,
  inheritedModel,
  inheritedEffort,
}: {
  projectId: string;
  model: string | null;
  effort: ReasoningEffort | null;
  inheritedModel: string | null;
  inheritedEffort: ReasoningEffort | null;
}) {
  const fetcher = useFetcher<{
    ok?: boolean;
    error?: string;
    saved?: string;
  }>();
  const busy = fetcher.state !== "idle";
  const commit = (value: string, nextEffort: ReasoningEffort | null) =>
    fetcher.submit(
      { intent: "save-model", model: value, effort: nextEffort ?? "" },
      { method: "post" },
    );
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <ModelSelection
          model={model}
          effort={effort}
          busy={busy}
          onCommit={commit}
        />
        {model && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => commit("", null)}
          >
            Reset to workspace default
          </Button>
        )}
      </div>
      {/* Always show what an unset override resolves to, so nobody re-pins the same model by
          hand (as happened before): unset here just inherits this value. */}
      <p className="text-sm text-muted-foreground">
        {model && inheritedModel ? (
          <>
            Overriding the default of{" "}
            <span className="font-mono text-xs">{inheritedModel}</span>. Reset
            to inherit it
            {inheritedEffort ? ` at ${inheritedEffort} effort` : ""}.
          </>
        ) : model ? (
          <>
            Using project override{" "}
            <span className="font-mono text-xs">{model}</span>. The workspace
            has no default.
          </>
        ) : inheritedModel ? (
          <>
            No override — inheriting the workspace default{" "}
            <span className="font-mono text-xs">{inheritedModel}</span>
            {inheritedEffort ? ` at ${inheritedEffort} effort` : ""}.
          </>
        ) : (
          <>
            No workspace default is configured. Connect a model provider and
            choose a default in{" "}
            <Link to="/org/settings" className="underline">
              Org settings
            </Link>
            .
          </>
        )}
      </p>
      {fetcher.data?.error && (
        <p className="text-sm text-destructive">{fetcher.data.error}</p>
      )}
      {fetcher.data?.ok && (
        <p className="text-sm text-muted-foreground">
          Staged — publish it on the Deployment tab to apply.
        </p>
      )}
    </div>
  );
}

/** Drop the leading YAML frontmatter so the skill body editor shows just the markdown. */
function stripFrontmatter(source: string): string {
  const m = source.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  return (m ? m[1] : source).trim();
}
