import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireProjectAccess: vi.fn(),
  resolveAgentContext: vi.fn(),
}));

vi.mock("~/auth/session.server", () => ({
  sessionLoader: (
    _args: unknown,
    callback: (ctx: { auth: unknown }) => unknown,
  ) => callback({ auth: { user: { id: "user_1" } } }),
}));
vi.mock("~/project/guard.server", () => ({
  requireProjectAccess: mocks.requireProjectAccess,
}));
vi.mock("~/project/agent-context.server", () => ({
  agentFromParams: (params: { agentName?: string }) => params.agentName ?? null,
  resolveAgentContext: mocks.resolveAgentContext,
}));

import { loader } from "~/routes/legacy.playground";

const ROSTER = [
  { id: "agent_ivy", name: "ivy" },
  { id: "agent_rex", name: "rex" },
];

async function redirectFor(
  params: Record<string, string>,
  layout: "single" | "team",
) {
  mocks.requireProjectAccess.mockResolvedValue({
    project: { id: "proj_1", slug: "customer-ops", layout },
  });
  mocks.resolveAgentContext.mockResolvedValue({ roster: ROSTER });
  const thrown = await Promise.resolve(
    loader({
      request: new Request("http://localhost/repos/proj_1/playground"),
      params: { projectId: "proj_1", ...params },
      context: {},
    } as never),
  ).catch((e: unknown) => e);
  expect(thrown).toBeInstanceOf(Response);
  const res = thrown as Response;
  expect(res.status).toBe(301);
  return res.headers.get("Location");
}

beforeEach(() => vi.clearAllMocks());

describe("retired Playground URL", () => {
  it("sends a single-agent repo to that agent's Chat page", async () => {
    expect(await redirectFor({}, "single")).toBe("/t/customer-ops/agent_ivy");
  });

  it("sends a team member's Playground to that member's Chat page", async () => {
    expect(await redirectFor({ agentName: "rex" }, "team")).toBe(
      "/t/customer-ops/agent_rex",
    );
  });

  it("sends a team's repo-level URL to the team activity feed", async () => {
    expect(await redirectFor({}, "team")).toBe("/t/customer-ops/activity");
  });

  it("only needs read access, so a viewer's old bookmark still lands", async () => {
    await redirectFor({}, "single");
    expect(mocks.requireProjectAccess).toHaveBeenCalledWith(
      expect.anything(),
      "proj_1",
      "read",
    );
  });
});
