import { useMemo } from "react";

import { parseDelimited } from "~/lib/csv";
import { CUT_NOTICE } from "./states";

/**
 * Rows past this are not rendered: a table is for looking at, and 2,000 rows is well past what
 * anyone reads on a screen (and far more DOM than a phone wants).
 */
export const MAX_TABLE_ROWS = 2000;

/**
 * A CSV/TSV file as a table: sticky header, row numbers, cells truncated with the full value in
 * the tooltip. It has no scroller of its own — the viewer's scroll box scrolls both ways, so the
 * header row can stick to its top (an inner sideways scroller would capture the sticky header and
 * it would scroll off).
 */
export function CsvView({
  text,
  delimiter,
  truncated = false,
}: {
  text: string;
  delimiter: string;
  truncated?: boolean;
}) {
  // One more than the cap: the header row is not a data row.
  const parsed = useMemo(
    () => parseDelimited(text, delimiter, MAX_TABLE_ROWS + 1),
    [text, delimiter],
  );
  const [head, ...body] = parsed.rows;
  const columns = useMemo(
    () => parsed.rows.reduce((n, row) => Math.max(n, row.length), 0),
    [parsed],
  );
  if (!head) {
    return (
      <p className="px-4 py-4 text-xs text-muted-foreground">The file is empty.</p>
    );
  }
  const notice = parsed.truncated
    ? `Showing the first ${MAX_TABLE_ROWS.toLocaleString()} rows. Download the file for the rest.`
    : truncated
      ? CUT_NOTICE
      : null;

  return (
    <div className="min-w-full w-max">
      <table className="w-max min-w-full border-collapse text-xs">
        <thead className="sticky top-0 z-10 bg-muted">
          <tr>
            <th className="w-[1%] border-b border-border px-2 py-1.5 text-right font-normal text-muted-foreground/60">
              #
            </th>
            {Array.from({ length: columns }, (_, c) => (
              <th
                key={c}
                title={head[c]}
                className="max-w-64 truncate border-b border-l border-border px-2.5 py-1.5 text-left font-semibold"
              >
                {head[c] ?? ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r} className="hover:bg-accent/40">
              <td className="border-b border-border px-2 py-1 text-right font-mono text-muted-foreground/60 tabular-nums">
                {r + 1}
              </td>
              {Array.from({ length: columns }, (_, c) => (
                <td
                  key={c}
                  title={row[c]}
                  className="max-w-64 truncate border-b border-l border-border px-2.5 py-1 align-top"
                >
                  {row[c] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {notice && (
        <p className="sticky bottom-0 left-0 w-fit max-w-full border-t border-border/60 bg-background px-4 py-2 text-[11px] text-muted-foreground italic">
          {notice}
        </p>
      )}
    </div>
  );
}
