/**
 * The artifact bridge: the script injected first into every served page, and the guard the panel
 * runs on what it hears. The script is exercised in a `vm` against a fake window — what matters is
 * what it DOES (shim storage, strip the token from the reported location, forward console, obey
 * nav only from the parent), not how it is spelled.
 */
import vm from "node:vm";
import { describe, expect, it } from "vitest";

import {
  ARTIFACT_BRIDGE_SOURCE,
  artifactBridgeNav,
  isArtifactBridgeMessage,
} from "~/foh/artifact-bridge";
import { injectArtifactBridge } from "~/foh/artifact-bridge.server";
import { artifactPageBody } from "~/foh/artifact-preview.server";

function scriptOf(doc: string): string {
  const match = /<script>([\s\S]*?)<\/script>/.exec(doc);
  if (!match) throw new Error("no bridge script");
  return match[1];
}

type Listener = ((event: Record<string, unknown>) => void) & {
  capture?: boolean;
};

/** Run the bridge in a fake window at `pathname`, framed by a parent unless `framed` is false. */
function runBridge(pathname: string, framed = true) {
  const posted: Array<Record<string, unknown>> = [];
  const listeners: Record<string, Listener[]> = {};
  const history = { back: 0, forward: 0 };
  const logged: unknown[][] = [];
  const parent = {
    postMessage: (message: Record<string, unknown>) => posted.push(message),
  };
  const win: Record<string, unknown> = {
    location: {
      pathname,
      origin: "https://preview.example",
      search: "?q=1",
      hash: "#top",
    },
    document: { title: "My page" },
    history: {
      back: () => history.back++,
      forward: () => history.forward++,
    },
    console: {
      log: (...args: unknown[]) => logged.push(args),
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    addEventListener: (type: string, fn: Listener, capture?: unknown) => {
      const listener: Listener = (event) => fn(event);
      listener.capture = capture === true;
      (listeners[type] ??= []).push(listener);
    },
  };
  // An opaque origin: touching storage throws.
  for (const name of ["localStorage", "sessionStorage"]) {
    Object.defineProperty(win, name, {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
  }
  win.window = win;
  win.parent = framed ? parent : win;
  const context = vm.createContext(win);
  vm.runInContext(
    scriptOf(injectArtifactBridge("<html><head></head></html>")),
    context,
  );
  const fire = (type: string, event: Record<string, unknown> = {}) =>
    (listeners[type] ?? []).forEach((fn) => fn(event));
  /** An event that does not bubble, fired at an element: `window` only hears it while capturing. */
  const fireAtElement = (type: string, event: Record<string, unknown>) =>
    (listeners[type] ?? [])
      .filter((fn) => fn.capture)
      .forEach((fn) => fn(event));
  return { win, context, posted, fire, fireAtElement, history, logged, parent };
}

describe("bridge script", () => {
  it("replaces storage an opaque origin cannot use with a working in-memory store", () => {
    const { context } = runBridge("/a/tok/index.html", false);
    expect(
      vm.runInContext(
        `localStorage.setItem("k", 1); [localStorage.getItem("k"), localStorage.length, sessionStorage.getItem("k")]`,
        context,
      ),
    ).toEqual(["1", 1, null]);
  });

  it("reports the location inside the bundle, with the token prefix stripped", () => {
    const share = runBridge("/a/tok123/docs/my%20page.html");
    share.fire("load");
    expect(share.posted).toEqual([
      {
        source: ARTIFACT_BRIDGE_SOURCE,
        type: "location",
        href: "/docs/my page.html?q=1#top",
        title: "My page",
      },
    ]);

    const preview = runBridge("/artifacts/preview/tok.sig/art_1/index.html");
    preview.fire("hashchange");
    expect(preview.posted[0]).toMatchObject({ href: "/index.html?q=1#top" });
    expect(preview.posted.every(isArtifactBridgeMessage)).toBe(true);
  });

  it("forwards console calls as strings, scrubbed of the token, and still logs them", () => {
    const { context, posted, logged } = runBridge("/a/tok123/index.html");
    vm.runInContext(
      `console.log("at https://preview.example/a/tok123/x.js", {n: 1})`,
      context,
    );
    expect(posted).toEqual([
      {
        source: ARTIFACT_BRIDGE_SOURCE,
        type: "console",
        level: "log",
        args: ["at /x.js", '{"n":1}'],
      },
    ]);
    expect(logged).toHaveLength(1);
    expect(posted.every(isArtifactBridgeMessage)).toBe(true);
  });

  it("reports a script error once, and a resource that failed to load as an error", () => {
    const { win, posted, fire, fireAtElement } = runBridge("/a/tok/index.html");
    fire("error", {
      target: win,
      message: "boom",
      filename: "https://preview.example/a/tok/app.js",
      lineno: 3,
    });
    fireAtElement("error", {
      target: {
        nodeType: 1,
        tagName: "SCRIPT",
        src: "https://preview.example/a/tok/missing.js",
      },
    });
    fireAtElement("error", {
      target: {
        nodeType: 1,
        tagName: "IMG",
        src: "https://cdn.example/a.png",
        currentSrc: "https://cdn.example/a@2x.png",
      },
    });
    fireAtElement("error", {
      target: { nodeType: 1, tagName: "LINK", href: "https://cdn.example/x.css" },
    });

    expect(posted.map((m) => [m.level, ...(m.args as string[])])).toEqual([
      ["error", "boom (/app.js:3)"],
      ["error", "Failed to load <script> /missing.js"],
      ["error", "Failed to load <img> https://cdn.example/a@2x.png"],
      ["error", "Failed to load <link> https://cdn.example/x.css"],
    ]);
    expect(posted.every(isArtifactBridgeMessage)).toBe(true);
  });

  it("caps what it forwards to what the panel's guard accepts", () => {
    const { context, posted } = runBridge("/a/tok/index.html");
    vm.runInContext(
      `console.log.apply(console, Array(30).fill("x".repeat(5000)))`,
      context,
    );
    expect(isArtifactBridgeMessage(posted[0])).toBe(true);
  });

  it("navigates only on a nav command from its parent", () => {
    const { fire, history, parent } = runBridge("/a/tok/index.html");
    fire("message", { source: {}, data: artifactBridgeNav("back") });
    fire("message", {
      source: parent,
      data: { source: "other", type: "nav", dir: "back" },
    });
    expect(history).toEqual({ back: 0, forward: 0 });

    fire("message", { source: parent, data: artifactBridgeNav("back") });
    fire("message", { source: parent, data: artifactBridgeNav("forward") });
    expect(history).toEqual({ back: 1, forward: 1 });
  });

  it("says nothing when it is not framed", () => {
    const { context, posted, fire } = runBridge("/a/tok/index.html", false);
    fire("load");
    vm.runInContext(`console.log("hi")`, context);
    expect(posted).toEqual([]);
  });
});

describe("injectArtifactBridge", () => {
  const bridgeAt = (doc: string) =>
    injectArtifactBridge(doc).indexOf("<script>");

  it("goes first inside <head>, before the page's own scripts", () => {
    const doc = `<!doctype html><html lang="en"><HEAD data-x="1"><script src="app.js"></script></head></html>`;
    const out = injectArtifactBridge(doc);
    expect(bridgeAt(doc)).toBe(doc.indexOf(">", doc.indexOf("<HEAD")) + 1);
    expect(out.indexOf("app.js")).toBeGreaterThan(bridgeAt(doc));
  });

  it("falls back to after <html>, then to the very start", () => {
    const noHead = `<html><body>x</body></html>`;
    expect(bridgeAt(noHead)).toBe("<html>".length);
    expect(bridgeAt(`<p>fragment</p>`)).toBe(0);
    // `<header>` is not a head.
    expect(bridgeAt(`<header>x</header>`)).toBe(0);
  });

  it("adds a viewport meta only when the head has none", () => {
    const count = (doc: string) =>
      injectArtifactBridge(doc).match(/name="?viewport/g)?.length ?? 0;
    expect(count(`<html><head></head></html>`)).toBe(1);
    expect(
      count(
        `<html><head><meta name=viewport content="width=500"></head></html>`,
      ),
    ).toBe(1);
  });
});

describe("isArtifactBridgeMessage", () => {
  it("accepts the two page messages", () => {
    expect(
      isArtifactBridgeMessage({
        source: ARTIFACT_BRIDGE_SOURCE,
        type: "location",
        href: "/",
        title: "",
      }),
    ).toBe(true);
    expect(
      isArtifactBridgeMessage({
        source: ARTIFACT_BRIDGE_SOURCE,
        type: "console",
        level: "warn",
        args: ["a"],
      }),
    ).toBe(true);
  });

  it("refuses other sources, unknown types and levels, and oversized or non-string fields", () => {
    const base = { source: ARTIFACT_BRIDGE_SOURCE, type: "console" };
    for (const data of [
      null,
      "x",
      [],
      { ...base, source: "other", level: "log", args: [] },
      artifactBridgeNav("back"),
      { ...base, level: "trace", args: [] },
      { ...base, level: "log", args: [1] },
      { ...base, level: "log", args: Array(21).fill("a") },
      { ...base, level: "log", args: ["x".repeat(4001)] },
      { source: ARTIFACT_BRIDGE_SOURCE, type: "location", href: 1, title: "" },
      {
        source: ARTIFACT_BRIDGE_SOURCE,
        type: "location",
        href: "x".repeat(8193),
        title: "",
      },
    ]) {
      expect(isArtifactBridgeMessage(data)).toBe(false);
    }
  });
});

describe("artifactPageBody", () => {
  const root = "/a/tok/";

  it("rewrites and instruments HTML, rewrites CSS, and round-trips non-UTF-8 bytes", () => {
    const html = Buffer.concat([
      Buffer.from(`<html><head><link href="/s.css"></head><body>caf`),
      Buffer.from([0xe9]), // latin1 é, invalid as UTF-8
      Buffer.from(`</body></html>`),
    ]);
    const page = artifactPageBody({
      bytes: html,
      contentType: "text/html; charset=windows-1252",
      siteRoot: root,
    });
    const text = page.toString("latin1");
    expect(text).toContain(`href="/a/tok/s.css"`);
    expect(text.indexOf("<script>")).toBe("<html><head>".length);
    expect(page.includes(Buffer.from([0x63, 0x61, 0x66, 0xe9]))).toBe(true);

    const css = artifactPageBody({
      bytes: Buffer.from("a{background:url(/bg.png)}"),
      contentType: "text/css",
      siteRoot: root,
    });
    expect(css.toString()).toBe("a{background:url(/a/tok/bg.png)}");
  });

  it("passes every other type through untouched", () => {
    const js = Buffer.from(`fetch("/data.json")`);
    expect(
      artifactPageBody({
        bytes: js,
        contentType: "text/javascript",
        siteRoot: root,
      }),
    ).toBe(js);
  });
});
