/**
 * The workspace task strip's row (issue #142, rebuilt on pipeline steps by #225 §4.3): the
 * compact one-liner is DERIVED from the task's `steps` via the same runningStepSummary the
 * publish panel's full stepper state uses — one source of truth, two densities. SSR string
 * assertions in a routes stub (the row's dismiss fetcher needs a data router), matching the
 * repo's component-test pattern.
 */
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";

import { TaskRow, type WorkspaceTask } from "~/components/workspace-tasks";

function renderRow(task: WorkspaceTask): string {
  const Stub = createRoutesStub([
    { path: "*", Component: () => <TaskRow task={task} projectId="proj_1" /> },
  ]);
  // Strip React's text-node comment markers so interpolated copy matches as one string.
  return renderToString(<Stub initialEntries={["/"]} />).replace(/<!-- -->/g, "");
}

const base: WorkspaceTask = {
  id: "task_1",
  kind: "publish",
  subjectKey: "publish",
  label: "Publishing 2 changes",
  steps: null,
  status: "running",
  originUrl: "/repos/proj_1",
  resultUrl: null,
  error: null,
  createdAt: "2026-07-01T00:00:00.000Z",
};

describe("TaskRow", () => {
  it("derives the running one-liner from the running step's label + detail", () => {
    const html = renderRow({
      ...base,
      steps: [
        { key: "check", label: "Checking your changes", status: "succeeded" },
        {
          key: "build",
          label: "Building your agents",
          status: "running",
          detail: "ivy (1 of 2)",
        },
        { key: "commit", label: "Saving to your repository", status: "pending" },
      ],
    });
    expect(html).toContain("Publishing 2 changes");
    expect(html).toContain("— Building your agents — ivy (1 of 2)");
  });

  it("shows just the label while no step is running yet", () => {
    const html = renderRow({ ...base, steps: null });
    expect(html).toContain("Publishing 2 changes");
    expect(html).not.toContain("— ");
  });

  it("renders a succeeded task with its result link and a dismiss", () => {
    const html = renderRow({
      ...base,
      status: "succeeded",
      resultUrl: "/repos/proj_1?released=v3",
    });
    expect(html).toContain("View result →");
    expect(html).toContain('href="/repos/proj_1?released=v3"');
    expect(html).toContain('aria-label="Dismiss"');
  });

  it("renders a failed task with the first line of its error", () => {
    const html = renderRow({
      ...base,
      status: "failed",
      error: "The build failed — nothing was published\nsecond line never shows",
    });
    expect(html).toContain("failed");
    // The visible text is the first line only (the full error stays in the tooltip title).
    expect(html).toContain(" — The build failed — nothing was published</span>");
  });
});
