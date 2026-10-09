import { describe, expect, it } from "vitest";

import {
  appendConsoleEntry,
  artifactPreviewUrlAt,
  EMPTY_FRAME_HISTORY,
  frameHistoryRequested,
  frameHistoryVisited,
  type ConsoleEntry,
  type FrameHistory,
} from "~/components/artifacts/mini-browser-state";

const MINTED =
  "https://preview.example/artifacts/preview/tok.sig/art_1/index.html";
const PREFIX = "https://preview.example/artifacts/preview/tok.sig/art_1";

describe("artifactPreviewUrlAt", () => {
  it("puts the page the user is on under the fresh token", () => {
    expect(artifactPreviewUrlAt(MINTED, "/about.html?tab=2#team")).toBe(
      `${PREFIX}/about.html?tab=2#team`,
    );
  });

  it("re-encodes a decoded path without double-encoding escapes", () => {
    expect(artifactPreviewUrlAt(MINTED, "/my page.html")).toBe(
      `${PREFIX}/my%20page.html`,
    );
    expect(artifactPreviewUrlAt(MINTED, "/a%2Fb.html")).toBe(
      `${PREFIX}/a%2Fb.html`,
    );
  });

  it("falls back to the entry with no location yet", () => {
    expect(artifactPreviewUrlAt(MINTED, null)).toBe(MINTED);
  });

  it("refuses a location that could leave the artifact's prefix", () => {
    for (const href of [
      "/../other/index.html",
      "/./x/../../y",
      "//evil.example/x",
      "https://evil.example/",
      "relative.html",
      "/a\\..\\b",
      "/a\nb",
    ]) {
      expect(artifactPreviewUrlAt(MINTED, href)).toBe(MINTED);
    }
  });

  it("returns the minted URL when it is not a preview URL", () => {
    expect(artifactPreviewUrlAt("https://x.example/other", "/a.html")).toBe(
      "https://x.example/other",
    );
  });
});

describe("frame history", () => {
  const visit = (state: FrameHistory, ...hrefs: string[]) =>
    hrefs.reduce(frameHistoryVisited, state);

  it("starts with nothing to go back or forward to", () => {
    expect(visit(EMPTY_FRAME_HISTORY, "/index.html")).toMatchObject({
      back: 0,
      forward: 0,
    });
  });

  it("counts followed links as back steps", () => {
    expect(
      visit(EMPTY_FRAME_HISTORY, "/index.html", "/a.html", "/b.html"),
    ).toMatchObject({ back: 2, forward: 0 });
  });

  it("counts a duplicate report once", () => {
    expect(
      visit(EMPTY_FRAME_HISTORY, "/index.html", "/a.html", "/a.html"),
    ).toMatchObject({ back: 1 });
  });

  it("moves a step between the stacks for a requested Back and Forward", () => {
    let state = visit(EMPTY_FRAME_HISTORY, "/index.html", "/a.html", "/b.html");
    state = visit(frameHistoryRequested(state, "back"), "/a.html");
    expect(state).toMatchObject({ back: 1, forward: 1, pending: null });
    state = visit(frameHistoryRequested(state, "forward"), "/b.html");
    expect(state).toMatchObject({ back: 2, forward: 0 });
  });

  it("drops the forward stack when a link is followed after going back", () => {
    let state = visit(EMPTY_FRAME_HISTORY, "/index.html", "/a.html");
    state = visit(frameHistoryRequested(state, "back"), "/index.html");
    state = visit(state, "/c.html");
    expect(state).toMatchObject({ back: 1, forward: 0 });
  });

  it("never counts below zero", () => {
    let state = visit(EMPTY_FRAME_HISTORY, "/index.html");
    state = visit(frameHistoryRequested(state, "back"), "/elsewhere.html");
    expect(state.back).toBe(0);
  });
});

describe("appendConsoleEntry", () => {
  const entry = (n: number): ConsoleEntry => ({
    n,
    level: "log",
    text: `${n}`,
  });

  it("appends under the cap", () => {
    expect(appendConsoleEntry([entry(1)], entry(2), 3).map((e) => e.n)).toEqual(
      [1, 2],
    );
  });

  it("keeps only the newest entries past the cap", () => {
    let list: ConsoleEntry[] = [];
    for (let n = 1; n <= 7; n++) list = appendConsoleEntry(list, entry(n), 5);
    expect(list.map((e) => e.n)).toEqual([3, 4, 5, 6, 7]);
  });
});
