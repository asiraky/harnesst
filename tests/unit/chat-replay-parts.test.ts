import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("~/foh/artifact-store.server", () => ({
  listArtifactsForSession: async () => [],
}));

import { streamTurn, type TalkEvent } from "~/agent/talk.server";
import { ReasoningAccumulator } from "~/chat/reasoning";
import { buildModelDirective } from "~/models/model-directive";
import {
  projectEventsToEntries,
  type PlaygroundSession,
} from "~/playground/sessions.server";

type EveEvent = Parameters<typeof projectEventsToEntries>[0][number];

const at = "2026-03-01T10:00:00.000Z";
const later = "2026-03-01T10:00:09.000Z";

function session(over: Partial<PlaygroundSession> = {}): PlaygroundSession {
  return {
    projectId: "proj",
    id: "sess",
    externalSessionId: "eve_1",
    streamIndex: 100,
    lastVersion: "v1",
    ...over,
  } as PlaygroundSession;
}

describe("ReasoningAccumulator", () => {
  it("tracks the open block from cumulative appends and joins blocks with a blank line", () => {
    const r = new ReasoningAccumulator();
    expect(r.apply("reasoning.appended", { reasoningSoFar: "Think" })).toBe(true);
    r.apply("reasoning.appended", { reasoningSoFar: "Thinking hard" });
    r.apply("reasoning.completed", { reasoning: "Thinking hard." });
    r.apply("reasoning.appended", { reasoningDelta: "Then " });
    r.apply("reasoning.appended", { reasoningDelta: "act" });
    expect(r.text()).toBe("Thinking hard.\n\nThen act");
  });

  it("accepts a completed block with no appends, and ignores other events", () => {
    const r = new ReasoningAccumulator();
    expect(r.apply("message.appended", { messageSoFar: "x" })).toBe(false);
    r.apply("reasoning.completed", { reasoning: "Plan." });
    expect(r.text()).toBe("Plan.");
  });

  it("is null when only blank reasoning arrived", () => {
    const r = new ReasoningAccumulator();
    r.apply("reasoning.completed", { reasoning: "  " });
    expect(r.text()).toBeNull();
  });
});

describe("projectEventsToEntries — parts, attachments, reasoning, actions", () => {
  const sha = "c".repeat(64);
  const uploads = {
    index: [
      {
        sha256: sha,
        name: "chart.png",
        mediaType: "image/png",
        size: 42,
        createdAt: "2026-03-01T09:59:59.000Z",
      },
    ],
    urlFor: (s: string) => `/api/chat/uploads/proj/sess/${s}`,
  };

  function turnEvents(
    parts: unknown[],
    summary: string,
    extra: EveEvent[] = [],
  ): EveEvent[] {
    return [
      {
        type: "session.started",
        data: { runtime: { modelId: "dynamic:m/base" } },
        meta: { at },
      },
      { type: "turn.started", data: { turnId: "turn_0" }, meta: { at } },
      {
        type: "message.received",
        data: { turnId: "turn_0", message: summary, parts },
        meta: { at },
      },
      ...extra,
      {
        type: "message.completed",
        data: { turnId: "turn_0", message: "Done." },
        meta: { at: later },
      },
      { type: "turn.completed", data: { turnId: "turn_0" }, meta: { at: later } },
    ];
  }

  it("reads the user's text from the text parts and resolves file parts to stored uploads", () => {
    const directive = buildModelDirective({ id: "m/picked" }, "f".repeat(64));
    const entries = projectEventsToEntries(
      turnEvents(
        [
          { type: "text", text: `${directive}\n\nwhat's in this chart?` },
          { type: "file", filename: "chart.png", mediaType: "image/png", size: 42 },
        ],
        `${directive}\n\nwhat's in this chart?\n[file: chart.png (image/png)]`,
      ),
      session(),
      uploads,
    );
    const user = entries.find((e) => e.role === "user")!;
    expect(user.text).toBe("what's in this chart?");
    expect(user.attachments).toEqual([
      {
        id: sha,
        name: "chart.png",
        mediaType: "image/png",
        size: 42,
        url: `/api/chat/uploads/proj/sess/${sha}`,
      },
    ]);
    expect(user.at).toBe(at);
    const assistant = entries.find((e) => e.role === "assistant")!;
    expect(assistant.modelId).toBe("m/picked");
    expect(assistant.at).toBe(later);
  });

  it("keeps a files-only message as a user entry with empty text", () => {
    const entries = projectEventsToEntries(
      turnEvents(
        [{ type: "file", filename: "chart.png", mediaType: "image/png", size: 42 }],
        "[file: chart.png (image/png)]",
      ),
      session(),
      uploads,
    );
    const user = entries.find((e) => e.role === "user")!;
    expect(user.text).toBe("");
    expect(user.attachments).toHaveLength(1);
  });

  it("renders attachment chips without links when no upload index is supplied", () => {
    const entries = projectEventsToEntries(
      turnEvents(
        [
          { type: "text", text: "hi" },
          { type: "file", filename: "chart.png", mediaType: "image/png", size: 42 },
        ],
        "hi\n[file: chart.png (image/png)]",
      ),
      session(),
    );
    const user = entries.find((e) => e.role === "user")!;
    expect(user.attachments?.[0]?.url).toBeNull();
  });

  it("collects reasoning and tool detail onto the assistant entry", () => {
    const entries = projectEventsToEntries(
      turnEvents([], "run it", [
        { type: "step.started", data: { turnId: "turn_0", sequence: 1 }, meta: { at } },
        {
          type: "reasoning.appended",
          data: { turnId: "turn_0", reasoningSoFar: "I should list" },
          meta: { at },
        },
        {
          type: "reasoning.completed",
          data: { turnId: "turn_0", reasoning: "I should list files." },
          meta: { at },
        },
        {
          type: "actions.requested",
          data: {
            turnId: "turn_0",
            sequence: 1,
            actions: [{ callId: "c1", toolName: "bash", input: { command: "ls" } }],
          },
          meta: { at },
        },
        {
          type: "action.result",
          data: {
            turnId: "turn_0",
            status: "completed",
            result: {
              callId: "c1",
              output: { stdout: "a.txt\n", stderr: "", exitCode: 2 },
            },
          },
          meta: { at },
        },
        {
          type: "step.completed",
          data: { turnId: "turn_0", sequence: 1 },
          meta: { at },
        },
      ]).map((e) =>
        // A plain-string message (no parts) must still project as before.
        e.type === "message.received"
          ? { ...e, data: { turnId: "turn_0", message: "run it" } }
          : e,
      ),
      session(),
    );
    const user = entries.find((e) => e.role === "user")!;
    expect(user.text).toBe("run it");
    expect(user.attachments).toBeUndefined();
    const assistant = entries.find((e) => e.role === "assistant")!;
    expect(assistant.reasoning).toBe("I should list files.");
    expect(assistant.steps?.[0]?.actions).toEqual([
      {
        toolName: "bash",
        summary: "ls",
        input: "ls",
        output: "a.txt",
        exitCode: 2,
        isError: true,
      },
    ]);
  });
});

describe("streamTurn with attachments", () => {
  afterEach(() => vi.unstubAllGlobals());

  function ndjson(events: unknown[]): Response {
    return new Response(events.map((e) => JSON.stringify(e)).join("\n") + "\n", {
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
    });
  }

  it("sends the content array and recognises eve's summarised echo as its own turn", async () => {
    const at = new Date(Date.now() + 1_000).toISOString();
    const message = [
      { type: "text" as const, text: "look" },
      {
        type: "file" as const,
        data: "iVBORw0KGgo=",
        mediaType: "image/png",
        filename: "a.png",
      },
    ];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ continuationToken: "tok" }), {
          status: 202,
          headers: { "content-type": "application/json", "x-eve-session-id": "s1" },
        }),
      )
      .mockResolvedValueOnce(
        ndjson([
          { type: "session.started", data: { runtime: { modelId: "m/x" } }, meta: { at } },
          {
            type: "message.received",
            data: { turnId: "t1", message: "look\n[file: a.png (image/png)]" },
            meta: { at },
          },
          {
            type: "reasoning.appended",
            data: { turnId: "t1", reasoningSoFar: "Hmm" },
            meta: { at },
          },
          {
            type: "message.completed",
            data: { turnId: "t1", message: "A cat." },
            meta: { at },
          },
          { type: "turn.completed", data: { turnId: "t1" }, meta: { at } },
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const out: TalkEvent[] = [];
    for await (const event of streamTurn({ baseUrl: "https://agent.test", message })) {
      out.push(event);
    }

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as {
      message: unknown;
    };
    expect(body.message).toEqual(message);
    expect(out.filter((e) => e.kind === "reasoning")).toEqual([
      { kind: "reasoning", text: "Hmm" },
    ]);
    const done = out.at(-1);
    expect(done?.kind === "done" && done.result.ok).toBe(true);
    expect(done?.kind === "done" && done.result.reply).toBe("A cat.");
    expect(done?.kind === "done" && done.result.reasoning).toBe("Hmm");
  });

  it("explains a refused attachment send from a pre-attachments build", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Missing message." }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const out: TalkEvent[] = [];
    for await (const event of streamTurn({
      baseUrl: "https://agent.test",
      message: [{ type: "file", data: "AA==", mediaType: "text/plain", filename: "a.txt" }],
    })) {
      out.push(event);
    }
    const done = out.at(-1);
    expect(done?.kind === "done" && done.result.ok).toBe(false);
    expect(done?.kind === "done" && done.result.error).toMatch(/predates attachments/);
  });
});
