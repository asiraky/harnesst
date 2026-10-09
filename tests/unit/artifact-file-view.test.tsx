/**
 * Which viewer the panel body picks for an artifact, and which URLs it points that viewer at —
 * version-pinned, with the download switch only where a download is offered. Rendered on the
 * server, so text viewers stop at their loading state (their fetch runs in an effect).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatArtifact } from "~/chat/types";
import { ArtifactFileView, prettyJson } from "~/components/artifacts/artifact-file-view";
import { readArtifactText } from "~/components/artifacts/use-artifact-text";
import type { ArtifactViewer } from "~/foh/artifact-viewer";

function artifact(over: Partial<ChatArtifact> & { viewer: ArtifactViewer }): ChatArtifact {
  return {
    id: "art1",
    name: "file.bin",
    title: null,
    kind: "file",
    contentType: "application/octet-stream",
    byteSize: 2048,
    url: "/api/foh/p1/artifact/art1/v-latest",
    version: 1,
    latestVersionId: "v-latest",
    shareUrl: "/a/tok",
    ...over,
  };
}

function render(
  a: ChatArtifact,
  opts: { versionId?: string | null; mode?: "preview" | "source" } = {},
) {
  return renderToStaticMarkup(
    <ArtifactFileView
      artifact={a}
      projectId="p1"
      versionId={opts.versionId ?? null}
      mode={opts.mode ?? "preview"}
    />,
  );
}

describe("ArtifactFileView", () => {
  it("frames a PDF unsandboxed at the version the panel picked", () => {
    const html = render(
      artifact({ viewer: "pdf", kind: "document", name: "r.pdf", contentType: "application/pdf" }),
      { versionId: "v-old" },
    );
    expect(html).toContain('<iframe src="/api/foh/p1/artifact/art1/v-old"');
    expect(html).not.toContain("sandbox");
  });

  it("pins an image to the latest version when the panel asks for the newest", () => {
    const html = render(
      artifact({ viewer: "image", kind: "image", name: "a.png", contentType: "image/png" }),
    );
    expect(html).toContain('src="/api/foh/p1/artifact/art1/v-latest"');
  });

  it("shows an SVG preview as an image but its source as text", () => {
    const svg = artifact({ viewer: "svg", kind: "image", name: "a.svg", contentType: "image/svg+xml" });
    expect(render(svg)).toContain("<img");
    const source = render(svg, { mode: "source" });
    expect(source).not.toContain("<img");
    expect(source).toContain('role="status"');
  });

  it("gives media a native player", () => {
    expect(render(artifact({ viewer: "video", name: "a.mp4" }))).toContain("<video");
    expect(render(artifact({ viewer: "audio", name: "a.mp3" }))).toContain("<audio");
  });

  it("offers an unknown type as a download and a new-tab open", () => {
    const html = render(artifact({ viewer: "file", name: "deck.pptx" }));
    expect(html).toContain('href="/api/foh/p1/artifact/art1/v-latest?download=1"');
    expect(html).toContain('href="/api/foh/p1/artifact/art1/v-latest" target="_blank"');
  });

  it("loads text for the text viewers instead of pointing an element at the bytes", () => {
    for (const viewer of ["markdown", "csv", "json", "text"] as const) {
      const html = render(artifact({ viewer, name: "x" }));
      expect(html).toContain('role="status"');
      expect(html).not.toContain("<img");
    }
  });
});

describe("prettyJson", () => {
  it("re-indents valid JSON", () => {
    expect(prettyJson('{"a":[1,2]}')).toEqual({
      ok: true,
      text: '{\n  "a": [\n    1,\n    2\n  ]\n}',
    });
  });

  it("says why invalid JSON will not format", () => {
    const out = prettyJson('{"a":');
    expect(out.ok).toBe(false);
  });
});

describe("readArtifactText", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports the endpoint's truncation header", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("abc", { headers: { "X-Artifact-Truncated": "1" } }),
      ),
    );
    await expect(readArtifactText("/x")).resolves.toEqual({ text: "abc", truncated: true });
  });

  it("is not truncated without the header", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("abc")));
    await expect(readArtifactText("/x")).resolves.toEqual({ text: "abc", truncated: false });
  });

  it("fails on a non-OK answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Not found", { status: 404 })));
    await expect(readArtifactText("/x")).rejects.toThrow(/isn't available/);
  });
});
