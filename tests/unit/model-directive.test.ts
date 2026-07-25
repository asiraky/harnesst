/**
 * The playground model directive — the one-line transport between the model selector and the
 * deployed agent's dynamic-model resolver. Round-trips must be exact: the same line harnesst builds
 * is parsed back for attribution and stripped from every display surface.
 */
import { describe, expect, it } from "vitest";

import {
  buildModelDirective,
  effectiveModelId,
  parseModelDirective,
  stripModelDirective,
} from "~/models/model-directive";

describe("buildModelDirective", () => {
  it("builds the id + context window line", () => {
    expect(
      buildModelDirective({
        id: "anthropic/claude-sonnet-5",
        contextWindowTokens: 200_000,
        effort: "high",
      }),
    ).toBe(
      "<!-- harnesst:model anthropic/claude-sonnet-5 ctx=200000 effort=high -->",
    );
  });

  it("omits the context window when unknown", () => {
    expect(buildModelDirective({ id: "openai/gpt-5.1" })).toBe(
      "<!-- harnesst:model openai/gpt-5.1 -->",
    );
  });

  it("drops characters that could break the comment or the parser", () => {
    expect(buildModelDirective({ id: "we`ird -->id" })).toBe(
      "<!-- harnesst:model weird--id -->",
    );
  });
});

describe("parseModelDirective", () => {
  it("round-trips what buildModelDirective produced (as a sent-message prefix)", () => {
    const sent = `${buildModelDirective({ id: "z-ai/glm-5.2", contextWindowTokens: 131_072, effort: "low" })}\n\nwhat model are you?`;
    expect(parseModelDirective(sent)).toEqual({
      id: "z-ai/glm-5.2",
      contextWindowTokens: 131_072,
      effort: "low",
    });
  });

  it("parses a directive without a context window", () => {
    expect(
      parseModelDirective("<!-- harnesst:model openai/gpt-5.1 -->\n\nhi"),
    ).toEqual({
      id: "openai/gpt-5.1",
      contextWindowTokens: undefined,
      effort: undefined,
    });
  });

  it("parses effort without requiring a context window", () => {
    expect(
      parseModelDirective(
        "<!-- harnesst:model codex/abcdefghijkl/gpt-5.5 effort=xhigh -->\n\nhi",
      ),
    ).toEqual({
      id: "codex/abcdefghijkl/gpt-5.5",
      contextWindowTokens: undefined,
      effort: "xhigh",
    });
  });

  it("returns null when the message has no directive", () => {
    expect(parseModelDirective("just a normal message")).toBeNull();
  });

  it("ignores a directive that is not at the start of the message", () => {
    expect(
      parseModelDirective("look at this: <!-- harnesst:model openai/gpt-5.1 -->"),
    ).toBeNull();
  });

  it("returns null for malformed directives", () => {
    expect(parseModelDirective("<!-- harnesst:model -->\n\nhi")).toBeNull();
  });
});

describe("stripModelDirective", () => {
  it("removes the directive line and the blank line after it", () => {
    const sent =
      "<!-- harnesst:model anthropic/claude-sonnet-5 ctx=200000 -->\n\nwhat model are you?";
    expect(stripModelDirective(sent)).toBe("what model are you?");
  });

  it("leaves ordinary messages untouched", () => {
    expect(stripModelDirective("2 + 2 = ?")).toBe("2 + 2 = ?");
    expect(stripModelDirective("multi\n\nline")).toBe("multi\n\nline");
  });

  it("leaves a mid-message mention untouched", () => {
    const text = "the line <!-- harnesst:model x --> is a directive";
    expect(stripModelDirective(text)).toBe(text);
  });
});

describe("effectiveModelId", () => {
  it("returns the static runtime id as-is, ignoring any directive", () => {
    expect(
      effectiveModelId(
        "anthropic/claude-sonnet-5",
        "<!-- harnesst:model openai/gpt-5.1 -->\n\nhi",
      ),
    ).toBe("anthropic/claude-sonnet-5");
  });

  it("unwraps the dynamic prefix to the fallback when no directive was sent", () => {
    expect(effectiveModelId("dynamic:anthropic/claude-sonnet-5", "hi")).toBe(
      "anthropic/claude-sonnet-5",
    );
  });

  it("prefers the sent directive for a dynamic-model agent", () => {
    expect(
      effectiveModelId(
        "dynamic:anthropic/claude-sonnet-5",
        "<!-- harnesst:model openai/gpt-5.1 ctx=400000 -->\n\nhi",
      ),
    ).toBe("openai/gpt-5.1");
  });

  it("strips the gateway provider segment from a live-model fallback id", () => {
    // A live openrouter.chatModel fallback is reported as dynamic:openrouter/<id> — the
    // fallback-served turn must display the same bare id directive-served turns do.
    expect(
      effectiveModelId(
        "dynamic:openrouter.chat/anthropic/claude-haiku-4.5",
        "hi",
      ),
    ).toBe("anthropic/claude-haiku-4.5");
    // A model under OpenRouter's own vendor namespace survives the single-segment strip.
    expect(
      effectiveModelId("dynamic:openrouter.chat/openrouter/auto", "hi"),
    ).toBe("openrouter/auto");
  });

  it("keeps a connection-qualified direct-provider fallback reference", () => {
    expect(
      effectiveModelId(
        "dynamic:anthropic/abcdefghijkl/claude-sonnet-4-5",
        "hi",
      ),
    ).toBe("anthropic/abcdefghijkl/claude-sonnet-4-5");
    expect(
      effectiveModelId(
        "dynamic:openrouter/abcdefghijkl.chat/anthropic/claude-sonnet-4-5",
        "hi",
      ),
    ).toBe("openrouter/abcdefghijkl/anthropic/claude-sonnet-4-5");
  });

  it("normalizes the OpenAI SDK's runtime flavor suffix back to the selected reference", () => {
    expect(
      effectiveModelId("dynamic:openai/abcdefghijkl.responses/gpt-5.4", "hi"),
    ).toBe("openai/abcdefghijkl/gpt-5.4");
  });

  it("strips the harnesst gateway segment but keeps a codex/<conn>/<slug> id intact (issue #28)", () => {
    // A codex fallback runs through the harnesstGateway provider (named "harnesst"), so eve reports
    // dynamic:harnesst/codex/<conn>/<slug>. Only the leading provider segment is stripped.
    expect(
      effectiveModelId("dynamic:harnesst.chat/codex/abcdefghijkl/gpt-5.5", "hi"),
    ).toBe("codex/abcdefghijkl/gpt-5.5");
  });
});
