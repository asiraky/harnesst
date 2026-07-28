/**
 * Assistant streaming route (app/routes/api.projects.$projectId.assistant.stream.ts) — the
 * per-turn context it hands the model, with every collaborator mocked.
 *
 * The model must keep learning which checkout it may edit (a model that goes hunting with `find`
 * edits a stale checkout and its work is never staged), and the human must never see that note:
 * it rode bare on the sent message, so eve recorded it and the transcript replayed it above every
 * message the user had ever typed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionAuth: vi.fn(),
  requireProject: vi.fn(),
  ensureAssistantInstance: vi.fn(),
  ensureConversationCheckout: vi.fn(),
  getCheckoutRow: vi.fn(),
  getPlaygroundSession: vi.fn(),
  createPlaygroundSession: vi.fn(),
  markPlaygroundSessionRunning: vi.fn(async () => {}),
  streamTurnResponse: vi.fn(() => new Response("ok")),
}));

vi.mock("~/auth/session.server", () => ({
  getSessionAuth: mocks.getSessionAuth,
}));
vi.mock("~/project/guard.server", () => ({
  requireProject: mocks.requireProject,
  requireRepo: (project: unknown) => project,
}));
vi.mock("~/assistant/instance.server", () => ({
  ensureAssistantInstance: mocks.ensureAssistantInstance,
}));
vi.mock("~/assistant/checkout-sync.server", () => ({
  ensureConversationCheckout: mocks.ensureConversationCheckout,
  getCheckoutRow: mocks.getCheckoutRow,
}));
vi.mock("~/playground/sessions.server", () => ({
  getPlaygroundSession: mocks.getPlaygroundSession,
  createPlaygroundSession: mocks.createPlaygroundSession,
  markPlaygroundSessionRunning: mocks.markPlaygroundSessionRunning,
  titleFromMessage: (message: string) => message.slice(0, 80),
}));
vi.mock("~/chat/turn-stream.server", () => ({
  streamTurnResponse: mocks.streamTurnResponse,
  asString: (value: FormDataEntryValue | null) =>
    typeof value === "string" ? value : "",
}));

import { action } from "~/routes/api.projects.$projectId.assistant.stream";
import {
  stripSystemNotes,
  SYSTEM_NOTE_END,
  SYSTEM_NOTE_START,
} from "~/chat/system-note";
import { conversationCheckoutPath } from "~/assistant/checkout-sync";

const AUTH = { user: { id: "user_1" } };
const PROJECT = { id: "proj_1", orgId: "org_1", name: "repo" };
const INSTANCE = {
  status: "live",
  url: "http://assistant",
  agentId: "agent_1",
  deploymentId: "dep_1",
  environmentId: "env_1",
  releaseId: "rel_1",
  version: "v1",
  gitSha: "abc",
};
const SESSION = {
  id: "conv_1",
  agentId: "agent_1",
  externalSessionId: "sess_1",
  lastDeploymentId: "dep_1",
  surface: "assistant",
  title: "earlier message",
};

function args(form: Record<string, string>) {
  return {
    request: new Request(
      "http://localhost/api/projects/proj_1/assistant/stream",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form),
      },
    ),
    params: { projectId: "proj_1" },
    context: {},
  } as never;
}

/** Run one turn and return the input the route handed the shared drain. */
async function run(message: string, playgroundSessionId = "conv_1") {
  await action(args({ message, playgroundSessionId }));
  const [input] = mocks.streamTurnResponse.mock.calls.at(-1) as unknown as [
    { message: string; messagePrefix: string | null },
  ];
  return input;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionAuth.mockResolvedValue(AUTH);
  mocks.requireProject.mockResolvedValue(PROJECT);
  mocks.ensureAssistantInstance.mockResolvedValue(INSTANCE);
  mocks.ensureConversationCheckout.mockResolvedValue({ ok: true, note: null });
  mocks.getCheckoutRow.mockResolvedValue(null);
  mocks.getPlaygroundSession.mockResolvedValue(SESSION);
  mocks.streamTurnResponse.mockReturnValue(new Response("ok"));
});

describe("assistant stream route: per-turn checkout context", () => {
  it("still tells the model its checkout, on a continuing turn as much as the first", async () => {
    const input = await run("make the button blue");
    expect(input.messagePrefix).toContain(conversationCheckoutPath("conv_1"));
    expect(input.messagePrefix).toContain("harnesst/conv-conv_1");
  });

  it("keeps that note out of the message the user sees", async () => {
    mocks.getCheckoutRow.mockResolvedValue({
      warnings: ["skipped logo.png (binary)"],
    });
    mocks.ensureConversationCheckout.mockResolvedValue({
      ok: true,
      note: "The base branch advanced.",
    });
    const input = await run("make the button blue");
    // Marked, not bare. The bare form is only recognisable by a deliberately narrow heuristic
    // kept for transcripts recorded before the wrapper existed; what harnesst sends from here on
    // must be unambiguous, because eve records the sent message and the transcript replays it.
    expect(input.messagePrefix?.startsWith(SYSTEM_NOTE_START)).toBe(true);
    expect(input.messagePrefix?.endsWith(SYSTEM_NOTE_END)).toBe(true);
    const sent = `${input.messagePrefix}\n\n${input.message}`;
    expect(stripSystemNotes(sent)).toBe("make the button blue");
  });

  it("sends no context at all when the instance has no checkout sidecar", async () => {
    mocks.ensureConversationCheckout.mockResolvedValue({
      ok: false,
      unsupported: true,
      note: null,
      reason: "no sidecar endpoint",
    });
    const input = await run("make the button blue");
    expect(input.messagePrefix).toBeNull();
  });
});
