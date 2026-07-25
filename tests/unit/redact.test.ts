import { describe, expect, it } from "vitest";

import {
  capField,
  capString,
  FIELD_CAP,
  redactSecrets,
} from "~/observability/capture.server";

describe("redactSecrets", () => {
  it("masks bearer tokens in strings", () => {
    expect(
      redactSecrets(
        "curl -H 'Authorization: Bearer abc.def-1234567890xyz' https://x",
      ),
    ).toBe("curl -H 'Authorization: Bearer [redacted]' https://x");
  });

  it("leaves short 'Bearer' prose alone", () => {
    const prose = "the Bearer of this message brings good news";
    expect(redactSecrets(prose)).toBe(prose);
  });

  it("scrubs run-level metadata/error shapes (what ingestRun feeds through)", () => {
    // ingestRun's only seam is the DB call, so assert the pure pass over the exact shapes it
    // now routes through it: run metadata (with the raw user input) and the error string.
    const metadata = redactSecrets({
      input: "use key sk-ant-0123456789abcdefghijklmnop please",
    }) as { input: string };
    expect(metadata.input).toBe("use key [redacted] please");
    expect(
      redactSecrets(
        "tool failed: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload rejected",
      ),
    ).toBe("tool failed: Authorization: Bearer [redacted] rejected");
  });

  it("masks provider and cloud keys anywhere they appear", () => {
    const out = redactSecrets(
      "key sk-ant-0123456789abcdefghijklmnop and sk-0123456789abcdefghij and AKIAIOSFODNN7EXAMPLE and ghp_0123456789abcdefghij0123456789abcd",
    ) as string;
    expect(out).not.toMatch(/sk-ant-0123/);
    expect(out).not.toMatch(/AKIAIOSFODNN7EXAMPLE/);
    expect(out).not.toMatch(/ghp_0123/);
    expect(out).toContain("[redacted]");
  });

  it("masks harnesst ingest tokens", () => {
    expect(redactSecrets("edn_abcdefghijklmnopqrstuvwx")).toBe("[redacted]");
  });

  it("masks long opaque values only under secret-shaped keys", () => {
    const blob = "Zm9vYmFyODY0YmxvYjEyMzQ1Njc4OTBhYmNkZWY";
    const out = redactSecrets({ apiKey: blob, note: blob }) as Record<
      string,
      unknown
    >;
    expect(out.apiKey).toBe("[redacted]");
    // A plain long value under a non-secret key survives (conservative).
    expect(out.note).toBe(blob);
  });

  it("does not shred normal prose", () => {
    const prose = "The agent read three files and summarized the results nicely.";
    expect(redactSecrets(prose)).toBe(prose);
  });

  it("walks nested objects and arrays", () => {
    const out = redactSecrets({
      steps: [{ token: "abcdefghijklmnopqrstuvwxyz012345" }],
    }) as { steps: { token: string }[] };
    expect(out.steps[0].token).toBe("[redacted]");
  });
});

describe("caps", () => {
  it("keeps the head of an oversized string and flags truncation", () => {
    const { text, truncated } = capString("z".repeat(FIELD_CAP + 10));
    expect(text.length).toBe(FIELD_CAP);
    expect(truncated).toBe(true);
  });

  it("caps string leaves inside an object", () => {
    const { value, truncated } = capField({
      command: "a".repeat(FIELD_CAP + 1),
      short: "ok",
    });
    const v = value as { command: string; short: string };
    expect(v.command.length).toBe(FIELD_CAP);
    expect(v.short).toBe("ok");
    expect(truncated).toBe(true);
  });

  it("passes small values through untouched", () => {
    const { value, truncated } = capField({ command: "ls -la" });
    expect(value).toEqual({ command: "ls -la" });
    expect(truncated).toBe(false);
  });
});
