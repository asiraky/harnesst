/**
 * The runtime model-config endpoint (`/api/gateway/v1/model-config`) — the contract every
 * deployed container depends on. Three generations of caller have to keep working at once:
 * a pre-#344 container asking with `?agent=` alone, a current one adding `?subagent=` and
 * `?project=`, and anything asking with a project id that isn't this workspace's (which must be
 * refused rather than silently answered from another repo's rows).
 *
 * The resolution chain itself is covered as pure logic in agent-model-config.test.ts; here the
 * store and catalog are stubbed and what's pinned is the request parsing, the auth boundary,
 * and the error copy the agent surfaces verbatim.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findWorkspaceModel: vi.fn(),
  getProject: vi.fn(),
  resolveTargetModel: vi.fn(),
  verifyGatewayToken: vi.fn(),
}));

vi.mock("~/db/queries.server", () => ({ getProject: mocks.getProject }));

vi.mock("~/models/agent-model-config.server", () => ({
  resolveTargetModel: mocks.resolveTargetModel,
}));

vi.mock("~/models/union.server", () => ({
  findWorkspaceModel: mocks.findWorkspaceModel,
}));

vi.mock("~/gateway/token.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/gateway/token.server")>();
  return { ...actual, verifyGatewayToken: mocks.verifyGatewayToken };
});

const { loader } = await import("~/routes/api.gateway.model-config");

const RESOLVED = {
  model: "anthropic/abcdefghijkl/claude-opus-4.8",
  effort: "high" as const,
  source: "override" as const,
};

/** The loader only ever reads `request`; the rest of the route args are framework furniture. */
function call(query: string): Promise<Response> {
  const request = new Request(
    `https://harnesst.test/api/gateway/v1/model-config${query}`,
    { headers: { authorization: "Bearer edng_org_1.sig" } },
  );
  return loader({ request } as unknown as Parameters<typeof loader>[0]);
}

async function body(response: Response) {
  return (await response.json()) as {
    model?: string;
    effort?: string | null;
    source?: string;
    contextWindowTokens?: number | null;
    error?: { message: string };
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyGatewayToken.mockReturnValue("org_1");
  mocks.resolveTargetModel.mockResolvedValue(RESOLVED);
  mocks.findWorkspaceModel.mockResolvedValue({ contextWindow: 200_000 });
  mocks.getProject.mockResolvedValue({ id: "proj_1", orgId: "org_1" });
});

describe("model-config loader", () => {
  it("resolves a legacy one-argument caller against the agent's own target", async () => {
    const response = await call("?agent=bookkeeping");

    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({
      model: RESOLVED.model,
      effort: "high",
      source: "override",
      contextWindowTokens: 200_000,
    });
    expect(mocks.resolveTargetModel).toHaveBeenCalledWith("org_1", {
      agentName: "bookkeeping",
      subagentPath: "",
      projectId: null,
    });
    // Nothing to verify when the caller names no project.
    expect(mocks.getProject).not.toHaveBeenCalled();
  });

  it("passes a nested subagent path and the project scope through", async () => {
    const response = await call("?agent=bookkeeping&subagent=reader%2Fskimmer&project=proj_1");

    expect(response.status).toBe(200);
    expect(mocks.resolveTargetModel).toHaveBeenCalledWith("org_1", {
      agentName: "bookkeeping",
      subagentPath: "reader/skimmer",
      projectId: "proj_1",
    });
  });

  it("normalizes a sloppy subagent path rather than inventing an ancestor", async () => {
    await call("?agent=bookkeeping&subagent=%2Freader%2F%2Fskimmer%2F");

    expect(mocks.resolveTargetModel).toHaveBeenCalledWith(
      "org_1",
      expect.objectContaining({ subagentPath: "reader/skimmer" }),
    );
  });

  it("refuses a project id that is not this workspace's", async () => {
    mocks.getProject.mockResolvedValue(null);

    const response = await call("?agent=bookkeeping&project=proj_other");

    expect(response.status).toBe(404);
    expect((await body(response)).error?.message).toContain(
      'The project "proj_other" is not part of this workspace',
    );
    // The refusal happens BEFORE any row is read — a foreign id never scopes a lookup.
    expect(mocks.resolveTargetModel).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller", async () => {
    mocks.verifyGatewayToken.mockReturnValue(null);

    const response = await call("?agent=bookkeeping");

    expect(response.status).toBe(401);
    expect((await body(response)).error?.message).toBe(
      "Missing or invalid gateway token.",
    );
  });

  it("requires an agent name", async () => {
    const response = await call("?subagent=reader");

    expect(response.status).toBe(400);
    expect((await body(response)).error?.message).toBe("Pass ?agent=<agent-name>.");
  });

  it("names the nested target in the not-configured error", async () => {
    mocks.resolveTargetModel.mockResolvedValue(null);

    const response = await call("?agent=bookkeeping&subagent=reader");

    expect(response.status).toBe(404);
    expect((await body(response)).error?.message).toContain(
      'the "bookkeeping/reader" agent',
    );
  });

  it("still answers when the catalog lookup blows up", async () => {
    mocks.findWorkspaceModel.mockRejectedValue(new Error("catalog down"));

    const response = await call("?agent=bookkeeping");

    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({
      model: RESOLVED.model,
      contextWindowTokens: null,
    });
  });
});
