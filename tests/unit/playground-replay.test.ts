import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadPlaygroundEntriesFromEve,
  type PlaygroundSession,
} from "~/playground/sessions.server";
import type { Target } from "~/chat/playground.server";
import { buildSeedContext } from "~/playground/seed";
import { buildModelDirective } from "~/models/model-directive";
import { buildSystemNotes } from "~/chat/system-note";

function streamResponse(events: unknown[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          events.map((event) => JSON.stringify(event)).join("\n") + "\n",
        ),
      );
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}

const target: Target = {
  deploymentId: "dep_1",
  environmentId: "env_1",
  releaseId: "rel_1",
  url: "https://agent.example.test",
  version: "v1",
  environmentName: "production",
  gitSha: "sha_1",
};

function session(over: Partial<PlaygroundSession> = {}): PlaygroundSession {
  return {
    externalSessionId: "sess_1",
    streamIndex: 100,
    lastVersion: "v1",
    ...over,
  } as PlaygroundSession;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadPlaygroundEntriesFromEve", () => {
  it("replays a running turn from the saved Eve cursor", async () => {
    const at = new Date().toISOString();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(
        streamResponse([
          {
            type: "session.started",
            data: { runtime: { modelId: "m/x" } },
            meta: { at },
          },
          { type: "turn.started", data: { turnId: "turn_0" }, meta: { at } },
          {
            type: "message.received",
            data: { turnId: "turn_0", message: "finish the deploy" },
            meta: { at },
          },
          {
            type: "step.started",
            data: { turnId: "turn_0", sequence: 1 },
            meta: { at },
          },
          {
            type: "message.appended",
            data: { turnId: "turn_0", messageSoFar: "Working on it" },
            meta: { at },
          },
        ]),
      ),
    );

    const entries = await loadPlaygroundEntriesFromEve({
      session: session({ status: "running", streamIndex: 5 }),
      target,
    });

    expect(entries).toMatchObject([
      { role: "user", text: "finish the deploy" },
      {
        role: "assistant",
        text: "Working on it",
        modelId: "m/x",
      },
    ]);
  });

  it("keeps every assistant message of a turn and surfaces ask_question prompts", async () => {
    const at = new Date().toISOString();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(
        streamResponse([
          {
            type: "session.started",
            data: { runtime: { modelId: "m/x" } },
            meta: { at },
          },
          { type: "turn.started", data: { turnId: "turn_0" }, meta: { at } },
          {
            type: "message.received",
            data: { turnId: "turn_0", message: "deploy the landing page" },
            meta: { at },
          },
          {
            type: "message.completed",
            data: { turnId: "turn_0", message: "Checking access." },
            meta: { at },
          },
          {
            type: "step.started",
            data: { turnId: "turn_0", sequence: 1 },
            meta: { at },
          },
          {
            type: "step.completed",
            data: { turnId: "turn_0", sequence: 1 },
            meta: { at },
          },
          {
            type: "message.appended",
            data: { turnId: "turn_0", messageSoFar: "One decision for you:" },
            meta: { at },
          },
          {
            type: "message.completed",
            data: { turnId: "turn_0", message: "One decision for you:" },
            meta: { at },
          },
          {
            type: "input.requested",
            data: {
              turnId: "turn_0",
              requests: [
                {
                  requestId: "r1",
                  display: "select",
                  prompt: "Merge now or wait for review?",
                  options: [
                    { id: "merge", label: "Merge now", style: "primary" },
                    { id: "wait", label: "Wait for review" },
                  ],
                  action: {
                    callId: "r1",
                    kind: "tool-call",
                    toolName: "ask_question",
                    input: { prompt: "Merge now or wait for review?" },
                  },
                },
              ],
            },
            meta: { at },
          },
          { type: "turn.completed", data: { turnId: "turn_0" }, meta: { at } },
          { type: "session.waiting", data: {}, meta: { at } },
        ]),
      ),
    );

    const entries = await loadPlaygroundEntriesFromEve({
      session: session({ streamIndex: 11 }),
      target,
    });

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      role: "user",
      text: "deploy the landing page",
    });
    expect(entries[1]).toMatchObject({
      role: "assistant",
      text: "Checking access.\n\nOne decision for you:",
      inputRequests: [
        {
          requestId: "r1",
          prompt: "Merge now or wait for review?",
          display: "select",
          options: [
            { id: "merge", label: "Merge now", style: "primary" },
            { id: "wait", label: "Wait for review" },
          ],
        },
      ],
    });
    expect(entries[1].steps).toHaveLength(1);
  });

  it("strips the model directive and attributes its model and effort (dynamic agent)", async () => {
    const at = new Date().toISOString();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(
        streamResponse([
          {
            type: "session.started",
            data: { runtime: { modelId: "dynamic:anthropic/claude-sonnet-5" } },
            meta: { at },
          },
          { type: "turn.started", data: { turnId: "turn_0" }, meta: { at } },
          {
            type: "message.received",
            data: { turnId: "turn_0", message: "what model are you?" },
            meta: { at },
          },
          {
            type: "message.completed",
            data: { turnId: "turn_0", message: "The default one." },
            meta: { at },
          },
          { type: "turn.started", data: { turnId: "turn_1" }, meta: { at } },
          {
            type: "message.received",
            data: {
              turnId: "turn_1",
              message:
                "<!-- harnesst:model openai/gpt-5.1 ctx=400000 effort=high -->\n\nand now?",
            },
            meta: { at },
          },
          {
            type: "message.completed",
            data: { turnId: "turn_1", message: "A different one." },
            meta: { at },
          },
        ]),
      ),
    );

    const entries = await loadPlaygroundEntriesFromEve({
      session: session({ streamIndex: 7 }),
      target,
    });

    expect(entries).toMatchObject([
      { role: "user", text: "what model are you?" },
      {
        role: "assistant",
        text: "The default one.",
        modelId: "anthropic/claude-sonnet-5",
      },
      // The directive never shows in the transcript…
      { role: "user", text: "and now?" },
      // …but attributes the turn to the model that actually served it.
      {
        role: "assistant",
        text: "A different one.",
        modelId: "openai/gpt-5.1",
        effort: "high",
      },
    ]);
  });

  it("ignores model directives when the deployed agent's model is static", async () => {
    const at = new Date().toISOString();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(
        streamResponse([
          {
            type: "session.started",
            data: { runtime: { modelId: "anthropic/claude-sonnet-5" } },
            meta: { at },
          },
          { type: "turn.started", data: { turnId: "turn_0" }, meta: { at } },
          {
            type: "message.received",
            data: {
              turnId: "turn_0",
              message: "<!-- harnesst:model openai/gpt-5.1 -->\n\nand now?",
            },
            meta: { at },
          },
          {
            type: "message.completed",
            data: { turnId: "turn_0", message: "Still the static model." },
            meta: { at },
          },
        ]),
      ),
    );

    const entries = await loadPlaygroundEntriesFromEve({
      session: session({ streamIndex: 4 }),
      target,
    });

    // A static agent can't switch — attribution must not claim the directive's model.
    expect(entries).toMatchObject([
      { role: "user", text: "and now?" },
      {
        role: "assistant",
        text: "Still the static model.",
        modelId: "anthropic/claude-sonnet-5",
      },
    ]);
  });

  it("strips a cross-redeploy seed block from the user text (#71)", async () => {
    const at = new Date().toISOString();
    // The reseed turn's sent message: model directive, then the seed block built from the cached
    // transcript, then the user's actual message. Only the plain message must render.
    const seed = buildSeedContext([
      { id: "prev:u", role: "user", text: "Please deploy my thing." },
      {
        id: "prev:a",
        role: "assistant",
        text: "I can't finish this without the credential.",
        inputRequests: [{ requestId: "r0", prompt: "Add it and retry?" }],
      },
    ])!;
    const directive = buildModelDirective({ id: "anthropic/claude-sonnet-5" });
    const sentMessage = `${directive}\n\n${seed}\n\nCan you try again?`;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(
        streamResponse([
          {
            type: "session.started",
            data: { runtime: { modelId: "dynamic:anthropic/claude-sonnet-5" } },
            meta: { at },
          },
          { type: "turn.started", data: { turnId: "turn_0" }, meta: { at } },
          {
            type: "message.received",
            data: { turnId: "turn_0", message: sentMessage },
            meta: { at },
          },
          {
            type: "message.completed",
            data: { turnId: "turn_0", message: "Retried successfully." },
            meta: { at },
          },
        ]),
      ),
    );

    const entries = await loadPlaygroundEntriesFromEve({
      session: session({ streamIndex: 4 }),
      target,
    });

    expect(entries[0]).toMatchObject({
      role: "user",
      text: "Can you try again?",
    });
    // No leaked transcript or markers in the user bubble.
    expect(entries[0].text).not.toContain("Please deploy my thing.");
    expect(entries[0].text).not.toContain("harnesst:context");
    expect(entries[1]).toMatchObject({
      role: "assistant",
      text: "Retried successfully.",
    });
  });

  it("hides harnesst's per-turn system notes from the user's message", async () => {
    const at = new Date().toISOString();
    // The assistant surface prepends its checkout note on EVERY turn, so a note that survives the
    // projection sits above every message the user has ever sent in that conversation.
    const notes = buildSystemNotes([
      "[harnesst] Your working checkout for this conversation is at /workspace/home/checkouts/jthtifwqufzu on branch harnesst/conv-jthtifwqufzu. Do ALL repo edits inside that directory with bash.",
      "[harnesst] From your last sync: skipped logo.png (binary).",
    ])!;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(
        streamResponse([
          { type: "turn.started", data: { turnId: "turn_0" }, meta: { at } },
          {
            type: "message.received",
            data: {
              turnId: "turn_0",
              message: `${notes}\n\nmake the button blue`,
            },
            meta: { at },
          },
          // A conversation that predates the wrapper: the same notes, sent bare.
          { type: "turn.started", data: { turnId: "turn_1" }, meta: { at } },
          {
            type: "message.received",
            data: {
              turnId: "turn_1",
              message:
                "[harnesst] Your working checkout for this conversation is at /workspace/home/checkouts/jthtifwqufzu on branch harnesst/conv-jthtifwqufzu.\n\nand now make it green",
            },
            meta: { at },
          },
          {
            type: "message.completed",
            data: { turnId: "turn_1", message: "Done." },
            meta: { at },
          },
        ]),
      ),
    );

    const entries = await loadPlaygroundEntriesFromEve({
      session: session({ streamIndex: 4 }),
      target,
    });

    expect(entries[0]).toMatchObject({
      role: "user",
      text: "make the button blue",
    });
    expect(entries[1]).toMatchObject({
      role: "user",
      text: "and now make it green",
    });
    for (const entry of entries) {
      expect(entry.text).not.toContain("[harnesst]");
      expect(entry.text).not.toContain("harnesst:note");
    }
  });

  it("surfaces a stopped or timed-out turn instead of an empty assistant reply", async () => {
    const at = new Date().toISOString();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(
        streamResponse([
          {
            type: "turn.started",
            data: { turnId: "turn_0" },
            meta: { at },
          },
          {
            type: "message.received",
            data: { turnId: "turn_0", message: "work for a long time" },
            meta: { at },
          },
          {
            type: "step.started",
            data: { turnId: "turn_0", sequence: 1 },
            meta: { at },
          },
          {
            type: "step.completed",
            data: { turnId: "turn_0", sequence: 1 },
            meta: { at },
          },
        ]),
      ),
    );

    const entries = await loadPlaygroundEntriesFromEve({
      session: session({ status: "failed", streamIndex: 4 }),
      target,
    });

    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({
      role: "assistant",
      text: "",
      error: expect.stringContaining("stopped before harnesst recorded"),
    });
  });

  it("normalizes a transient provider turn.failed into a friendly, retryable message", async () => {
    const at = new Date().toISOString();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(
        streamResponse([
          { type: "turn.started", data: { turnId: "turn_0" }, meta: { at } },
          {
            type: "message.received",
            data: { turnId: "turn_0", message: "summarize the repo" },
            meta: { at },
          },
          {
            type: "turn.failed",
            data: {
              turnId: "turn_0",
              message: "The server had an error processing your request.",
              code: "MODEL_CALL_FAILED",
              details: {
                detail:
                  "Error: The server had an error processing your request\n      at normalizeModelStreamError (file:///app/.output/server/_libs/eve.mjs:56852:10)",
              },
            },
            meta: { at },
          },
        ]),
      ),
    );

    const entries = await loadPlaygroundEntriesFromEve({
      session: session({ status: "failed", streamIndex: 3 }),
      target,
    });

    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({
      role: "assistant",
      error: "The model provider had a temporary error. Retry your message.",
      errorRetryable: true,
    });
    expect(entries[1].errorDetail).toContain("eve.mjs");
  });

  // The exact trail a GitHub-homed FOH session produced in production on 2026-07-27: turn 0 asked a
  // question and parked (no reply, by design), the human answered from the inbox, and turn 1 died on
  // an overloaded provider. Both entries were then wrong — the parked question was labelled as a
  // turn that "stopped before harnesst recorded a final reply", and the failure offered a Retry that
  // the channel-homed send path refuses.
  const parkedThenFailedOnChannel = (at: string) => [
    { type: "turn.started", data: { turnId: "turn_0" }, meta: { at } },
    {
      type: "message.received",
      data: { turnId: "turn_0", message: "write me a .gitignore" },
      meta: { at },
    },
    {
      type: "input.requested",
      data: {
        turnId: "turn_0",
        requests: [
          {
            requestId: "r1",
            display: "select",
            prompt: "Which language toolchain should the .gitignore target?",
            options: [{ id: "node", label: "Node.js" }],
          },
        ],
      },
      meta: { at },
    },
    { type: "turn.completed", data: { turnId: "turn_0" }, meta: { at } },
    { type: "turn.started", data: { turnId: "turn_1" }, meta: { at } },
    {
      type: "message.received",
      data: { turnId: "turn_1", message: "Node.js" },
      meta: { at },
    },
    {
      type: "turn.failed",
      data: {
        turnId: "turn_1",
        message: "Our servers are currently overloaded. Please try again later.",
        code: "MODEL_CALL_FAILED",
      },
      meta: { at },
    },
  ];

  const githubSession = () =>
    session({
      status: "failed",
      streamIndex: 7,
      resumeVia: {
        channel: "github",
        routePath: "/eve/v1/github/harnesst/answer",
        rawToken: "repo:1310524517:issue:1",
        state: {},
      },
    });

  it("does not offer a retry that a channel-homed session would refuse", async () => {
    const at = new Date().toISOString();
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(streamResponse(parkedThenFailedOnChannel(at))),
    );

    const entries = await loadPlaygroundEntriesFromEve({
      session: githubSession(),
      target,
    });

    const failed = entries.at(-1)!;
    expect(failed.errorRetryable).toBe(false);
    expect(failed.error).toContain("GitHub thread");
    expect(failed.error).not.toContain("Retry your message");
    expect(failed.errorDetail).toContain("overloaded");
  });

  it("does not defame the parked turn when a LATER turn fails the session", async () => {
    const at = new Date().toISOString();
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(streamResponse(parkedThenFailedOnChannel(at))),
    );

    const entries = await loadPlaygroundEntriesFromEve({
      session: githubSession(),
      target,
    });

    // A turn that ended by ASKING has no reply by design; only the tail turn can borrow the
    // session-level failure. Before the fix this read "The turn stopped before harnesst recorded a
    // final reply" — printed directly above the question the human was sent there to answer.
    const parked = entries.find((e) => e.inputRequests?.length)!;
    expect(parked.error).toBeNull();
  });

  it("keeps a non-transient turn.failed specific and non-retryable", async () => {
    const at = new Date().toISOString();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(
        streamResponse([
          { type: "turn.started", data: { turnId: "turn_0" }, meta: { at } },
          {
            type: "message.received",
            data: { turnId: "turn_0", message: "use a bad model" },
            meta: { at },
          },
          {
            type: "turn.failed",
            data: {
              turnId: "turn_0",
              message: "Model 'gpt-9' not found",
              code: "MODEL_NOT_FOUND",
            },
            meta: { at },
          },
        ]),
      ),
    );

    const entries = await loadPlaygroundEntriesFromEve({
      session: session({ status: "failed", streamIndex: 3 }),
      target,
    });

    expect(entries).toHaveLength(2);
    expect(entries[1].role).toBe("assistant");
    expect(entries[1].error).toContain("not found");
    expect(entries[1].errorRetryable).toBe(false);
  });
});
