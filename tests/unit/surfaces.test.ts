/**
 * The Chat ⇄ Build toggle is context-preserving (app/lib/surfaces.ts): an agent's conversation
 * maps to that agent's Build page and back. Chat keys agents by id, Build by name, and a
 * single-agent repo has no member page — the mapping must cross all three seams.
 */
import { describe, expect, it } from "vitest";

import {
  buildToChatHref,
  chatToBuildHref,
  counterpartHref,
  surfaceOf,
  type SurfaceRepo,
} from "~/lib/surfaces";

const repos: SurfaceRepo[] = [
  {
    slug: "acme",
    layout: "team",
    agents: [
      { id: "ag_1", name: "ivy" },
      { id: "ag_2", name: "ops lead" },
    ],
  },
  { slug: "solo", layout: "single", agents: [{ id: "ag_9", name: "solo-bot" }] },
];

describe("surfaceOf", () => {
  it("puts / and /t/... on Chat, everything else on Build", () => {
    expect(surfaceOf("/")).toBe("chat");
    expect(surfaceOf("/t/acme/ag_1")).toBe("chat");
    expect(surfaceOf("/dashboard")).toBe("build");
    expect(surfaceOf("/team")).toBe("build");
  });
});

describe("chatToBuildHref", () => {
  it("team agent → the member page keyed by name, session included", () => {
    expect(chatToBuildHref("/t/acme/ag_1", repos)).toBe("/repos/acme/agents/ivy");
    expect(chatToBuildHref("/t/acme/ag_1/s/sess_1", repos)).toBe(
      "/repos/acme/agents/ivy",
    );
  });

  it("URL-encodes member names", () => {
    expect(chatToBuildHref("/t/acme/ag_2", repos)).toBe(
      "/repos/acme/agents/ops%20lead",
    );
  });

  it("single-agent repo → the repo page (no member page exists)", () => {
    expect(chatToBuildHref("/t/solo/ag_9", repos)).toBe("/repos/solo");
  });

  it("activity feed and unknown agent → the repo page", () => {
    expect(chatToBuildHref("/t/acme/activity", repos)).toBe("/repos/acme");
    expect(chatToBuildHref("/t/acme/ag_nope", repos)).toBe("/repos/acme");
  });

  it("null off Chat or for a repo the viewer can't build", () => {
    expect(chatToBuildHref("/", repos)).toBeNull();
    expect(chatToBuildHref("/t/other/ag_1", repos)).toBeNull();
  });
});

describe("buildToChatHref", () => {
  it("member page (any tab) → that agent's conversations keyed by id", () => {
    expect(buildToChatHref("/repos/acme/agents/ivy", repos)).toBe("/t/acme/ag_1");
    expect(buildToChatHref("/repos/acme/agents/ops%20lead/runs", repos)).toBe(
      "/t/acme/ag_2",
    );
  });

  it("team repo page → the activity feed", () => {
    expect(buildToChatHref("/repos/acme", repos)).toBe("/t/acme/activity");
    expect(buildToChatHref("/repos/acme/settings", repos)).toBe("/t/acme/activity");
  });

  it("single-agent repo page → its one agent", () => {
    expect(buildToChatHref("/repos/solo/deployment", repos)).toBe("/t/solo/ag_9");
  });

  it("unknown member name falls back to the activity feed", () => {
    expect(buildToChatHref("/repos/acme/agents/ghost", repos)).toBe(
      "/t/acme/activity",
    );
  });

  it("null off a repo page or for an unknown repo", () => {
    expect(buildToChatHref("/dashboard", repos)).toBeNull();
    expect(buildToChatHref("/repos/other", repos)).toBeNull();
  });
});

describe("counterpartHref", () => {
  it("dispatches on the surface you're leaving", () => {
    expect(counterpartHref("chat", "/t/acme/ag_1", repos)).toBe(
      "/repos/acme/agents/ivy",
    );
    expect(counterpartHref("build", "/repos/acme/agents/ivy", repos)).toBe(
      "/t/acme/ag_1",
    );
  });
});
