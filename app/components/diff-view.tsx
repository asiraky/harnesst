/**
 * Unified-diff renderer for a single file's GitHub `patch` (the hunk text `pulls.listFiles`
 * returns). Used to review pending changes as real per-file line diffs in the publish panel.
 * Pure presentation: it parses the `@@ … @@` hunks and colours added/removed/context lines.
 * Binary or too-large files have no patch — the caller renders the add/delete counts instead.
 */
import { cn } from "~/lib/utils";

interface DiffLine {
  kind: "add" | "del" | "context" | "hunk";
  text: string;
}

/** Split a unified-diff patch into typed lines (hunk headers kept for context). */
export function parsePatch(patch: string): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@")) lines.push({ kind: "hunk", text: raw });
    else if (raw.startsWith("+")) lines.push({ kind: "add", text: raw.slice(1) });
    else if (raw.startsWith("-")) lines.push({ kind: "del", text: raw.slice(1) });
    else lines.push({ kind: "context", text: raw.replace(/^ /, "") });
  }
  // Drop a trailing empty context line the split can leave.
  if (lines.length > 0 && lines[lines.length - 1].kind === "context" && lines[lines.length - 1].text === "") {
    lines.pop();
  }
  return lines;
}

export function DiffView({ patch }: { patch: string }) {
  const lines = parsePatch(patch);
  return (
    <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 text-xs leading-relaxed">
      <code className="block">
        {lines.map((line, i) => (
          <span
            key={i}
            className={cn(
              "block px-3 py-0.5 whitespace-pre",
              line.kind === "add" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
              line.kind === "del" && "bg-rose-500/10 text-rose-700 dark:text-rose-400",
              line.kind === "hunk" && "bg-blue-500/10 text-blue-700 dark:text-blue-400",
              line.kind === "context" && "text-muted-foreground",
            )}
          >
            <span className="select-none opacity-60">
              {line.kind === "add" ? "+ " : line.kind === "del" ? "- " : line.kind === "hunk" ? "" : "  "}
            </span>
            {line.text || " "}
          </span>
        ))}
      </code>
    </pre>
  );
}
