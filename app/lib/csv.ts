/**
 * A small, forgiving parser for delimited text (CSV, TSV) — the artifact table viewer's. Ported
 * from Omniplex (web/src/lib/csv.ts).
 *
 * RFC 4180 as far as it goes — quoted fields, doubled quotes inside them, delimiters and newlines
 * inside quotes, CRLF or LF — and lenient past it, because the files it meets are whatever an agent's
 * script wrote: a stray quote in the middle of a bare field is kept as a character, an unterminated
 * quote runs to the end, and ragged rows stay ragged rather than being rejected.
 */
import {
  artifactExtensionOf,
  artifactMediaEssence,
} from "~/foh/artifact-viewer";

export interface Delimited {
  rows: string[][];
  /** More rows followed than were kept. */
  truncated: boolean;
}

export function parseDelimited(
  text: string,
  delimiter = ",",
  maxRows = Infinity,
): Delimited {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  // Whether the current field has begun: a quote is only special as a field's FIRST character.
  // `5" pipe` is a bare field with an inch mark in it.
  let fieldStarted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const n = text.length;

  const endField = () => {
    row.push(field);
    field = "";
    fieldStarted = false;
  };
  const endRow = (): boolean => {
    endField();
    rows.push(row);
    row = [];
    return rows.length >= maxRows;
  };

  while (i < n) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && !fieldStarted) {
      quoted = true;
      fieldStarted = true;
      i++;
      continue;
    }
    if (c === delimiter) {
      endField();
      i++;
      continue;
    }
    if (c === "\n" || c === "\r") {
      i += c === "\r" && text[i + 1] === "\n" ? 2 : 1;
      if (endRow()) return { rows, truncated: text.slice(i).trim() !== "" };
      continue;
    }
    field += c;
    fieldStarted = true;
    i++;
  }
  // The last row, unless the text ended on a newline and nothing followed it.
  if (field !== "" || row.length > 0 || fieldStarted) endRow();
  return { rows, truncated: false };
}

/** The delimiter for a delimited-text file: a tab for TSV (by name, then type), else a comma. */
export function delimiterFor(name: string, contentType: string): string {
  return artifactExtensionOf(name) === "tsv" ||
    artifactMediaEssence(contentType) === "text/tab-separated-values"
    ? "\t"
    : ",";
}
