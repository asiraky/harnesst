/**
 * The Publish control + panel (issue #225 §4.1/§4.2): the pure state logic (grouping, action
 * badges, control states, disabled reasons) and the SSR rendering of the presentational
 * pieces — createdBy attribution (assistant vs teammate), badges, group headers, and the
 * pipeline step list. Components render via renderToString inside a routes stub (the rows'
 * fetchers need a data router); assertions are string containment on the HTML.
 */
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  memberProgress,
  phaseBarModel,
  publishControlState,
  publishDisabledReason,
  publishedVersion,
  resolveDeployProgress,
  runningStepSummary,
  type DeploymentSnapshot,
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
  const render = (state: PublishControlState, changeRevision = "revision-1") =>
    renderInRouter(
      <PublishNudgeBanner
        state={state}
        projectId="p1"
        changeRevision={changeRevision}
        onOpen={open}
      />,
    );
  afterEach(() => vi.unstubAllGlobals());

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

  it("revives a dismissed nudge when saved drafts change without changing count", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => "ready:3:revision-1",
      setItem: vi.fn(),
    });
    expect(render({ kind: "ready", count: 3 }, "revision-1")).toBe("");
    expect(render({ kind: "ready", count: 3 }, "revision-2")).toContain(
      "3 saved changes aren&#x27;t live yet",
    );
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

describe("PipelineStepList (issue #375 redesign)", () => {
  it("renders every phase segment from the start, skip reasons, and member cards", () => {
    const steps: PipelineStep[] = [
      { key: "check", label: "Checking your changes", status: "succeeded" },
      {
        key: "build",
        label: "Building your agents",
        status: "running",
        detail: "1 of 2",
        substeps: [
          { label: "ivy", status: "succeeded", startedAt: "2026-08-14T00:00:00.000Z" },
          { label: "otto", status: "running", startedAt: "2026-08-14T00:00:05.000Z" },
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
    // Every phase is a bar segment carrying its live status — an absent phase reads as a bug.
    for (const key of ["check", "build", "commit", "version", "deploy"]) {
      expect(html).toContain(`data-phase="${key}"`);
    }
    expect(html).toContain('data-phase="build" data-status="running"');
    expect(html).toContain('data-phase="version" data-status="skipped"');
    expect(html).toContain(
      "Skipped — This change only affects the assistant&#x27;s configuration",
    );
    // One card per member, phase text and all.
    expect(html).toContain('data-member="ivy" data-phase="built"');
    expect(html).toContain('data-member="otto" data-phase="building"');
    expect(html).toContain("Building image…");
    // The running step's one-liner shows the completion counter.
    expect(html).toContain("Building your agents — 1 of 2");
  });

  it("live-announces only the running step", () => {
    const steps = initialPublishSteps();
    steps[0].status = "running";
    steps[0].detail = "orphan gate";
    const html = renderInRouter(<PipelineStepList steps={steps} />);
    expect(html.match(/aria-live="polite"/g)).toHaveLength(1);
    expect(html).toContain("orphan gate");
  });

  it("auto-expands a failure — output and recovery actions render without interaction — and later phases stay pending", () => {
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
    // Phases after the failure render as pending, never as failed — only one step ever fails.
    for (const key of ["commit", "version", "deploy"]) {
      expect(html).toContain(`data-phase="${key}" data-status="pending"`);
    }
    expect(html.match(/data-status="failed"/g)).toHaveLength(1);
  });

  it("puts a member-scoped failure on its card, not duplicated in the aggregate block", () => {
    const steps = initialPublishSteps();
    steps[0].status = "succeeded";
    steps[1].status = "failed";
    steps[1].error =
      "The build failed (`agents/otto/agent`) — nothing was published:\n\nerror TS2304";
    steps[1].substeps = [
      { label: "ivy", status: "succeeded" },
      { label: "otto", status: "failed", error: "error TS2304" },
    ];
    const html = renderInRouter(<PipelineStepList steps={steps} onBackToChanges={() => {}} />);
    // The failed card is red and carries its own output…
    expect(html).toContain('data-member="otto" data-phase="failed"');
    expect(html.match(/error TS2304/g)).toHaveLength(1);
    // …and the aggregate ("The build failed…") is not repeated below the cards.
    expect(html).not.toContain("nothing was published");
    expect(html).toContain("Back to changes");
  });

  it("renders the all-green settled state with no spinner and no failure block", () => {
    const steps = initialPublishSteps();
    for (const step of steps) step.status = "succeeded";
    const html = renderInRouter(<PipelineStepList steps={steps} />);
    for (const key of ["check", "build", "commit", "version", "deploy"]) {
      expect(html).toContain(`data-phase="${key}" data-status="succeeded"`);
    }
    expect(html).not.toContain("animate-spin");
    expect(html).not.toContain("<pre");
  });

  it("shows a ticking elapsed time on an in-flight member card", () => {
    const steps = initialPublishSteps();
    steps[1].status = "running";
    steps[1].substeps = [
      {
        label: "ivy",
        status: "running",
        // Started a minute ago — the card renders "1m Ns", not nothing.
        startedAt: new Date(Date.now() - 61_000).toISOString(),
      },
    ];
    const html = renderInRouter(<PipelineStepList steps={steps} />);
    expect(html).toMatch(/1m \d+s/);
  });
});

describe("phaseBarModel", () => {
  it("maps the five steps to compact segments, carrying status and skip reason", () => {
    const steps = initialPublishSteps();
    steps[0].status = "succeeded";
    steps[1].status = "skipped";
    steps[1].reason = "assistant only";
    expect(phaseBarModel(steps)).toEqual([
      { key: "check", label: "Check", status: "succeeded" },
      { key: "build", label: "Build", status: "skipped", reason: "assistant only" },
      { key: "commit", label: "Save", status: "pending" },
      { key: "version", label: "Version", status: "pending" },
      { key: "deploy", label: "Deploy", status: "pending" },
    ]);
  });

  it("renders a full pending bar before the first poll returns steps", () => {
    const segments = phaseBarModel(null);
    expect(segments).toHaveLength(5);
    expect(segments.every((s) => s.status === "pending")).toBe(true);
  });
});

describe("memberProgress", () => {
  const T0 = "2026-08-14T00:00:00.000Z";
  const T1 = "2026-08-14T00:01:00.000Z";
  const T2 = "2026-08-14T00:02:00.000Z";

  function stepsWith(over: {
    build?: PipelineStep["substeps"];
    deploy?: PipelineStep["substeps"];
  }): PipelineStep[] {
    const steps = initialPublishSteps();
    if (over.build) steps[1].substeps = over.build;
    if (over.deploy) steps[4].substeps = over.deploy;
    return steps;
  }

  it("joins build and deploy substeps by label: build start, deploy outcome", () => {
    const cards = memberProgress(
      stepsWith({
        build: [{ label: "ivy", status: "succeeded", startedAt: T0, finishedAt: T1 }],
        deploy: [
          { label: "ivy", status: "succeeded", deploymentId: "dep_1", finishedAt: T2 },
        ],
      }),
    );
    // The card's clock starts at the BUILD start (the member's first activity), ends at the
    // deploy's finish, and the deploy substep's resolved status names the phase.
    expect(cards).toEqual([
      { label: "ivy", phase: "live", startedAt: T0, finishedAt: T2 },
    ]);
  });

  it("an untouched member (no build substep) starts queued and its clock is the deploy's", () => {
    const cards = memberProgress(
      stepsWith({
        build: [{ label: "ivy", status: "succeeded", startedAt: T0 }],
        deploy: [
          { label: "ivy", status: "pending" },
          { label: "otto", status: "pending", startedAt: T1 },
        ],
      }),
    );
    expect(cards).toEqual([
      // Built, waiting on the deploy pool…
      { label: "ivy", phase: "built", startedAt: T0 },
      // …vs never built at all: queued.
      { label: "otto", phase: "queued", startedAt: T1 },
    ]);
  });

  it("a running deploy substep is 'starting'; a failed one is 'failed' with its error", () => {
    const cards = memberProgress(
      stepsWith({
        deploy: [
          { label: "ivy", status: "running", startedAt: T1 },
          { label: "otto", status: "failed", startedAt: T1, finishedAt: T2, error: "boom" },
        ],
      }),
    );
    expect(cards).toEqual([
      { label: "ivy", phase: "starting", startedAt: T1 },
      { label: "otto", phase: "failed", startedAt: T1, finishedAt: T2, error: "boom" },
    ]);
  });

  it("a failed build outranks the member's deploy substep — the deploy never really ran", () => {
    const cards = memberProgress(
      stepsWith({
        build: [
          { label: "ivy", status: "failed", startedAt: T0, finishedAt: T1, error: "TS2304" },
        ],
        deploy: [{ label: "ivy", status: "pending" }],
      }),
    );
    expect(cards).toEqual([
      { label: "ivy", phase: "failed", startedAt: T0, finishedAt: T1, error: "TS2304" },
    ]);
  });

  it("members mid-build (no deploy substeps yet) map straight from the build statuses", () => {
    const cards = memberProgress(
      stepsWith({
        build: [
          { label: "ivy", status: "running", startedAt: T0 },
          { label: "otto", status: "pending" },
        ],
      }),
    );
    expect(cards).toEqual([
      { label: "ivy", phase: "building", startedAt: T0 },
      { label: "otto", phase: "queued" },
    ]);
  });

  it("degrades without timestamps (pre-#375 rows): cards render, just with no timer fields", () => {
    const cards = memberProgress(
      stepsWith({ deploy: [{ label: "ivy", status: "succeeded" }] }),
    );
    expect(cards).toEqual([{ label: "ivy", phase: "live" }]);
  });

  it("is empty when there are no substeps at all (single-agent pre-deploy, or no steps)", () => {
    expect(memberProgress(initialPublishSteps())).toEqual([]);
    expect(memberProgress(null)).toEqual([]);
  });
});

describe("resolveDeployProgress — row timestamps (issue #375)", () => {
  it("merges the deployment row's clock into the substep: created = started, updated = finished", () => {
    const steps = initialPublishSteps();
    steps[4].status = "succeeded";
    steps[4].substeps = [{ label: "ivy", status: "succeeded", deploymentId: "dep_1" }];
    const rows = new Map<string, DeploymentSnapshot>([
      [
        "dep_1",
        {
          status: "live",
          errorDetail: null,
          createdAt: "2026-08-14T00:00:00.000Z",
          updatedAt: "2026-08-14T00:00:30.000Z",
        },
      ],
    ]);
    const resolved = resolveDeployProgress(steps, rows);
    expect(resolved?.[4].substeps?.[0]).toMatchObject({
      status: "succeeded",
      startedAt: "2026-08-14T00:00:00.000Z",
      finishedAt: "2026-08-14T00:00:30.000Z",
    });
  });

  it("a still-starting row carries its start but no finish", () => {
    const steps = initialPublishSteps();
    steps[4].status = "succeeded";
    steps[4].substeps = [{ label: "ivy", status: "succeeded", deploymentId: "dep_1" }];
    const rows = new Map<string, DeploymentSnapshot>([
      ["dep_1", { status: "building", errorDetail: null, createdAt: "2026-08-14T00:00:00.000Z" }],
    ]);
    const sub = resolveDeployProgress(steps, rows)?.[4].substeps?.[0];
    expect(sub).toMatchObject({ status: "running", startedAt: "2026-08-14T00:00:00.000Z" });
    expect(sub?.finishedAt).toBeUndefined();
  });

  it("a replaced row keeps its start but drops the finish — updatedAt is the LATER drain/stop", () => {
    const steps = initialPublishSteps();
    steps[4].status = "succeeded";
    steps[4].substeps = [{ label: "ivy", status: "succeeded", deploymentId: "dep_1" }];
    const rows = new Map<string, DeploymentSnapshot>([
      [
        "dep_1",
        {
          status: "stopped",
          errorDetail: null,
          createdAt: "2026-08-14T00:00:00.000Z",
          // Twelve hours later — when it was replaced, NOT when it came up.
          updatedAt: "2026-08-14T12:00:00.000Z",
        },
      ],
    ]);
    const sub = resolveDeployProgress(steps, rows)?.[4].substeps?.[0];
    expect(sub).toMatchObject({ status: "succeeded", startedAt: "2026-08-14T00:00:00.000Z" });
    expect(sub?.finishedAt).toBeUndefined();
  });

  it("rolls the latest substep finish up into the deploy step — not the queue-time stamp", () => {
    const steps = initialPublishSteps();
    steps[4].status = "succeeded";
    // The pipeline stamped the step finished the moment the jobs were QUEUED…
    steps[4].startedAt = "2026-08-14T00:00:00.000Z";
    steps[4].finishedAt = "2026-08-14T00:00:30.000Z";
    steps[4].substeps = [
      { label: "ivy", status: "succeeded", deploymentId: "dep_1" },
      { label: "otto", status: "succeeded", deploymentId: "dep_2" },
    ];
    const rows = new Map<string, DeploymentSnapshot>([
      ["dep_1", { status: "live", errorDetail: null, updatedAt: "2026-08-14T00:02:00.000Z" }],
      ["dep_2", { status: "live", errorDetail: null, updatedAt: "2026-08-14T00:04:00.000Z" }],
    ]);
    const step = resolveDeployProgress(steps, rows)?.[4];
    // …but the phase really ended when the last agent came up; without this the overall
    // timer snaps back from four minutes to thirty seconds on success.
    expect(step?.status).toBe("succeeded");
    expect(step?.finishedAt).toBe("2026-08-14T00:04:00.000Z");
  });

  it("rows without timestamps (older readers) still resolve statuses — no timer fields", () => {
    const steps = initialPublishSteps();
    steps[4].status = "succeeded";
    steps[4].substeps = [{ label: "ivy", status: "succeeded", deploymentId: "dep_1" }];
    const rows = new Map<string, DeploymentSnapshot>([
      ["dep_1", { status: "failed", errorDetail: "port in use" }],
    ]);
    const sub = resolveDeployProgress(steps, rows)?.[4].substeps?.[0];
    expect(sub).toMatchObject({ status: "failed", error: "port in use" });
    expect(sub?.startedAt).toBeUndefined();
  });
});
