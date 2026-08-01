/**
 * Shared chat surface pieces (assistant + playground): a transcript that owns its scroll
 * region and keeps itself pinned to the newest message (unless the user scrolls up to
 * read), user/assistant bubbles, a typing indicator for an in-flight turn, a collapsible
 * steps card for agent tool activity, and a composer that submits on Enter (Shift+Enter
 * for a newline) and clears after send. The routes own the data; this owns the
 * conversational feel.
 */
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import {
  ArrowUp,
  ChevronRight,
  CircleHelp,
  CornerDownLeft,
  FileCode2,
  Image as ImageIcon,
  Loader2,
  Maximize2,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import Markdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import type {
  ChatArtifact,
  ChatInputAnswer,
  ChatInputOptionField,
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

/**
 * Agent replies are markdown, so they're rendered by a real markdown parser (react-markdown +
 * remark-gfm) rather than a hand-rolled tokenizer: GFM's literal autolinks are what make the
 * bare URLs and email addresses agents actually emit clickable, and the parser gets the awkward
 * link forms (parenthesised URLs, `[label](url "title")`, `<https://…>`) right for free.
 *
 * Raw HTML stays unrendered — no `rehype-raw` — so the XSS surface is closed by construction,
 * and every URL still passes the protocol allowlist below before it becomes an href.
 */

const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

type MarkdownNode = {
  type: string;
  tagName?: string;
  value?: string;
  children?: MarkdownNode[];
};

/**
 * Nested containers (`>` and list indentation) are parsed recursively, so a reply nested
 * thousands deep either blows the stack — a throw during render, which an error boundary can't
 * contain on the server, so the whole transcript 500s — or takes seconds to parse. An agent reply
 * is untrusted input, and nothing real nests anywhere near this deep, so past the limit the text
 * is shown verbatim instead.
 */
const MAX_NESTING = 100;

export function MarkdownText({ text }: { text: string }) {
  // Footnote ids are page-global, so two replies that both use `[^1]` would emit the same id and
  // the second one's link would jump to the first one's definition. Scope them to this turn.
  const instance = useId().replace(/[^a-zA-Z0-9]/g, "");
  // A live turn re-renders the whole transcript on every streamed token, so keep the element
  // keyed to its text: settled turns then skip re-parsing while a newer one is still arriving.
  const rendered = useMemo(
    () =>
      nestedTooDeep(text) ? (
        <p className="leading-relaxed whitespace-pre-wrap">{text}</p>
      ) : (
        <Markdown
          remarkPlugins={REMARK_PLUGINS}
          rehypePlugins={REHYPE_PLUGINS}
          remarkRehypeOptions={{ clobberPrefix: `${instance}-` }}
          urlTransform={markdownUrlTransform}
          components={MARKDOWN_COMPONENTS}
        >
          {text}
        </Markdown>
      ),
    [instance, text],
  );
  return <div className="space-y-2 break-words">{rendered}</div>;
}

/** Every container the parser recurses into — a `>` marker, a list marker, two columns of
 * indentation — counted per line, since they all stack on a single line too (`- - - x`). */
const CONTAINER_MARKER = /(?:[-*+]|\d{1,9}[.)])[ \t]/y;

function nestedTooDeep(markdown: string): boolean {
  for (const line of markdown.split("\n")) {
    let depth = 0;
    let columns = 0;
    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      if (ch === " ") {
        columns += 1;
        i += 1;
        continue;
      }
      if (ch === "\t") {
        columns += 4;
        i += 1;
        continue;
      }
      // Indentation only counts within the innermost container, so a marker resets it.
      if (ch === ">") {
        depth += 1;
        columns = 0;
        i += 1;
        continue;
      }
      CONTAINER_MARKER.lastIndex = i;
      const marker = CONTAINER_MARKER.exec(line);
      if (!marker) break;
      depth += 1;
      columns = 0;
      i += marker[0].length;
    }
    if (depth + Math.floor(columns / 2) > MAX_NESTING) return true;
  }
  return false;
}

/**
 * Raw HTML isn't rendered, and an unrendered html node would vanish without a trace — but
 * agents write `<branch-name>` or `Array<string>` in ordinary prose, and the old renderer showed
 * those verbatim. Turning html nodes into text nodes keeps them visible (React escapes them) and
 * keeps HTML inert.
 */
function remarkHtmlAsText() {
  return (tree: MarkdownNode) => {
    const walk = (node: MarkdownNode) => {
      if (node.type === "html") node.type = "text";
      for (const child of node.children ?? []) walk(child);
    };
    walk(tree);
  };
}

/** `remarkBreaks` keeps a single newline a line break, as agents (and the previous renderer)
 * assume, instead of collapsing it into the surrounding paragraph. */
const REMARK_PLUGINS = [remarkGfm, remarkBreaks, remarkHtmlAsText];

/**
 * Every `br` is followed by a source-formatting newline in the generated tree. Normally that's
 * invisible, but paragraphs keep `whitespace-pre-wrap` (so a reply's aligned plaintext survives,
 * as it did before), which would render it as a second line break. Drop it.
 */
function rehypeDropBreakNewline() {
  return (tree: MarkdownNode) => {
    const walk = (node: MarkdownNode) => {
      const children = node.children ?? [];
      children.forEach((child, index) => {
        const next = children[index + 1];
        if (child.tagName === "br" && next?.type === "text")
          next.value = next.value?.replace(/^\n/, "");
        walk(child);
      });
    };
    walk(tree);
  };
}

const REHYPE_PLUGINS = [rehypeDropBreakNewline];

/**
 * URLs pass through untouched so `MarkdownAnchor` can apply the allowlist itself and still show
 * the raw target when it rejects one — react-markdown's transform would erase it first. Links and
 * images are the only URL-bearing output a markdown reply can produce (raw HTML is never
 * rendered) and both go through that component, so nothing skips the check.
 */
function markdownUrlTransform(url: string): string {
  return url;
}

/** An app path or same-page fragment stays same-tab; anything else has to parse as an allowlisted
 * protocol. Returns null when the target isn't safe to turn into a link. */
function safeHref(value: string): string | null {
  const trimmed = value.trim();
  // GFM footnotes link to a fragment on the page being read.
  if (trimmed.startsWith("#")) return trimmed;
  // One leading slash is an app path. `//host` is protocol-relative — i.e. external — so let it
  // fall through to URL parsing (which rejects it) rather than passing as an internal link.
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return trimmed;
  try {
    const url = new URL(trimmed);
    return SAFE_LINK_PROTOCOLS.has(url.protocol) ? trimmed : null;
  } catch {
    return null;
  }
}

/** True inside an anchor's children — a linked image must not nest a second anchor, which is
 * invalid HTML the browser un-nests into a broken pair of links. */
const InsideAnchor = createContext(false);

function MarkdownAnchor({
  href,
  children,
  className,
  // The hast node react-markdown passes alongside the props is not a DOM attribute.
  node: _node,
  ...rest
}: ComponentPropsWithoutRef<"a"> & { node?: unknown }) {
  const safe = href ? safeHref(href) : null;
  // A rejected target must never silently swallow the anchor: show the label with the raw URL
  // beside it so the reader can still see what was linked.
  if (!safe)
    return (
      <>
        {children}
        {href ? ` (${href})` : null}
      </>
    );
  // App paths and fragments (a footnote jump) stay in this tab; only offsite targets open one.
  const internal = safe.startsWith("/") || safe.startsWith("#");
  return (
    // `rest` carries what the parser generated — a footnote's `id` and aria metadata, without
    // which its backlink has nothing to jump to.
    <a
      {...rest}
      href={safe}
      target={internal ? undefined : "_blank"}
      rel={internal ? undefined : "noreferrer"}
      className={cn("font-medium underline underline-offset-4", className)}
    >
      <InsideAnchor.Provider value={true}>{children}</InsideAnchor.Provider>
    </a>
  );
}

/**
 * An `<img>` would fetch an agent-supplied URL automatically — a tracking pixel, or a GET against
 * any host the browser can reach — just from opening a transcript. The old renderer never loaded
 * images, so keep it that way and offer the source as a link instead. Inside a link already
 * (`[![badge](img)](href)`) the label is all that's left to render.
 */
function MarkdownImage({
  src,
  alt,
  title,
}: ComponentPropsWithoutRef<"img"> & { node?: unknown }) {
  const insideAnchor = useContext(InsideAnchor);
  const label = alt || (typeof src === "string" ? src : "") || "image";
  if (insideAnchor) return <>{label}</>;
  return (
    <MarkdownAnchor
      href={typeof src === "string" ? src : undefined}
      title={title}
    >
      {label}
    </MarkdownAnchor>
  );
}

/** Flatten a hast subtree to its text — used to render a fenced block from the `pre` node so the
 * inner `code` element never reaches the inline-code component. */
function nodeText(node: MarkdownNode | undefined): string {
  if (!node) return "";
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(nodeText).join("");
}

const HEADING_CLASS = "pt-1 font-semibold leading-snug";

const MARKDOWN_COMPONENTS: Components = {
  a: MarkdownAnchor,
  // `whitespace-pre-wrap` keeps runs of spaces, so a reply that aligns plaintext by hand still
  // lines up — the previous renderer preserved it and agents lean on it.
  p: ({ children }) => (
    <p className="leading-relaxed whitespace-pre-wrap">{children}</p>
  ),
  // Chat lives inside a page that owns h1/h2, so markdown headings start at h3 and flatten out
  // rather than competing with the surface's own hierarchy.
  h1: ({ children }) => (
    <h3 className={cn(HEADING_CLASS, "text-base")}>{children}</h3>
  ),
  h2: ({ children }) => (
    <h4 className={cn(HEADING_CLASS, "text-base")}>{children}</h4>
  ),
  h3: ({ children }) => (
    <h5 className={cn(HEADING_CLASS, "text-sm")}>{children}</h5>
  ),
  h4: ({ children }) => (
    <h5 className={cn(HEADING_CLASS, "text-sm")}>{children}</h5>
  ),
  h5: ({ children }) => (
    <h5 className={cn(HEADING_CLASS, "text-sm")}>{children}</h5>
  ),
  h6: ({ children }) => (
    <h5 className={cn(HEADING_CLASS, "text-sm")}>{children}</h5>
  ),
  ul: ({ children, className }) => (
    <ul
      className={cn(
        "space-y-1 leading-relaxed",
        // GFM task lists carry their own checkbox — a bullet as well reads as noise.
        className?.includes("contains-task-list")
          ? "list-none pl-0 [&_input]:mr-1.5 [&_input]:align-middle"
          : "list-disc pl-5",
      )}
    >
      {children}
    </ul>
  ),
  ol: ({ children, start }) => (
    <ol start={start} className="list-decimal space-y-1 pl-5 leading-relaxed">
      {children}
    </ol>
  ),
  blockquote: ({ children }) => (
    <blockquote className="space-y-2 border-l-2 border-muted-foreground/30 pl-3 text-muted-foreground">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="border-border" />,
  pre: ({ node }) => (
    <pre className="max-w-full overflow-x-auto rounded-lg bg-muted/60 p-3 font-mono text-xs leading-relaxed">
      <code>{nodeText(node).replace(/\n$/, "")}</code>
    </pre>
  ),
  code: ({ children }) => (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.88em]">
      {children}
    </code>
  ),
  table: ({ children }) => (
    <div className="max-w-full overflow-x-auto">
      <table className="w-full border-collapse text-left text-xs">
        {children}
      </table>
    </div>
  ),
  th: ({ children, style }) => (
    <th
      style={style}
      className="border-b border-border px-2 py-1.5 font-semibold"
    >
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td
      style={style}
      className="border-b border-border/60 px-2 py-1.5 align-top"
    >
      {children}
    </td>
  ),
  img: MarkdownImage,
};

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
  const asRows = options.some(
    (option) =>
      option.description || option.media || (option.fields?.length ?? 0) > 0,
  );
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
            {options.map((option) =>
              option.media?.artifact?.kind === "image" &&
              option.media.artifact.url?.startsWith("/api/foh/") ? (
                <DirectionOptionCard
                  key={option.id}
                  option={option}
                  surface={request.surface}
                  disabled={!answerable}
                  onSelect={() =>
                    onAnswer?.(option.label, {
                      requestId: request.requestId,
                      optionId: option.id,
                    })
                  }
                />
              ) : (
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
              ),
            )}
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
        {option.fields && option.fields.length > 0 && (
          <OptionFields fields={option.fields} />
        )}
      </span>
      <ChevronRight
        className="size-4 shrink-0 text-muted-foreground/40 transition group-hover:translate-x-0.5 group-hover:text-primary"
        aria-hidden
      />
    </button>
  );
}

/**
 * A visual-direction choice. The generated first viewport leads at one consistent surface-driven
 * ratio, while selection and structured facts live in their own region below it. The image link is
 * deliberately separate from the selection button so opening a sketch cannot accidentally answer
 * the pending question.
 */
function DirectionOptionCard({
  option,
  surface,
  disabled,
  onSelect,
}: {
  option: ChatInputOption;
  surface?: ChatInputRequest["surface"];
  disabled: boolean;
  onSelect: () => void;
}) {
  const artifact = option.media?.artifact;
  if (!artifact?.url) {
    return (
      <OptionRow option={option} disabled={disabled} onSelect={onSelect} />
    );
  }
  const portrait = surface === "mobile" || surface === "native";

  return (
    <article className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <a
        href={artifact.url}
        target="_blank"
        rel="noreferrer"
        className={cn(
          "group/media mx-auto block bg-muted/30",
          portrait ? "w-full max-w-sm" : "w-full",
        )}
        aria-label={`Open ${option.label} sketch at full size`}
      >
        <span
          className={cn(
            "block overflow-hidden",
            portrait ? "aspect-[9/16]" : "aspect-[8/5]",
          )}
        >
          <img
            src={artifact.url}
            alt={`Sketch for ${option.label}`}
            className="size-full object-contain"
          />
        </span>
        <span className="flex items-center justify-end gap-1.5 border-t border-border/60 px-3 py-1.5 text-[11px] font-medium text-muted-foreground transition group-hover/media:text-foreground">
          <Maximize2 className="size-3" aria-hidden />
          Open sketch
        </span>
      </a>
      <button
        type="button"
        disabled={disabled}
        onClick={onSelect}
        className={cn(
          "group flex w-full items-start gap-3 border-t border-border px-3.5 py-3 text-left transition disabled:pointer-events-none disabled:opacity-70",
          option.style === "danger"
            ? "hover:bg-destructive/5"
            : "hover:bg-primary/[0.06]",
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="block text-sm leading-snug font-semibold text-foreground">
            {option.label}
          </span>
          {option.description && (
            <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
              {option.description}
            </span>
          )}
          {option.fields && option.fields.length > 0 && (
            <OptionFields fields={option.fields} />
          )}
        </span>
        <ChevronRight
          className="mt-0.5 size-4 shrink-0 text-muted-foreground/40 transition group-hover:translate-x-0.5 group-hover:text-primary"
          aria-hidden
        />
      </button>
    </article>
  );
}

function OptionFields({ fields }: { fields: ChatInputOptionField[] }) {
  return (
    <span className="mt-3 grid gap-2.5 sm:grid-cols-2">
      {fields.map((field) => (
        <span key={field.label} className="min-w-0">
          <span className="block text-[10px] leading-none font-semibold tracking-wider text-muted-foreground uppercase">
            {field.label}
          </span>
          {field.value.type === "text" ? (
            <span className="mt-1 block text-xs leading-relaxed text-foreground/85">
              {field.value.text}
            </span>
          ) : (
            <span className="mt-1.5 flex flex-wrap gap-1.5">
              {field.value.swatches.map((swatch) => (
                <span
                  key={swatch.color}
                  className={cn(
                    "inline-flex items-center rounded-full border border-border bg-background p-0.5",
                    swatch.label ? "gap-1.5 pr-2" : "",
                  )}
                  title={swatch.label ?? swatch.color}
                  aria-label={swatch.label ?? swatch.color}
                >
                  <span
                    className="block size-5 rounded-full border border-black/10"
                    style={{ backgroundColor: swatch.color }}
                    aria-hidden
                  />
                  {swatch.label && (
                    <span className="text-[11px] leading-none text-muted-foreground">
                      {swatch.label}
                    </span>
                  )}
                </span>
              ))}
            </span>
          )}
        </span>
      ))}
    </span>
  );
}

/**
 * A published artifact (#290, #291) as a card under the turn that produced it, with a quiet caption
 * line carrying the agent's title (or the file name) and the size.
 *
 * An IMAGE renders itself. This is the ONE place harnesst loads an image in a transcript, and it is
 * safe for exactly one reason: `artifact.url` is minted by harnesst from a row id, so the browser
 * only ever fetches first-party bytes harnesst already copied and sniffed. `MarkdownImage` still
 * refuses every `<img>` the agent writes in prose — an agent-supplied src is a tracking pixel or a
 * browser-side GET against any host it can reach, and nothing here relaxes that.
 *
 * An HTML page does NOT render itself: it has no URL in transcript data at all (a bundle is reached
 * only through a token the app mints on demand), so the card is a button that asks the page to open
 * the preview panel. `onOpen` absent means no panel is available on this surface — the playground
 * reuses these pieces — and the card then simply says what was published.
 */
export function ArtifactCard({
  artifact,
  onOpen,
}: {
  artifact: ChatArtifact;
  /** Opens the sandboxed preview panel. Only meaningful for `kind: "html"`. */
  onOpen?: (artifact: ChatArtifact) => void;
}) {
  const label = artifact.title?.trim() || artifact.name;
  const caption = (
    <figcaption className="flex items-center gap-2 border-t border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground/70">
      {artifact.kind === "html" ? (
        <FileCode2 className="size-3.5 shrink-0" aria-hidden />
      ) : (
        <ImageIcon className="size-3.5 shrink-0" aria-hidden />
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {/* The whole "it was republished" signal (#292): the card updated in place, so a version
          badge is all the transcript needs to say — no second card, no new event. */}
      {artifact.version > 1 && (
        <span
          className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
          title={`Updated — version ${artifact.version}`}
        >
          v{artifact.version}
        </span>
      )}
      <span className="shrink-0">{formatBytes(artifact.byteSize)}</span>
    </figcaption>
  );

  if (artifact.kind === "html") {
    return (
      <figure className="w-fit max-w-[85%] overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <button
          type="button"
          onClick={onOpen ? () => onOpen(artifact) : undefined}
          disabled={!onOpen}
          className="flex w-full items-center gap-3 px-4 py-3 text-left enabled:hover:bg-muted/50 disabled:cursor-default"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <FileCode2 className="size-4.5" aria-hidden />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{label}</span>
            <span className="block text-xs text-muted-foreground">
              {onOpen ? "Open preview" : "Published page"}
            </span>
          </span>
        </button>
        {caption}
      </figure>
    );
  }

  return (
    <figure className="w-fit max-w-[85%] overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <a href={artifact.url ?? undefined} target="_blank" rel="noreferrer">
        <img
          src={artifact.url ?? undefined}
          alt={label}
          // Bounded height so a tall screenshot doesn't push the rest of the transcript out of
          // view; the transcript pins to the bottom as images load.
          className="block max-h-96 max-w-full object-contain"
        />
      </a>
      {caption}
    </figure>
  );
}

/** Compact byte size for the artifact caption (KB above a kilobyte, MB above a megabyte). */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
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
  focusKey,
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
  /** Refocus the composer when the surrounding conversation changes. */
  focusKey?: unknown;
  onSend: (message: string) => void;
  /** Optional controls rendered in the toolbar, left of the send button (e.g. a picker). */
  controls?: ReactNode;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const unavailable = busy || disabled;

  // A disabled textarea loses focus when a turn starts. Focus on first availability,
  // restore it when the turn finishes, and let conversation surfaces request the same
  // behavior when they switch the conversation without remounting this component.
  useEffect(() => {
    if (!unavailable) ref.current?.focus();
  }, [focusKey, unavailable]);

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
