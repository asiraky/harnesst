import { describe, expect, it } from "vitest";

import {
  ACTION_INPUT_CAP,
  ACTION_OUTPUT_CAP,
  formatActionInput,
  formatActionOutput,
  toChatStepAction,
  toChatStepActions,
} from "~/chat/step-actions.server";

describe("formatActionInput", () => {
  it("shows a bash command verbatim", () => {
    expect(formatActionInput({ command: "ls -la /workspace" })).toBe(
      "ls -la /workspace",
    );
  });

  it("pretty-prints any other input as JSON", () => {
    expect(formatActionInput({ path: "a.txt", lines: [1, 2] })).toBe(
      JSON.stringify({ path: "a.txt", lines: [1, 2] }, null, 2),
    );
  });

  it("returns null for a missing input", () => {
    expect(formatActionInput(undefined)).toBeNull();
    expect(formatActionInput(null)).toBeNull();
  });

  it("caps at the input limit and marks the cut", () => {
    const out = formatActionInput({ command: "x".repeat(ACTION_INPUT_CAP + 50) })!;
    expect(out.startsWith("x".repeat(ACTION_INPUT_CAP))).toBe(true);
    expect(out.slice(ACTION_INPUT_CAP)).toBe("\n… (truncated)");
    expect(formatActionInput({ command: "x".repeat(ACTION_INPUT_CAP) })).toBe(
      "x".repeat(ACTION_INPUT_CAP),
    );
  });

  it("redacts secrets, including by key before the object is flattened", () => {
    const token = "A".repeat(40);
    const out = formatActionInput({ url: "https://x", apiKey: token })!;
    expect(out).not.toContain(token);
    const cmd = formatActionInput({
      command: `curl -H "Authorization: Bearer ${"b".repeat(30)}" x`,
    })!;
    expect(cmd).not.toContain("b".repeat(30));
  });
});

describe("formatActionOutput", () => {
  it("joins stdout and a labelled stderr", () => {
    expect(
      formatActionOutput({ stdout: "ok\n", stderr: "warn\n", exitCode: 0 }),
    ).toBe("ok\nstderr:\nwarn");
  });

  it("omits a blank stderr and returns null when there's nothing at all", () => {
    expect(formatActionOutput({ stdout: "ok", stderr: "  \n" })).toBe("ok");
    expect(formatActionOutput({ stdout: "", stderr: "" })).toBeNull();
  });

  it("passes a string through and pretty-prints anything else", () => {
    expect(formatActionOutput("done")).toBe("done");
    expect(formatActionOutput({ files: ["a"] })).toBe(
      JSON.stringify({ files: ["a"] }, null, 2),
    );
  });

  it("caps at the output limit", () => {
    const out = formatActionOutput("y".repeat(ACTION_OUTPUT_CAP + 1))!;
    expect(out.length).toBe(ACTION_OUTPUT_CAP + "\n… (truncated)".length);
  });

  it("redacts credentials in output", () => {
    const key = `sk-ant-${"k".repeat(30)}`;
    expect(formatActionOutput({ stdout: `KEY=${key}` })).not.toContain(key);
  });
});

describe("toChatStepActions", () => {
  it("is undefined for a step with no tool calls", () => {
    expect(toChatStepActions(undefined)).toBeUndefined();
    expect(toChatStepActions([])).toBeUndefined();
  });

  it("defaults the error flag and exit code", () => {
    expect(toChatStepAction({ toolName: "bash" })).toEqual({
      toolName: "bash",
      summary: null,
      input: null,
      output: null,
      exitCode: null,
      isError: false,
    });
  });
});
