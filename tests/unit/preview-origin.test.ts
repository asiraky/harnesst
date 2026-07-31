/**
 * The optional artifact-preview sandbox origin (#296). Everything here is a decision the browser
 * cannot be asked to re-check: which origin a minted preview URL points at, which host serves it,
 * and — the one that would fail silently and dangerously — which origin is allowed to EMBED it once
 * the preview no longer shares an origin with the app.
 *
 * `PREVIEW_ORIGIN` unset is the self-host default and has to stay byte-identical to #291, so every
 * case is asserted in both configurations rather than only in the configured one.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  artifactPreviewHeaders,
  artifactPreviewUrl,
} from "~/foh/artifact-preview.server";
import {
  isPreviewHost,
  previewFrameAncestors,
  previewHostAppRedirect,
  previewHostRedirect,
  previewOrigin,
} from "~/lib/preview-origin.server";

const SAVED = {
  PREVIEW_ORIGIN: process.env.PREVIEW_ORIGIN,
  BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
  MARKETING_HOST: process.env.MARKETING_HOST,
};

function setEnv(name: keyof typeof SAVED, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const APP = "https://harnesst.example.com";
const PREVIEW = "https://preview.harnesst.example.com";

beforeEach(() => {
  setEnv("PREVIEW_ORIGIN", undefined);
  setEnv("MARKETING_HOST", undefined);
  setEnv("BETTER_AUTH_URL", APP);
});

afterEach(() => {
  setEnv("PREVIEW_ORIGIN", SAVED.PREVIEW_ORIGIN);
  setEnv("BETTER_AUTH_URL", SAVED.BETTER_AUTH_URL);
  setEnv("MARKETING_HOST", SAVED.MARKETING_HOST);
});

const get = (url: string, method = "GET") => new Request(url, { method });
const location = (response: Response | null) =>
  response?.headers.get("location") ?? null;

const PREVIEW_PATH = "/artifacts/preview/tok/art_1/index.html";

describe("previewOrigin", () => {
  it("is null when unset — the self-host default", () => {
    expect(previewOrigin()).toBeNull();
    setEnv("PREVIEW_ORIGIN", "   ");
    expect(previewOrigin()).toBeNull();
  });

  it("normalizes a configured origin", () => {
    setEnv("PREVIEW_ORIGIN", " HTTPS://Preview.Harnesst.Example.com ");
    expect(previewOrigin()).toBe(PREVIEW);
  });

  it("promotes a bare host using the app origin's scheme and port, for local development", () => {
    setEnv("BETTER_AUTH_URL", "http://localhost:5173");
    setEnv("PREVIEW_ORIGIN", "preview.localhost");
    expect(previewOrigin()).toBe("http://preview.localhost:5173");

    // An explicit port on the value wins over the app origin's.
    setEnv("PREVIEW_ORIGIN", "preview.localhost:6100");
    expect(previewOrigin()).toBe("http://preview.localhost:6100");
  });

  it.each([
    ["a path", "https://preview.example.com/previews"],
    ["a query", "https://preview.example.com/?a=1"],
    ["a fragment", "https://preview.example.com/#x"],
    ["credentials", "https://user:pw@preview.example.com"],
    ["a non-http scheme", "ftp://preview.example.com"],
    ["whitespace inside a bare host", "preview example com"],
  ])("reads as unset when the value carries %s", (_label, value) => {
    setEnv("PREVIEW_ORIGIN", value);
    expect(previewOrigin()).toBeNull();
  });

  it("refuses to equal the app origin, which would redirect a host to itself forever", () => {
    setEnv("PREVIEW_ORIGIN", APP);
    expect(previewOrigin()).toBeNull();
    setEnv("PREVIEW_ORIGIN", "harnesst.example.com");
    expect(previewOrigin()).toBeNull();
  });
});

describe("isPreviewHost", () => {
  it("is false for every request when unconfigured", () => {
    expect(isPreviewHost(get(`${PREVIEW}${PREVIEW_PATH}`))).toBe(false);
  });

  it("matches the configured host, on any port when the value names none", () => {
    setEnv("PREVIEW_ORIGIN", PREVIEW);
    expect(isPreviewHost(get(`${PREVIEW}${PREVIEW_PATH}`))).toBe(true);
    expect(
      isPreviewHost(get(`http://preview.harnesst.example.com:3000/`)),
    ).toBe(true);
    expect(isPreviewHost(get(`${APP}${PREVIEW_PATH}`))).toBe(false);
  });

  it("requires the port to match when the configured value carries one", () => {
    setEnv("BETTER_AUTH_URL", "http://localhost:5173");
    setEnv("PREVIEW_ORIGIN", "preview.localhost:6100");
    expect(isPreviewHost(get("http://preview.localhost:6100/"))).toBe(true);
    expect(isPreviewHost(get("http://preview.localhost:5173/"))).toBe(false);
  });
});

describe("previewHostRedirect (the preview route's host check)", () => {
  it("serves in place when unconfigured", () => {
    expect(previewHostRedirect(get(`${APP}${PREVIEW_PATH}`))).toBeNull();
  });

  it("sends an app-origin request to the sandbox origin, capability intact", () => {
    setEnv("PREVIEW_ORIGIN", PREVIEW);
    const response = previewHostRedirect(get(`${APP}${PREVIEW_PATH}?v=2`));
    expect(location(response)).toBe(`${PREVIEW}${PREVIEW_PATH}?v=2`);
  });

  it("serves a request that already arrived on the sandbox origin", () => {
    setEnv("PREVIEW_ORIGIN", PREVIEW);
    expect(previewHostRedirect(get(`${PREVIEW}${PREVIEW_PATH}`))).toBeNull();
  });

  it("does not redirect unsafe methods", () => {
    setEnv("PREVIEW_ORIGIN", PREVIEW);
    expect(
      previewHostRedirect(get(`${APP}${PREVIEW_PATH}`, "POST")),
    ).toBeNull();
  });
});

describe("previewHostAppRedirect (the sandbox origin serves previews only)", () => {
  it("is a no-op when unconfigured, on any host", () => {
    expect(previewHostAppRedirect(get(`${APP}/foh/projects`))).toBeNull();
    expect(previewHostAppRedirect(get(`${PREVIEW}/sign-in`))).toBeNull();
  });

  it("bounces non-preview requests on the sandbox origin back to the app", () => {
    setEnv("PREVIEW_ORIGIN", PREVIEW);
    expect(location(previewHostAppRedirect(get(`${PREVIEW}/sign-in?next=%2Fx`)))).toBe(
      `${APP}/sign-in?next=%2Fx`,
    );
  });

  it("leaves preview requests, and every app-origin request, alone", () => {
    setEnv("PREVIEW_ORIGIN", PREVIEW);
    expect(
      previewHostAppRedirect(get(`${PREVIEW}${PREVIEW_PATH}`)),
    ).toBeNull();
    expect(previewHostAppRedirect(get(`${APP}/sign-in`))).toBeNull();
  });

  it("does not redirect unsafe methods, whose body a redirect would drop", () => {
    setEnv("PREVIEW_ORIGIN", PREVIEW);
    expect(
      previewHostAppRedirect(get(`${PREVIEW}/api/auth/sign-in`, "POST")),
    ).toBeNull();
  });

  it("leaves a case-variant preview path alone, which would otherwise ping-pong forever", () => {
    setEnv("PREVIEW_ORIGIN", PREVIEW);
    // React Router matches routes case-insensitively, so this still reaches the preview route.
    // Bouncing it to the app origin would only get it bounced back by the route's host check.
    expect(
      previewHostAppRedirect(
        get(`${PREVIEW}${PREVIEW_PATH.replace("/artifacts/", "/Artifacts/")}`),
      ),
    ).toBeNull();
  });
});

describe("artifactPreviewUrl", () => {
  it("stays a root-relative path when unconfigured", () => {
    expect(artifactPreviewUrl("tok", "art_1", "index.html")).toBe(
      "/artifacts/preview/tok/art_1/index.html",
    );
  });

  it("is absolute on the sandbox origin when configured, path encoding unchanged", () => {
    setEnv("PREVIEW_ORIGIN", PREVIEW);
    expect(artifactPreviewUrl("tok", "art_1", "sub dir/page.html")).toBe(
      `${PREVIEW}/artifacts/preview/tok/art_1/sub%20dir/page.html`,
    );
  });
});

describe("frame-ancestors on a preview response", () => {
  const ancestors = (requestUrl: string) =>
    artifactPreviewHeaders({
      contentType: "text/html",
      byteSize: 10,
      requestUrl,
    })
      .get("Content-Security-Policy")
      ?.split("; ")
      .find((directive) => directive.startsWith("frame-ancestors "));

  it("names the app origin even when the bytes come from the sandbox origin", () => {
    setEnv("PREVIEW_ORIGIN", PREVIEW);
    expect(ancestors(`${PREVIEW}${PREVIEW_PATH}`)).toBe(
      `frame-ancestors ${APP}`,
    );
  });

  it("names the app origin when there is no split at all", () => {
    expect(ancestors(`${APP}${PREVIEW_PATH}`)).toBe(`frame-ancestors ${APP}`);
  });

  it("falls back to the request's own origin only on a single-origin install with no configured app origin", () => {
    setEnv("BETTER_AUTH_URL", undefined);
    expect(ancestors(`https://selfhost.example${PREVIEW_PATH}`)).toBe(
      "frame-ancestors https://selfhost.example",
    );
  });

  it("fails closed rather than letting a preview declare itself embeddable", () => {
    setEnv("BETTER_AUTH_URL", undefined);
    setEnv("PREVIEW_ORIGIN", PREVIEW);
    expect(ancestors(`${PREVIEW}${PREVIEW_PATH}`)).toBe("frame-ancestors 'none'");
    expect(previewFrameAncestors(`${PREVIEW}${PREVIEW_PATH}`)).toBe("'none'");
  });
});
