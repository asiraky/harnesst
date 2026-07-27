/**
 * Run-transcript rendering (Observe pillar, M3 — PRD §7.6). Turns a run's ordered steps into a
 * chat-shaped narrative instead of a JSON dump: user/assistant bubbles, quiet model-call beats,
 * foldable reasoning, and tool calls as collapsed action rows that expand to a SEMANTIC render
 * (a bash call reads like a terminal; everything else gets Input/Output sections) with an
 * opt-in "Raw JSON" toggle and copy buttons. Everything degrades to whatever `data` exists —
 * legacy runs with `{summary, exitCode}` or nothing still render.
 *
 * Progressive disclosure is real: an expanded body is rendered ONLY while open (render-prop),
 * so a 100-step run keeps its payloads out of the DOM until asked for. Reused visual language
 * from `chat.tsx` (bubbles, muted step cards) so Playground and Observe feel like one product.
 */
import { useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Brain,
  Check,
  ChevronRight,
  Copy,
  Cpu,
  MessageSquare,
  Terminal,
  Users,
  Wrench,
} from "lucide-react";

import { Badge } from "~/components/ui/badge";
import { stripChannelContext } from "~/chat/channel-context";
import { formatMs } from "~/lib/time";

/** A run step as it arrives from the loader (drizzle row; `data` is free-form jsonb). */
export interface StepView {
  id: string;
  seq: number;
  type: string;
  model: string | null;
  toolName: string | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  durationMs: number | null;
  isError: boolean;
  approvalGated: boolean;
  data: Record<string, unknown> | null;
}

function tokensOf(step: StepView): number {
  return (step.tokensInput ?? 0) + (step.tokensOutput ?? 0);
}

function asString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** Copy-to-clipboard button that flips to a check for a beat. */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground transition hover:bg-muted"
      onClick={() => {
        navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          },
          () => {},
        );
      }}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      {copied ? "Copied" : label}
    </button>
  );
}

/**
 * A thin relative-duration bar — a lightweight waterfall substitute. Width scales to the
 * slowest step in the run so the expensive step pops without a full Gantt chart.
 */
function DurationBar({
  durationMs,
  maxMs,
}: {
  durationMs: number | null;
  maxMs: number;
}) {
  if (durationMs == null || maxMs <= 0) return null;
  const pct = Math.max(3, Math.round((durationMs / maxMs) * 100));
  return (
    <span
      className="hidden h-1 w-16 overflow-hidden rounded-full bg-muted sm:inline-block"
      title={`${formatMs(durationMs)} of ${formatMs(maxMs)} (slowest step)`}
      aria-hidden
    >
      <span
        className="block h-full rounded-full bg-muted-foreground/50"
        style={{ width: `${pct}%` }}
      />
    </span>
  );
}

/** Controlled disclosure: body is built (render-prop) ONLY while open — never in the DOM otherwise. */
function Expandable({
  id,
  defaultOpen,
  header,
  children,
}: {
  id?: string;
  defaultOpen?: boolean;
  /** Receives the open state so the row can rotate a chevron etc. */
  header: (open: boolean) => ReactNode;
  children: () => ReactNode;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div
      id={id}
      className="scroll-mt-20 rounded-xl border bg-card text-card-foreground"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
      >
        <ChevronRight
          className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
          aria-hidden
        />
        {header(open)}
      </button>
      {open && <div className="border-t px-3 py-3">{children()}</div>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-2 first:mt-0">
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      {children}
    </div>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return (
    <pre className="max-h-80 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap">
      {children}
    </pre>
  );
}

// —— Tool renderer registry ————————————————————————————————————————————————
// Keyed by tool name with a generic fallback. A renderer gets the tool step's `data` and draws
// its input/output semantically. Ship two: a bash-like terminal and a generic Input/Output.

type ToolData = {
  input?: unknown;
  output?: unknown;
  summary?: string;
  exitCode?: number;
  truncated?: boolean;
};

function TruncatedNote({ data }: { data: ToolData }) {
  if (!data.truncated) return null;
  return (
    <p className="mt-1 text-xs text-muted-foreground">
      Output truncated to fit — showing the head.
    </p>
  );
}

/** bash-shaped: command as a terminal line, output as a mono block with exit code. */
function BashRenderer({ data }: { data: ToolData }) {
  const command =
    data.input && typeof data.input === "object"
      ? (data.input as Record<string, unknown>).command
      : data.input;
  const output = data.output;
  const stdout =
    output && typeof output === "object"
      ? ((output as Record<string, unknown>).stdout ??
        (output as Record<string, unknown>).output ??
        output)
      : output;
  return (
    <div>
      {command != null && (
        <Section title="Command">
          <pre className="overflow-auto rounded-lg border bg-black/90 p-3 font-mono text-xs text-emerald-300 whitespace-pre-wrap dark:bg-black">
            <span className="text-muted-foreground">$ </span>
            {asString(command)}
          </pre>
        </Section>
      )}
      {stdout != null && String(stdout).length > 0 && (
        <Section title={`Output${data.exitCode != null ? ` · exit ${data.exitCode}` : ""}`}>
          <Mono>{asString(stdout)}</Mono>
        </Section>
      )}
      <TruncatedNote data={data} />
    </div>
  );
}

/** Fallback: Input / Output sections, objects pretty-printed, strings as text. */
function GenericRenderer({ data }: { data: ToolData }) {
  const hasInput = data.input !== undefined;
  const hasOutput = data.output !== undefined;
  if (!hasInput && !hasOutput) {
    return (
      <p className="text-xs text-muted-foreground">
        {data.summary
          ? data.summary
          : "No input or output was captured for this step."}
      </p>
    );
  }
  return (
    <div>
      {hasInput && (
        <Section title="Input">
          <Mono>{asString(data.input)}</Mono>
        </Section>
      )}
      {hasOutput && (
        <Section title={`Output${data.exitCode != null ? ` · exit ${data.exitCode}` : ""}`}>
          <Mono>{asString(data.output)}</Mono>
        </Section>
      )}
      <TruncatedNote data={data} />
    </div>
  );
}

/**
 * Detect harnesst's generated delegation tool. eve derives a tool's name from its kebab filename
 * (`ask-teammate.ts` → `ask-teammate`); match the underscore form defensively too.
 */
function isDelegationTool(toolName: string | null): boolean {
  return toolName === "ask-teammate" || toolName === "ask_teammate";
}

/**
 * A delegation step: the ask (input.message), the teammate's reply (output.reply) or the error,
 * and — when the peer run was recorded — a link into it (linked traces, D6).
 */
function DelegationRenderer({ data }: { data: ToolData }) {
  const input = (data.input ?? {}) as Record<string, unknown>;
  const output = (data.output ?? {}) as Record<string, unknown>;
  const teammate =
    typeof output.teammate === "string"
      ? output.teammate
      : typeof input.teammate === "string"
        ? input.teammate
        : null;
  const message = typeof input.message === "string" ? input.message : null;
  const reply = typeof output.reply === "string" ? output.reply : null;
  const error =
    output.ok === false && typeof output.error === "string" ? output.error : null;
  const runPath = typeof output.runPath === "string" ? output.runPath : null;
  return (
    <div>
      {message && (
        <Section title={`Asked ${teammate ?? "teammate"}`}>
          <Mono>{message}</Mono>
        </Section>
      )}
      {reply && (
        <Section title="Reply">
          <Mono>{reply}</Mono>
        </Section>
      )}
      {error && (
        <Section title="Result">
          <p className="text-sm text-destructive whitespace-pre-wrap">{error}</p>
        </Section>
      )}
      {runPath && (
        <a
          href={runPath}
          className="mt-2 inline-block text-sm font-medium underline underline-offset-4"
        >
          View {teammate ?? "the teammate"}&rsquo;s run →
        </a>
      )}
    </div>
  );
}

/** Detect a bash-shaped call: named `bash` or carrying a string `input.command`. */
function isBashShaped(toolName: string | null, data: ToolData): boolean {
  if (toolName === "bash" || toolName === "shell" || toolName === "exec")
    return true;
  return !!(
    data.input &&
    typeof data.input === "object" &&
    typeof (data.input as Record<string, unknown>).command === "string"
  );
}

function ToolCall({
  step,
  maxMs,
  defaultOpen,
}: {
  step: StepView;
  maxMs: number;
  defaultOpen?: boolean;
}) {
  const data = (step.data ?? {}) as ToolData;
  const rawJson = JSON.stringify(step.data ?? {}, null, 2);
  const delegation = isDelegationTool(step.toolName);
  const output = (data.output ?? {}) as Record<string, unknown>;
  const input = (data.input ?? {}) as Record<string, unknown>;
  const teammate =
    typeof output.teammate === "string"
      ? output.teammate
      : typeof input.teammate === "string"
        ? input.teammate
        : null;
  // Failed tool calls read red; delegation is its own team hue (indigo); everything else
  // takes the brand accent so the transcript has colour without being loud.
  const iconColor = step.isError
    ? "text-rose-600 dark:text-rose-400"
    : delegation
      ? "text-indigo-600 dark:text-indigo-400"
      : "text-primary";
  return (
    <Expandable
      id={`step-${step.seq}`}
      defaultOpen={defaultOpen}
      header={() => (
        <span className="flex min-w-0 flex-1 items-center gap-2">
          {delegation ? (
            <Users className={`size-4 shrink-0 ${iconColor}`} />
          ) : isBashShaped(step.toolName, data) ? (
            <Terminal className={`size-4 shrink-0 ${iconColor}`} />
          ) : (
            <Wrench className={`size-4 shrink-0 ${iconColor}`} />
          )}
          {delegation ? (
            <span className="font-medium">
              Asked {teammate ?? "teammate"}
            </span>
          ) : (
            <span className="font-mono font-medium">{step.toolName ?? "tool"}</span>
          )}
          {!delegation && data.summary && (
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
              {data.summary}
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
            {step.isError && <Badge variant="destructive">error</Badge>}
            {step.approvalGated && <Badge variant="outline">approval</Badge>}
            <DurationBar durationMs={step.durationMs} maxMs={maxMs} />
            <span>{formatMs(step.durationMs)}</span>
          </span>
        </span>
      )}
    >
      {() => (
        <ToolBody data={data} toolName={step.toolName} rawJson={rawJson} />
      )}
    </Expandable>
  );
}

function ToolBody({
  data,
  toolName,
  rawJson,
}: {
  data: ToolData;
  toolName: string | null;
  rawJson: string;
}) {
  const [raw, setRaw] = useState(false);
  return (
    <div>
      {raw ? (
        <Mono>{rawJson}</Mono>
      ) : isDelegationTool(toolName) ? (
        <DelegationRenderer data={data} />
      ) : isBashShaped(toolName, data) ? (
        <BashRenderer data={data} />
      ) : (
        <GenericRenderer data={data} />
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded-md border px-2 py-1 text-xs text-muted-foreground transition hover:bg-muted"
          onClick={() => setRaw((r) => !r)}
        >
          {raw ? "Semantic view" : "Raw JSON"}
        </button>
        {data.input !== undefined && (
          <CopyButton value={asString(data.input)} label="Copy input" />
        )}
        {data.output !== undefined && (
          <CopyButton value={asString(data.output)} label="Copy output" />
        )}
      </div>
    </div>
  );
}

/**
 * A model-call beat: a compact one-line row (model, tokens, duration, relative bar) — the quiet
 * thinking between actions. Expands only when it carries error detail. `expensive` tints the
 * top token-consuming call(s).
 */
function ModelCall({
  step,
  maxMs,
  expensive,
  defaultOpen,
}: {
  step: StepView;
  maxMs: number;
  expensive?: boolean;
  defaultOpen?: boolean;
}) {
  const data = (step.data ?? {}) as {
    message?: string;
    code?: string;
    details?: string;
  };
  const line = (
    <span className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground">
      <Cpu
        className={`size-3.5 shrink-0 ${
          step.isError ? "text-rose-600 dark:text-rose-400" : "text-primary"
        }`}
      />
      <span className="truncate font-mono">{step.model ?? "model call"}</span>
      {expensive && (
        <Badge variant="outline" className="border-amber-500/50 text-amber-600 dark:text-amber-400">
          top tokens
        </Badge>
      )}
      {step.isError && <Badge variant="destructive">error</Badge>}
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {tokensOf(step) > 0 && (
          <span title="input / output tokens">
            {step.tokensInput ?? 0} in / {step.tokensOutput ?? 0} out
          </span>
        )}
        <DurationBar durationMs={step.durationMs} maxMs={maxMs} />
        <span>{formatMs(step.durationMs)}</span>
      </span>
    </span>
  );

  if (!step.isError) {
    return (
      <div
        className={`flex items-center gap-2 rounded-lg px-3 py-1.5 ${expensive ? "bg-amber-500/5" : ""}`}
      >
        {line}
      </div>
    );
  }
  return (
    <Expandable
      id={`step-${step.seq}`}
      defaultOpen={defaultOpen}
      header={() => line}
    >
      {() => (
        <div className="text-sm text-destructive whitespace-pre-wrap">
          {data.message}
          {data.code ? `\nCode: ${data.code}` : ""}
          {data.details ? `\nDetails: ${data.details}` : ""}
        </div>
      )}
    </Expandable>
  );
}

/** Reasoning: foldable muted prose, visually distinct from messages and tool I/O. */
function Reasoning({ step }: { step: StepView }) {
  const data = (step.data ?? {}) as { text?: string; truncated?: boolean };
  const text = data.text ?? "";
  if (!text) return null;
  return (
    <Expandable
      id={`step-${step.seq}`}
      header={() => (
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <Brain className="size-3.5 text-primary" />
          Reasoning
        </span>
      )}
    >
      {() => (
        <p className="text-sm italic text-muted-foreground whitespace-pre-wrap">
          {text}
          {data.truncated ? " …" : ""}
        </p>
      )}
    </Expandable>
  );
}

/** JSON-looking assistant text renders as code; prose renders as prose. */
function looksStructured(text: string): boolean {
  const t = text.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

function MessageBubble({
  step,
  emphasized,
}: {
  step: StepView;
  /** The run's final answer — visually lifted. */
  emphasized?: boolean;
}) {
  const data = (step.data ?? {}) as {
    role?: string;
    text?: string;
    truncated?: boolean;
  };
  const role = data.role === "user" ? "user" : "assistant";
  // A channel-triggered turn's user message leads with eve's `<github_context>` envelope — the
  // model's addressing metadata, not the person's words. Display-only: the recorded step keeps it.
  const text =
    role === "user"
      ? stripChannelContext(data.text ?? "")
      : (data.text ?? "");
  if (!text) return null;

  if (role === "user") {
    return (
      <div className="group flex flex-col items-end gap-1">
        <div className="ml-auto w-fit max-w-[85%] rounded-2xl bg-primary px-4 py-2.5 text-sm text-primary-foreground">
          <p className="whitespace-pre-wrap">{text}</p>
        </div>
        <div className="opacity-0 transition group-hover:opacity-100">
          <CopyButton value={text} label="Copy input" />
        </div>
      </div>
    );
  }

  const structured = looksStructured(text);
  return (
    <div
      className={`w-fit max-w-[85%] rounded-2xl border px-4 py-2.5 text-sm ${
        emphasized ? "border-primary/40 bg-primary/5 shadow-sm" : "bg-card"
      }`}
    >
      {emphasized && (
        <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Answer
        </p>
      )}
      {structured ? (
        <Mono>{text}</Mono>
      ) : (
        <p className="whitespace-pre-wrap">{text}</p>
      )}
      {data.truncated && (
        <p className="mt-1 text-xs text-muted-foreground">Truncated to fit.</p>
      )}
    </div>
  );
}

/**
 * The whole transcript, in seq order. Computes the slowest step (for duration bars), the
 * top-token model call (highlight), the last assistant message (emphasis), and the first error
 * step (auto-expanded — the "jump to failing step" target).
 */
export function RunTranscript({ steps }: { steps: StepView[] }) {
  if (steps.length === 0) {
    return (
      <p className="mt-2 text-sm text-muted-foreground">
        No steps recorded for this run.
      </p>
    );
  }
  const maxMs = steps.reduce((m, s) => Math.max(m, s.durationMs ?? 0), 0);
  const maxModelTokens = steps.reduce(
    (m, s) => (s.type === "model_call" ? Math.max(m, tokensOf(s)) : m),
    0,
  );
  const firstErrorSeq = steps.find((s) => s.isError)?.seq ?? null;
  const lastAssistantSeq = [...steps]
    .reverse()
    .find(
      (s) =>
        s.type === "message" &&
        (s.data as { role?: string } | null)?.role !== "user",
    )?.seq;

  return (
    <div className="mt-4 space-y-3">
      {steps.map((step) => {
        const defaultOpen = step.seq === firstErrorSeq;
        switch (step.type) {
          case "message":
            return (
              <MessageBubble
                key={step.id}
                step={step}
                emphasized={step.seq === lastAssistantSeq}
              />
            );
          case "reasoning":
            return <Reasoning key={step.id} step={step} />;
          case "tool_call":
            return (
              <ToolCall
                key={step.id}
                step={step}
                maxMs={maxMs}
                defaultOpen={defaultOpen}
              />
            );
          case "model_call":
            return (
              <ModelCall
                key={step.id}
                step={step}
                maxMs={maxMs}
                expensive={
                  maxModelTokens > 0 && tokensOf(step) === maxModelTokens
                }
                defaultOpen={defaultOpen}
              />
            );
          default:
            return (
              <Expandable
                key={step.id}
                id={`step-${step.seq}`}
                header={() => (
                  <span className="flex items-center gap-2 text-sm">
                    <MessageSquare className="size-4 text-muted-foreground" />
                    {step.type}
                    {step.isError && <Badge variant="destructive">error</Badge>}
                  </span>
                )}
              >
                {() => <Mono>{JSON.stringify(step.data ?? {}, null, 2)}</Mono>}
              </Expandable>
            );
        }
      })}
      {firstErrorSeq != null && (
        <p className="sr-only" aria-hidden>
          <AlertTriangle /> error at step {firstErrorSeq}
        </p>
      )}
    </div>
  );
}
