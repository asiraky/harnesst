/**
 * Display formatting for one tool call inside a chat step (`ChatStepAction`). Shared by the live
 * stream (`toChatStep`) and the eve replay projection so a reload renders exactly what the live
 * turn showed. Pure apart from the redaction table it borrows.
 *
 * Order matters: secrets are redacted on the RAW value first (so key-based redaction still sees
 * object keys like `apiKey`), then the value is formatted, then capped — capping first could cut a
 * token mid-way into a shape the redaction patterns no longer recognise.
 */
import type { ChatStepAction } from "~/chat/types";
import { redactSecrets } from "~/observability/capture.server";

export const ACTION_INPUT_CAP = 4_000;
export const ACTION_OUTPUT_CAP = 8_000;
const TRUNCATED = "\n… (truncated)";

export interface RawStepAction {
  toolName: string;
  summary?: string | null;
  input?: unknown;
  output?: unknown;
  exitCode?: number | null;
  isError?: boolean;
}

function cap(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}${TRUNCATED}` : value;
}

function prettyJson(value: unknown): string | null {
  try {
    const json = JSON.stringify(value, null, 2);
    return json === undefined ? null : json;
  } catch {
    return null;
  }
}

/** A bash-like `{command}` input shows the command verbatim; anything else as pretty JSON. */
export function formatActionInput(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  const redacted = redactSecrets(input);
  let text: string | null;
  if (typeof redacted === "string") text = redacted;
  else if (
    typeof redacted === "object" &&
    redacted !== null &&
    !Array.isArray(redacted) &&
    typeof (redacted as Record<string, unknown>).command === "string"
  ) {
    text = (redacted as Record<string, unknown>).command as string;
  } else text = prettyJson(redacted);
  return text ? cap(text, ACTION_INPUT_CAP) : null;
}

/** stdout/stderr outputs join (stderr labelled); strings verbatim; anything else pretty JSON. */
export function formatActionOutput(output: unknown): string | null {
  if (output === undefined || output === null) return null;
  const redacted = redactSecrets(output);
  let text: string | null;
  if (typeof redacted === "string") text = redacted;
  else if (
    typeof redacted === "object" &&
    redacted !== null &&
    !Array.isArray(redacted) &&
    ("stdout" in redacted || "stderr" in redacted)
  ) {
    const o = redacted as Record<string, unknown>;
    const stdout = typeof o.stdout === "string" ? o.stdout : "";
    const stderr = typeof o.stderr === "string" ? o.stderr : "";
    text = [
      stdout.replace(/\n+$/, ""),
      stderr.trim() ? `stderr:\n${stderr.replace(/\n+$/, "")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  } else text = prettyJson(redacted);
  return text ? cap(text, ACTION_OUTPUT_CAP) : null;
}

export function toChatStepAction(action: RawStepAction): ChatStepAction {
  return {
    toolName: action.toolName,
    summary: action.summary ? (redactSecrets(action.summary) as string) : null,
    input: formatActionInput(action.input),
    output: formatActionOutput(action.output),
    exitCode: action.exitCode ?? null,
    isError: action.isError ?? false,
  };
}

/** Undefined for a step with no tool calls, so the field stays absent on model-only steps. */
export function toChatStepActions(
  actions: ReadonlyArray<RawStepAction> | null | undefined,
): ChatStepAction[] | undefined {
  return actions && actions.length > 0
    ? actions.map(toChatStepAction)
    : undefined;
}
