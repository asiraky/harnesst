/**
 * A file's text with line numbers, shiki highlighting, a wrap toggle and copy — the artifact panel's
 * source view, and the text/JSON viewers. Ported from Omniplex's `CodeView`, with highlighting added.
 *
 * Big files are the design constraint: the source endpoint returns up to 1 MiB, which is tens of
 * thousands of lines. So:
 *   - lines render in blocks of 300 under `content-visibility: auto`, which lets the browser skip
 *     layout and paint for every block that is off screen;
 *   - highlighting runs a block at a time (shiki's `grammarState` carries a comment or string that
 *     spans a block boundary), yielding to the browser between blocks so the panel never freezes,
 *     and the plain text is on screen from the first frame;
 *   - past `MAX_HIGHLIGHT_CHARS` it does not highlight at all — a megabyte of tokens is a lot of
 *     DOM for colour nobody scrolls far enough to read.
 *
 * Token colours come from shiki's dual theme as inline `color` plus `--shiki-dark`; the existing
 * `.dark .chat-shiki .shiki span` rule (app.css) swaps them in dark mode, so the code is wrapped in
 * those classes rather than carrying a second copy of the rule. Only token spans sit inside
 * `.shiki` — the gutter must not, or the rule would recolour the line numbers.
 */
import {
  memo,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Check, Copy, WrapText } from "lucide-react";

import { cn } from "~/lib/utils";
import { useCopy } from "~/components/chat/clipboard";
import { getHighlighter, type HighlightToken } from "~/components/chat/code-block";
import { codeLanguageFor, splitLines } from "./artifact-type";
import { CUT_NOTICE } from "./states";

const BLOCK_LINES = 300;
const LINE_PX = 19;
/** Above this many characters the view stays plain text. */
export const MAX_HIGHLIGHT_CHARS = 512 * 1024;
/** Lines longer than this (minified bundles) are left uncoloured rather than tokenized. */
const MAX_TOKENIZED_LINE = 2000;
const THEMES = { light: "github-light", dark: "github-dark" };
/** Prose reads better wrapped; code reads better with its own line breaks. */
const WRAP_BY_DEFAULT = new Set(["text", "markdown", "csv"]);

/** shiki's `htmlStyle` (CSS property names) → a React style object. */
function tokenStyle(style: Record<string, string> | undefined): CSSProperties | undefined {
  if (!style) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(style)) {
    out[key.startsWith("--") ? key : key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] =
      value;
  }
  return out as CSSProperties;
}

/** Highlight `blocks` one at a time, yielding between them; `[]` until the first block lands. */
function useHighlightedBlocks(
  blocks: string[][],
  lang: string,
  enabled: boolean,
): HighlightToken[][][] {
  const [state, setState] = useState<{
    blocks: string[][] | null;
    tokens: HighlightToken[][][];
  }>({ blocks: null, tokens: [] });

  useEffect(() => {
    if (!enabled || lang === "text") return;
    let cancelled = false;
    void (async () => {
      const { h, bundled } = await getHighlighter();
      if (cancelled || !bundled.has(lang)) return;
      if (!h.getLoadedLanguages().includes(lang)) await h.loadLanguage(lang);
      let grammarState: unknown;
      const tokens: HighlightToken[][][] = [];
      for (const block of blocks) {
        if (cancelled) return;
        const result = h.codeToTokens(block.join("\n"), {
          lang,
          themes: THEMES,
          grammarState,
          tokenizeMaxLineLength: MAX_TOKENIZED_LINE,
        });
        grammarState = result.grammarState;
        tokens.push(result.tokens);
        setState({ blocks, tokens: tokens.slice() });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    })().catch(() => {
      // A grammar that fails to load leaves the plain text up — nothing to tell the user.
    });
    return () => {
      cancelled = true;
    };
  }, [blocks, lang, enabled]);

  return state.blocks === blocks ? state.tokens : [];
}

const CodeLines = memo(function CodeLines({
  lines,
  tokens,
  start,
  gutter,
  wrap,
}: {
  lines: string[];
  tokens: HighlightToken[][] | undefined;
  start: number;
  gutter: string;
  wrap: boolean;
}) {
  return (
    <div
      style={{
        contentVisibility: "auto",
        containIntrinsicSize: `auto ${lines.length * LINE_PX}px`,
      }}
    >
      {lines.map((line, i) => {
        const lineTokens = tokens?.[i];
        return (
          <div key={i} className="flex">
            <span
              aria-hidden
              style={{ width: gutter }}
              className={cn(
                "shrink-0 pr-3 text-right text-muted-foreground/50 select-none",
                !wrap && "sticky left-0 bg-background",
              )}
            >
              {start + i + 1}
            </span>
            <span
              className={cn(
                "shiki min-w-0 flex-1 pr-4",
                wrap
                  ? "break-words whitespace-pre-wrap [overflow-wrap:anywhere]"
                  : "whitespace-pre",
              )}
            >
              {lineTokens && lineTokens.length > 0
                ? lineTokens.map((t, j) => (
                    <span key={j} style={tokenStyle(t.htmlStyle)}>
                      {t.content}
                    </span>
                  ))
                : line || " "}
            </span>
          </div>
        );
      })}
    </div>
  );
});

export function CodeView({
  text,
  name,
  contentType = "",
  language,
  truncated = false,
  label,
  leading,
}: {
  text: string;
  /** The file's name — picks the grammar unless `language` does. */
  name: string;
  contentType?: string;
  /** A shiki grammar id that overrides the one the name implies (pretty JSON, say). */
  language?: string;
  truncated?: boolean;
  /** What the toolbar calls it; defaults to the grammar. */
  label?: string;
  /** A control at the toolbar's start (the bundle file picker), so it sticks with the toolbar. */
  leading?: ReactNode;
}) {
  const lang = language ?? codeLanguageFor(name, contentType);
  const [wrap, setWrap] = useState(() => WRAP_BY_DEFAULT.has(lang));
  const { copy, copied } = useCopy();

  const lines = useMemo(() => splitLines(text), [text]);
  const blocks = useMemo(() => {
    const out: string[][] = [];
    for (let i = 0; i < lines.length; i += BLOCK_LINES) {
      out.push(lines.slice(i, i + BLOCK_LINES));
    }
    return out;
  }, [lines]);
  const highlightable = text.length <= MAX_HIGHLIGHT_CHARS;
  const tokens = useHighlightedBlocks(blocks, lang, highlightable);
  // The padding is inside the width (border-box), so it is added rather than counted in ch.
  const gutter = `calc(${String(lines.length).length}ch + 1.5rem)`;

  return (
    <div className="chat-shiki min-w-full">
      <div className="sticky top-0 left-0 z-10 flex items-center gap-2 border-b border-border/60 bg-background/95 py-1 pr-1.5 pl-4 backdrop-blur select-none">
        {leading}
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {label ?? lang}
          {" · "}
          {lines.length.toLocaleString()} {lines.length === 1 ? "line" : "lines"}
          {!highlightable && " · not highlighted (large file)"}
        </span>
        <button
          type="button"
          onClick={() => setWrap((v) => !v)}
          aria-pressed={wrap}
          aria-label={wrap ? "Disable line wrap" : "Wrap lines"}
          title={wrap ? "Disable line wrap" : "Wrap lines"}
          className={cn(
            "flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            wrap && "bg-accent text-foreground",
          )}
        >
          <WrapText className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={() => void copy(text)}
          aria-label={copied ? "Copied" : "Copy text"}
          title={truncated ? "Copy the text shown" : "Copy"}
          className="flex h-7 items-center gap-1 rounded-md px-2 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {copied ? (
            <Check className="size-3.5 text-emerald-500" />
          ) : (
            <Copy className="size-3.5" />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {truncated && (
        <p className="sticky left-0 border-b border-border/60 bg-muted/40 px-4 py-1.5 text-[11px] text-muted-foreground">
          {CUT_NOTICE}
        </p>
      )}
      <div
        className={cn(
          "py-2 font-mono text-[12px] leading-[19px]",
          !wrap && "w-max min-w-full",
        )}
      >
        {blocks.map((block, b) => (
          <CodeLines
            key={b}
            lines={block}
            tokens={tokens[b]}
            start={b * BLOCK_LINES}
            gutter={gutter}
            wrap={wrap}
          />
        ))}
      </div>
    </div>
  );
}
