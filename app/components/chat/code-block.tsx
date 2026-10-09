/**
 * Fenced code block: a header with the language + wrap toggle + copy, shiki highlighting
 * (lazy-loaded, client-only, light/dark dual theme via CSS vars), and a fold for very long blocks.
 *
 * While the reply is still streaming the block renders plain — highlighting a half-arrived block on
 * every token is expensive and the colours flicker. It highlights once the turn settles.
 */
import { memo, useEffect, useState } from "react";
import { Check, ChevronDown, Copy, WrapText } from "lucide-react";

import { cn } from "~/lib/utils";
import { useCopy } from "./clipboard";

const FOLD_LINES = 40;

/** Common fence aliases → shiki grammar ids. */
const LANGUAGE_ALIASES: Record<string, string> = {
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  js: "javascript",
  ts: "typescript",
  yml: "yaml",
  py: "python",
  rb: "ruby",
  md: "markdown",
  "c++": "cpp",
  golang: "go",
  rs: "rust",
  text: "text",
  plaintext: "text",
  txt: "text",
};

export function normalizeLanguage(raw: string | null | undefined): string {
  const lang = (raw ?? "").trim().toLowerCase();
  if (!lang) return "text";
  return LANGUAGE_ALIASES[lang] ?? lang;
}

/** `language-ts` (from the hast className) → "ts". */
export function languageFromClassName(className: unknown): string | null {
  const list = Array.isArray(className)
    ? className
    : typeof className === "string"
      ? className.split(/\s+/)
      : [];
  for (const c of list) {
    if (typeof c === "string" && c.startsWith("language-")) return c.slice(9);
  }
  return null;
}

// ---- highlighter ---------------------------------------------------------------------------

export type HighlightToken = {
  content: string;
  htmlStyle?: Record<string, string>;
};

type Highlighter = {
  codeToHtml: (
    code: string,
    opts: { lang: string; themes: { light: string; dark: string } },
  ) => string;
  /** Per-line tokens; `grammarState` continues a file highlighted in chunks (the artifact code view). */
  codeToTokens: (
    code: string,
    opts: {
      lang: string;
      themes: { light: string; dark: string };
      grammarState?: unknown;
      tokenizeMaxLineLength?: number;
    },
  ) => { tokens: HighlightToken[][]; grammarState?: unknown };
  loadLanguage: (lang: string) => Promise<void>;
  getLoadedLanguages: () => string[];
};

let highlighterPromise: Promise<{ h: Highlighter; bundled: Set<string> }> | null =
  null;

/** The shared lazy shiki instance — one per page, also used by the artifact code view. */
export function getHighlighter() {
  highlighterPromise ??= import("shiki/bundle/web").then(async (mod) => {
    const h = (await mod.createHighlighter({
      themes: ["github-light", "github-dark"],
      langs: [],
    })) as unknown as Highlighter;
    return { h, bundled: new Set(Object.keys(mod.bundledLanguages)) };
  });
  return highlighterPromise;
}

const htmlCache = new Map<string, string>();
const MAX_CACHE = 300;

async function highlight(code: string, lang: string): Promise<string | null> {
  const key = `${lang}\u0000${code}`;
  const hit = htmlCache.get(key);
  if (hit) return hit;
  const { h, bundled } = await getHighlighter();
  if (lang === "text" || !bundled.has(lang)) return null;
  if (!h.getLoadedLanguages().includes(lang)) await h.loadLanguage(lang);
  const html = h.codeToHtml(code, {
    lang,
    themes: { light: "github-light", dark: "github-dark" },
  });
  htmlCache.set(key, html);
  if (htmlCache.size > MAX_CACHE) {
    const oldest = htmlCache.keys().next().value;
    if (oldest !== undefined) htmlCache.delete(oldest);
  }
  return html;
}

// ---- component -----------------------------------------------------------------------------

export const CodeBlock = memo(function CodeBlock({
  code,
  language,
  streaming = false,
}: {
  code: string;
  language: string | null;
  streaming?: boolean;
}) {
  const lang = normalizeLanguage(language);
  const [html, setHtml] = useState<string | null>(() =>
    htmlCache.get(`${lang}\u0000${code}`) ?? null,
  );
  const [wrap, setWrap] = useState(false);
  const lineCount = code.split("\n").length;
  const foldable = lineCount > FOLD_LINES && !streaming;
  const [expanded, setExpanded] = useState(false);
  const { copy, copied } = useCopy();

  useEffect(() => {
    if (streaming) return;
    let alive = true;
    highlight(code, lang)
      .then((out) => {
        if (alive) setHtml(out);
      })
      .catch(() => {
        if (alive) setHtml(null);
      });
    return () => {
      alive = false;
    };
  }, [code, lang, streaming]);

  const folded = foldable && !expanded;

  return (
    <div
      className="chat-code group/code relative overflow-hidden rounded-xl border border-border/70 bg-muted/40 dark:bg-muted/25"
      data-wrap={wrap ? "true" : "false"}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border/50 py-1 pr-1 pl-3 select-none">
        <span className="font-mono text-[11px] text-muted-foreground">
          {language?.trim() || "text"}
        </span>
        <span className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => setWrap((v) => !v)}
            aria-pressed={wrap}
            aria-label={wrap ? "Disable line wrap" : "Wrap lines"}
            title={wrap ? "Disable line wrap" : "Wrap lines"}
            className={cn(
              "flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              wrap && "bg-accent text-foreground",
            )}
          >
            <WrapText className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => void copy(code)}
            aria-label={copied ? "Copied" : "Copy code"}
            title={copied ? "Copied" : "Copy code"}
            className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {copied ? (
              <Check className="size-3.5 text-emerald-500" />
            ) : (
              <Copy className="size-3.5" />
            )}
            <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
          </button>
        </span>
      </div>
      <div
        className={cn(
          "relative",
          folded && "max-h-[28rem] overflow-hidden",
        )}
      >
        {html ? (
          <div
            className="chat-shiki"
            // Shiki escapes the source; the markup is its own span tree.
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <pre className="chat-shiki-plain">
            <code>{code}</code>
          </pre>
        )}
        {folded && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-card to-transparent" />
        )}
      </div>
      {foldable && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full items-center justify-center gap-1 border-t border-border/50 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          <ChevronDown
            className={cn("size-3.5 transition-transform", expanded && "rotate-180")}
          />
          {expanded ? "Collapse" : `Show all ${lineCount} lines`}
        </button>
      )}
    </div>
  );
});
