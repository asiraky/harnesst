/**
 * The Publish control + panel (issue #225 §4.1/§4.2): the pure state logic (grouping, action
 * badges, control states, disabled reasons) and the SSR rendering of the presentational
 * pieces — createdBy attribution (assistant vs teammate), badges, group headers, and the
 * pipeline step list. Components render via renderToString inside a routes stub (the rows'
 * fetchers need a data router); assertions are string containment on the HTML.
 */
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";

import {
  PipelineStepList,
  PublishNudgeBanner,
  PublishReviewChanges,
} from "~/components/publish";
import type { DraftChange, PipelineStep } from "~/data/ports";
import {
  changeAction,
  groupDrafts,
  initialPublishSteps,
  publishControlState,
  publishDisabledReason,
  publishedVersion,
  runningStepSummary,
  type PublishChangeRow,
  type PublishControlState,
} from "~/publish/publish-panel";

function renderInRouter(ui: React.ReactElement): string {
  const Stub = createRoutesStub([{ path: "*", Component: () => ui }]);
  // Strip React's text-node comment markers so interpolated copy matches as one string.
  return renderToString(<Stub initialEntries={["/"]} />).replace(/<!-- -->/g, "");
}

function draft(agentId: string | null, path = `${agentId ?? "shared"}.ts`): DraftChange {
  return {
    id: `d_${path}`,
    projectId: "proj_1",
    agentId,
    path,
    content: "x",
    baseSha: null,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as DraftChange;
}

const roster = [
  { id: "agent_a", name: "alpha" },
  { id: "agent_b", name: "bravo" },
  { id: "agent_c", name: "charlie" },
];

describe("groupDrafts", () => {
  it("groups changes under their owning member (roster order), shared block last", () => {
    const drafts = [
      draft("agent_b", "bravo/instructions.md"),
      draft("agent_a", "alpha/model.md"),
      draft(null, "package.json"),
      draft("agent_a", "alpha/tools.md"),
    ];
    expect(groupDrafts(drafts, roster)).toEqual([
      { member: "alpha", files: ["alpha/model.md", "alpha/tools.md"] },
      { member: "bravo", files: ["bravo/instructions.md"] },
      { member: null, files: ["package.json"] },
    ]);
  });

  it("omits members with no changes and emits no shared block when nothing is shared", () => {
    expect(groupDrafts([draft("agent_c", "charlie/x.md")], roster)).toEqual([
      { member: "charlie", files: ["charlie/x.md"] },
    ]);
  });

  it("is empty for no changes", () => {
    expect(groupDrafts([], roster)).toEqual([]);
  });

  it("keeps a change whose owner is not in the roster, in the shared block", () => {
    // The built-in assistant owns `.harnesst/assistant/**` and is not a roster member. Dropping
    // its changes here made the header count "1 change" over an empty panel — and Publish
    // shipped a file the user was never shown.
    expect(
      groupDrafts(
        [draft("agent_a", "alpha/model.md"), draft("agent_x", ".harnesst/assistant/instructions.md")],
        roster,
      ),
    ).toEqual([
      { member: "alpha", files: ["alpha/model.md"] },
      { member: null, files: [".harnesst/assistant/instructions.md"] },
    ]);
  });

  it("never drops a change: every path in, every path out", () => {
    const drafts = [
      draft("agent_a", "alpha/a.md"),
      draft(null, "package.json"),
      draft("ghost_1", "gone/one.md"),
      draft("ghost_2", "gone/two.md"),
    ];
    const grouped = groupDrafts(drafts, roster).flatMap((g) => g.files);
    expect(grouped.sort()).toEqual(drafts.map((d) => d.path).sort());
  });
});

describe("changeAction", () => {
  it("labels a null-content change as deleted regardless of repo state", () => {
    expect(changeAction(null, true)).toBe("deleted");
    expect(changeAction(null, false)).toBe("deleted");
  });

  it("labels content for a path missing from the repo as new", () => {
    expect(changeAction("body", false)).toBe("new");
  });

  it("labels content over an existing repo file as edited", () => {
    expect(changeAction("body", true)).toBe("edited");
  });

  it("degrades to edited (never new) when the repo tree was unreadable", () => {
    expect(changeAction("body", null)).toBe("edited");
  });
});

describe("publishControlState", () => {
  const base = {
    changeCount: 0,
    deployed: true,
    deploying: false,
    liveVersion: "v12" as string | null,
    running: null as { taskId: string; steps: PipelineStep[] | null } | null,
    failed: null as { taskId: string; steps: PipelineStep[] | null; error: string | null } | null,
  };

  it("is quiet Live text when nothing is saved and the project is deployed", () => {
    expect(publishControlState(base)).toEqual({ kind: "live", version: "v12" });
  });

  it("is the never-deployed state when no deployment has ever run", () => {
    expect(publishControlState({ ...base, deployed: false, liveVersion: null })).toEqual({
      kind: "never-deployed",
    });
  });

  it("reports the deploy in flight rather than claiming Live with no version", () => {
    // A HEAD publish or a rollback deploys with no publish task to watch: between queueing and
    // going live the project HAS deployment rows but none of them is `live` yet.
    expect(
      publishControlState({ ...base, deploying: true, liveVersion: null }),
    ).toEqual({ kind: "deploying" });
  });

  it("prefers a saved-changes Publish button over the in-flight deploy state", () => {
    expect(publishControlState({ ...base, deploying: true, changeCount: 1 })).toEqual({
      kind: "ready",
      count: 1,
    });
  });

  it("is the primary Publish button when changes are saved", () => {
    expect(publishControlState({ ...base, changeCount: 3 })).toEqual({
      kind: "ready",
      count: 3,
    });
  });

  it("is the running state — with the running step's one-liner — over everything else", () => {
    const steps: PipelineStep[] = [
      { key: "check", label: "Checking your changes", status: "succeeded" },
      { key: "build", label: "Building your agents", status: "running", detail: "ivy (1 of 2)" },
      { key: "commit", label: "Saving to your repository", status: "pending" },
    ];
    expect(
      publishControlState({
        ...base,
        changeCount: 3,
        running: { taskId: "task_1", steps },
        failed: { taskId: "task_0", steps: null, error: "old" },
      }),
    ).toEqual({ kind: "running", summary: "Building your agents — ivy (1 of 2)" });
  });

  it("is the failed state over the ready state (a grounded publish is THE thing to surface)", () => {
    expect(
      publishControlState({
        ...base,
        changeCount: 2,
        failed: { taskId: "task_9", steps: null, error: "boom" },
      }),
    ).toEqual({ kind: "failed" });
  });
});

describe("runningStepSummary", () => {
  it("is the running step's label, with its detail when present", () => {
    expect(
      runningStepSummary([
        { key: "check", label: "Checking your changes", status: "succeeded" },
        { key: "build", label: "Building your agents", status: "running" },
      ]),
    ).toBe("Building your agents");
    expect(
      runningStepSummary([
        { key: "deploy", label: "Starting your agents", status: "running", detail: "otto" },
      ]),
    ).toBe("Starting your agents — otto");
  });

  it("is null when no step is running (or there are no steps)", () => {
    expect(runningStepSummary(null)).toBeNull();
    expect(runningStepSummary(initialPublishSteps())).toBeNull();
  });
});

describe("publishedVersion", () => {
  it("reads the version label off the succeeded version step", () => {
    expect(
      publishedVersion([
        { key: "commit", label: "Saving to your repository", status: "succeeded" },
        { key: "version", label: "Creating version", status: "succeeded", detail: "v13" },
      ]),
    ).toBe("v13");
  });

  it("is null when the version step was skipped, unfinished, or absent", () => {
    expect(
      publishedVersion([
        { key: "version", label: "Creating version", status: "skipped", reason: "x" },
      ]),
    ).toBeNull();
    expect(publishedVersion(initialPublishSteps())).toBeNull();
    expect(
      publishedVersion([{ key: "version", label: "Creating version", status: "succeeded" }]),
    ).toBeNull();
    expect(publishedVersion(null)).toBeNull();
  });
});

describe("publishDisabledReason", () => {
  it("explains that a publish is already running", () => {
    expect(
      publishDisabledReason({
        running: { taskId: "t", steps: null },
        changeCount: 3,
        needsEnvironmentChoice: false,
        envAnswer: "",
      }),
    ).toMatch(/already running/);
  });

  it("asks for the environment answer only while the question is unanswered", () => {
    const base = { running: null, changeCount: 2, needsEnvironmentChoice: true };
    expect(publishDisabledReason({ ...base, envAnswer: "" })).toMatch(/environment/);
    expect(publishDisabledReason({ ...base, envAnswer: "production" })).toBeNull();
  });

  it("is null when a publish may run", () => {
    expect(
      publishDisabledReason({
        running: null,
        changeCount: 1,
        needsEnvironmentChoice: false,
        envAnswer: "",
      }),
    ).toBeNull();
  });
});

describe("PublishNudgeBanner", () => {
  const open = () => {};
  const render = (state: PublishControlState) =>
    renderInRouter(
      <PublishNudgeBanner state={state} projectId="p1" onOpen={open} />,
    );

  it("nudges about saved changes, with the count and a dismiss", () => {
    const html = render({ kind: "ready", count: 3 });
    expect(html).toContain("3 saved changes aren&#x27;t live yet");
    expect(html).toContain("Review &amp; publish →");
    expect(html).toContain('aria-label="Dismiss"');
  });

  it("says isn't/aren't to match one change vs several", () => {
    expect(render({ kind: "ready", count: 1 })).toContain(
      "1 saved change isn&#x27;t live yet",
    );
    expect(render({ kind: "ready", count: 2 })).toContain(
      "2 saved changes aren&#x27;t live yet",
    );
  });

  it("nudges a never-deployed repository toward its first publish", () => {
    const html = render({ kind: "never-deployed" });
    expect(html).toContain("hasn&#x27;t been deployed yet");
    expect(html).toContain("Publish it →");
  });

  // The banner deliberately covers only the states with no workspace task behind them. A
  // running, failed or just-finished publish is already a row in WorkspaceTasksIndicator
  // directly above it, and live/deploying are status for the Deployment tab, not a nudge.
  it("renders nothing for states the task strip or the Deployment tab already own", () => {
    expect(render({ kind: "running", summary: "Building" })).toBe("");
    expect(render({ kind: "failed" })).toBe("");
    expect(render({ kind: "live", version: "v12" })).toBe("");
    expect(render({ kind: "deploying" })).toBe("");
  });
});

describe("PublishReviewChanges", () => {
  const row = (over: Partial<PublishChangeRow>): PublishChangeRow => ({
    path: "agents/ivy/agent/instructions.md",
    action: "edited",
    savedBy: "Ada",
    savedAt: "2026-07-01T00:00:00.000Z",
    ...over,
  });

  it("renders member group headers, the shared block, badges, and attribution", () => {
    const html = renderInRouter(
      <PublishReviewChanges
        projectId="proj_1"
        groups={[
          {
            member: "ivy",
            files: [
              row({}),
              row({ path: "agents/ivy/agent/agent.ts", action: "new", savedBy: null }),
            ],
          },
          {
            member: null,
            files: [row({ path: "package.json", action: "deleted" })],
          },
        ]}
      />,
    );
    // Group headers: member name in mono, shared block labeled.
    expect(html).toContain(">ivy</span>");
    expect(html).toContain("Shared — affects all agents");
    // Action badges.
    expect(html).toContain(">Edited</span>");
    expect(html).toContain(">New</span>");
    expect(html).toContain(">Deleted</span>");
    // Attribution: the assistant is named and visually distinct; teammates by display name.
    expect(html).toContain("Assistant");
    expect(html).toContain("Ada");
    // Every file row is present with a per-file discard affordance.
    expect(html).toContain("agents/ivy/agent/instructions.md");
    expect(html).toContain('aria-label="Discard package.json"');
  });
});

describe("PipelineStepList", () => {
  it("renders every step from the start, skip reasons, substeps, and the failure output", () => {
    const steps: PipelineStep[] = [
      { key: "check", label: "Checking your changes", status: "succeeded" },
      {
        key: "build",
        label: "Building your agents",
        status: "failed",
        error: "src/agent.ts(3,7): error TS2304: Cannot find name 'foo'.",
        substeps: [
          { label: "ivy", status: "succeeded" },
          { label: "otto", status: "failed" },
        ],
      },
      { key: "commit", label: "Saving to your repository", status: "pending" },
      {
        key: "version",
        label: "Creating version",
        status: "skipped",
        reason: "This change only affects the assistant's configuration",
      },
      { key: "deploy", label: "Starting your agents", status: "pending" },
    ];
    const html = renderInRouter(<PipelineStepList steps={steps} />);
    expect(html).toContain('role="list"');
    for (const step of steps) expect(html).toContain(step.label);
    // The failed step shows the compiler's own output, and later steps stay pending (present).
    expect(html).toContain("Cannot find name");
    expect(html).toContain("ivy");
    expect(html).toContain("otto");
    expect(html).toContain(
      "Skipped — This change only affects the assistant&#x27;s configuration",
    );
  });

  it("live-announces only the running step", () => {
    const steps = initialPublishSteps();
    steps[0].status = "running";
    steps[0].detail = "orphan gate";
    const html = renderInRouter(<PipelineStepList steps={steps} />);
    expect(html.match(/aria-live="polite"/g)).toHaveLength(1);
    expect(html).toContain("orphan gate");
  });

  it("auto-expands a failure — output and recovery actions render without interaction — and later steps stay pending", () => {
    const steps = initialPublishSteps();
    steps[0].status = "succeeded";
    steps[1].status = "failed";
    steps[1].error = "src/agent.ts(3,7): error TS2304: Cannot find name 'foo'.\n  3 | foo();";
    const html = renderInRouter(
      <PipelineStepList
        steps={steps}
        assistantFixHref="/repos/proj_1/assistant?fix=task_9"
        onAskAssistant={() => {}}
        onBackToChanges={() => {}}
      />,
    );
    // The error is expanded on render — no click required — with its newline structure intact
    // (a <pre> block; both lines of the compiler output are present).
    expect(html).toContain("<pre");
    expect(html).toContain("Cannot find name");
    expect(html).toContain("3 | foo();");
    // The two §4.3 recovery actions sit beneath the output.
    expect(html).toContain("Ask the assistant to fix this");
    expect(html).toContain('href="/repos/proj_1/assistant?fix=task_9"');
    expect(html).toContain("Back to changes");
    // Steps after the failure render as pending, never as failed — only one step ever fails.
    for (const key of ["commit", "version", "deploy"]) {
      expect(html).toContain(`data-step="${key}" data-status="pending"`);
    }
    expect(html.match(/data-status="failed"/g)).toHaveLength(1);
  });

  it("shows the recorded version label on the succeeded version step", () => {
    const steps = initialPublishSteps();
    for (const step of steps) step.status = "succeeded";
    steps.find((s) => s.key === "version")!.detail = "v13";
    const html = renderInRouter(<PipelineStepList steps={steps} />);
    expect(html).toContain("v13");
  });
});
