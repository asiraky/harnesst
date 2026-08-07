/**
 * POST /api/secrets/deposit (issue #364) — the Vercel issuer's credential drop.
 *
 * The route is the third hop of security invariant 3 (issuer tool memory → deposit route →
 * secret store → target container env), so what's pinned here is exactly the set of ways it may
 * and may not write:
 *
 *  - a missing or unverifiable bearer is a 401 before anything executes;
 *  - the caller is derived from the token's deployment, never the payload;
 *  - a caller whose COMMITTED lock does not carry the `vercel-issuer` agent install writes
 *    nothing, whatever the payload says (invariant 4) — and a tool/bundle that merely shares the
 *    id does not count;
 *  - only `VERCEL_*` keys are writable, and `sandboxExposed: true` is refused outright (the
 *    flow exists to keep credentials OUT of the sandbox shell);
 *  - a live roster member gets a real sealed write (`sandboxExposed: false`) plus an env
 *    invalidation so the queued redeploy delivers it;
 *  - the built-in assistant is not a depositable target even when the name matches;
 *  - a pending member (staged draft under agents/<name>/, no agents row) gets a sealed
 *    pending_secrets row that opens back to the deposited value, and no invalidation;
 *  - an unknown member gets nothing;
 *  - every authenticated attempt lands an audit row that carries the key name and NEVER the
 *    value.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyDelegationToken: vi.fn(),
  recordCapabilityCall: vi.fn(),
  invalidateAgentEnvironments: vi.fn(),
  getAgentSource: vi.fn(),
  listDrafts: vi.fn(),
  writePendingSecret: vi.fn(),
  secretsSet: vi.fn(),
  store: {
    deployments: { findById: vi.fn() },
    environments: { findById: vi.fn() },
    agents: { findById: vi.fn(), listByProject: vi.fn() },
    projects: { findById: vi.fn() },
  },
}));

vi.mock("~/seams/index.server", () => ({
  getRuntime: () => ({ data: mocks.store, secrets: { set: mocks.secretsSet } }),
}));
vi.mock("~/team/token.server", () => ({
  verifyDelegationToken: mocks.verifyDelegationToken,
}));
vi.mock("~/capabilities/audit.server", () => ({
  recordCapabilityCall: mocks.recordCapabilityCall,
}));
vi.mock("~/deploy/env-reconcile.server", () => ({
  invalidateAgentEnvironments: mocks.invalidateAgentEnvironments,
}));
vi.mock("~/github/cached.server", () => ({
  getAgentSource: mocks.getAgentSource,
}));
vi.mock("~/drafts/drafts.server", () => ({ listDrafts: mocks.listDrafts }));
vi.mock("~/project/secrets.server", () => ({
  writePendingSecret: mocks.writePendingSecret,
}));

import { decodeKey, open } from "~/seams/oss/secretbox";

const ISSUER_ENTRY = {
  id: "vercel-issuer",
  type: "agent",
  name: "Vercel Issuer",
  version: "0.1.0",
  hash: "abc",
  registry: "fixture",
  member: "vercel-issuer",
  files: ["agents/vercel-issuer/agent/agent.ts"],
};

function lockJson(installs: unknown[]): string {
  return JSON.stringify({ version: 1, installs });
}

function depositRequest(body: unknown, authorization?: string): Request {
  return new Request("http://localhost/api/secrets/deposit", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization ? { authorization } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** react-router `data()` payload/status, whether returned or thrown. */
function unwrap(value: unknown): { payload: unknown; status: number } {
  const d = value as { data: unknown; init?: { status?: number } | null };
  return { payload: d.data, status: d.init?.status ?? 200 };
}

function actionArgs(request: Request) {
  return { request, params: {}, context: {} as never };
}

async function callAction(body: unknown, authorization = "Bearer good") {
  const { action } = await import("~/routes/api.secrets.deposit");
  return action(actionArgs(depositRequest(body, authorization)) as never);
}

const GOOD_BODY = { member: "dev", key: "VERCEL_TOKEN", value: "vcp_sekret" };

describe("POST /api/secrets/deposit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyDelegationToken.mockImplementation((token: string) =>
      token === "good" ? "dep_1" : null,
    );
    mocks.store.deployments.findById.mockResolvedValue({
      id: "dep_1",
      environmentId: "env_1",
    });
    mocks.store.environments.findById.mockResolvedValue({
      id: "env_1",
      agentId: "ag_issuer",
    });
    mocks.store.agents.findById.mockResolvedValue({
      id: "ag_issuer",
      projectId: "proj_1",
      name: "vercel-issuer",
      root: "agents/vercel-issuer/agent",
      kind: "member",
    });
    mocks.store.projects.findById.mockResolvedValue({
      id: "proj_1",
      repoOwner: "acme",
      repoName: "web",
      repoInstallationId: 123,
    });
    mocks.store.agents.listByProject.mockResolvedValue([
      {
        id: "ag_issuer",
        projectId: "proj_1",
        name: "vercel-issuer",
        root: "agents/vercel-issuer/agent",
        kind: "member",
      },
      {
        id: "ag_dev",
        projectId: "proj_1",
        name: "dev",
        root: "agents/dev/agent",
        kind: "member",
      },
    ]);
    mocks.getAgentSource.mockResolvedValue({
      files: { "harnesst-lock.json": lockJson([ISSUER_ENTRY]) },
    });
    mocks.listDrafts.mockResolvedValue([]);
    mocks.secretsSet.mockResolvedValue(undefined);
    mocks.invalidateAgentEnvironments.mockResolvedValue({ environmentIds: [] });
    mocks.writePendingSecret.mockResolvedValue(undefined);
    mocks.recordCapabilityCall.mockResolvedValue(undefined);
  });

  it("401s a missing or unverifiable bearer token without touching the store", async () => {
    const { action } = await import("~/routes/api.secrets.deposit");
    for (const auth of [undefined, "Bearer bad"]) {
      const thrown = await Promise.resolve(
        action(actionArgs(depositRequest(GOOD_BODY, auth)) as never),
      )
        .then(() => null)
        .catch((error) => error);
      expect(unwrap(thrown).status).toBe(401);
    }
    expect(mocks.secretsSet).not.toHaveBeenCalled();
    expect(mocks.store.deployments.findById).not.toHaveBeenCalled();
  });

  it("refuses a caller whose committed lock has no vercel-issuer agent install, and audits it", async () => {
    mocks.getAgentSource.mockResolvedValue({ files: {} });
    const { payload } = unwrap(await callAction(GOOD_BODY));
    expect(payload).toMatchObject({ ok: false });
    expect(mocks.secretsSet).not.toHaveBeenCalled();
    expect(mocks.writePendingSecret).not.toHaveBeenCalled();
    expect(mocks.recordCapabilityCall).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "refused",
        operation: "secrets.deposit",
        agentId: "ag_issuer",
      }),
    );
  });

  it("does not accept a TOOL or bundle that merely shares the issuer id", async () => {
    mocks.getAgentSource.mockResolvedValue({
      files: {
        "harnesst-lock.json": lockJson([
          { ...ISSUER_ENTRY, type: "tool", files: ["tools/vercel-issuer.ts"] },
        ]),
      },
    });
    const { payload } = unwrap(await callAction(GOOD_BODY));
    expect(payload).toMatchObject({ ok: false });
    expect(mocks.secretsSet).not.toHaveBeenCalled();
  });

  it("refuses non-VERCEL_* keys and sandbox-exposed deposits before any lookup of the target", async () => {
    for (const body of [
      { ...GOOD_BODY, key: "GITHUB_TOKEN" },
      { ...GOOD_BODY, sandboxExposed: true },
    ]) {
      const { payload } = unwrap(await callAction(body));
      expect(payload).toMatchObject({ ok: false });
    }
    expect(mocks.secretsSet).not.toHaveBeenCalled();
    expect(mocks.store.agents.listByProject).not.toHaveBeenCalled();
  });

  it("writes a live roster member's secret sealed out of the sandbox and queues the redeploy", async () => {
    const { payload } = unwrap(await callAction(GOOD_BODY));
    expect(payload).toEqual({ ok: true, delivery: "queued" });
    expect(mocks.secretsSet).toHaveBeenCalledWith(
      { projectId: "proj_1", agentId: "ag_dev", environmentId: null, key: "VERCEL_TOKEN" },
      "vcp_sekret",
      { sandboxExposed: false, updatedBy: null },
    );
    expect(mocks.invalidateAgentEnvironments).toHaveBeenCalledWith({
      agentIds: ["ag_dev"],
      createdBy: null,
    });
    const audited = mocks.recordCapabilityCall.mock.calls.at(-1)?.[0] as {
      outcome: string;
      inputSummary: Record<string, unknown>;
    };
    expect(audited.outcome).toBe("ok");
    expect(JSON.stringify(audited.inputSummary)).not.toContain("vcp_sekret");
  });

  it("never targets the built-in assistant even when the name matches", async () => {
    mocks.store.agents.listByProject.mockResolvedValue([
      { id: "ag_asst", projectId: "proj_1", name: "dev", root: "agent", kind: "assistant" },
    ]);
    const { payload } = unwrap(await callAction(GOOD_BODY));
    expect(payload).toMatchObject({ ok: false });
    expect(mocks.secretsSet).not.toHaveBeenCalled();
  });

  it("holds a pending member's deposit sealed in pending_secrets without invalidating anything", async () => {
    mocks.store.agents.listByProject.mockResolvedValue([]);
    mocks.listDrafts.mockResolvedValue([{ path: "agents/dev/agent/agent.ts", content: "x" }]);
    const { payload } = unwrap(await callAction(GOOD_BODY));
    expect(payload).toEqual({ ok: true, delivery: "held" });
    expect(mocks.invalidateAgentEnvironments).not.toHaveBeenCalled();
    const written = mocks.writePendingSecret.mock.calls[0]?.[0] as {
      projectId: string;
      memberName: string;
      key: string;
      sealed: never;
      sandboxExposed: boolean;
      attachShared: boolean;
    };
    expect(written).toMatchObject({
      projectId: "proj_1",
      memberName: "dev",
      key: "VERCEL_TOKEN",
      sandboxExposed: false,
      attachShared: false,
    });
    const sealKey = decodeKey(process.env.HARNESST_SECRETS_KEY);
    expect(open(sealKey, written.sealed)).toBe("vcp_sekret");
  });

  it("refuses a member that exists neither on the roster, in the repo tree, nor as a draft", async () => {
    mocks.store.agents.listByProject.mockResolvedValue([]);
    const { payload } = unwrap(await callAction(GOOD_BODY));
    expect(payload).toMatchObject({ ok: false });
    expect(mocks.writePendingSecret).not.toHaveBeenCalled();
    expect(mocks.secretsSet).not.toHaveBeenCalled();
  });
});
