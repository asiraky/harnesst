/**
 * The transcript's persisted-entry renderer (#271): a still-running turn rebuilt from the
 * event cache — switching away from a session mid-turn and back — has steps but no reply
 * text yet, and must NOT render the "(empty reply)" fallback. All three transcript views
 * share the guard; the assistant route is the original from #193.
 */
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ChatEntry } from "~/chat/types";
import { AgentEntry as FohAgentEntry } from "~/routes/foh.session";
import { AgentEntry as PlaygroundAgentEntry } from "~/routes/projects.$projectId.playground";
import { AgentEntry as AssistantAgentEntry } from "~/routes/projects.$projectId.assistant";

function entry(overrides: Partial<ChatEntry> = {}): ChatEntry {
  return {
    id: "entry_1",
    role: "assistant",
    text: "",
    steps: [{ kind: "tool", label: "Read", detail: "app/root.tsx" }],
    ...overrides,
  } as ChatEntry;
}

const VIEWS = [
  ["foh", FohAgentEntry],
  ["playground", PlaygroundAgentEntry],
  ["assistant", AssistantAgentEntry],
] as const;

describe.each(VIEWS)("%s AgentEntry", (_name, AgentEntry) => {
  it("suppresses the empty bubble while the turn is still running", () => {
    const html = renderToString(<AgentEntry entry={entry()} running />);
    expect(html).not.toContain("(empty reply)");
    expect(html).toContain("Still working");
  });

  it("keeps the empty-reply fallback on a settled turn", () => {
    expect(renderToString(<AgentEntry entry={entry()} />)).toContain(
      "(empty reply)",
    );
  });

  it("shows reply text a running turn has already emitted", () => {
    const html = renderToString(
      <AgentEntry entry={entry({ text: "partial answer" })} running />,
    );
    expect(html).toContain("partial answer");
    expect(html).not.toContain("(empty reply)");
  });

  it("shows an error on a running turn", () => {
    const html = renderToString(
      <AgentEntry entry={entry({ error: "eve stream died" })} running />,
    );
    expect(html).toContain("eve stream died");
  });

  it("shows a pending input request on a running turn", () => {
    const html = renderToString(
      <AgentEntry
        entry={entry({
          inputRequests: [
            { requestId: "req_1", prompt: "Which branch?" },
          ] as ChatEntry["inputRequests"],
        })}
        running
      />,
    );
    expect(html).toContain("Which branch?");
    expect(html).not.toContain("(empty reply)");
  });
});
