import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";

import type { AssistantContext } from "~/assistant/authoring.server";
import {
  packageRootFor,
  runAssistantEval,
  type EvalRunnerDeps,
} from "~/assistant/eval-runner.server";
import type { Agent } from "~/data/ports";
import type { EvalGrant } from "~/gateway/eval-grant.server";

const MODEL = "codex/abcdefghijkl/gpt-5.5";

const ctx = {
  project: {
    id: "projectabcde",
    orgId: "org_1",
  },
  agentId: "assistantabc",
  environmentId: "envabcdefghi",
  deploymentId: "depabcdefghi",
} as unknown as AssistantContext;

const member = {
  id: "memberabcdef",
  projectId: "projectabcde",
  kind: "member",
  name: "researcher",
  root: "agents/researcher/agent",
} as Agent;

function grant(): EvalGrant {
  return {
    id: "grantabcdefg",
    orgId: "org_1",
    projectId: "projectabcde",
    conversationId: "convabcdefgh",
    memberName: "researcher",
    model: MODEL,
    effort: "high",
    modelSource: "override",
    expiresAt: new Date("2030-01-01T00:10:00Z"),
    maxConcurrentCalls: 4,
    activeCalls: 0,
    maxCalls: 64,
    usedCalls: 0,
    maxTokens: 500_000,
    reservedTokens: 0,
    revokedAt: null,
    createdAt: new Date("2030-01-01T00:00:00Z"),
    updatedAt: new Date("2030-01-01T00:00:00Z"),
  };
}

function deps(patch: Partial<EvalRunnerDeps> = {}): EvalRunnerDeps {
  return {
    authorizeConversation: vi.fn(async () => true),
    listAgents: vi.fn(async () => [member]),
    resolveModel: vi.fn(async () => ({
      model: MODEL,
      effort: "high" as const,
      source: "override" as const,
    })),
    createGrant: vi.fn(async () => grant()),
    revokeGrant: vi.fn(async () => {}),
    auxEndpoint: vi.fn(async () => "http://127.0.0.1:3100"),
    fetch: vi.fn(async () =>
      Response.json({
        ok: true,
        exitCode: 0,
        stdout: "3 passed",
        stderr: "",
        sourceIdentity: {
          kind: "unpublished-checkout",
          headSha: "abc",
          workingTreeSha256: "def",
        },
      }),
    ),
    gatewayUrl: () => "http://control-plane/api/gateway/v1",
    assistantToken: () => "edna_sidecar",
    evalToken: () => "edne_scoped",
    ...patch,
  };
}

describe("assistant eval runner", () => {
  it("isolates repo code in a checkout-only container without the Docker socket", async () => {
    const source = await readFile(
      "assistant-template/checkout-sidecar.mjs",
      "utf8",
    );
    expect(source).toContain("volume-subpath=${volumeSubpath}");
    expect(source).toContain('"--cap-drop"');
    expect(source).not.toContain("/var/run/docker.sock:/var/run/docker.sock");
    expect(source).toContain("Docker passes ONLY envArgs");
  });

  it("maps only supported single/team member roots", () => {
    expect(packageRootFor("agent")).toBe(".");
    expect(packageRootFor("agents/researcher/agent")).toBe("agents/researcher");
    expect(packageRootFor("../agent")).toBeNull();
    expect(packageRootFor("agents/researcher/../../secret/agent")).toBeNull();
  });

  it("rejects a checkout outside the authenticated active project before minting", async () => {
    const createGrant = vi.fn(async () => grant());
    const result = await runAssistantEval(
      ctx,
      { conversationId: "convabcdefgh", member: "researcher" },
      deps({ authorizeConversation: async () => false, createGrant }),
    );
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toMatch(/not the active assistant conversation/i);
    expect(createGrant).not.toHaveBeenCalled();
  });

  it("rejects direct-provider models with a specific safe alternative", async () => {
    const createGrant = vi.fn(async () => grant());
    const result = await runAssistantEval(
      ctx,
      { conversationId: "convabcdefgh", member: "researcher" },
      deps({
        resolveModel: async () => ({
          model: "anthropic/abcdefghijkl/claude-opus-4-6",
          effort: null,
          source: "workspace-default",
        }),
        createGrant,
      }),
    );
    expect(result.error).toMatch(/credential-safe broker/i);
    expect(result.error).toMatch(/Codex model/i);
    expect(createGrant).not.toHaveBeenCalled();
  });

  it("runs the selected team member with only scoped coordinates and revokes afterward", async () => {
    let sidecarRequest: RequestInit | undefined;
    const revokeGrant = vi.fn(async () => {});
    const result = await runAssistantEval(
      ctx,
      { conversationId: "convabcdefgh", member: "researcher" },
      deps({
        revokeGrant,
        fetch: vi.fn(async (_url, init) => {
          sidecarRequest = init;
          return Response.json({ ok: true, exitCode: 0, stdout: "3 passed" });
        }),
      }),
    );

    const body = JSON.parse(String(sidecarRequest?.body));
    expect(body).toMatchObject({
      conversationId: "convabcdefgh",
      packageRoot: "agents/researcher",
      gatewayToken: "edne_scoped",
    });
    expect(JSON.stringify(body)).not.toContain("provider");
    expect(result).toMatchObject({
      ok: true,
      member: "researcher",
      model: { id: MODEL, source: "override" },
      authorization: { cleanup: "revoked" },
    });
    expect(revokeGrant).toHaveBeenCalledWith("grantabcdefg");
  });

  it("cleans up the grant even when the disposable runner fails", async () => {
    const revokeGrant = vi.fn(async () => {});
    const result = await runAssistantEval(
      ctx,
      { conversationId: "convabcdefgh", member: "researcher" },
      deps({
        fetch: vi.fn(async () => {
          throw new Error("sidecar unavailable");
        }),
        revokeGrant,
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      authorization: { cleanup: "revoked" },
    });
    expect(revokeGrant).toHaveBeenCalledOnce();
  });
});
