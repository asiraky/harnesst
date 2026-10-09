import { describe, expect, it } from "vitest";

import {
  artifactBadge,
  artifactBadgeLabel,
  artifactMemberIsText,
  artifactTypeFamily,
  codeLanguageFor,
  splitLines,
} from "~/components/artifacts/artifact-type";

describe("artifactBadgeLabel", () => {
  it("is the upper-cased extension, cut to five characters", () => {
    expect(artifactBadgeLabel("report.pdf", "application/pdf")).toBe("PDF");
    expect(artifactBadgeLabel("app.webmanifest", "")).toBe("WEBMA");
  });

  it("falls back to a tidied media subtype when the name has no extension", () => {
    expect(artifactBadgeLabel("README", "text/markdown")).toBe("MARKD");
    expect(artifactBadgeLabel("notes", "application/x-yaml")).toBe("YAML");
    expect(artifactBadgeLabel("feed", "application/rss+xml")).toBe("RSS");
  });

  it("says FILE when neither name nor type says anything", () => {
    expect(artifactBadgeLabel("blob", "application/octet-stream")).toBe("FILE");
    expect(artifactBadgeLabel("blob", "")).toBe("FILE");
  });
});

describe("artifactTypeFamily", () => {
  it("groups by extension first", () => {
    expect(artifactTypeFamily("deck.pptx", "application/octet-stream")).toBe("doc");
    expect(artifactTypeFamily("sheet.xlsx", "application/octet-stream")).toBe("data");
    expect(artifactTypeFamily("clip.mov", "application/octet-stream")).toBe("media");
    expect(artifactTypeFamily("main.go", "application/octet-stream")).toBe("code");
    expect(artifactTypeFamily("logo.svg", "image/svg+xml")).toBe("image");
  });

  it("uses the media type when the extension is unknown", () => {
    expect(artifactTypeFamily("photo", "image/heic")).toBe("image");
    expect(artifactTypeFamily("song", "audio/mpeg")).toBe("media");
    expect(artifactTypeFamily("thing", "application/vnd.ms-excel.spreadsheet")).toBe("data");
    expect(artifactTypeFamily("thing", "application/x-sh")).toBe("code");
  });

  it("is other for opaque binaries", () => {
    expect(artifactTypeFamily("archive.zip", "application/zip")).toBe("other");
  });
});

describe("artifactBadge", () => {
  it("badges a page bundle as HTML whatever its directory is called", () => {
    expect(
      artifactBadge({ kind: "html", name: "report.v2", contentType: "" }),
    ).toEqual({ label: "HTML", family: "html" });
  });

  it("badges a single file from its name and type", () => {
    expect(
      artifactBadge({ kind: "file", name: "data.csv", contentType: "text/csv" }),
    ).toEqual({ label: "CSV", family: "data" });
  });
});

describe("codeLanguageFor", () => {
  it("maps extensions to grammar ids, case-insensitively", () => {
    expect(codeLanguageFor("src/App.TSX")).toBe("tsx");
    expect(codeLanguageFor("server.mjs")).toBe("javascript");
    expect(codeLanguageFor("styles/site.css")).toBe("css");
  });

  it("recognises extension-less names that say what they are", () => {
    expect(codeLanguageFor("deploy/Dockerfile")).toBe("dockerfile");
    expect(codeLanguageFor("Makefile")).toBe("make");
  });

  it("asks the media type only when the name has no extension", () => {
    expect(codeLanguageFor("README", "text/markdown; charset=utf-8")).toBe("markdown");
    expect(codeLanguageFor("notes.txt", "application/json")).toBe("text");
  });

  it("is text when nothing says", () => {
    expect(codeLanguageFor("blob", "application/octet-stream")).toBe("text");
  });

  it("passes an unmapped extension through for the highlighter to try", () => {
    expect(codeLanguageFor("query.prql")).toBe("prql");
  });
});

describe("splitLines", () => {
  it("drops the phantom line after a trailing newline", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
  });

  it("keeps a real blank last line and strips CR from CRLF", () => {
    expect(splitLines("a\r\nb\r\n\r\n")).toEqual(["a", "b", ""]);
  });

  it("gives one empty line for empty text", () => {
    expect(splitLines("")).toEqual([""]);
  });
});

describe("artifactMemberIsText", () => {
  it("shows a bundle's markup, styles and scripts", () => {
    expect(artifactMemberIsText("index.html", "text/html")).toBe(true);
    expect(artifactMemberIsText("assets/app.js", "text/javascript")).toBe(true);
    expect(artifactMemberIsText("icon.svg", "image/svg+xml")).toBe(true);
  });

  it("refuses binaries", () => {
    expect(artifactMemberIsText("hero.png", "image/png")).toBe(false);
    expect(artifactMemberIsText("font.woff2", "font/woff2")).toBe(false);
  });
});
