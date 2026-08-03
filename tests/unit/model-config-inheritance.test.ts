/**
 * What a RUNNING container actually gets back (issue #344): the model-config endpoint driven
 * through the REAL `resolveTargetModel`, with only the override table and the workspace default
 * stubbed. `model-config-route.test.ts` pins the request parsing with resolution mocked out; this
 * file pins the thing the issue asks for — that two targets of the same agent, configured
 * differently, resolve to different models over the wire, and that the pre-#344 caller that knows
 * only the parent's name still lands on the parent's selection.
 *
 * The fake `db` returns the seeded rows for the agent without re-implementing the WHERE clause:
 * choosing among them is `pickTargetModel`'s job (pure, and unit-tested directly in
 * `agent-model-config.test.ts`), so a lax fake cannot fake a pass here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface OverrideRow {
  subagentPath: string;
  projectId: string | null;
  model: string;
  effort: string | null;
}

const mocks = vi.hoisted(() => ({
  rows: [] as unknown[],
  workspaceDefault: { model: null as string | null, effort: null as string | null },
  findWorkspaceModel: vi.fn(),
  getProject: vi.fn(),
  verifyGatewayToken: vi.fn(),
}));

vi.mock("~/db/client.server", () => {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: async () => mocks.rows,
  };
  return { db: { select: () => chain } };
});

vi.mock("~/org/workspace.server", () => ({
  getWorkspaceAssistantSelection: async () => mocks.workspaceDefault,
}));

vi.mock("~/db/queries.server", () => ({ getProject: mocks.getProject }));

vi.mock("~/models/union.server", () => ({
  findWorkspaceModel: mocks.findWorkspaceModel,
}));

vi.mock("~/gateway/token.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/gateway/token.server")>()),
  verifyGatewayToken: mocks.verifyGatewayToken,
}));

const { loader } = await import("~/routes/api.gateway.model-config");

const PARENT_MODEL = "anthropic/conn_1/claude-sonnet-4.7";
const READER_MODEL = "openai/conn_2/gpt-5-mini";
const DEFAULT_MODEL = "anthropic/conn_1/claude-haiku-4.5";

/** One runtime request, exactly as the generated `harnesst/model.ts` makes it. */
async function ask(query: string) {
  const response = await loader({
    request: new Request(
      `https://harnesst.test/api/gateway/v1/model-config${query}`,
      { headers: { authorization: "Bearer edng_org_1.sig" } },
    ),
  } as unknown as Parameters<typeof loader>[0]);
  return {
    status: response.status,
    body: (await response.json()) as {
      model?: string;
      effort?: string | null;
      source?: string;
      error?: { message: string };
    },
  };
}

function seedOverrides(rows: OverrideRow[]): void {
  mocks.rows = rows;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rows = [];
  mocks.workspaceDefault = { model: DEFAULT_MODEL, effort: null };
  mocks.verifyGatewayToken.mockReturnValue("org_1");
  mocks.findWorkspaceModel.mockResolvedValue(null);
  mocks.getProject.mockResolvedValue({ id: "p1", orgId: "org_1" });
});

describe("model-config over the real resolution chain", () => {
  beforeEach(() => {
    seedOverrides([
      { subagentPath: "", projectId: "p1", model: PARENT_MODEL, effort: null },
      { subagentPath: "reader", projectId: "p1", model: READER_MODEL, effort: "high" },
    ]);
  });

  it("answers the subagent and its parent with different models", async () => {
    const parent = await ask("?agent=ivy&project=p1");
    const reader = await ask("?agent=ivy&subagent=reader&project=p1");

    expect(parent.body).toMatchObject({
      model: PARENT_MODEL,
      effort: null,
      source: "override",
    });
    expect(reader.body).toMatchObject({
      model: READER_MODEL,
      effort: "high",
      source: "override",
    });
    expect(reader.body.model).not.toBe(parent.body.model);
  });

  it("gives a pre-#344 container that asks with the bare name the PARENT's selection", async () => {
    // The legacy generated module never sends `subagent`, so it can only ever land on `""`.
    expect((await ask("?agent=ivy")).body).toMatchObject({
      model: PARENT_MODEL,
      source: "override",
    });
  });

  it("inherits the nearest configured ancestor for an unpinned nested target", async () => {
    const { body } = await ask("?agent=ivy&subagent=reader%2Fskimmer&project=p1");

    expect(body).toMatchObject({
      model: READER_MODEL,
      effort: "high",
      source: "parent-override",
    });
  });

  it("falls through to the workspace default for a subagent of an unpinned agent", async () => {
    seedOverrides([]);

    expect((await ask("?agent=ivy&subagent=reader&project=p1")).body).toMatchObject({
      model: DEFAULT_MODEL,
      source: "workspace-default",
    });
  });

  it("404s with the nested target named when nothing at all is configured", async () => {
    seedOverrides([]);
    mocks.workspaceDefault = { model: null, effort: null };

    const { status, body } = await ask("?agent=ivy&subagent=reader");

    expect(status).toBe(404);
    expect(body.error?.message).toContain('the "ivy/reader" agent');
  });
});
