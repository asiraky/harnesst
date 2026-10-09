import { describe, expect, it } from "vitest";

import { safeRelativePath } from "../../catalog/templates/tools/team-artifacts/files/lib/team-artifacts";

describe("team-artifacts safeRelativePath", () => {
  it("accepts bundle paths and refuses anything that could leave the folder", () => {
    for (const ok of ["index.html", "assets/app.css", "_next/static/a.js"]) {
      expect(safeRelativePath(ok)).toBe(true);
    }
    for (const bad of [
      "",
      "/etc/passwd",
      "../escape",
      "a/../../escape",
      ".env",
      "a//b",
      "a/",
      "a/b/c/d/e/f/g/h/i",
      42,
    ]) {
      expect(safeRelativePath(bad)).toBe(false);
    }
  });
});
