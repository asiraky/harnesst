/**
 * Artifact media rules (#290) — the two judgements that gate a publish.
 *
 * Both are security decisions, not formatting: the path check is what keeps `docker cp` inside the
 * agent's own home volume, and the sniff is what keeps a mislabelled HTML payload out of a
 * same-origin, cookie-authenticated response.
 */
import { describe, expect, it } from "vitest";

import { resolveArtifactSource, sniffArtifactContentType } from "~/foh/artifact-media";

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
