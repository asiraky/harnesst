/**
 * Back from Settings (app/lib/settings-back.ts): returns to the exact Chat or Build page
 * you left, never to a settings page, and to Build's root when nothing was visited.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  backTarget,
  isSettingsPath,
  lastWorkspaceLocation,
  rememberWorkspacePath,
  resetWorkspaceLocation,
} from "~/lib/settings-back";

describe("isSettingsPath", () => {
  it("matches /settings and its sections, not lookalikes", () => {
    expect(isSettingsPath("/settings")).toBe(true);
    expect(isSettingsPath("/settings/members")).toBe(true);
    expect(isSettingsPath("/repos/acme/settings")).toBe(false);
    expect(isSettingsPath("/settingsx")).toBe(false);
  });
});

describe("rememberWorkspacePath", () => {
  beforeEach(resetWorkspaceLocation);

  it("keeps the last non-settings location, search and hash included", () => {
    rememberWorkspacePath("/repos/acme/runs", "?run=7", "#step-3");
    rememberWorkspacePath("/settings/members", "");
    expect(lastWorkspaceLocation()).toBe("/repos/acme/runs?run=7#step-3");
  });
});

describe("backTarget", () => {
  it("labels the destination by its surface", () => {
    expect(backTarget("/t/acme/ag_1")).toEqual({
      href: "/t/acme/ag_1",
      surface: "chat",
      label: "Back to Chat",
    });
    expect(backTarget("/repos/acme/runs")).toMatchObject({
      surface: "build",
      label: "Back to Build",
    });
  });

  it("judges the surface by path alone — Chat home with a query is still Chat", () => {
    expect(backTarget("/?view=all")).toMatchObject({
      href: "/?view=all",
      surface: "chat",
      label: "Back to Chat",
    });
  });

  it("falls back to Build's root with nothing to return to", () => {
    expect(backTarget(null)).toEqual({
      href: "/dashboard",
      surface: "build",
      label: "Back to Build",
    });
  });
});
