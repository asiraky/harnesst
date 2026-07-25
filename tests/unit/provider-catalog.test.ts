import { afterEach, describe, expect, it, vi } from "vitest";

import {
  listCodexModels,
  listAnthropicModels,
  listOpenAiModels,
  listProviderModels,
  normalizeAnthropicCatalog,
  normalizeOpenAiCatalog,
  validateProviderApiKey,
} from "~/models/provider-catalog.server";

const oldOpenRouterBase = process.env.HARNESST_OPENROUTER_API_BASE_URL;
const oldAnthropicBase = process.env.HARNESST_ANTHROPIC_API_BASE_URL;
const oldOpenAiBase = process.env.HARNESST_OPENAI_API_BASE_URL;

afterEach(() => {
  vi.restoreAllMocks();
  if (oldOpenRouterBase === undefined)
    delete process.env.HARNESST_OPENROUTER_API_BASE_URL;
  else process.env.HARNESST_OPENROUTER_API_BASE_URL = oldOpenRouterBase;
  if (oldAnthropicBase === undefined)
    delete process.env.HARNESST_ANTHROPIC_API_BASE_URL;
  else process.env.HARNESST_ANTHROPIC_API_BASE_URL = oldAnthropicBase;
  if (oldOpenAiBase === undefined) delete process.env.HARNESST_OPENAI_API_BASE_URL;
  else process.env.HARNESST_OPENAI_API_BASE_URL = oldOpenAiBase;
});

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("OpenRouter provider catalog", () => {
  it("validates with GET /api/v1/key and a bearer token at the overridable host", async () => {
    process.env.HARNESST_OPENROUTER_API_BASE_URL = "https://router.test///";
    const fetcher = vi.fn(async () => json({ data: { label: "key" } }));
    await validateProviderApiKey("openrouter", "sk-or", {
      fetch: fetcher as typeof fetch,
    });
    expect(fetcher).toHaveBeenCalledWith("https://router.test/api/v1/key", {
      method: "GET",
      headers: { authorization: "Bearer sk-or" },
    });
  });

  it("supports an injected authenticated OpenRouter catalog", async () => {
    const listOpenRouter = vi.fn(async (_apiKey: string) => []);
    await expect(
      listProviderModels("openrouter", "sk-or", { listOpenRouter }),
    ).resolves.toEqual([]);
    expect(listOpenRouter).toHaveBeenCalledOnce();
    expect(listOpenRouter).toHaveBeenCalledWith("sk-or");
  });

  it("lists models with the exact connection key", async () => {
    process.env.HARNESST_OPENROUTER_API_BASE_URL = "https://router.test";
    const fetcher = vi.fn(async () => json({ data: [{ id: "a/model" }] }));
    await expect(
      listProviderModels("openrouter", "sk-exact", {
        fetch: fetcher as typeof fetch,
      }),
    ).resolves.toHaveLength(1);
    expect(fetcher).toHaveBeenCalledWith("https://router.test/api/v1/models", {
      method: "GET",
      headers: { authorization: "Bearer sk-exact" },
    });
  });
});

describe("Codex provider catalog", () => {
  it("includes curated per-model reasoning levels", () => {
    const models = listCodexModels();
    expect(models.find((model) => model.id === "gpt-5.4")).toMatchObject({
      supportedEfforts: ["none", "low", "medium", "high", "xhigh"],
      providerDefaultEffort: "medium",
    });
    expect(models.every((model) => model.supportedEfforts?.length)).toBe(true);
  });
});

describe("Anthropic provider catalog", () => {
  it("normalizes provider token limits", () => {
    const [model] = normalizeAnthropicCatalog([
      {
        data: [
          {
            id: "claude-sonnet-5",
            display_name: "Claude Sonnet 5",
            max_input_tokens: 1_000_000,
            max_tokens: 128_000,
          },
        ],
      },
    ]);
    expect(model).toMatchObject({
      id: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      upstreamModelId: "claude-sonnet-5",
    });
  });

  it("paginates with Anthropic's required key/version headers", async () => {
    process.env.HARNESST_ANTHROPIC_API_BASE_URL = "https://anthropic.test/";
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          data: [{ id: "claude-b", display_name: "B" }],
          has_more: true,
          last_id: "claude-b",
        }),
      )
      .mockResolvedValueOnce(
        json({
          data: [{ id: "claude-a", display_name: "A" }],
          has_more: false,
        }),
      );
    const models = await listAnthropicModels("sk-ant", {
      fetch: fetcher as typeof fetch,
    });
    expect(models.map((model) => model.id)).toEqual(["claude-a", "claude-b"]);
    expect(fetcher.mock.calls[0][0]).toBe(
      "https://anthropic.test/v1/models?limit=1000",
    );
    expect(fetcher.mock.calls[1][0]).toBe(
      "https://anthropic.test/v1/models?limit=1000&after_id=claude-b",
    );
    expect(fetcher.mock.calls[0][1]).toEqual({
      method: "GET",
      headers: {
        "x-api-key": "sk-ant",
        "anthropic-version": "2023-06-01",
      },
    });
  });
});

describe("OpenAI provider catalog", () => {
  it("keeps text/chat model families and excludes non-text variants", () => {
    const models = normalizeOpenAiCatalog({
      data: [
        { id: "gpt-5.4", owned_by: "openai" },
        { id: "o3-pro" },
        { id: "codex-mini-latest" },
        { id: "ft:gpt-5-mini:org:custom" },
        { id: "ft:o3-mini:org:custom" },
        { id: "ft:text-embedding-3-large:org:custom" },
        { id: "gpt-4o-realtime-preview" },
        { id: "text-embedding-3-large" },
        { id: "text-davinci-003" },
        { id: "davinci-002" },
        { id: "babbage-002" },
        { id: "dall-e-3" },
        { id: "whisper-1" },
      ],
    });
    expect(models.map((model) => model.id)).toEqual([
      "codex-mini-latest",
      "ft:gpt-5-mini:org:custom",
      "ft:o3-mini:org:custom",
      "gpt-5.4",
      "o3-pro",
    ]);
  });

  it("uses GET /v1/models with bearer authentication at the overridable host", async () => {
    process.env.HARNESST_OPENAI_API_BASE_URL = "https://openai.test/";
    const fetcher = vi.fn(async () => json({ data: [{ id: "gpt-5.4" }] }));
    await expect(
      listOpenAiModels("sk-openai", { fetch: fetcher as typeof fetch }),
    ).resolves.toHaveLength(1);
    expect(fetcher).toHaveBeenCalledWith("https://openai.test/v1/models", {
      method: "GET",
      headers: { authorization: "Bearer sk-openai" },
    });
  });
});

describe("provider key errors", () => {
  it("does not include the credential in an upstream rejection error", async () => {
    const fetcher = vi.fn(async () => json({ error: "bad" }, 401));
    const error = await validateProviderApiKey("openai", "super-secret", {
      fetch: fetcher as typeof fetch,
    }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("super-secret");
  });
});
