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
  PublishControlButton,
  PublishReviewChanges,
} from "~/components/publish";
import type { DraftChange, PipelineStep } from "~/data/ports";
import {
  changeAction,
  groupDrafts,
  initialPublishSteps,
  publishControlState,
  publishDisabledReason,
  runningStepSummary,
  type PublishChangeRow,
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

describe("PublishControlButton", () => {
  const open = () => {};

  it("renders quiet Live text — not a button — when deployed with nothing saved", () => {
    const html = renderInRouter(
      <PublishControlButton state={{ kind: "live", version: "v12" }} onOpen={open} />,
    );
    expect(html).toContain("Live · v12");
    expect(html).not.toContain("<button");
  });

  it("renders Not deployed yet with a Publish button for a never-deployed repo", () => {
    const html = renderInRouter(
      <PublishControlButton state={{ kind: "never-deployed" }} onOpen={open} />,
    );
    expect(html).toContain("Not deployed yet");
    expect(html).toContain("Publish</button>");
  });

  it("renders the change count on the primary button", () => {
    expect(
      renderInRouter(
        <PublishControlButton state={{ kind: "ready", count: 3 }} onOpen={open} />,
      ),
    ).toContain("Publish 3 changes");
    expect(
      renderInRouter(
        <PublishControlButton state={{ kind: "ready", count: 1 }} onOpen={open} />,
      ),
    ).toContain("Publish 1 change<");
  });

  it("renders the live running summary while a publish runs", () => {
    const html = renderInRouter(
      <PublishControlButton
        state={{ kind: "running", summary: "Building your agents — ivy (1 of 2)" }}
        onOpen={open}
      />,
    );
    expect(html).toContain("Building your agents — ivy (1 of 2)");
    const fallback = renderInRouter(
      <PublishControlButton state={{ kind: "running", summary: null }} onOpen={open} />,
    );
    expect(fallback).toContain("Publishing…");
  });

  it("renders the destructive failed state", () => {
    const html = renderInRouter(
      <PublishControlButton state={{ kind: "failed" }} onOpen={open} />,
    );
    expect(html).toContain("Publish failed");
    expect(html).toContain('data-variant="destructive"');
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
});
