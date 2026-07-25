/**
 * The publish panel's per-file diff generator (§4.2): saved changes are whole-file, so the
 * panel diffs repo content against the draft server-side and hands DiffView the same unified
 * hunk format GitHub produces. Pins hunk headers, context windows, add/delete-only files, and
 * round-trip compatibility with DiffView's parsePatch.
 */
import { describe, expect, it } from "vitest";

import { parsePatch } from "~/components/diff-view";
import { unifiedDiff } from "~/publish/unified-diff";

describe("unifiedDiff", () => {
  it("returns null when both sides are identical (nothing to render)", () => {
    expect(unifiedDiff(null, null)).toBeNull();
    expect(unifiedDiff("a\nb\n", "a\nb\n")).toBeNull();
  });

  it("treats a trailing-newline-only difference as no change", () => {
    expect(unifiedDiff("a", "a\n")).toBeNull();
  });

  it("diffs an edited line with context and a correct hunk header", () => {
    const patch = unifiedDiff("a\nb\nc\n", "a\nx\nc\n");
    expect(patch).toBe("@@ -1,3 +1,3 @@\n a\n-b\n+x\n c");
  });

  it("renders a new file as a pure-add hunk anchored at -0,0", () => {
    const patch = unifiedDiff(null, "hello\nworld\n");
    expect(patch).toBe("@@ -0,0 +1,2 @@\n+hello\n+world");
  });

  it("renders a deletion as a pure-delete hunk anchored at +0,0", () => {
    const patch = unifiedDiff("hello\nworld\n", null);
    expect(patch).toBe("@@ -1,2 +0,0 @@\n-hello\n-world");
  });

  it("windows long files to three lines of context around the change", () => {
    const before = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n");
    const after = before.replace("line6", "changed");
    const patch = unifiedDiff(before, after)!;
    expect(patch.split("\n")[0]).toBe("@@ -3,7 +3,7 @@");
    expect(patch).toContain("-line6");
    expect(patch).toContain("+changed");
    // Lines outside the context window never appear.
    expect(patch).not.toContain("line1");
    expect(patch).not.toContain("line10");
  });

  it("emits separate hunks for changes far apart, merging ones whose context touches", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line${i + 1}`);
    const changedFar = [...lines];
    changedFar[2] = "top";
    changedFar[27] = "bottom";
    const patch = unifiedDiff(lines.join("\n"), changedFar.join("\n"))!;
    expect(patch.match(/^@@ /gm)).toHaveLength(2);
  });

  it("round-trips through DiffView's parsePatch with the right line kinds", () => {
    const patch = unifiedDiff("keep\nold\nkeep2\n", "keep\nnew\nkeep2\n")!;
    const kinds = parsePatch(patch).map((l) => l.kind);
    expect(kinds).toEqual(["hunk", "context", "del", "add", "context"]);
  });
});
