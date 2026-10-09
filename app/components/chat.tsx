/**
 * Shared chat surface pieces (assistant + Front of House chat): a transcript that owns its scroll
 * region and keeps itself pinned to the newest message (unless the user scrolls up to
 * read), user/assistant bubbles, a typing indicator for an in-flight turn, a collapsible
 * steps card for agent tool activity, and a composer that submits on Enter (Shift+Enter
 * for a newline) and clears after the route accepts the send. The routes own the data; this owns the
 * conversational feel.
 */
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import {
  ArrowDown,
  BookOpen,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  CornerDownLeft,
  Copy,
  FileText,
  Globe,
  Image as ImageIcon,
  Info,
  Lightbulb,
  Loader2,
  Maximize2,
  MessageSquareWarning,
  OctagonAlert,
  Pencil,
  RotateCcw,
  Search,
  ShieldAlert,
  Terminal,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import Markdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";

import type {
  ChatArtifact,
  ChatAttachment,
  ChatInputAnswer,
  ChatInputOptionField,
  ChatInputOption,
  ChatInputRequest,
  ChatStep,
  ChatStepAction,
} from "~/chat/types";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { useCopy } from "./chat/clipboard";
import { CodeBlock, languageFromClassName } from "./chat/code-block";
import { formatBytes, loadIntoComposer } from "./chat/composer";
import { LightboxHost, openLightbox } from "./chat/lightbox";
import { artifactBadge } from "./artifacts/artifact-type";
import { SharePopover } from "./artifacts/share-popover";
import { TypeBadge } from "./artifacts/type-badge";
import { useAutoScroll } from "./chat/use-auto-scroll";

export function ChatTranscript({
  children,
  lead,
  forceScrollDep,
}: {
  children: ReactNode;
  /** Page intro (title, alerts, …) that scrolls away with the conversation. */
  lead?: ReactNode;
  /** Legacy: content growth is observed directly now, so this is ignored. */
  dep?: unknown;
  /** Changes when user intent should force the newest message into view (a send). */
  forceScrollDep?: unknown;
}) {
  const { scrollRef, contentRef, following, hasUnseen, follow } =
    useAutoScroll();
  useEffect(() => {
    if (forceScrollDep == null || forceScrollDep === "") return;
    follow();
  }, [forceScrollDep, follow]);
  return (
    <div className="relative min-h-0 flex-1">
      {/* Full-bleed scroll region (content centered inside) so the wheel works anywhere
          across the viewport, not just over the centered column. */}
      <div
        ref={scrollRef}
        className="h-full overflow-y-auto overscroll-contain [overflow-anchor:none]"
      >
        <div ref={contentRef} className="mx-auto w-full max-w-3xl px-4 pt-8 sm:px-6">
          {lead}
          <div className="space-y-8 pb-8">{children}</div>
        </div>
      </div>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-background to-transparent"
      />
      {!following && (
        <button
          type="button"
          aria-label="Jump to latest"
          onClick={() => follow("smooth")}
          className={cn(
            "absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 animate-in items-center gap-1.5 rounded-full border border-border bg-popover/95 text-xs font-medium text-muted-foreground shadow-md backdrop-blur transition-colors fade-in-0 slide-in-from-bottom-2 hover:text-foreground",
            hasUnseen ? "h-7 px-3" : "size-8 justify-center",
          )}
        >
          <ArrowDown className="size-4" />
          {hasUnseen && <span>New messages</span>}
        </button>
      )}
      <LightboxHost />
    </div>
  );
}

const COLLAPSE_LINES = 12;
const COLLAPSE_CHARS = 900;

/** Relative time ("just now", "5m ago", "Tue 14:02") with the full date on hover. */
function RelativeTime({ at }: { at: string }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  return (
    <time
      dateTime={at}
      title={d.toLocaleString()}
      className="text-[11px] text-muted-foreground/70 tabular-nums"
      suppressHydrationWarning
    >
      {formatRelative(d, Date.now())}
    </time>
  );
}

export function formatRelative(d: Date, now: number): string {
  const s = Math.round((now - d.getTime()) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  const sameDay = new Date(now).toDateString() === d.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (sameDay) return time;
  if (s < 6 * 86400)
    return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

function ActionButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  );
}

function CopyAction({ text, label = "Copy" }: { text: string; label?: string }) {
  const { copy, copied } = useCopy();
  return (
    <ActionButton label={copied ? "Copied" : label} onClick={() => void copy(text)}>
      {copied ? (
        <Check className="size-3.5 text-emerald-500" />
      ) : (
        <Copy className="size-3.5" />
      )}
    </ActionButton>
  );
}

/**
 * Hover action row under a message: copy (the markdown source), optional retry, and a timestamp.
 * Always visible on touch devices, where there's no hover.
 */
export function MessageActions({
  text,
  at,
  onRetry,
  align = "start",
}: {
  text: string;
  at?: string | null;
  onRetry?: () => void;
  align?: "start" | "end";
}) {
  if (!text && !at) return null;
  return (
    <div
      className={cn(
        "flex items-center gap-0.5 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100",
        align === "end" && "justify-end",
      )}
    >
      {text && <CopyAction text={text} />}
      {onRetry && (
        <ActionButton label="Retry — send this again" onClick={onRetry}>
          <RotateCcw className="size-3.5" />
        </ActionButton>
      )}
      {at && (
        <span className="px-1.5">
          <RelativeTime at={at} />
        </span>
      )}
    </div>
  );
}

function AttachmentList({
  attachments,
  align = "end",
}: {
  attachments: (ChatAttachment & { previewUrl?: string | null })[];
  align?: "start" | "end";
}) {
  if (attachments.length === 0) return null;
  const images = attachments.filter(
    (a) => a.mediaType.startsWith("image/") && (a.previewUrl ?? a.url),
  );
  const imageSet = new Set(images);
  const files = attachments.filter((a) => !imageSet.has(a));
  const gallery = images.map((a) => ({ src: (a.previewUrl ?? a.url)!, alt: a.name }));
  return (
    <div className={cn("flex flex-col gap-1.5", align === "end" ? "items-end" : "items-start")}>
      {images.length > 0 && (
        <div className={cn("flex flex-wrap gap-1.5", align === "end" && "justify-end")}>
          {images.map((a, i) => (
            <button
              key={a.id}
              type="button"
              onClick={() => openLightbox(gallery, i)}
              className="overflow-hidden rounded-xl border border-border bg-muted transition hover:opacity-90"
              aria-label={`View ${a.name}`}
            >
              <img
                src={(a.previewUrl ?? a.url)!}
                alt={a.name}
                loading="lazy"
                className={cn(
                  "block object-cover",
                  images.length === 1 ? "max-h-72 min-h-16 min-w-16 max-w-[min(100%,24rem)]" : "size-28",
                )}
              />
            </button>
          ))}
        </div>
      )}
      {files.map((a) => {
        const body = (
          <>
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <FileText className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-xs font-medium">{a.name}</span>
              <span className="block text-[11px] text-muted-foreground">
                {a.mediaType}
                {a.size != null ? ` · ${formatBytes(a.size)}` : ""}
              </span>
            </span>
          </>
        );
        const cls =
          "flex max-w-72 items-center gap-2 rounded-xl border border-border bg-card px-2.5 py-2 text-left";
        return a.url ? (
          <a key={a.id} href={a.url} target="_blank" rel="noreferrer" className={cn(cls, "hover:bg-accent/50")}>
            {body}
          </a>
        ) : (
          <div key={a.id} className={cls}>
            {body}
          </div>
        );
      })}
    </div>
  );
}

export function UserBubble({
  text,
  attachments,
  at,
}: {
  text: string;
  attachments?: (ChatAttachment & { previewUrl?: string | null })[];
  at?: string | null;
}) {
  const long =
    text.length > COLLAPSE_CHARS || text.split("\n").length > COLLAPSE_LINES;
  const [expanded, setExpanded] = useState(false);
  const collapsed = long && !expanded;
  return (
    <div className="group/msg chat-row-in relative ml-auto flex w-full flex-col items-end gap-1">
      {attachments && attachments.length > 0 && (
        <AttachmentList attachments={attachments} />
      )}
      {text && (
        <div className="relative w-fit max-w-[90%] rounded-3xl bg-muted px-4 py-2.5 text-sm leading-relaxed text-foreground sm:max-w-[80%]">
          <p
            className={cn(
              "whitespace-pre-wrap [overflow-wrap:anywhere]",
              collapsed && "max-h-64 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]",
            )}
          >
            {text}
          </p>
          {long && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-1 flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              <ChevronDown className={cn("size-3.5 transition-transform", expanded && "rotate-180")} />
              {expanded ? "Show less" : "Show more"}
            </button>
          )}
        </div>
      )}
      <div className="absolute top-full right-0 mt-0.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100 pointer-coarse:static pointer-coarse:mt-0 pointer-coarse:opacity-100">
        {at && (
          <span className="px-1.5">
            <RelativeTime at={at} />
          </span>
        )}
        {text && (
          <ActionButton
            label="Edit — load into the composer"
            onClick={() => {
              if (!loadIntoComposer(text)) toast.error("No composer on this page");
            }}
          >
            <Pencil className="size-3.5" />
          </ActionButton>
        )}
        {text && <CopyAction text={text} />}
      </div>
    </div>
  );
}

export function AssistantBubble({ children }: { children: ReactNode }) {
  return (
    <div className="w-fit max-w-[95%] sm:max-w-[85%] rounded-2xl border border-l-2 border-primary/20 border-l-primary/50 bg-card px-4 py-2.5 text-sm">
      {children}
    </div>
  );
}

/**
 * One assistant turn as an open, full-width block (no bubble, no avatar gutter): user turns
 * are right-aligned filled bubbles, so the unboxed left column reads as the assistant, and
 * everything that belongs to the turn — activity, reply, questions, sync
 * note, metadata — stacks inside the same column instead of floating as detached cards.
 */
export function AssistantTurn({ children }: { children: ReactNode }) {
  return (
    <div className="group/msg chat-row-in min-w-0 space-y-2 text-sm">{children}</div>
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
    <p className="[overflow-wrap:anywhere] font-mono text-[11px] leading-relaxed text-muted-foreground/70">
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

export function MarkdownText({
  text,
  streaming = false,
}: {
  text: string;
  /** Still arriving: code stays unhighlighted and a caret trails the last block. */
  streaming?: boolean;
}) {
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
          components={streaming ? MARKDOWN_COMPONENTS_STREAMING : MARKDOWN_COMPONENTS}
        >
          {text}
        </Markdown>
      ),
    [instance, text, streaming],
  );
  return (
    <div
      className={cn(
        "chat-markdown space-y-3 leading-relaxed [overflow-wrap:anywhere]",
        streaming && "chat-streaming",
      )}
    >
      {rendered}
    </div>
  );
}

/**
 * The agent's thinking, when the model streams it. Collapsed by default once the turn is done;
 * open with a shimmering label while it's live.
 */
export function ReasoningBlock({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  const [open, setOpen] = useState<boolean | null>(null);
  const isOpen = open ?? false;
  if (!text.trim()) return null;
  const words = text.trim().split(/\s+/).length;
  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => setOpen(!isOpen)}
        aria-expanded={isOpen}
        className="flex items-center gap-1.5 rounded-md py-0.5 text-muted-foreground transition-colors hover:text-foreground"
      >
        <Brain className="size-3.5 shrink-0" aria-hidden />
        <span className={cn(streaming && "chat-shimmer")}>
          {streaming ? "Thinking…" : "Thought"}
        </span>
        {!streaming && (
          <span className="text-muted-foreground/60">· {words} words</span>
        )}
        <ChevronRight
          className={cn("size-3.5 shrink-0 transition-transform", isOpen && "rotate-90")}
          aria-hidden
        />
      </button>
      {isOpen ? (
        <div className="mt-1 ml-[7px] max-h-80 overflow-y-auto border-l border-border pl-4 text-muted-foreground">
          <MarkdownText text={text} streaming={streaming} />
        </div>
      ) : streaming ? (
        <p className="mt-1 ml-[7px] line-clamp-2 border-l border-border pl-4 text-muted-foreground/80 italic">
          {text.slice(-280)}
        </p>
      ) : null}
    </div>
  );
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
/**
 * GitHub alerts: a blockquote whose first line is `[!NOTE]` (TIP, IMPORTANT, WARNING, CAUTION)
 * renders as a callout. The marker is stripped and the kind lands on `data-alert`.
 */
const ALERT_KINDS = new Set(["note", "tip", "important", "warning", "caution"]);
function remarkAlerts() {
  return (tree: MarkdownNode) => {
    const walk = (node: MarkdownNode & { data?: { hProperties?: Record<string, unknown> } }) => {
      if (node.type === "blockquote") {
        const para = node.children?.[0];
        const first = para?.type === "paragraph" ? para.children?.[0] : undefined;
        const m = first?.type === "text" ? /^\[!(\w+)\][ \t]*\n?/.exec(first.value ?? "") : null;
        const kind = m?.[1]?.toLowerCase();
        if (m && first && kind && ALERT_KINDS.has(kind)) {
          first.value = (first.value ?? "").slice(m[0].length);
          // remark-breaks turns the newline after the marker into a break node — drop it.
          if (!first.value && para?.children?.[1]?.type === "break") para.children.splice(1, 1);
          node.data = { ...node.data, hProperties: { "data-alert": kind } };
        }
      }
      for (const child of node.children ?? []) walk(child);
    };
    walk(tree);
  };
}

const REMARK_PLUGINS = [remarkGfm, remarkAlerts, remarkBreaks, remarkHtmlAsText];

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
    <ol start={start} className="list-decimal space-y-1 pl-5 leading-relaxed marker:text-muted-foreground">
      {children}
    </ol>
  ),
  blockquote: ({ children, node }) => {
    const props = node?.properties as Record<string, unknown> | undefined;
    // mdast hProperties land verbatim ("data-alert"), not camelCased.
    const kind = (props?.["data-alert"] ?? props?.dataAlert) as string | undefined;
    const alert = kind ? ALERT_STYLES[kind] : null;
    if (alert) {
      const Icon = alert.icon;
      return (
        <div className={cn("space-y-1 rounded-r-lg border-l-2 py-2.5 pr-3.5 pl-3.5", alert.box)}>
          <p className={cn("flex items-center gap-1.5 text-xs font-semibold", alert.title)}>
            <Icon className="size-3.5" aria-hidden />
            {alert.label}
          </p>
          <div className="space-y-2">{children}</div>
        </div>
      );
    }
    return (
      <blockquote className="space-y-2 border-l-2 border-muted-foreground/30 pl-3 text-muted-foreground">
        {children}
      </blockquote>
    );
  },
  hr: () => <hr className="border-border" />,
  pre: ({ node }) => {
    const codeNode = node?.children?.[0] as
      | { properties?: { className?: unknown } }
      | undefined;
    return (
      <CodeBlock
        code={nodeText(node as MarkdownNode).replace(/\n$/, "")}
        language={languageFromClassName(codeNode?.properties?.className)}
      />
    );
  },
  code: ({ children }) => (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.88em]">
      {children}
    </code>
  ),
  table: ({ children }) => (
    <div className="max-w-full overflow-x-auto rounded-xl border border-border">
      <table className="w-full min-w-80 border-collapse text-left text-xs [&_tbody_tr:last-child_td]:border-b-0 [&_thead]:bg-muted/50">
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

/** While streaming, fenced blocks skip highlighting (it would re-run on every token). */
const MARKDOWN_COMPONENTS_STREAMING: Components = {
  ...MARKDOWN_COMPONENTS,
  pre: ({ node }) => {
    const codeNode = node?.children?.[0] as
      | { properties?: { className?: unknown } }
      | undefined;
    return (
      <CodeBlock
        code={nodeText(node as MarkdownNode).replace(/\n$/, "")}
        language={languageFromClassName(codeNode?.properties?.className)}
        streaming
      />
    );
  },
};

const ALERT_STYLES: Record<
  string,
  { label: string; icon: typeof Info; box: string; title: string }
> = {
  note: { label: "Note", icon: Info, box: "border-sky-500 bg-sky-500/[0.06]", title: "text-sky-600 dark:text-sky-400" },
  tip: { label: "Tip", icon: Lightbulb, box: "border-emerald-500 bg-emerald-500/[0.06]", title: "text-emerald-600 dark:text-emerald-400" },
  important: { label: "Important", icon: MessageSquareWarning, box: "border-violet-500 bg-violet-500/[0.06]", title: "text-violet-600 dark:text-violet-400" },
  warning: { label: "Warning", icon: TriangleAlert, box: "border-amber-500 bg-amber-500/[0.07]", title: "text-amber-600 dark:text-amber-400" },
  caution: { label: "Caution", icon: OctagonAlert, box: "border-red-500 bg-red-500/[0.06]", title: "text-red-600 dark:text-red-400" },
};

/**
 * Pending agent input requests (ask_question / tool approvals), rendered inline at the end
 * of the turn so a question never gets lost after a reply that trails off with "one decision
 * for you:". Rendered unboxed (a labelled section, not a nested card) so it sits cleanly
 * whether the surface wraps it in a chat bubble (Front of House) or an open turn column
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
  activeRequestId,
  answeredRequestIds,
}: {
  requests: ChatInputRequest[];
  onAnswer?: (text: string, answer?: ChatInputAnswer) => void;
  busy?: boolean;
  /** When present, only this request is currently answerable. */
  activeRequestId?: string | null;
  /** Answers collected locally while the rest of a batch is still being reviewed. */
  answeredRequestIds?: ReadonlySet<string>;
}) {
  if (requests.length === 0) return null;
  return (
    <div className="mt-2.5 space-y-4">
      {requests.map((request) => (
        <InputRequestView
          key={request.requestId}
          request={request}
          onAnswer={
            activeRequestId === undefined || activeRequestId === request.requestId
              ? onAnswer
              : undefined
          }
          busy={busy}
          answered={answeredRequestIds?.has(request.requestId) ?? false}
        />
      ))}
    </div>
  );
}

function InputRequestView({
  request,
  onAnswer,
  busy,
  answered,
}: {
  request: ChatInputRequest;
  onAnswer?: (text: string, answer?: ChatInputAnswer) => void;
  busy?: boolean;
  answered?: boolean;
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
      {isConfirmation && request.action && (
        <details className="rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-xs">
          <summary className="cursor-pointer font-medium text-foreground">
            {request.action.toolName ?? "Tool call"}
            {request.action.callId ? ` · ${request.action.callId}` : ""}
          </summary>
          {request.action.input !== undefined && (
            <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground">
              {formatApprovalInput(request.action.input)}
            </pre>
          )}
        </details>
      )}
      {answered && (
        <p className="text-xs font-medium text-muted-foreground">Answer queued.</p>
      )}
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

function formatApprovalInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return "(unavailable)";
  }
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
 * A published artifact (#290, #291) as a card under the turn that produced it.
 *
 * An IMAGE renders itself, with the lightbox as its primary action. This is the ONE place harnesst
 * loads an image in a transcript, and it is safe for exactly one reason: `artifact.url` is minted by
 * harnesst from a row id, so the browser only ever fetches first-party bytes harnesst already
 * copied and sniffed. `MarkdownImage` still refuses every `<img>` the agent writes in prose — an
 * agent-supplied src is a tracking pixel or a browser-side GET against any host it can reach, and
 * nothing here relaxes that.
 *
 * Everything else — a page, a PDF, markdown, a table, media, an unknown file — is a tile (type
 * badge, title, size, version) whose click asks the page to open the artifact panel, which picks
 * the viewer from `artifact.viewer`. A page has no URL in transcript data at all (a bundle is
 * reached only through a token the app mints on demand), so it can only open through the panel or
 * its public share link.
 *
 * `onOpen` absent means this surface has no panel. The tile then opens the bytes in a new tab
 * instead (`url`, or the share link for a page) rather than sitting there disabled; with neither it
 * is just a picture of what was published.
 *
 * With a public link (`shareUrl`), the card also carries the panel's Share popover. It sits BESIDE
 * the card's open action, never inside it — a button inside a button is invalid markup and would
 * open the panel on every share click — and stops its clicks (the popover's portalled ones
 * included, which bubble through the React tree) at its own wrapper.
 */
export function ArtifactCard({
  artifact,
  onOpen,
}: {
  artifact: ChatArtifact;
  /** Opens the artifact panel on this artifact (any kind). */
  onOpen?: (artifact: ChatArtifact) => void;
}) {
  const label = artifact.title?.trim() || artifact.name;
  // The whole "it was republished" signal (#292): the card updated in place, so a version badge is
  // all the transcript needs to say — no second card, no new event.
  const versionBadge =
    artifact.version > 1 ? (
      <span
        className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
        title={`Updated — version ${artifact.version}`}
      >
        v{artifact.version}
      </span>
    ) : null;

  const share = (className: string) =>
    artifact.shareUrl ? (
      <span
        className={cn("shrink-0", className)}
        onClick={(event) => event.stopPropagation()}
      >
        <SharePopover
          shareUrl={artifact.shareUrl}
          title={label}
          isPage={artifact.kind === "html"}
        />
      </span>
    ) : null;

  if (artifact.kind === "image" && artifact.url) {
    const src = artifact.url;
    return (
      <figure className="w-fit max-w-[95%] sm:max-w-[85%] overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <button
          type="button"
          className="block cursor-zoom-in"
          onClick={() => openLightbox([{ src, alt: label }])}
          aria-label={`View ${label}`}
        >
          <img
            src={src}
            alt={label}
            // Bounded height so a tall screenshot doesn't push the rest of the transcript out of
            // view; the transcript follows the bottom as images load.
            className="block max-h-96 max-w-full object-contain"
          />
        </button>
        <figcaption className="flex items-center gap-2 border-t border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground/70">
          <ImageIcon className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {versionBadge}
          <span className="shrink-0">{formatBytes(artifact.byteSize)}</span>
          {onOpen && (
            <button
              type="button"
              onClick={() => onOpen(artifact)}
              className="-my-1 shrink-0 rounded-md px-1.5 py-1 font-sans font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label={`Open ${label} in the panel`}
            >
              Open
            </button>
          )}
          {share("-my-1.5 font-sans")}
        </figcaption>
      </figure>
    );
  }

  const href = artifact.url ?? artifact.shareUrl;
  const body = (
    <>
      <TypeBadge badge={artifactBadge(artifact)} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className="line-clamp-2 text-sm leading-snug font-medium break-words text-foreground"
          title={artifact.name}
        >
          {label}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          {label !== artifact.name && (
            <span className="min-w-0 truncate font-mono">{artifact.name}</span>
          )}
          <span className="shrink-0">{formatBytes(artifact.byteSize)}</span>
          {versionBadge}
        </span>
      </span>
      {(onOpen || href) && (
        <span className="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground transition-colors group-hover/tile:bg-accent">
          Open
        </span>
      )}
    </>
  );
  // The card is a box holding its open action (button, link, or nothing) and, beside it, Share.
  const shape =
    "flex w-full max-w-[95%] items-center rounded-xl border border-border bg-card shadow-sm transition-colors sm:max-w-sm";
  const action =
    "group/tile flex min-w-0 flex-1 items-center gap-3 rounded-xl p-2.5 text-left";
  const interactive =
    "cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring";
  const hover = "has-[[data-card-action]:hover]:bg-muted/50";

  let main: React.ReactNode;
  if (onOpen) {
    main = (
      <button
        type="button"
        data-card-action
        onClick={() => onOpen(artifact)}
        className={cn(action, interactive)}
        aria-label={`Open ${label}`}
      >
        {body}
      </button>
    );
  } else if (href) {
    main = (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        data-card-action
        className={cn(action, interactive)}
        aria-label={`Open ${label} in a new tab`}
      >
        {body}
      </a>
    );
  } else {
    main = <div className={action}>{body}</div>;
  }
  return (
    <div className={cn(shape, (onOpen || href) && hover)}>
      {main}
      {share("pr-2")}
    </div>
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

function toolIcon(name: string | null | undefined) {
  const n = (name ?? "").toLowerCase();
  if (/bash|shell|exec|command|terminal|run/.test(n)) return Terminal;
  if (/read|view|cat|open/.test(n)) return FileText;
  if (/write|edit|patch|replace|create/.test(n)) return Pencil;
  if (/search|grep|glob|find|list|ls/.test(n)) return Search;
  if (/fetch|http|web|browse|url/.test(n)) return Globe;
  if (/skill|load/.test(n)) return BookOpen;
  return Wrench;
}

/** "12s", "1m 04s" — ticks by writing the DOM directly so the transcript doesn't re-render. */
function Elapsed({ since }: { since: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const render = () => {
      if (!ref.current) return;
      const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
      ref.current.textContent =
        s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
    };
    render();
    const t = setInterval(render, 1000);
    return () => clearInterval(t);
  }, [since]);
  return <span ref={ref} className="tabular-nums" suppressHydrationWarning />;
}

function ActionDetail({ action }: { action: ChatStepAction }) {
  const [open, setOpen] = useState(false);
  const Icon = toolIcon(action.toolName);
  const hasBody = Boolean(action.input || action.output);
  const failed = action.isError || (action.exitCode != null && action.exitCode !== 0);
  return (
    <li className="min-w-0">
      <button
        type="button"
        disabled={!hasBody}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 items-center gap-2 rounded-md py-0.5 text-left enabled:hover:text-foreground"
        aria-expanded={hasBody ? open : undefined}
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="shrink-0 font-mono font-medium text-foreground/80">
          {action.toolName}
        </span>
        {action.summary && (
          <span className="min-w-0 truncate font-mono text-muted-foreground">
            {action.summary}
          </span>
        )}
        {action.exitCode != null && (
          <span
            className={cn(
              "shrink-0 rounded px-1 py-px font-mono text-[10px]",
              failed ? "bg-destructive/10 text-destructive" : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
            )}
          >
            exit {action.exitCode}
          </span>
        )}
        {action.isError && action.exitCode == null && (
          <span className="shrink-0 font-medium text-destructive">failed</span>
        )}
        {hasBody && (
          <ChevronRight
            className={cn("ml-auto size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
            aria-hidden
          />
        )}
      </button>
      {open && (
        <div className="mt-1 mb-1.5 space-y-1.5">
          {action.input && (
            <CodeBlock
              code={action.input}
              language={/bash|shell|exec|command/i.test(action.toolName) ? "bash" : "json"}
            />
          )}
          {action.output && <CodeBlock code={action.output} language="output" />}
        </div>
      )}
    </li>
  );
}

/**
 * The agent's work for one turn as a quiet inline disclosure, not a detached card: collapsed
 * it reads as a one-line summary ("4 steps · 12.3s"); expanded it lists each step on a
 * timeline rail with tool + summary, duration/tokens, and every tool call with its input and
 * output. During a live turn, pass `activity` — the row shows a spinner with what the agent is
 * doing right now (and, with `startedAt`, a live elapsed timer) instead of the summary.
 */
export function StepsCard({
  steps,
  idPrefix,
  activity,
  startedAt,
}: {
  steps: ChatStep[];
  idPrefix: string;
  /** Live turns: the agent's current activity, shown with a spinner in the header. */
  activity?: string | null;
  /** Live turns: when the turn started (ms epoch), for the elapsed timer. */
  startedAt?: number | null;
}) {
  if (steps.length === 0 && !activity) return null;
  const totalMs = steps.reduce((sum, s) => sum + (s.durationMs ?? 0), 0);
  const failed = steps.some((s) => s.isError);
  const live = (
    <span className="flex min-w-0 items-center gap-1.5">
      <Loader2 className="size-3 shrink-0 animate-spin text-primary" aria-hidden />
      <span className="chat-shimmer min-w-0 truncate">{activity}</span>
      {startedAt != null && (
        <span className="shrink-0 text-muted-foreground/70">
          · <Elapsed since={startedAt} />
        </span>
      )}
      {steps.length > 0 && (
        <span className="shrink-0 text-muted-foreground/70">
          · {steps.length} step{steps.length === 1 ? "" : "s"}
        </span>
      )}
    </span>
  );

  // Nothing to expand yet — a bare working line, no dead chevron.
  if (steps.length === 0) {
    return <div className="flex min-w-0 py-0.5 text-xs text-muted-foreground">{live}</div>;
  }

  return (
    <details className="group w-full max-w-full text-xs">
      <summary className="flex w-fit max-w-full cursor-pointer select-none items-center gap-1.5 rounded-md py-0.5 text-muted-foreground transition-colors [&::-webkit-details-marker]:hidden hover:text-foreground">
        {activity ? (
          live
        ) : (
          <>
            <Wrench className="size-3.5 shrink-0" aria-hidden />
            <span>
              {steps.length} step{steps.length === 1 ? "" : "s"}
              {totalMs > 0 ? <span className="text-muted-foreground/60"> · {formatDuration(totalMs)}</span> : null}
              {failed ? <span className="text-destructive"> · failed</span> : null}
            </span>
          </>
        )}
        <ChevronRight
          className="size-3.5 shrink-0 transition-transform group-open:rotate-90"
          aria-hidden
        />
      </summary>
      <ol className="mt-1 ml-[7px] space-y-2 border-l border-border py-1 pl-4">
        {steps.map((s, i) => {
          const Icon = toolIcon(s.toolName ?? s.type);
          const actions = s.actions ?? [];
          return (
            <li key={`${idPrefix}-step-${s.type}-${i}`} className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="font-mono font-medium text-foreground/80">
                  {s.toolName ?? s.type}
                </span>
                {(s.summary || s.name) && actions.length <= 1 && (
                  <span className="min-w-0 max-w-full truncate font-mono text-muted-foreground">
                    {s.summary ?? s.name}
                  </span>
                )}
                <span className="shrink-0 text-muted-foreground/70">
                  {s.durationMs != null ? formatDuration(s.durationMs) : ""}
                  {s.tokensIn != null || s.tokensOut != null
                    ? `${s.durationMs != null ? " · " : ""}${s.tokensIn ?? 0} in / ${s.tokensOut ?? 0} out tok`
                    : ""}
                </span>
                {s.isError && (
                  <span className="shrink-0 font-medium text-destructive">failed</span>
                )}
              </div>
              {actions.length > 0 && (
                <ul className="mt-1 space-y-0.5 pl-1">
                  {actions.map((a, j) => (
                    <ActionDetail key={`${idPrefix}-step-${i}-a-${j}`} action={a} />
                  ))}
                </ul>
              )}
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
          );
        })}
      </ol>
    </details>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export { ChatComposer, loadIntoComposer } from "./chat/composer";
