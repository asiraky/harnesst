/**
 * Brokered-capability framework (issue #166) — the generic route and the call orchestration.
 *
 * Two layers under test, mirroring connections-broker.test.ts:
 *
 *  - `executeCapabilityCall` (pure decision ladder, fake deps): unknown providers/operations 404
 *    (unlisted operations DO NOT EXIST — no passthrough), a disabled group refuses with the
 *    Deployment-tab message and the check runs PER CALL (an edit applies at the next call, no
 *    reconnect), inputs zod-parse with unknown keys stripped, a dead grant surfaces the reconnect
 *    text, invariant refusals are 200 business outcomes, vendor throws are 502 — and EVERY call
 *    that got past auth lands one audit row (ok/refused/error) with the operation's REDACTED
 *    digest, never the raw payload. The execute path is WRITE-AHEAD: a "pending" row must land
 *    before the vendor operation runs (no row → no execution), and a failed finalize never masks
 *    the result.
 *  - the `POST /api/capabilities/:provider/:operation` action (mocked seams): HARNESST_TEAM_TOKEN
 *    delegation auth (the Discord-send-proxy pattern), deployment → environment → agent
 *    resolution, a hard body-size cap enforced while streaming (413), transport refusals
 *    (malformed/oversized bodies) audited for the authenticated caller, and outcome passthrough.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { CapabilityCallRecord } from "~/capabilities/audit.server";
import type { CapabilityDefinition } from "~/capabilities/definition.server";
import {
  executeCapabilityCall,
  type CapabilityCaller,
  type CapabilityExecuteDeps,
} from "~/capabilities/execute.server";

const routeMocks = vi.hoisted(() => ({
  executeCapabilityCall: vi.fn(),
  recordCapabilityCall: vi.fn(),
  store: {
    deployments: { findById: vi.fn() },
    environments: { findById: vi.fn() },
    agents: { findById: vi.fn() },
  },
  verifyDelegationToken: vi.fn(),
}));

vi.mock("~/capabilities/execute.server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/capabilities/execute.server")>();
  return { ...actual, executeCapabilityCall: routeMocks.executeCapabilityCall };
});
vi.mock("~/capabilities/audit.server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/capabilities/audit.server")>();
  return { ...actual, recordCapabilityCall: routeMocks.recordCapabilityCall };
});
vi.mock("~/seams/index.server", () => ({
  getRuntime: () => ({ data: routeMocks.store }),
}));
vi.mock("~/team/token.server", () => ({
  verifyDelegationToken: routeMocks.verifyDelegationToken,
}));

// The pure-logic tests want the REAL orchestration despite the route-facing mock.
const realExecute = (await vi
  .importActual<typeof import("~/capabilities/execute.server")>(
    "~/capabilities/execute.server",
  )
  .then((m) => m.executeCapabilityCall)) as typeof executeCapabilityCall;

const CALLER: CapabilityCaller = {
  deploymentId: "dep_1",
  agent: {
    id: "agntabcdefgh",
    projectId: "projabcdefgh",
    name: "books",
    root: "roster/books",
  },
};

/** A minimal fake capability: one default read group, one write group with invariants. */
function fakeCapability(over: Partial<CapabilityDefinition> = {}): CapabilityDefinition {
  return {
    provider: "xero",
    resource: {
      label: "organisation",
      list: async () => [{ id: "tenant-1", name: "Acme Ltd" }],
    },
    operationGroups: [
      {
        id: "read-stuff",
        label: "Read stuff",
        description: "Read things.",
        risk: "read",
        default: true,
        operations: [
          {
            id: "echo",
            input: z.object({ name: z.string().min(1) }),
            summarize: (input) => ({ name: (input as { name: string }).name }),
            execute: async (input) => ({ echoed: (input as { name: string }).name }),
          },
        ],
      },
      {
        id: "write-stuff",
        label: "Write stuff",
        description: "Write things.",
        risk: "write",
        operations: [
          {
            id: "guarded_write",
            input: z.object({ amount: z.number(), secretPayload: z.string().optional() }),
            summarize: (input) => ({ amount: (input as { amount: number }).amount }),
            validate: async (input) =>
              (input as { amount: number }).amount > 100
                ? { ok: false, error: "Amounts over 100 need a human." }
                : { ok: true },
            execute: async () => ({ written: true }),
          },
        ],
      },
    ],
    ...over,
  };
}

function deps(over: Partial<CapabilityExecuteDeps> = {}): {
  deps: CapabilityExecuteDeps;
  audits: CapabilityCallRecord[];
} {
  const audits: CapabilityCallRecord[] = [];
  return {
    audits,
    deps: {
      getCapability: (provider) => (provider === "xero" ? fakeCapability() : null),
      enabledGroups: async () => ["read-stuff", "write-stuff"],
      findGrant: async () => ({ resourceId: "tenant-1" }),
      accessToken: async () => ({
        ok: true,
        accessToken: "at_1",
        expiresAt: Date.now() + 1_800_000,
      }),
      record: async (record) => {
        audits.push(record);
      },
      // The write-ahead pair: begin appends a "pending" row, finalize settles it in place —
      // the same shape the real Drizzle-backed audit takes.
      begin: async (record) => {
        audits.push({ ...record, outcome: "pending", error: null });
        return String(audits.length - 1);
      },
      finalize: async (id, outcome, error) => {
        audits[Number(id)] = { ...audits[Number(id)], outcome, error };
      },
      fetchImpl: fetch,
      ...over,
    },
  };
}

function call(
  operation: string,
  body: unknown,
  d: CapabilityExecuteDeps,
  provider = "xero",
) {
  return realExecute({ provider, operation, caller: CALLER, body }, d);
}

describe("executeCapabilityCall", () => {
  it("404s a provider without capability delivery — including discord (the proxy stays its own surface)", async () => {
    // "google" is a real refresh-token provider; "discord" isn't a connection provider at all.
    // Neither has a capability definition, so neither exists on this route.
    for (const provider of ["google", "discord", "nope"]) {
      const { deps: d } = deps();
      const out = await call("echo", { name: "x" }, d, provider);
      expect(out.status).toBe(404);
      expect(out.body.ok).toBe(false);
    }
  });

  it("404s an unlisted operation — anything not whitelisted does not exist", async () => {
    const { deps: d, audits } = deps();
    const out = await call("delete_everything", {}, d);
    expect(out.status).toBe(404);
    expect(out.body.error).toMatch(/no operation "delete_everything"/);
    expect(audits).toMatchObject([
      { operation: "delete_everything", outcome: "refused", groupId: null },
    ]);
  });

  it("refuses a disabled group with the Deployment-tab message, naming the group label", async () => {
    const { deps: d, audits } = deps({ enabledGroups: async () => ["read-stuff"] });
    const out = await call("guarded_write", { amount: 5 }, d);
    expect(out.status).toBe(200);
    expect(out.body.ok).toBe(false);
    expect(out.body.error).toMatch(/"Write stuff" permission/);
    expect(out.body.error).toMatch(/Deployment tab/);
    expect(audits).toMatchObject([
      { outcome: "refused", groupId: "write-stuff", inputSummary: { amount: 5 } },
    ]);
  });

  it("checks enablement PER CALL — a Deployment-tab de-selection cuts the agent off at the very next call", async () => {
    let enabled = ["read-stuff", "write-stuff"];
    const { deps: d } = deps({ enabledGroups: async () => enabled });
    const first = await call("guarded_write", { amount: 5 }, d);
    expect(first.body).toEqual({ ok: true, result: { written: true } });
    // The instant-disable payoff: no reconnect, no redeploy — the next call is refused.
    enabled = ["read-stuff"];
    const second = await call("guarded_write", { amount: 5 }, d);
    expect(second.body.ok).toBe(false);
    expect(second.body.error).toMatch(/"Write stuff" permission isn't enabled/);
  });

  it("refuses a shape-invalid input readably (200 business outcome)", async () => {
    const { deps: d, audits } = deps();
    const out = await call("echo", { name: "" }, d);
    expect(out.status).toBe(200);
    expect(out.body.ok).toBe(false);
    expect(out.body.error).toMatch(/Invalid input: name/);
    expect(audits[0].outcome).toBe("refused");
  });

  it("refuses when the capability declares a resource and the grant isn't bound yet", async () => {
    const { deps: d } = deps({ findGrant: async () => ({ resourceId: null }) });
    const out = await call("echo", { name: "x" }, d);
    expect(out.status).toBe(200);
    expect(out.body.ok).toBe(false);
    expect(out.body.error).toMatch(/isn't bound to an organisation/);
  });

  it("surfaces a dead grant as a readable 200 reconnect message and audits an error", async () => {
    const { deps: d, audits } = deps({
      accessToken: async () => ({
        ok: false,
        status: 403,
        error: "The Xero connection for this agent has expired — reconnect it.",
      }),
    });
    const out = await call("echo", { name: "x" }, d);
    expect(out.status).toBe(200);
    expect(out.body.error).toMatch(/expired — reconnect/);
    expect(audits[0].outcome).toBe("error");
  });

  it("keeps infrastructure token failures on their own status (502 stays 502)", async () => {
    const { deps: d } = deps({
      accessToken: async () => ({ ok: false, status: 502, error: "upstream down" }),
    });
    const out = await call("echo", { name: "x" }, d);
    expect(out.status).toBe(502);
  });

  it("returns an invariant refusal as a 200 business outcome with the operation's text", async () => {
    const { deps: d, audits } = deps();
    const out = await call("guarded_write", { amount: 500 }, d);
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: false, error: "Amounts over 100 need a human." });
    expect(audits).toMatchObject([{ outcome: "refused", groupId: "write-stuff" }]);
  });

  it("502s a vendor throw from execute and audits the error", async () => {
    const capability = fakeCapability();
    capability.operationGroups[0].operations[0].execute = async () => {
      throw new Error("Xero rejected the request (HTTP 500)");
    };
    const { deps: d, audits } = deps({ getCapability: () => capability });
    const out = await call("echo", { name: "x" }, d);
    expect(out.status).toBe(502);
    expect(out.body.error).toMatch(/Xero rejected/);
    expect(audits).toMatchObject([{ outcome: "error", inputSummary: { name: "x" } }]);
  });

  it("audits every outcome with the REDACTED digest — the raw payload never lands in a row", async () => {
    const { deps: d, audits } = deps();
    await call("guarded_write", { amount: 5, secretPayload: "top-secret" }, d);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      agentId: CALLER.agent.id,
      deploymentId: CALLER.deploymentId,
      provider: "xero",
      operation: "guarded_write",
      groupId: "write-stuff",
      outcome: "ok",
      error: null,
      inputSummary: { amount: 5 },
    });
    expect(JSON.stringify(audits[0].inputSummary)).not.toContain("top-secret");
  });

  it("refuses to EXECUTE when the write-ahead audit row can't be written — no unrecorded vendor mutation", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const capability = fakeCapability();
      let executed = false;
      capability.operationGroups[0].operations[0].execute = async () => {
        executed = true;
        return {};
      };
      const { deps: d } = deps({
        getCapability: () => capability,
        begin: async () => {
          throw new Error("audit table unavailable");
        },
      });
      const out = await call("echo", { name: "x" }, d);
      expect(out.status).toBe(502);
      expect(out.body.ok).toBe(false);
      expect(out.body.error).toMatch(/audit log.*not executed/);
      expect(executed).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("never lets a failed finalize mask the result — the pending row already recorded the call", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { deps: d, audits } = deps({
        finalize: async () => {
          throw new Error("audit table unavailable");
        },
      });
      const out = await call("echo", { name: "x" }, d);
      expect(out.body).toEqual({ ok: true, result: { echoed: "x" } });
      // The write-ahead row survives as the queryable trace of the executed call.
      expect(audits).toMatchObject([
        { operation: "echo", outcome: "pending", inputSummary: { name: "x" } },
      ]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("never lets a failed refusal audit mask the refusal itself (no mutation at stake)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { deps: d } = deps({
        enabledGroups: async () => [],
        record: async () => {
          throw new Error("audit table unavailable");
        },
      });
      const out = await call("echo", { name: "x" }, d);
      expect(out.status).toBe(200);
      expect(out.body.ok).toBe(false);
      expect(out.body.error).toMatch(/permission isn't enabled/);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("hands the operation a live context: fresh token, bound resource, caller agent", async () => {
    const capability = fakeCapability();
    const seen: unknown[] = [];
    capability.operationGroups[0].operations[0].execute = async (_input, ctx) => {
      seen.push(ctx);
      return {};
    };
    const { deps: d } = deps({ getCapability: () => capability });
    await call("echo", { name: "x" }, d);
    expect(seen[0]).toMatchObject({
      accessToken: "at_1",
      resourceId: "tenant-1",
      agentId: CALLER.agent.id,
    });
  });
});

/* ─────────────── the POST /api/capabilities/:provider/:operation action ─────────────── */

function capabilityRequest(body: unknown, authorization?: string): Request {
  return new Request("http://localhost/api/capabilities/xero/echo", {
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

function actionArgs(request: Request, params: Record<string, string>) {
  return {
    request,
    url: new URL(request.url),
    pattern: new URL(request.url).pathname,
    params,
    context: {} as never,
  };
}

const PARAMS = { provider: "xero", operation: "echo" };

describe("POST /api/capabilities/:provider/:operation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeMocks.recordCapabilityCall.mockReset().mockResolvedValue(undefined);
    routeMocks.verifyDelegationToken.mockReturnValue("dep_1");
    routeMocks.store.deployments.findById.mockResolvedValue({
      id: "dep_1",
      environmentId: "env_1",
    });
    routeMocks.store.environments.findById.mockResolvedValue({
      id: "env_1",
      agentId: "agnt_1",
    });
    routeMocks.store.agents.findById.mockResolvedValue({
      id: "agnt_1",
      projectId: "proj_1",
      name: "books",
      root: "roster/books",
    });
    routeMocks.executeCapabilityCall.mockResolvedValue({
      status: 200,
      body: { ok: true, result: { echoed: "x" } },
    });
  });

  it("401s a missing or unverifiable bearer token without executing anything", async () => {
    routeMocks.verifyDelegationToken.mockReturnValue(null);
    const { action } = await import(
      "~/routes/api.capabilities.$provider.$operation"
    );
    for (const request of [
      capabilityRequest({ name: "x" }),
      capabilityRequest({ name: "x" }, "Bearer forged"),
    ]) {
      const thrown = await action(actionArgs(request, PARAMS))
        .then(() => null)
        .catch((error) => error);
      expect(unwrap(thrown).status).toBe(401);
    }
    expect(routeMocks.executeCapabilityCall).not.toHaveBeenCalled();
  });

  it("400s a non-JSON body AND audits the refused call for the authenticated caller", async () => {
    const { action } = await import(
      "~/routes/api.capabilities.$provider.$operation"
    );
    const result = await action(
      actionArgs(capabilityRequest("not json", "Bearer good"), PARAMS),
    );
    expect(unwrap(result).status).toBe(400);
    expect(routeMocks.executeCapabilityCall).not.toHaveBeenCalled();
    // Every request past auth is queryable (acceptance criterion 5) — transport refusals too.
    expect(routeMocks.recordCapabilityCall).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agnt_1",
        deploymentId: "dep_1",
        provider: "xero",
        operation: "echo",
        outcome: "refused",
        error: expect.stringMatching(/JSON body/),
      }),
    );
  });

  it("413s a body over the route's cap without handing it to the framework, and audits the refusal", async () => {
    const { action } = await import(
      "~/routes/api.capabilities.$provider.$operation"
    );
    // Just over 15 MiB of raw body — the stream reader must bail before buffering it whole.
    const huge = "x".repeat(15 * 1024 * 1024 + 1);
    const result = await action(
      actionArgs(capabilityRequest(huge, "Bearer good"), PARAMS),
    );
    expect(unwrap(result).status).toBe(413);
    expect(routeMocks.executeCapabilityCall).not.toHaveBeenCalled();
    expect(routeMocks.recordCapabilityCall).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "refused",
        error: expect.stringMatching(/15 MiB limit/),
      }),
    );
  });

  it("keeps a failed transport-refusal audit from masking the 400 itself", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      routeMocks.recordCapabilityCall.mockRejectedValue(
        new Error("audit table unavailable"),
      );
      const { action } = await import(
        "~/routes/api.capabilities.$provider.$operation"
      );
      const result = await action(
        actionArgs(capabilityRequest("not json", "Bearer good"), PARAMS),
      );
      expect(unwrap(result).status).toBe(400);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("resolves deployment → environment → agent and executes for THAT caller", async () => {
    const { action } = await import(
      "~/routes/api.capabilities.$provider.$operation"
    );
    const result = await action(
      actionArgs(capabilityRequest({ name: "x" }, "Bearer good"), PARAMS),
    );
    expect(routeMocks.store.deployments.findById).toHaveBeenCalledWith("dep_1");
    expect(routeMocks.executeCapabilityCall).toHaveBeenCalledWith({
      provider: "xero",
      operation: "echo",
      caller: {
        deploymentId: "dep_1",
        agent: {
          id: "agnt_1",
          projectId: "proj_1",
          name: "books",
          root: "roster/books",
        },
      },
      body: { name: "x" },
    });
    expect(unwrap(result)).toEqual({
      payload: { ok: true, result: { echoed: "x" } },
      status: 200,
    });
  });

  it("403s a token whose deployment no longer resolves to an agent", async () => {
    routeMocks.store.deployments.findById.mockResolvedValue(null);
    const { action } = await import(
      "~/routes/api.capabilities.$provider.$operation"
    );
    const result = await action(
      actionArgs(capabilityRequest({ name: "x" }, "Bearer good"), PARAMS),
    );
    expect(unwrap(result).status).toBe(403);
    expect(routeMocks.executeCapabilityCall).not.toHaveBeenCalled();
  });

  it("passes the framework's outcome through with its status (refusals stay 200, vendor failures 502)", async () => {
    routeMocks.executeCapabilityCall.mockResolvedValue({
      status: 502,
      body: { ok: false, error: "Xero rejected the request (HTTP 500)" },
    });
    const { action } = await import(
      "~/routes/api.capabilities.$provider.$operation"
    );
    const result = await action(
      actionArgs(capabilityRequest({ name: "x" }, "Bearer good"), PARAMS),
    );
    expect(unwrap(result)).toEqual({
      payload: { ok: false, error: "Xero rejected the request (HTTP 500)" },
      status: 502,
    });
  });
});
