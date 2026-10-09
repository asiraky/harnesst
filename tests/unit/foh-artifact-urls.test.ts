/**
 * Root-relative URL rewriting for page artifacts — the cases of Omniplex's `artefacturls_test.go`.
 * Wrong in one direction and a page's stylesheet loads harnesst's HTML instead; wrong in the other
 * and text the page shows (or a script's strings) is silently altered.
 */
import { describe, expect, it } from "vitest";

import {
  artifactSiteRoot,
  rewriteRootUrlsCss,
  rewriteRootUrlsHtml,
} from "~/foh/artifact-urls";

const ROOT = "/p/tok/dist/";

describe("rewriteRootUrlsHtml", () => {
  it.each([
    [
      "quoted attributes",
      `<link rel=stylesheet href="/a.css"><script src='/b.js'></script>`,
      `<link rel=stylesheet href="/p/tok/dist/a.css"><script src='/p/tok/dist/b.js'></script>`,
    ],
    [
      "unquoted, upper case",
      `<IMG SRC=/x.png><a HREF = /about/>`,
      `<IMG SRC=/p/tok/dist/x.png><a HREF = /p/tok/dist/about/>`,
    ],
    [
      "the bare root",
      `<a href="/">home</a>`,
      `<a href="/p/tok/dist/">home</a>`,
    ],
    [
      "other sites and relative paths",
      `<script src="//cdn.x/y.js"></script><a href="https://x/a">x</a><img src="a.png"><a href="#top">t</a>`,
      `<script src="//cdn.x/y.js"></script><a href="https://x/a">x</a><img src="a.png"><a href="#top">t</a>`,
    ],
    [
      "forms, video, objects",
      `<form action="/go"><button formaction="/b"></button></form><video poster="/p.jpg"></video><object data="/d.svg"></object>`,
      `<form action="/p/tok/dist/go"><button formaction="/p/tok/dist/b"></button></form><video poster="/p/tok/dist/p.jpg"></video><object data="/p/tok/dist/d.svg"></object>`,
    ],
    [
      "srcset",
      `<img srcset="/a.png 1x, /b.png 2x, https://c/d.png 3x">`,
      `<img srcset="/p/tok/dist/a.png 1x, /p/tok/dist/b.png 2x, https://c/d.png 3x">`,
    ],
    [
      "style element",
      `<STYLE>@import "/base.css"; body{background:url(/bg.png)}</style>`,
      `<STYLE>@import "/p/tok/dist/base.css"; body{background:url(/p/tok/dist/bg.png)}</style>`,
    ],
    [
      "style attribute",
      `<div style="background-image:url('/h.jpg')">`,
      `<div style="background-image:url('/p/tok/dist/h.jpg')">`,
    ],
    [
      "text the page shows",
      `<p>use url(/bg.svg) or <code> href="/x"</code></p><title>src="/t"</title><textarea> href="/y"</textarea>`,
      `<p>use url(/bg.svg) or <code> href="/x"</code></p><title>src="/t"</title><textarea> href="/y"</textarea>`,
    ],
    [
      "script and comments",
      `<script>const a = '<img src="/x">'; x.style = "url(/y)"</script><!-- <a href="/z"> -->`,
      `<script>const a = '<img src="/x">'; x.style = "url(/y)"</script><!-- <a href="/z"> -->`,
    ],
    [
      "a > inside a quoted value",
      `<a title="a > b" href="/x">`,
      `<a title="a > b" href="/p/tok/dist/x">`,
    ],
    [
      "an apostrophe in an unquoted value",
      `<a title=don't href="/x">t</a><a href="/y">`,
      `<a title=don't href="/p/tok/dist/x">t</a><a href="/p/tok/dist/y">`,
    ],
    [
      "a lone <",
      `<p>1 < 2</p><a href="/x">`,
      `<p>1 < 2</p><a href="/p/tok/dist/x">`,
    ],
    [
      "an upper-case closing tag on a raw-text element",
      `<SCRIPT>var u="/x"</SCRIPT><a href="/y">`,
      `<SCRIPT>var u="/x"</SCRIPT><a href="/p/tok/dist/y">`,
    ],
  ])("%s", (_name, input, want) => {
    expect(rewriteRootUrlsHtml(input, ROOT)).toBe(want);
  });

  it("treats a $ in the root as text, not a group reference", () => {
    expect(rewriteRootUrlsHtml(`<a href="/x">`, "/p/a$1/")).toBe(
      `<a href="/p/a$1/x">`,
    );
  });

  it("does not treat a latin1-decoded NBSP byte as whitespace", () => {
    const doc = `<a href="/x">`;
    expect(rewriteRootUrlsHtml(doc, ROOT)).toBe(doc);
  });
});

describe("rewriteRootUrlsCss", () => {
  it("rewrites url() and @import, leaving other sites and relative paths", () => {
    expect(
      rewriteRootUrlsCss(
        `@import '/base.css'; @font-face{src:url( "/f.woff2" )} a{background:url(//cdn/x.png)} b{background:url(c.png)}`,
        ROOT,
      ),
    ).toBe(
      `@import '/p/tok/dist/base.css'; @font-face{src:url( "/p/tok/dist/f.woff2" )} a{background:url(//cdn/x.png)} b{background:url(c.png)}`,
    );
  });
});

describe("artifactSiteRoot", () => {
  it("is the prefix plus the entry document's directory, slash-terminated", () => {
    expect(artifactSiteRoot("/a/tok", "index.html")).toBe("/a/tok/");
    expect(artifactSiteRoot("/a/tok/", "dist/index.html")).toBe("/a/tok/dist/");
    expect(artifactSiteRoot("/a/tok", "my site/v 2/index.html")).toBe(
      "/a/tok/my%20site/v%202/",
    );
  });
});
