/**
 * Which viewer opens an artifact — shared by the panel and the entry builder, so a misroute here
 * means a file rendered by the wrong component (or an HTML file treated as an inert picture).
 */
import { describe, expect, it } from "vitest";

import {
  artifactHasSourceView,
  artifactReadsText,
  artifactViewerFor,
  artifactViewerForArtifact,
} from "~/foh/artifact-viewer";

describe("artifactViewerFor", () => {
  it("goes by the extension first", () => {
    expect(artifactViewerFor("index.HTML", "text/plain")).toBe("html");
    expect(artifactViewerFor("notes.md", "text/plain")).toBe("markdown");
    expect(artifactViewerFor("chart.svg", "image/svg+xml")).toBe("svg");
    expect(artifactViewerFor("invoice.pdf", "application/octet-stream")).toBe(
      "pdf",
    );
    expect(artifactViewerFor("data.tsv", "text/plain")).toBe("csv");
    expect(artifactViewerFor("pkg.json", "text/plain")).toBe("json");
    expect(artifactViewerFor("a.gif", "")).toBe("image");
    expect(artifactViewerFor("a.mp3", "")).toBe("audio");
    expect(artifactViewerFor("a.webm", "")).toBe("video");
    expect(artifactViewerFor("src/main.go", "")).toBe("text");
  });

  it("falls back to the content type when the name says nothing", () => {
    expect(artifactViewerFor("report", "text/html; charset=utf-8")).toBe(
      "html",
    );
    expect(artifactViewerFor("readme", "text/markdown")).toBe("markdown");
    expect(artifactViewerFor("feed", "application/geo+json")).toBe("json");
    expect(artifactViewerFor("photo", "image/webp")).toBe("image");
    expect(artifactViewerFor("clip", "video/quicktime")).toBe("video");
    expect(artifactViewerFor("log", "text/x-whatever")).toBe("text");
  });

  it("offers anything unrecognised as a download", () => {
    expect(artifactViewerFor("blob", "application/octet-stream")).toBe("file");
    expect(artifactViewerFor("a.zip", "application/zip")).toBe("file");
    // A raster the browser may not draw is not handed to an <img>.
    expect(artifactViewerFor("a.tiff", "image/tiff")).toBe("file");
  });

  it("opens a page bundle as a page whatever its directory is called", () => {
    expect(
      artifactViewerForArtifact({
        kind: "html",
        name: "site",
        contentType: "text/html",
      }),
    ).toBe("html");
    expect(
      artifactViewerForArtifact({
        kind: "file",
        name: "notes.md",
        contentType: "text/markdown",
      }),
    ).toBe("markdown");
  });
});

describe("viewer modes", () => {
  it("offers a source view only where there is a rendered form to flip from", () => {
    expect(artifactHasSourceView("html")).toBe(true);
    expect(artifactHasSourceView("markdown")).toBe(true);
    expect(artifactHasSourceView("csv")).toBe(true);
    expect(artifactHasSourceView("text")).toBe(false);
    expect(artifactHasSourceView("image")).toBe(false);
  });

  it("reads text for the text viewers, and for pages and SVG only in source mode", () => {
    expect(artifactReadsText("json")).toBe(true);
    expect(artifactReadsText("text")).toBe(true);
    expect(artifactReadsText("html")).toBe(false);
    expect(artifactReadsText("html", "source")).toBe(true);
    expect(artifactReadsText("svg", "source")).toBe(true);
    expect(artifactReadsText("pdf", "source")).toBe(false);
    expect(artifactReadsText("video")).toBe(false);
  });
});
