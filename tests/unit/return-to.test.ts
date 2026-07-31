/**
 * `safeReturnTo` (app/auth/return-to.ts) guards every `returnTo` consumed by the auth screens
 * (login, signup, forgot/reset password) and the workspace chooser. It must only ever produce a
 * same-origin path — in particular it must reject dot-segment payloads whose NORMALIZED pathname
 * becomes protocol-relative ("/.//evil.com" → "//evil.com"), the open-redirect vector found in
 * review.
 */
import { describe, expect, it } from "vitest";

import { returnToFromRequest, safeReturnTo } from "~/auth/return-to";

describe("safeReturnTo", () => {
  it("accepts ordinary same-origin paths, preserving query and hash", () => {
    expect(safeReturnTo("/dashboard")).toBe("/dashboard");
    expect(safeReturnTo("/org/members?tab=invites#pending")).toBe(
      "/org/members?tab=invites#pending",
    );
  });

  it("turns React Router single-fetch URLs into document destinations", () => {
    expect(
      safeReturnTo(
        "/projects/123.data?_routes=root%2Croutes%2Fprojects&tab=activity&index",
      ),
    ).toBe("/projects/123?tab=activity");
    expect(safeReturnTo("/_root.data?_routes=root")).toBe("/");
    expect(safeReturnTo("/_.data?_routes=root")).toBe("/");
    expect(safeReturnTo("/projects/123/_.data?_routes=root")).toBe(
      "/projects/123/",
    );
    expect(safeReturnTo("/projects/123.data.data?_routes=root")).toBe("/");
  });

  it("preserves valued application index parameters", () => {
    expect(safeReturnTo("/search.data?index=articles&index")).toBe(
      "/search?index=articles",
    );
  });

  it("normalizes the current request before minting a returnTo value", () => {
    expect(
      returnToFromRequest(
        new Request(
          "https://harnesst.example.com/projects/123.data?_routes=root&tab=activity",
        ),
      ),
    ).toBe("/projects/123?tab=activity");
  });

  it("falls back to Front of House for empty, relative, and absolute-URL values (D18)", () => {
    expect(safeReturnTo(null)).toBe("/");
    expect(safeReturnTo(undefined)).toBe("/");
    expect(safeReturnTo("")).toBe("/");
    expect(safeReturnTo("dashboard")).toBe("/");
    expect(safeReturnTo("https://evil.com/")).toBe("/");
  });

  it("rejects protocol-relative values", () => {
    expect(safeReturnTo("//evil.com")).toBe("/");
    expect(safeReturnTo("//evil.com/path")).toBe("/");
  });

  it("rejects dot-segment payloads that normalize to a protocol-relative path", () => {
    expect(safeReturnTo("/.//evil.com")).toBe("/");
    expect(safeReturnTo("/..//evil.com")).toBe("/");
    expect(safeReturnTo("/a/..//evil.com")).toBe("/");
    expect(safeReturnTo("/.//evil.com?x=1#f")).toBe("/");
  });

  it("rejects backslash variants (browsers treat \\ as /)", () => {
    expect(safeReturnTo("/\\evil.com")).toBe("/");
    expect(safeReturnTo("/.\\/evil.com")).toBe("/");
  });

  it("honors a custom fallback", () => {
    expect(safeReturnTo("//evil.com", "/workspaces")).toBe("/workspaces");
  });
});
