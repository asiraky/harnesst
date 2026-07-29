/**
 * `MarkdownText` renders every agent reply on every surface (FOH transcript, assistant,
 * playground, marketplace), and until #272 its hand-rolled tokenizer only understood a strict
 * `[label](url)` — bare URLs, emails, angle-bracket autolinks, parenthesised URLs and titled
 * links all failed, the last two silently. These cover the table in that issue plus the
 * surrounding markdown the old renderer already handled, so a parser swap can't regress it.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarkdownText } from "~/components/chat";

const render = (text: string) =>
  renderToStaticMarkup(<MarkdownText text={text} />);

describe("MarkdownText links", () => {
  it("autolinks a bare URL in prose", () => {
    const html = render("See https://harnesst.dev/docs for details");
    expect(html).toContain('href="https://harnesst.dev/docs"');
    expect(html).toContain(">https://harnesst.dev/docs</a>");
  });

  it("autolinks a bare email address as mailto", () => {
    const html = render("Email me at asiraky@gmail.com");
    expect(html).toContain('href="mailto:asiraky@gmail.com"');
  });

  it("renders an angle-bracket autolink", () => {
    const html = render("<https://harnesst.dev/docs>");
    expect(html).toContain('href="https://harnesst.dev/docs"');
  });

  it("keeps a parenthesised URL intact instead of truncating at the first )", () => {
    const html = render("[wiki](https://en.wikipedia.org/wiki/Foo_(bar))");
    expect(html).toContain('href="https://en.wikipedia.org/wiki/Foo_(bar)"');
    // The trailing paren belongs to the href, not the surrounding text.
    expect(html).not.toContain("</a>)");
  });

  it("renders a titled link rather than dropping the anchor", () => {
    const html = render('[titled](https://example.com "Docs")');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('title="Docs"');
    expect(html).toContain(">titled</a>");
  });

  it("renders a plain markdown link", () => {
    const html = render("[the docs](https://harnesst.dev/docs)");
    expect(html).toContain('href="https://harnesst.dev/docs"');
    expect(html).toContain(">the docs</a>");
  });

  it("opens external links in a new tab and keeps app paths in-tab", () => {
    const external = render("[out](https://harnesst.dev)");
    expect(external).toContain('target="_blank"');
    expect(external).toContain('rel="noreferrer"');

    const internal = render("[settings](/projects/abc/settings)");
    expect(internal).toContain('href="/projects/abc/settings"');
    expect(internal).not.toContain("target=");
    expect(internal).not.toContain("rel=");
  });

  it("shows the label and the raw target when a URL is rejected, never swallowing it", () => {
    const html = render("[click me](javascript:alert(1))");
    expect(html).not.toContain("<a");
    expect(html).not.toContain("javascript:alert(1)&quot;");
    // Both halves stay visible so nothing is silently lost.
    expect(html).toContain("click me");
    expect(html).toContain("javascript:alert(1)");
  });

  it("rejects a protocol-relative target instead of treating it as an app path", () => {
    const html = render("[evil](//evil.example.com/steal)");
    expect(html).not.toContain("<a");
    expect(html).toContain("//evil.example.com/steal");
  });
});

describe("MarkdownText blocks", () => {
  it("still renders the inline and block markdown the old tokenizer handled", () => {
    const html = render(
      [
        "# Heading",
        "",
        "Some **bold**, some _emphasis_, and `inline code`.",
        "",
        "- first",
        "- second",
        "",
        "1. one",
        "2. two",
        "",
        "> quoted",
        "",
        "---",
        "",
        "```ts",
        "const x = 1;",
        "```",
      ].join("\n"),
    );

    expect(html).toContain("<h3");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>emphasis</em>");
    expect(html).toContain("inline code</code>");
    expect(html).toContain("<ul");
    expect(html).toContain("<ol");
    expect(html).toContain("<blockquote");
    expect(html).toContain("<hr");
    expect(html).toContain("<pre");
    expect(html).toContain("const x = 1;");
  });

  it("keeps a single newline as a line break, as the old renderer did", () => {
    expect(render("first line\nsecond line")).toContain("<br/>");
  });

  it("renders a code fence without a trailing blank line", () => {
    expect(render("```\nhello\n```")).toContain("<code>hello</code>");
  });

  it("renders a GFM table", () => {
    const html = render(["| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\n"));
    expect(html).toContain("<table");
    expect(html).toContain("<th");
    expect(html).toContain("<td");
  });

  it("shows raw HTML as escaped text and never as live markup", () => {
    const html = render(
      "Use <branch-name> and never <script>alert(1)</script>",
    );
    expect(html).toContain("&lt;branch-name&gt;");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("renders mid-stream text with unterminated markers without throwing", () => {
    expect(() =>
      render("Half **bold and an open fence\n```ts\nconst a"),
    ).not.toThrow();
    expect(render("Half **bold")).toContain("Half **bold");
  });
});
