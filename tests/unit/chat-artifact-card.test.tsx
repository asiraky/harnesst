/**
 * What a transcript artifact card does when clicked, by kind and by whether the surface has a panel.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ChatArtifact } from "~/chat/types";
import { ArtifactCard } from "~/components/chat";

const base: ChatArtifact = {
  id: "art1",
  name: "notes.md",
  title: "Notes",
  kind: "file",
  contentType: "text/markdown",
  byteSize: 1200,
  url: "/api/foh/p1/artifact/art1/v1",
  version: 1,
  latestVersionId: "v1",
  shareUrl: "/a/tok",
  viewer: "markdown",
};

const render = (a: ChatArtifact, onOpen?: (a: ChatArtifact) => void) =>
  renderToStaticMarkup(<ArtifactCard artifact={a} onOpen={onOpen} />);

describe("ArtifactCard", () => {
  it("is a panel button for a non-image when the surface has a panel", () => {
    const html = render(base, () => {});
    expect(html).toMatch(/^<div[^>]*><button/);
    expect(html).not.toContain("href=");
  });

  it("opens the bytes in a new tab when there is no panel", () => {
    const html = render(base);
    expect(html).toMatch(/^<div[^>]*><a href="\/api\/foh\/p1\/artifact\/art1\/v1" target="_blank"/);
  });

  it("falls back to the share link for a page, which has no url", () => {
    const html = render({ ...base, kind: "html", viewer: "html", url: null });
    expect(html).toMatch(/^<div[^>]*><a href="\/a\/tok"/);
  });

  it("is inert with neither a panel nor a link", () => {
    const html = render({ ...base, kind: "html", viewer: "html", url: null, shareUrl: null });
    expect(html).not.toMatch(/<(a|button)\b/);
    expect(html).not.toContain(">Open<");
  });

  it("renders an image inline, with an Open into the panel only when there is one", () => {
    const image = { ...base, kind: "image" as const, viewer: "image" as const, name: "a.png" };
    expect(render(image)).toContain('<img src="/api/foh/p1/artifact/art1/v1"');
    expect(render(image)).not.toContain(">Open<");
    expect(render(image, () => {})).toContain(">Open<");
  });

  it("offers Share beside the open action, never inside it, only when there is a link", () => {
    const html = render(base, () => {});
    const openEnds = html.indexOf("</button>");
    expect(html.indexOf('aria-label="Share"')).toBeGreaterThan(openEnds);
    expect(render({ ...base, shareUrl: null }, () => {})).not.toContain('aria-label="Share"');

    const image = { ...base, kind: "image" as const, viewer: "image" as const, name: "a.png" };
    expect(render(image)).toContain('aria-label="Share"');
    expect(render({ ...image, shareUrl: null })).not.toContain('aria-label="Share"');
  });

  it("shows the version only once republished", () => {
    expect(render(base)).not.toContain(">v1<");
    expect(render({ ...base, version: 3 })).toContain(">v3<");
  });
});
