/**
 * Artifact media rules (#290, #291) — the judgements that gate a publish.
 *
 * All of them are security decisions, not formatting: the path check is what keeps `docker cp` inside
 * the agent's own home volume, the sniff is what keeps a mislabelled HTML payload out of a
 * same-origin cookie-authenticated response, and the bundle rules decide which agent-authored files
 * the sandboxed preview route will ever serve — and under which declared type.
 */
import { describe, expect, it } from "vitest";

import {
  artifactCharsetType,
  artifactKindFor,
  bundleMemberContentType,
  normalizeBundleRelPath,
  pickBundleEntry,
  resolveArtifactSource,
  resolveBundleMember,
  sniffArtifactContentType,
} from "~/foh/artifact-media";

const png = (extra: number[] = []) =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...extra]);
const bytesOf = (text: string) => new TextEncoder().encode(text);

describe("resolveArtifactSource", () => {
  it("accepts an absolute path under the home root and keeps its basename", () => {
    expect(resolveArtifactSource("/workspace/home/artifacts/chart.png")).toEqual({
      path: "/workspace/home/artifacts/chart.png",
      name: "chart.png",
    });
  });

  it("accepts a path relative to the home root", () => {
    expect(resolveArtifactSource("artifacts/chart.png")).toEqual({
      path: "/workspace/home/artifacts/chart.png",
      name: "chart.png",
    });
  });

  it("accepts the agent-browser screenshot directory unchanged", () => {
    expect(
      resolveArtifactSource("/workspace/home/agent-browser/screenshots/shot.png"),
    ).toEqual({
      path: "/workspace/home/agent-browser/screenshots/shot.png",
      name: "shot.png",
    });
  });

  it("normalizes redundant separators rather than refusing them", () => {
    expect(resolveArtifactSource("/workspace/home//artifacts/./a.png")?.path).toBe(
      "/workspace/home/artifacts/a.png",
    );
  });

  it("refuses a traversal even when it lands back inside the home root", () => {
    expect(
      resolveArtifactSource("/workspace/home/artifacts/../artifacts/a.png"),
    ).toBeNull();
  });

  it("refuses paths outside the home root", () => {
    expect(resolveArtifactSource("/etc/shadow")).toBeNull();
    expect(resolveArtifactSource("/workspace/homework/a.png")).toBeNull();
    expect(resolveArtifactSource("/workspace/home")).toBeNull();
  });

  it("refuses non-strings, blanks and embedded NULs", () => {
    expect(resolveArtifactSource(undefined)).toBeNull();
    expect(resolveArtifactSource(42)).toBeNull();
    expect(resolveArtifactSource("   ")).toBeNull();
    expect(resolveArtifactSource("/workspace/home/a\0.png")).toBeNull();
  });
});

describe("sniffArtifactContentType", () => {
  it("reads the type from the bytes, ignoring the extension", () => {
    expect(sniffArtifactContentType(png(), "screenshot.jpg")).toBe("image/png");
    expect(
      sniffArtifactContentType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), "a.png"),
    ).toBe("image/jpeg");
  });

  it("recognizes WebP by both RIFF tags, not the leading one alone", () => {
    const webp = bytesOf("RIFF____WEBPVP8 ");
    expect(sniffArtifactContentType(webp, "a.webp")).toBe("image/webp");
    expect(sniffArtifactContentType(bytesOf("RIFF____WAVEfmt "), "a.wav")).toBeNull();
  });

  it("accepts SVG only when the document really opens with an svg root", () => {
    expect(
      sniffArtifactContentType(
        bytesOf('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'),
        "chart.svg",
      ),
    ).toBe("image/svg+xml");
    expect(
      sniffArtifactContentType(bytesOf("<svg viewBox='0 0 1 1'></svg>"), "chart.SVG"),
    ).toBe("image/svg+xml");
    // The dangerous shape: an HTML page named .svg. It must not become a served image.
    expect(
      sniffArtifactContentType(
        bytesOf("<html><body><svg onload='steal()'></svg></body></html>"),
        "chart.svg",
      ),
    ).toBeNull();
    // SVG bytes under any other name are not an SVG either — the name is the only tie-breaker.
    expect(sniffArtifactContentType(bytesOf("<svg/>"), "chart.png")).toBeNull();
  });

  it("refuses anything that is not one of the four image formats", () => {
    expect(sniffArtifactContentType(bytesOf("<html>hi</html>"), "page.html")).toBeNull();
    expect(sniffArtifactContentType(new Uint8Array(), "empty.png")).toBeNull();
    expect(sniffArtifactContentType(new Uint8Array([0x89, 0x50]), "short.png")).toBeNull();
  });
});

/**
 * Bundle-relative paths (#291) are validated on BOTH sides of the store: the tar entry names
 * `docker cp` hands back are container-controlled, and the splat of a preview request is
 * browser-controlled. The same normalizer runs on both, so a member can only ever be stored under a
 * key a request can reproduce, and only a shape that is safe as a lookup key at all.
 */
describe("normalizeBundleRelPath", () => {
  it("keeps a nested relative path and normalizes redundant segments", () => {
    expect(normalizeBundleRelPath("index.html")).toBe("index.html");
    expect(normalizeBundleRelPath("assets//app.css")).toBe("assets/app.css");
    expect(normalizeBundleRelPath("./assets/./fonts/x.woff2")).toBe(
      "assets/fonts/x.woff2",
    );
    expect(normalizeBundleRelPath("  index.html  ")).toBe("index.html");
  });

  it("refuses traversal, absolute paths, NULs and non-strings", () => {
    expect(normalizeBundleRelPath("../etc/passwd")).toBeNull();
    expect(normalizeBundleRelPath("assets/../../etc/passwd")).toBeNull();
    // A traversal that lands back inside is refused too — the key must be the literal stored one.
    expect(normalizeBundleRelPath("assets/../index.html")).toBeNull();
    expect(normalizeBundleRelPath("/etc/passwd")).toBeNull();
    expect(normalizeBundleRelPath("a\0.html")).toBeNull();
    expect(normalizeBundleRelPath(undefined)).toBeNull();
    expect(normalizeBundleRelPath(42)).toBeNull();
    expect(normalizeBundleRelPath("")).toBeNull();
    expect(normalizeBundleRelPath("./")).toBeNull();
  });

  it("refuses dotfiles, exotic characters and paths that are too long or too deep", () => {
    expect(normalizeBundleRelPath(".env")).toBeNull();
    expect(normalizeBundleRelPath("assets/.htaccess")).toBeNull();
    expect(normalizeBundleRelPath("assets/app app.css")).toBeNull();
    expect(normalizeBundleRelPath("assets/app%2e%2e.css")).toBeNull();
    expect(normalizeBundleRelPath("a/b/c/d/e/f/g/h/i/index.html")).toBeNull();
    expect(normalizeBundleRelPath(`${"a".repeat(101)}.css`)).toBeNull();
    expect(normalizeBundleRelPath(`${"a/".repeat(4)}${"b".repeat(300)}`)).toBeNull();
  });
});

describe("bundleMemberContentType", () => {
  it("maps allowed extensions, case-insensitively, off the last dot", () => {
    expect(bundleMemberContentType("index.html")).toBe("text/html");
    expect(bundleMemberContentType("assets/App.MJS")).toBe("text/javascript");
    expect(bundleMemberContentType("a/b/logo.PNG")).toBe("image/png");
    expect(bundleMemberContentType("app.min.css")).toBe("text/css");
    expect(bundleMemberContentType("x.woff2")).toBe("font/woff2");
  });

  it("returns null for anything off the allowlist or with no extension at all", () => {
    expect(bundleMemberContentType("run.sh")).toBeNull();
    expect(bundleMemberContentType("archive.zip")).toBeNull();
    expect(bundleMemberContentType("doc.pdf")).toBeNull();
    expect(bundleMemberContentType("Makefile")).toBeNull();
    // A leading dot is not an extension — `.css` is a dotfile, and dotfiles are refused above.
    expect(bundleMemberContentType(".css")).toBeNull();
  });
});

describe("resolveBundleMember", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  it("accepts a text member on its extension alone — there is nothing to sniff", () => {
    expect(resolveBundleMember("index.html", bytes("<html>hi</html>"))).toEqual({
      relPath: "index.html",
      contentType: "text/html",
    });
    expect(resolveBundleMember("assets/app.css", bytes("body{}"))).toEqual({
      relPath: "assets/app.css",
      contentType: "text/css",
    });
  });

  it("cross-checks an image member against the sniff, so a page cannot smuggle one in", () => {
    expect(resolveBundleMember("logo.png", png())).toEqual({
      relPath: "logo.png",
      contentType: "image/png",
    });
    // The smuggling shape: HTML wearing an image extension. Refused, rather than stored as a lie.
    expect(resolveBundleMember("logo.png", bytes("<html>hi</html>"))).toBeNull();
    expect(resolveBundleMember("icon.svg", bytes("<html><svg/></html>"))).toBeNull();
    expect(resolveBundleMember("icon.svg", bytes("<svg viewBox='0 0 1 1'/>"))).toEqual(
      { relPath: "icon.svg", contentType: "image/svg+xml" },
    );
  });

  it("refuses a member whose path or type is not allowed", () => {
    expect(resolveBundleMember("../index.html", bytes("<html/>"))).toBeNull();
    expect(resolveBundleMember("run.sh", bytes("#!/bin/sh"))).toBeNull();
  });
});

describe("pickBundleEntry", () => {
  it("prefers index.html at the root", () => {
    expect(pickBundleEntry(["assets/app.css", "index.html", "about.html"])).toBe(
      "index.html",
    );
  });

  it("takes the only page when it is not called index.html", () => {
    expect(pickBundleEntry(["report.html", "assets/app.css"])).toBe("report.html");
  });

  it("refuses to guess between two pages, and refuses a bundle with none", () => {
    expect(pickBundleEntry(["a.html", "b.html"])).toBeNull();
    expect(pickBundleEntry(["assets/app.css", "logo.png"])).toBeNull();
    // Nested is not the root: a page has to be named, not found by depth-first search.
    expect(pickBundleEntry(["site/index.html", "other/index.html"])).toBeNull();
  });
});

describe("artifactKindFor", () => {
  it("takes the agent's word when it says anything valid", () => {
    expect(artifactKindFor("image", "chart.png")).toBe("image");
    expect(artifactKindFor("html", "site")).toBe("html");
    // A directory of a page needs the explicit kind — its name says nothing.
    expect(artifactKindFor("html", "report.png")).toBe("html");
  });

  it("falls back to the extension when the agent says nothing", () => {
    expect(artifactKindFor(undefined, "chart.png")).toBe("image");
    expect(artifactKindFor(null, "site")).toBe("image");
    expect(artifactKindFor("", "report.html")).toBe("html");
    expect(artifactKindFor(undefined, "report.HTM")).toBe("html");
  });

  it("refuses a kind it does not know rather than guessing", () => {
    expect(artifactKindFor("pdf", "report.pdf")).toBeNull();
    expect(artifactKindFor("HTML", "report.html")).toBeNull();
    expect(artifactKindFor(7, "chart.png")).toBeNull();
  });
});

describe("artifactCharsetType", () => {
  it("declares utf-8 for text so a page does not render as mojibake, and leaves binary alone", () => {
    expect(artifactCharsetType("text/html")).toBe("text/html; charset=utf-8");
    expect(artifactCharsetType("application/json")).toBe(
      "application/json; charset=utf-8",
    );
    expect(artifactCharsetType("image/png")).toBe("image/png");
    expect(artifactCharsetType("font/woff2")).toBe("font/woff2");
  });
});
