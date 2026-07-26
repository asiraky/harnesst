import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  modelDirectiveSignaturePayload,
  parseModelDirective,
  stripModelDirective,
} from "~/models/model-directive";
import {
  signModelDirective,
  verifyModelDirectiveSignature,
} from "~/models/model-directive.server";

const OLD_KEY = process.env.HARNESST_SECRETS_KEY;
const DEPLOYMENT = "abcdefghijkl";
const MODEL = "anthropic/mnopqrstuvwx/claude-sonnet-4-5";

beforeEach(() => {
  process.env.HARNESST_SECRETS_KEY = "a".repeat(64);
});

afterEach(() => {
  if (OLD_KEY === undefined) delete process.env.HARNESST_SECRETS_KEY;
  else process.env.HARNESST_SECRETS_KEY = OLD_KEY;
});

describe("signed model directives", () => {
  it("keeps the legacy model line while signing the exact message body", () => {
    const body = "seed context\n\nhello";
    const directive = {
      id: MODEL,
      contextWindowTokens: 200_000,
      effort: "high" as const,
    };
    const signed = signModelDirective(directive, DEPLOYMENT, body);
    const signature = signed.match(/<!-- harnesst:sig ([a-f0-9]{64}) -->/)?.[1];

    expect(signed).toMatch(
      /^<!-- harnesst:model anthropic\/mnopqrstuvwx\/claude-sonnet-4-5 ctx=200000 effort=high -->\n<!-- harnesst:sig [a-f0-9]{64} -->$/,
    );
    expect(signature).toBeTruthy();
    expect(
      verifyModelDirectiveSignature(directive, DEPLOYMENT, body, signature!),
    ).toBe(true);
    expect(
      verifyModelDirectiveSignature(
        directive,
        DEPLOYMENT,
        `${body}!`,
        signature!,
      ),
    ).toBe(false);
  });

  it("keeps the legacy signature payload when effort is unset", () => {
    const body = "hello";
    const directive = { id: MODEL, contextWindowTokens: 200_000 };
    expect(modelDirectiveSignaturePayload(directive, body)).toBe(
      `${MODEL}\n200000\n${body}`,
    );
    const signature = signModelDirective(directive, DEPLOYMENT, body).match(
      /<!-- harnesst:sig ([a-f0-9]{64}) -->/,
    )?.[1];

    expect(signature).toBeTruthy();
    expect(
      verifyModelDirectiveSignature(directive, DEPLOYMENT, body, signature!),
    ).toBe(true);
    expect(
      verifyModelDirectiveSignature(
        { ...directive, effort: "high" },
        DEPLOYMENT,
        body,
        signature!,
      ),
    ).toBe(false);
  });

  it("parses and strips the signed prefix without exposing its signature", () => {
    const body = "hello";
    const signed = signModelDirective({ id: MODEL }, DEPLOYMENT, body);
    const sent = `${signed}\n\n${body}`;

    expect(parseModelDirective(sent)).toEqual({
      id: MODEL,
      contextWindowTokens: undefined,
      effort: undefined,
    });
    expect(stripModelDirective(sent)).toBe(body);
  });
});
