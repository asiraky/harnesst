/**
 * Shared chat surface pieces (assistant + playground): a transcript that owns its scroll
 * region and keeps itself pinned to the newest message (unless the user scrolls up to
 * read), user/assistant bubbles, a typing indicator for an in-flight turn, a collapsible
 * steps card for agent tool activity, and a composer that submits on Enter (Shift+Enter
 * for a newline) and clears after send. The routes own the data; this owns the
 * conversational feel.
 */
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  ArrowUp,
  ChevronRight,
  CircleHelp,
  CornerDownLeft,
  Loader2,
  ShieldAlert,
  Sparkles,
} from "lucide-react";

import type {
  ChatInputAnswer,
  ChatInputOption,
  ChatInputRequest,
  ChatStep,
} from "~/chat/types";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";

/** How close to the bottom (px) still counts as "pinned" — scrolling further up pauses
 * auto-scroll until the user returns to the bottom. */
const PIN_THRESHOLD = 60;

export function ChatTranscript({
  children,
  lead,
  dep,
  forceScrollDep,
}: {
  children: ReactNode;
  /** Page intro (title, alerts, …) that scrolls away with the conversation. */
  lead?: ReactNode;
  /** Changes when new content lands — triggers the scroll-to-bottom. */
  dep: unknown;
  /** Changes when user intent should force the newest message into view. */
  forceScrollDep?: unknown;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const scrollToBottom = () => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
  useEffect(() => {
    if (pinnedRef.current) scrollToBottom();
  }, [dep]);
  useEffect(() => {
    if (forceScrollDep == null || forceScrollDep === "") return;
    pinnedRef.current = true;
    scrollToBottom();
  }, [forceScrollDep]);
  return (
    // Full-bleed scroll region (content centered inside) so the wheel works anywhere
    // across the viewport, not just over the centered column.
    <div
      ref={ref}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      onScroll={(e) => {
        const el = e.currentTarget;
        pinnedRef.current =
          el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD;
      }}
    >
      <div className="mx-auto w-full max-w-5xl px-4 pt-6 sm:px-6">
        {lead}
        <div className="space-y-6 pb-2">{children}</div>
      </div>
    </div>
  );
}

export function UserBubble({ text }: { text: string }) {
  return (
    <div className="ml-auto w-fit max-w-[85%] rounded-2xl bg-muted px-4 py-2.5 text-sm text-foreground">
      <p className="whitespace-pre-wrap">{text}</p>
    </div>
  );
}

export function AssistantBubble({ children }: { children: ReactNode }) {
  return (
    <div className="w-fit max-w-[85%] rounded-2xl border border-l-2 border-primary/20 border-l-primary/50 bg-card px-4 py-2.5 text-sm">
      {children}
    </div>
  );
}

/**
 * One assistant turn as an open block with a glyph gutter (no bubble chrome): the glyph
 * marks "the assistant speaks" so user (right, filled) vs assistant (left, open) turns scan
 * instantly, and everything that belongs to the turn — activity, reply, questions, sync
 * note, metadata — stacks inside the same column instead of floating as detached cards.
 */
export function AssistantTurn({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <div
        className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary ring-1 ring-primary/20"
        aria-hidden
      >
        <Sparkles className="size-3.5" />
      </div>
      <div className="min-w-0 flex-1 space-y-2 pt-1 text-sm">{children}</div>
    </div>
  );
}

/** De-emphasized single-line turn metadata (version, model id) — a footer, not a header. */
export function TurnMeta({
  items,
}: {
  items: (string | null | undefined | false)[];
}) {
  const shown = items.filter((item): item is string => Boolean(item));
  if (shown.length === 0) return null;
  return (
    <p className="font-mono text-[11px] leading-relaxed text-muted-foreground/70">
      {shown.join(" · ")}
    </p>
  );
}

type MarkdownBlock =
  | { id: string; type: "paragraph"; text: string }
  | { id: string; type: "heading"; level: 1 | 2 | 3 | 4; text: string }
  | { id: string; type: "code"; language: string | null; code: string }
  | { id: string; type: "list"; ordered: boolean; items: MarkdownListItem[] }
  | { id: string; type: "quote"; text: string }
  | { id: string; type: "rule" };

type MarkdownListItem = { id: string; text: string };

type InlineToken =
  | { id: string; type: "text"; text: string }
  | { id: string; type: "line-break" }
  | { id: string; type: "code"; text: string }
  | { id: string; type: "strong"; text: string }
  | { id: string; type: "emphasis"; text: string }
  | { id: string; type: "link"; label: string; href: string | null };

const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export function MarkdownText({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdownBlocks(text), [text]);
  return (
    <div className="space-y-2 break-words">
      {blocks.map((block) => (
        <MarkdownBlockView key={block.id} block={block} />
      ))}
    </div>
  );
}

function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let blockId = 0;

  const nextId = (prefix: string) => `${prefix}-${blockId++}`;

  const flushParagraph = () => {
    const text = paragraph.join("\n").trim();
    if (text) blocks.push({ id: nextId("p"), type: "paragraph", text });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      continue;
    }

    const fence = trimmed.match(/^```([\w-]+)?\s*$/);
    if (fence) {
      flushParagraph();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        code.push(lines[i]);
        i += 1;
      }
      blocks.push({
        id: nextId("code"),
        type: "code",
        language: fence[1] ?? null,
        code: code.join("\n"),
      });
      continue;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      blocks.push({
        id: nextId("h"),
        type: "heading",
        level: heading[1].length as 1 | 2 | 3 | 4,
        text: heading[2].trim(),
      });
      continue;
    }

    if (/^([-*_])(?:\s*\1){2,}\s*$/.test(trimmed)) {
      flushParagraph();
      blocks.push({ id: nextId("rule"), type: "rule" });
      continue;
    }

    const unordered = trimmed.match(/^[-*+]\s+(.+)$/);
    const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const isOrdered = ordered !== null;
      const items: MarkdownListItem[] = [];
      while (i < lines.length) {
        const current = lines[i].trim();
        const item = isOrdered
          ? current.match(/^\d+[.)]\s+(.+)$/)
          : current.match(/^[-*+]\s+(.+)$/);
        if (!item) break;
        items.push({ id: nextId("li"), text: item[1] });
        i += 1;
      }
      i -= 1;
      blocks.push({
        id: nextId(isOrdered ? "ol" : "ul"),
        type: "list",
        ordered: isOrdered,
        items,
      });
      continue;
    }

    if (trimmed.startsWith(">")) {
      flushParagraph();
      const quote: string[] = [];
      while (i < lines.length) {
        const current = lines[i].trim();
        if (!current.startsWith(">")) break;
        quote.push(current.replace(/^>\s?/, ""));
        i += 1;
      }
      i -= 1;
      blocks.push({
        id: nextId("quote"),
        type: "quote",
        text: quote.join("\n").trim(),
      });
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();
  return blocks;
}

function MarkdownBlockView({ block }: { block: MarkdownBlock }) {
  switch (block.type) {
    case "heading": {
      const className =
        block.level <= 2
          ? "pt-1 text-base font-semibold leading-snug"
          : "pt-1 text-sm font-semibold leading-snug";
      if (block.level === 1)
        return (
          <h3 className={className}>
            <InlineMarkdown text={block.text} idPrefix={block.id} />
          </h3>
        );
      if (block.level === 2)
        return (
          <h4 className={className}>
            <InlineMarkdown text={block.text} idPrefix={block.id} />
          </h4>
        );
      return (
        <h5 className={className}>
          <InlineMarkdown text={block.text} idPrefix={block.id} />
        </h5>
      );
    }
    case "code":
      return (
        <pre className="max-w-full overflow-x-auto rounded-lg bg-muted/60 p-3 font-mono text-xs leading-relaxed">
          <code>{block.code}</code>
        </pre>
      );
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag
          className={`${block.ordered ? "list-decimal" : "list-disc"} space-y-1 pl-5 leading-relaxed`}
        >
          {block.items.map((item) => (
            <li key={item.id}>
              <InlineMarkdown text={item.text} idPrefix={item.id} />
            </li>
          ))}
        </Tag>
      );
    }
    case "quote":
      return (
        <blockquote className="border-l-2 border-muted-foreground/30 pl-3 text-muted-foreground">
          <InlineMarkdown text={block.text} idPrefix={block.id} />
        </blockquote>
      );
    case "rule":
      return <hr className="border-border" />;
    case "paragraph":
      return (
        <p className="whitespace-pre-wrap leading-relaxed">
          <InlineMarkdown text={block.text} idPrefix={block.id} />
        </p>
      );
  }
}

function InlineMarkdown({
  text,
  idPrefix,
}: {
  text: string;
  idPrefix: string;
}) {
  const tokens = useMemo(
    () => parseInlineMarkdown(text, idPrefix),
    [idPrefix, text],
  );
  return (
    <>
      {tokens.map((token) => (
        <InlineTokenView key={token.id} token={token} />
      ))}
    </>
  );
}

function parseInlineMarkdown(text: string, keyPrefix: string): InlineToken[] {
  const pattern =
    /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\[[^\]]+\]\([^)]+\)|\*[^*\s][^*]*\*|_[^_\s][^_]*_|\n)/g;
  const tokens: InlineToken[] = [];
  let cursor = 0;
  let part = 0;

  const nextId = (prefix: string) => `${keyPrefix}-${prefix}-${part++}`;

  for (const match of text.matchAll(pattern)) {
    const token = match[0];
    const start = match.index ?? 0;
    if (start > cursor) {
      tokens.push({
        id: nextId("text"),
        type: "text",
        text: text.slice(cursor, start),
      });
    }

    if (token === "\n") {
      tokens.push({ id: nextId("br"), type: "line-break" });
    } else if (token.startsWith("`")) {
      tokens.push({
        id: nextId("code"),
        type: "code",
        text: token.slice(1, -1),
      });
    } else if (token.startsWith("**") || token.startsWith("__")) {
      tokens.push({
        id: nextId("strong"),
        type: "strong",
        text: token.slice(2, -2),
      });
    } else if (token.startsWith("[")) {
      tokens.push(parseLinkToken(token, nextId("link")));
    } else {
      tokens.push({
        id: nextId("em"),
        type: "emphasis",
        text: token.slice(1, -1),
      });
    }

    cursor = start + token.length;
  }

  if (cursor < text.length) {
    tokens.push({ id: nextId("text"), type: "text", text: text.slice(cursor) });
  }
  return tokens;
}

function InlineTokenView({ token }: { token: InlineToken }) {
  switch (token.type) {
    case "text":
      return <>{token.text}</>;
    case "line-break":
      return <br />;
    case "code":
      return (
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.88em]">
          {token.text}
        </code>
      );
    case "strong":
      return (
        <strong>
          <InlineMarkdown text={token.text} idPrefix={token.id} />
        </strong>
      );
    case "emphasis":
      return (
        <em>
          <InlineMarkdown text={token.text} idPrefix={token.id} />
        </em>
      );
    case "link":
      return <MarkdownLink token={token} />;
  }
}

function parseLinkToken(token: string, id: string): InlineToken {
  const match = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  if (!match) return { id, type: "text", text: token };
  const label = match[1];
  const href = safeHref(match[2].trim());
  return { id, type: "link", label, href };
}

function MarkdownLink({
  token,
}: {
  token: Extract<InlineToken, { type: "link" }>;
}) {
  if (!token.href) return <>{token.label}</>;
  return (
    <a
      href={token.href}
      target={token.href.startsWith("/") ? undefined : "_blank"}
      rel={token.href.startsWith("/") ? undefined : "noreferrer"}
      className="font-medium underline underline-offset-4"
    >
      <InlineMarkdown text={token.label} idPrefix={token.id} />
    </a>
  );
}

function safeHref(value: string): string | null {
  if (value.startsWith("/")) return value;
  try {
    const url = new URL(value);
    return SAFE_LINK_PROTOCOLS.has(url.protocol) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Pending agent input requests (ask_question / tool approvals), rendered inline at the end
 * of the turn so a question never gets lost after a reply that trails off with "one decision
 * for you:". Rendered unboxed (a labelled section, not a nested card) so it sits cleanly
 * whether the surface wraps it in a chat bubble (playground) or an open turn column
 * (assistant), instead of stacking a box inside a bubble.
 *
 * The shape of the ask drives the affordance:
 * - tool approval (`display: "confirmation"`) → its options as action buttons;
 * - multiple choice with per-option descriptions → a stack of selectable rows;
 * - short multiple choice → a row of pill buttons;
 * - free text (no options) or `allowFreeform` alongside options → a hint pointing at the
 *   composer, where a typed reply resolves the request.
 *
 * Clicking an option sends its label as the visible answer plus a request-correlated
 * `ChatInputAnswer` ({requestId, optionId}) — surfaces that forward it let eve resolve
 * exactly the clicked request instead of text-matching the label against every pending
 * request in the batch. Pass `onAnswer` only where answering makes sense (the newest turn);
 * without it the options render as a static, non-interactive record.
 */
export function InputRequestsBlock({
  requests,
  onAnswer,
  busy,
}: {
  requests: ChatInputRequest[];
  onAnswer?: (text: string, answer?: ChatInputAnswer) => void;
  busy?: boolean;
}) {
  if (requests.length === 0) return null;
  return (
    <div className="mt-2.5 space-y-4">
      {requests.map((request) => (
        <InputRequestView
          key={request.requestId}
          request={request}
          onAnswer={onAnswer}
          busy={busy}
        />
      ))}
    </div>
  );
}

function InputRequestView({
  request,
  onAnswer,
  busy,
}: {
  request: ChatInputRequest;
  onAnswer?: (text: string, answer?: ChatInputAnswer) => void;
  busy?: boolean;
}) {
  const isConfirmation = request.display === "confirmation";
  const options = request.options ?? [];
  const asRows = options.some((option) => option.description);
  const answerable = Boolean(onAnswer) && !busy;
  const showFreeformHint =
    Boolean(onAnswer) && (request.allowFreeform || options.length === 0);

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-1.5 text-primary">
        {isConfirmation ? (
          <ShieldAlert className="size-3.5 shrink-0" aria-hidden />
        ) : (
          <CircleHelp className="size-3.5 shrink-0" aria-hidden />
        )}
        <span className="text-[11px] font-semibold tracking-wide uppercase">
          {isConfirmation ? "Approval needed" : "Your response"}
        </span>
      </div>
      <p className="text-sm leading-relaxed font-medium whitespace-pre-wrap text-foreground">
        {request.prompt}
      </p>
      {options.length > 0 &&
        (asRows ? (
          <div className="grid gap-2">
            {options.map((option) => (
              <OptionRow
                key={option.id}
                option={option}
                disabled={!answerable}
                onSelect={() =>
                  onAnswer?.(option.label, {
                    requestId: request.requestId,
                    optionId: option.id,
                  })
                }
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {options.map((option) => (
              <Button
                key={option.id}
                type="button"
                size="sm"
                variant={
                  option.style === "danger"
                    ? "destructive"
                    : option.style === "primary"
                      ? "default"
                      : "outline"
                }
                disabled={!answerable}
                title={option.description ?? undefined}
                onClick={() =>
                  onAnswer?.(option.label, {
                    requestId: request.requestId,
                    optionId: option.id,
                  })
                }
              >
                {option.label}
              </Button>
            ))}
          </div>
        ))}
      {showFreeformHint && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CornerDownLeft className="size-3 shrink-0" aria-hidden />
          <span>
            {options.length > 0
              ? "Or type your own answer in the box below."
              : "Type your answer in the box below."}
          </span>
        </p>
      )}
    </div>
  );
}

/** A multiple-choice option that carries a description — a full-width selectable row
 * (label + description) rather than a pill, so the extra context stays readable. */
function OptionRow({
  option,
  disabled,
  onSelect,
}: {
  option: ChatInputOption;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "group flex w-full items-center gap-3 rounded-xl border border-border bg-card px-3.5 py-2.5 text-left shadow-sm transition disabled:pointer-events-none disabled:opacity-70 disabled:shadow-none",
        option.style === "danger"
          ? "hover:border-destructive/60 hover:bg-destructive/5"
          : "hover:border-primary/60 hover:bg-primary/[0.06]",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm leading-snug font-medium text-foreground">
          {option.label}
        </span>
        {option.description && (
          <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
            {option.description}
          </span>
        )}
      </span>
      <ChevronRight
        className="size-4 shrink-0 text-muted-foreground/40 transition group-hover:translate-x-0.5 group-hover:text-primary"
        aria-hidden
      />
    </button>
  );
}

/** Typing indicator shown while the assistant turn is in flight — dots, not prose, so it
 * never reads like a real reply. */
export function PendingBubble() {
  return (
    <div className="w-fit rounded-2xl border border-l-2 border-primary/20 border-l-primary/50 bg-card px-4 py-3">
      <div className="flex items-center gap-1" aria-hidden="true">
        <span className="size-1.5 animate-pulse rounded-full bg-primary/70 [animation-delay:-0.3s]" />
        <span className="size-1.5 animate-pulse rounded-full bg-primary/70 [animation-delay:-0.15s]" />
        <span className="size-1.5 animate-pulse rounded-full bg-primary/70" />
      </div>
      <span className="sr-only">Working…</span>
    </div>
  );
}

/**
 * The agent's work for one turn as a quiet inline disclosure, not a detached card: collapsed
 * it reads as a one-line summary ("4 steps · 12.3s"); expanded it lists each step on a
 * timeline rail with tool + summary, duration/tokens, and failed steps surface their detail.
 * During a live turn, pass `activity` — the row shows a spinner with what the agent is doing
 * right now instead of the summary.
 */
export function StepsCard({
  steps,
  idPrefix,
  activity,
}: {
  steps: ChatStep[];
  idPrefix: string;
  /** Live turns: the agent's current activity, shown with a spinner in the header. */
  activity?: string | null;
}) {
  if (steps.length === 0 && !activity) return null;
  const totalMs = steps.reduce((sum, s) => sum + (s.durationMs ?? 0), 0);
  const failed = steps.some((s) => s.isError);

  // Nothing to expand yet — a bare working line, no dead chevron.
  if (steps.length === 0) {
    return (
      <div className="flex min-w-0 items-center gap-1.5 py-0.5 text-xs text-muted-foreground">
        <Loader2
          className="size-3 shrink-0 animate-spin text-primary"
          aria-hidden
        />
        <span className="min-w-0 truncate">{activity}</span>
      </div>
    );
  }

  return (
    <details className="group w-fit max-w-full text-xs">
      <summary className="flex w-fit cursor-pointer select-none items-center gap-1.5 rounded-md py-0.5 pr-1.5 text-muted-foreground transition-colors [&::-webkit-details-marker]:hidden hover:text-foreground">
        <ChevronRight
          className="size-3.5 shrink-0 transition-transform group-open:rotate-90"
          aria-hidden
        />
        {activity ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <Loader2
              className="size-3 shrink-0 animate-spin text-primary"
              aria-hidden
            />
            <span className="min-w-0 truncate">{activity}</span>
            <span className="shrink-0 text-muted-foreground/70">
              · {steps.length} step{steps.length === 1 ? "" : "s"}
            </span>
          </span>
        ) : (
          <span>
            {steps.length} step{steps.length === 1 ? "" : "s"}
            {totalMs > 0 ? ` · ${(totalMs / 1000).toFixed(1)}s` : ""}
            {failed ? (
              <span className="text-destructive"> · failed</span>
            ) : null}
          </span>
        )}
      </summary>
      <ol className="ml-[7px] mt-1 space-y-1.5 border-l border-border py-1 pl-4">
        {steps.map((s, i) => (
          <li key={`${idPrefix}-step-${s.type}-${i}`} className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="font-mono font-medium text-foreground/80">
                {s.toolName ?? s.type}
              </span>
              {(s.summary || s.name) && (
                <span className="min-w-0 max-w-full truncate font-mono text-muted-foreground">
                  {s.summary ?? s.name}
                </span>
              )}
              <span className="shrink-0 text-muted-foreground/70">
                {s.durationMs != null
                  ? `${(s.durationMs / 1000).toFixed(1)}s`
                  : ""}
                {s.tokensIn != null || s.tokensOut != null
                  ? `${s.durationMs != null ? " · " : ""}${s.tokensIn ?? 0} in / ${s.tokensOut ?? 0} out tok`
                  : ""}
              </span>
              {s.isError && (
                <span className="shrink-0 font-medium text-destructive">
                  failed
                </span>
              )}
            </div>
            {(s.message || s.code || s.details) && (
              <div className="mt-0.5 whitespace-pre-wrap font-mono text-destructive">
                {s.message}
                {s.code ? `${s.message ? "\n" : ""}Code: ${s.code}` : ""}
                {s.details
                  ? `${s.message || s.code ? "\n" : ""}Details: ${s.details}`
                  : ""}
              </div>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}

const MAX_COMPOSER_HEIGHT = 192;

/** Grow the textarea to fit its content, up to a cap (then it scrolls). */
function autoGrow(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, MAX_COMPOSER_HEIGHT)}px`;
}

function ComposerKbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-muted px-1 py-px font-sans text-[10px] font-medium text-muted-foreground">
      {children}
    </kbd>
  );
}

export function ChatComposer({
  placeholder,
  busy,
  busyHint,
  disabled = false,
  initialValue,
  onSend,
  controls,
}: {
  placeholder: string;
  busy: boolean;
  /** What the surface is waiting on while `busy` — shown with a spinner in the toolbar. */
  busyHint?: string;
  /** Disable composing without showing the in-flight spinner used for `busy`. */
  disabled?: boolean;
  /** Seed the composer's text (e.g. a publish failure handed off as context to fix). */
  initialValue?: string;
  onSend: (message: string) => void;
  /** Optional controls rendered in the toolbar, left of the send button (e.g. a picker). */
  controls?: ReactNode;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const unavailable = busy || disabled;

  // The textarea is uncontrolled, so defaultValue only applies on mount: size a pre-seeded
  // composer to its content immediately, and re-seed when a new handoff arrives while mounted.
  useEffect(() => {
    const el = ref.current;
    if (!el || initialValue == null || el.value === initialValue) return;
    el.value = initialValue;
    autoGrow(el);
  }, [initialValue]);

  const send = () => {
    const message = ref.current?.value.trim();
    if (!message || unavailable) return;
    onSend(message);
    if (ref.current) {
      ref.current.value = "";
      ref.current.style.height = "auto";
    }
  };

  return (
    <div className="rounded-2xl border bg-card shadow-sm transition focus-within:border-ring focus-within:ring-1 focus-within:ring-ring has-[textarea:disabled]:bg-muted/30">
      <Textarea
        ref={ref}
        placeholder={placeholder}
        aria-label={placeholder}
        defaultValue={initialValue}
        rows={1}
        className="max-h-48 min-h-11 resize-none border-0 bg-transparent px-4 py-3 text-sm shadow-none focus-visible:ring-0 disabled:bg-transparent dark:bg-transparent dark:disabled:bg-transparent"
        disabled={unavailable}
        onInput={(e) => autoGrow(e.currentTarget)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5 pl-3.5">
        <div className="flex min-w-0 items-center gap-2.5">
          {controls}
          {busy ? (
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2
                className="size-3 shrink-0 animate-spin text-primary"
                aria-hidden
              />
              <span className="min-w-0 truncate">{busyHint ?? "Working…"}</span>
            </span>
          ) : (
            !disabled && (
              <span className="hidden items-center gap-1 text-[11px] text-muted-foreground/70 sm:flex">
                <ComposerKbd>Enter</ComposerKbd> to send
                <span className="text-muted-foreground/50">·</span>
                <ComposerKbd>Shift+Enter</ComposerKbd> for a new line
              </span>
            )
          )}
        </div>
        <Button
          type="button"
          size="icon"
          className="size-9 shrink-0 rounded-full"
          onClick={send}
          disabled={unavailable}
          aria-label={busy ? "Waiting for the current turn" : "Send"}
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <ArrowUp className="size-4" />
          )}
        </Button>
      </div>
    </div>
  );
}
