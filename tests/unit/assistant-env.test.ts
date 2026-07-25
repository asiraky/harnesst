/** Built-in assistant model-provider env: exact connection credentials for direct providers and
 * harnesst's gateway only for active Codex OAuth connections. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getWorkspaceAssistantModel = vi.fn<() => Promise<string | null>>();
const getWorkspaceAssistantEffort =
  vi.fn<() => Promise<"low" | "medium" | "high" | null>>();
const getProviderDeploymentEnv = vi.fn<() => Promise<Record<string, string>>>();
const hasActiveCodexConnection = vi.fn<() => Promise<boolean>>();
const getActiveModelConnection =
  vi.fn<() => Promise<{ provider: string } | null>>();

vi.mock("~/org/workspace.server", () => ({
  getWorkspaceAssistantSelection: async () => ({
    model: await getWorkspaceAssistantModel(),
    effort: await getWorkspaceAssistantEffort(),
  }),
}));
vi.mock("~/models/provider-connections.server", () => ({
  getProviderDeploymentEnv: () => getProviderDeploymentEnv(),
  hasActiveCodexConnection: () => hasActiveCodexConnection(),
  getActiveModelConnection: () => getActiveModelConnection(),
}));

import { assistantEnv } from "~/assistant/instance.server";
import { verifyGatewayToken } from "~/gateway/token.server";

const OLD_KEY = process.env.HARNESST_SECRETS_KEY;
const CONNECTION = "abcdefghijkl";
const EXACT_OPENROUTER = "HARNESST_PROVIDER_OPENROUTER_ABCDEFGHIJKL_API_KEY";
const EXACT_ANTHROPIC = "HARNESST_PROVIDER_ANTHROPIC_ABCDEFGHIJKL_API_KEY";
const EXACT_OPENAI = "HARNESST_PROVIDER_OPENAI_ABCDEFGHIJKL_API_KEY";

beforeEach(() => {
  process.env.HARNESST_SECRETS_KEY = "a".repeat(64);
  getWorkspaceAssistantModel.mockReset();
  getWorkspaceAssistantEffort.mockReset();
  getWorkspaceAssistantEffort.mockResolvedValue(null);
  getProviderDeploymentEnv.mockReset();
  hasActiveCodexConnection.mockReset();
  getActiveModelConnection.mockReset();
  getProviderDeploymentEnv.mockResolvedValue({});
  hasActiveCodexConnection.mockResolvedValue(false);
  getActiveModelConnection.mockResolvedValue(null);
});
afterEach(() => {
  if (OLD_KEY === undefined) delete process.env.HARNESST_SECRETS_KEY;
  else process.env.HARNESST_SECRETS_KEY = OLD_KEY;
});

describe("assistantEnv", () => {
  it("injects the exact selected OpenRouter connection and its standard alias", async () => {
    getWorkspaceAssistantModel.mockResolvedValue(
      `openrouter/${CONNECTION}/anthropic/claude-sonnet-4-5`,
    );
    getProviderDeploymentEnv.mockResolvedValue({
      [EXACT_OPENROUTER]: "sk-or-workspace",
      OPENROUTER_API_KEY: "sk-or-workspace",
    });
    getActiveModelConnection.mockResolvedValue({ provider: "openrouter" });

    const env = await assistantEnv({ orgId: "org_1", deploymentId: "dep_1" });
    expect(env[EXACT_OPENROUTER]).toBe("sk-or-workspace");
    expect(env.OPENROUTER_API_KEY).toBe("sk-or-workspace");
    expect(env).not.toHaveProperty("HARNESST_MODEL_GATEWAY_URL");
    expect(env).not.toHaveProperty("HARNESST_MODEL_GATEWAY_TOKEN");
  });

  it("injects an Anthropic connection for direct provider routing", async () => {
    getWorkspaceAssistantModel.mockResolvedValue(
      `anthropic/${CONNECTION}/claude-sonnet-4-5`,
    );
    getProviderDeploymentEnv.mockResolvedValue({
      [EXACT_ANTHROPIC]: "sk-ant-workspace",
      ANTHROPIC_API_KEY: "sk-ant-workspace",
    });
    getActiveModelConnection.mockResolvedValue({ provider: "anthropic" });

    const env = await assistantEnv({ orgId: "org_1", deploymentId: "dep_1" });
    expect(env[EXACT_ANTHROPIC]).toBe("sk-ant-workspace");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-workspace");
    expect(env).not.toHaveProperty("HARNESST_MODEL_GATEWAY_TOKEN");
  });

  it("uses a published project override when no workspace default exists", async () => {
    getWorkspaceAssistantModel.mockResolvedValue(null);
    getProviderDeploymentEnv.mockResolvedValue({
      [EXACT_OPENAI]: "sk-openai-workspace",
      OPENAI_API_KEY: "sk-openai-workspace",
    });
    getActiveModelConnection.mockResolvedValue({ provider: "openai" });

    const env = await assistantEnv({
      orgId: "org_1",
      deploymentId: "dep_1",
      modelOverride: `openai/${CONNECTION}/gpt-5.4`,
      effortOverride: "high",
    });
    expect(env.HARNESST_ASSISTANT_MODEL).toBe(`openai/${CONNECTION}/gpt-5.4`);
    expect(env.HARNESST_ASSISTANT_EFFORT).toBe("high");
    expect(env[EXACT_OPENAI]).toBe("sk-openai-workspace");
    expect(getWorkspaceAssistantModel).not.toHaveBeenCalled();
  });

  it("inherits the workspace model and effort as one selection", async () => {
    getWorkspaceAssistantModel.mockResolvedValue(
      `openai/${CONNECTION}/gpt-5.4`,
    );
    getWorkspaceAssistantEffort.mockResolvedValue("medium");
    getProviderDeploymentEnv.mockResolvedValue({
      [EXACT_OPENAI]: "sk-openai-workspace",
      OPENAI_API_KEY: "sk-openai-workspace",
    });
    getActiveModelConnection.mockResolvedValue({ provider: "openai" });

    const env = await assistantEnv({ orgId: "org_1", deploymentId: "dep_1" });
    expect(env).toMatchObject({
      HARNESST_ASSISTANT_MODEL: `openai/${CONNECTION}/gpt-5.4`,
      HARNESST_ASSISTANT_EFFORT: "medium",
    });
  });

  it("does not inherit workspace effort when a project overrides the model", async () => {
    getWorkspaceAssistantModel.mockResolvedValue(
      `openai/${CONNECTION}/gpt-5.4`,
    );
    getWorkspaceAssistantEffort.mockResolvedValue("high");
    getProviderDeploymentEnv.mockResolvedValue({
      [EXACT_OPENAI]: "sk-openai-workspace",
      OPENAI_API_KEY: "sk-openai-workspace",
    });
    getActiveModelConnection.mockResolvedValue({ provider: "openai" });

    const env = await assistantEnv({
      orgId: "org_1",
      deploymentId: "dep_1",
      modelOverride: `openai/${CONNECTION}/gpt-5.4`,
      effortOverride: null,
    });
    expect(env).not.toHaveProperty("HARNESST_ASSISTANT_EFFORT");
    expect(getWorkspaceAssistantModel).not.toHaveBeenCalled();
  });

  it("runs an exact active Codex connection through the gateway", async () => {
    getWorkspaceAssistantModel.mockResolvedValue(`codex/${CONNECTION}/gpt-5.5`);
    getActiveModelConnection.mockResolvedValue({ provider: "codex" });
    hasActiveCodexConnection.mockResolvedValue(true);

    const env = await assistantEnv({ orgId: "org_1", deploymentId: "dep_1" });
    expect(env).not.toHaveProperty("OPENROUTER_API_KEY");
    expect(env.HARNESST_ASSISTANT_MODEL).toBe(`codex/${CONNECTION}/gpt-5.5`);
    expect(env.HARNESST_MODEL_GATEWAY_URL).toContain("/api/gateway/v1");
    expect(verifyGatewayToken(env.HARNESST_MODEL_GATEWAY_TOKEN)).toBe("org_1");
  });

  it("injects gateway env alongside a direct key when any Codex connection is active", async () => {
    getWorkspaceAssistantModel.mockResolvedValue(
      `openrouter/${CONNECTION}/openai/gpt-5.1`,
    );
    getProviderDeploymentEnv.mockResolvedValue({
      [EXACT_OPENROUTER]: "sk-or-workspace",
      OPENROUTER_API_KEY: "sk-or-workspace",
    });
    getActiveModelConnection.mockResolvedValue({ provider: "openrouter" });
    hasActiveCodexConnection.mockResolvedValue(true);

    const env = await assistantEnv({ orgId: "org_1", deploymentId: "dep_1" });
    expect(env[EXACT_OPENROUTER]).toBe("sk-or-workspace");
    expect(env.HARNESST_MODEL_GATEWAY_TOKEN).toBeTruthy();
  });

  it("keeps a configured legacy bare OpenRouter id runnable through the standard alias", async () => {
    getWorkspaceAssistantModel.mockResolvedValue("z-ai/glm-5.2");
    getProviderDeploymentEnv.mockResolvedValue({
      [EXACT_OPENROUTER]: "sk-or-workspace",
      OPENROUTER_API_KEY: "sk-or-workspace",
    });

    const env = await assistantEnv({ orgId: "org_1", deploymentId: "dep_1" });
    expect(env.HARNESST_ASSISTANT_MODEL).toBe("z-ai/glm-5.2");
    expect(env.OPENROUTER_API_KEY).toBe("sk-or-workspace");
  });

  it("throws when no workspace default model is configured", async () => {
    getWorkspaceAssistantModel.mockResolvedValue(null);
    await expect(
      assistantEnv({ orgId: "org_1", deploymentId: "dep_1" }),
    ).rejects.toThrow(/No assistant model is configured/);
  });

  it("rejects a qualified model whose exact connection is inactive", async () => {
    getWorkspaceAssistantModel.mockResolvedValue(
      `anthropic/${CONNECTION}/claude-sonnet-4-5`,
    );
    // A standard alias from some other connection cannot satisfy the selected exact reference.
    getProviderDeploymentEnv.mockResolvedValue({
      ANTHROPIC_API_KEY: "sk-ant-other",
    });
    getActiveModelConnection.mockResolvedValue(null);

    await expect(
      assistantEnv({ orgId: "org_1", deploymentId: "dep_1" }),
    ).rejects.toThrow(/selected model provider connection is not active/);
  });

  it("does not hide an invalid project override behind a healthy workspace default", async () => {
    getWorkspaceAssistantModel.mockResolvedValue(
      `openrouter/${CONNECTION}/openai/gpt-5.1`,
    );
    getProviderDeploymentEnv.mockResolvedValue({
      [EXACT_OPENROUTER]: "sk-or-workspace",
      OPENROUTER_API_KEY: "sk-or-workspace",
    });
    getActiveModelConnection.mockResolvedValue(null);

    await expect(
      assistantEnv({
        orgId: "org_1",
        deploymentId: "dep_1",
        modelOverride: `anthropic/${CONNECTION}/claude-sonnet-4-5`,
      }),
    ).rejects.toThrow(/selected model provider connection is not active/);
    expect(getWorkspaceAssistantModel).not.toHaveBeenCalled();
  });
});
