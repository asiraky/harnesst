/**
 * Minimal unified-diff generator for the publish panel's expandable per-file diffs (§4.2).
 * Saved changes are whole-file (a draft row holds the full new content), so the panel diffs the
 * repo's current content against the draft server-side and hands `DiffView` the same hunk format
 * GitHub's `pulls.listFiles` produces (`@@ -a,b +c,d @@` headers, `+`/`-`/` ` line prefixes).
 *
 * Line-based LCS with a work cap: agent files are small (instructions, one-module agents), so an
 * O(n·m) table is fine; anything past the cap degrades to a whole-file replace hunk rather than
 * burning CPU on a pathological input. Pure and unit-tested.
 */

const CONTEXT_LINES = 3;
/** Above this many DP cells, skip the LCS and emit a whole-file replace. */
const MAX_LCS_CELLS = 1_000_000;

interface DiffOp {
  kind: "ctx" | "add" | "del";
  text: string;
}

/** Split into lines, treating a trailing newline as line termination (not an extra empty line). */
function toLines(content: string): string[] {
  if (content === "") return [];
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Longest-common-subsequence walk over lines → a flat op list (classic DP, small inputs). */
function diffOps(a: string[], b: string[]): DiffOp[] {
  if (a.length * b.length > MAX_LCS_CELLS) {
    // Whole-file replace: still a valid, honest patch — just without minimal hunks.
    return [
      ...a.map((text): DiffOp => ({ kind: "del", text })),
      ...b.map((text): DiffOp => ({ kind: "add", text })),
    ];
  }
  // lcs[i][j] = LCS length of a[i:] and b[j:].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: "ctx", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ kind: "del", text: a[i] });
      i++;
    } else {
      ops.push({ kind: "add", text: b[j] });
      j++;
    }
  }
  for (; i < a.length; i++) ops.push({ kind: "del", text: a[i] });
  for (; j < b.length; j++) ops.push({ kind: "add", text: b[j] });
  return ops;
}

/**
 * Unified diff of two file bodies (null = the file doesn't exist on that side). Returns null
 * when the sides are identical — the caller renders "no changes" instead of an empty patch.
 */
export function unifiedDiff(before: string | null, after: string | null): string | null {
  if (before === after) return null;
  const a = toLines(before ?? "");
  const b = toLines(after ?? "");
  const ops = diffOps(a, b);
  if (!ops.some((op) => op.kind !== "ctx")) return null;

  // Group ops into hunks: each change run plus CONTEXT_LINES of context either side, merging
  // hunks whose context would touch or overlap.
  const changed = ops
    .map((op, index) => ({ op, index }))
    .filter(({ op }) => op.kind !== "ctx")
    .map(({ index }) => index);
  const ranges: { start: number; end: number }[] = [];
  for (const index of changed) {
    const start = Math.max(0, index - CONTEXT_LINES);
    const end = Math.min(ops.length - 1, index + CONTEXT_LINES);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }

  // Old/new line numbers for each op position (1-based, as unified diff headers count).
  const chunks: string[] = [];
  let oldLine = 1;
  let newLine = 1;
  let cursor = 0;
  for (const range of ranges) {
    // Advance the line counters through the ops before this hunk.
    for (; cursor < range.start; cursor++) {
      if (ops[cursor].kind !== "add") oldLine++;
      if (ops[cursor].kind !== "del") newLine++;
    }
    const lines: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    for (let k = range.start; k <= range.end; k++) {
      const op = ops[k];
      if (op.kind === "ctx") lines.push(` ${op.text}`);
      else if (op.kind === "del") lines.push(`-${op.text}`);
      else lines.push(`+${op.text}`);
      if (op.kind !== "add") oldCount++;
      if (op.kind !== "del") newCount++;
    }
    // Zero-length sides anchor one line earlier, per the unified format ("-0,0" for a new file).
    const oldStart = oldCount === 0 ? oldLine - 1 : oldLine;
    const newStart = newCount === 0 ? newLine - 1 : newLine;
    chunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    chunks.push(...lines);
    for (; cursor <= range.end; cursor++) {
      if (ops[cursor].kind !== "add") oldLine++;
      if (ops[cursor].kind !== "del") newLine++;
    }
  }
  return chunks.join("\n");
}
