/**
 * Root-relative URL rewriting for page artifacts — ported from Omniplex's `artefacturls.go`.
 *
 * A page written for the root of a site names its files from there: `/style.css`,
 * `/fonts/x.woff`, `/`. On the preview and share routes the root of the origin is harnesst, so left
 * alone those URLs reach the APP instead of the artifact: the page picks up harnesst's favicon, or
 * gets the app's HTML for its stylesheet and renders unstyled. `rewriteRootUrlsHtml` and
 * `rewriteRootUrlsCss` point them at the artifact's own site root (the token-bearing prefix plus
 * the entry document's directory), so they also authenticate with the token like any relative URL.
 *
 * They cover the places markup and CSS name a URL: an attribute, a srcset, `url()` and `@import`,
 * in a tag, a `<style>` or a stylesheet. Text the page shows is left as written, and so is script:
 * a URL a script builds at run time is not rewritten. `//host/x` is another site and is left alone.
 *
 * Operates on STRINGS whose characters are bytes (the server decodes with `latin1`, which maps
 * every byte to one char and back exactly), so a page in any ASCII-compatible encoding round-trips
 * untouched apart from the rewrites. That is also why whitespace here is the ASCII class only —
 * JavaScript's `\s` would match a latin1-decoded NBSP byte that HTML does not treat as space.
 *
 * Pure, client+server safe.
 */

const WS = "[\\t\\n\\f\\r ]";
const ROOT_ATTR = new RegExp(
  `(${WS}(?:href|src|action|formaction|poster|data|xlink:href)${WS}*=${WS}*["']?)/([^/])`,
  "gi",
);
const ROOT_SRCSET = new RegExp(
  `${WS}(?:image)?srcset${WS}*=${WS}*(?:"[^"]*"|'[^']*')`,
  "gi",
);
const SRCSET_URL = new RegExp(`(["',])(${WS}*)/([^/])`, "g");
const ROOT_CSS = new RegExp(
  `(url\\(${WS}*["']?|@import${WS}+["'])/([^/])`,
  "gi",
);

/** The elements whose content is not markup. Only `<style>`'s is rewritten; the rest pass through. */
const RAW_TEXT = ["style", "script", "textarea", "title", "xmp", "noscript"];

/** Rewrite a stylesheet's root-relative URLs to start at `root`, which ends in a slash. */
export function rewriteRootUrlsCss(css: string, root: string): string {
  // A function replacement, so a `$` in the root is text rather than a group reference.
  return css.replace(
    ROOT_CSS,
    (_m, lead: string, next: string) => lead + root + next,
  );
}

function rewriteTag(tag: string, root: string): string {
  let out = tag.replace(
    ROOT_ATTR,
    (_m, lead: string, next: string) => lead + root + next,
  );
  out = rewriteRootUrlsCss(out, root); // style="…url(/x)…"
  return out.replace(ROOT_SRCSET, (attr) =>
    attr.replace(
      SRCSET_URL,
      (_m, sep: string, space: string, next: string) =>
        sep + space + root + next,
    ),
  );
}

function isAsciiLetter(c: string | undefined): boolean {
  if (!c) return false;
  const code = c.charCodeAt(0) | 0x20;
  return code >= 0x61 && code <= 0x7a;
}

/**
 * Length of the tag at `start`, through its `>`. A quote opens a value only after `=`, so an
 * apostrophe in an unquoted value (`title=don't`) does not swallow the rest of the page.
 */
function tagEnd(doc: string, start: number): number {
  let quote = "";
  let prev = "";
  for (let j = start + 1; j < doc.length; j++) {
    const c = doc[j];
    if (quote) {
      if (c === quote) quote = "";
    } else if ((c === '"' || c === "'") && prev === "=") {
      quote = c;
    } else if (c === ">") {
      return j + 1 - start;
    }
    if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") prev = c;
  }
  return doc.length - start;
}

/** `indexOf` for a lower-case ASCII needle, ignoring ASCII case (and only ASCII case). */
function indexFold(haystack: string, needle: string, from: number): number {
  outer: for (let i = from; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      const c = haystack.charCodeAt(i + j);
      const folded = c >= 0x41 && c <= 0x5a ? c | 0x20 : c;
      if (folded !== needle.charCodeAt(j)) continue outer;
    }
    return i;
  }
  return -1;
}

function tagName(tag: string): string {
  const match = /^<([A-Za-z0-9-]+)/.exec(tag);
  return match ? match[1].toLowerCase() : "";
}

/** Rewrite the root-relative URLs in a document's tags and `<style>` elements to start at `root`. */
export function rewriteRootUrlsHtml(doc: string, root: string): string {
  let out = "";
  let i = 0;
  while (i < doc.length) {
    const lt = doc.indexOf("<", i);
    if (lt < 0) {
      out += doc.slice(i);
      break;
    }
    out += doc.slice(i, lt);
    i = lt;
    if (doc.startsWith("<!--", i)) {
      const end = doc.indexOf("-->", i + 4);
      const n = end >= 0 ? end + 3 - i : doc.length - i;
      out += doc.slice(i, i + n);
      i += n;
    } else if (isAsciiLetter(doc[i + 1])) {
      const n = tagEnd(doc, i);
      const tag = doc.slice(i, i + n);
      out += rewriteTag(tag, root);
      const name = tagName(tag);
      i += n;
      if (RAW_TEXT.includes(name)) {
        const end = indexFold(doc, `</${name}`, i);
        const bodyEnd = end >= 0 ? end : doc.length;
        const body = doc.slice(i, bodyEnd);
        out += name === "style" ? rewriteRootUrlsCss(body, root) : body;
        i = bodyEnd;
      }
    } else {
      out += "<";
      i += 1;
    }
  }
  return out;
}

/**
 * The site root a page's root-relative URLs are pointed at: the token-bearing route prefix plus
 * the directory of the entry document, so a bundle published as `site/` with `site/dist/index.html`
 * as its entry treats `dist/` as its root. Always ends in a slash.
 */
export function artifactSiteRoot(prefix: string, entryPath: string): string {
  const base = prefix.replace(/\/+$/, "");
  const slash = entryPath.lastIndexOf("/");
  if (slash <= 0) return `${base}/`;
  const dir = entryPath
    .slice(0, slash)
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return `${base}/${dir}/`;
}
