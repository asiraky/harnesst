/**
 * FOH → BOH cross-link hrefs (app/foh/boh-links.ts, issue #246): BOH member pages key on
 * agent NAME, and single-agent repos (the repo IS the agent) have no member page — their
 * agent link must collapse to the repo-level page.
 */
import { describe, expect, it } from "vitest";

import { bohAgentHref, bohTeamHref } from "~/foh/boh-links";

describe("bohTeamHref", () => {
  it("points at the repo landing", () => {
    expect(bohTeamHref("proj_1")).toBe("/repos/proj_1");
  });
});

describe("bohAgentHref", () => {
  it("team layout → the member page, keyed by name", () => {
    expect(bohAgentHref({ id: "proj_1", layout: "team" }, "ivy")).toBe(
      "/repos/proj_1/agents/ivy",
    );
  });

  it("URL-encodes member names", () => {
    expect(bohAgentHref({ id: "proj_1", layout: "team" }, "ops lead")).toBe(
      "/repos/proj_1/agents/ops%20lead",
    );
  });

  it("single-agent layout → the repo-level page (no member page exists)", () => {
    expect(bohAgentHref({ id: "proj_1", layout: "single" }, "ivy")).toBe(
      "/repos/proj_1",
    );
  });
});
