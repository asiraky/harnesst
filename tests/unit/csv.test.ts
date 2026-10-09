import { describe, expect, it } from "vitest";

import { delimiterFor, parseDelimited } from "~/lib/csv";

describe("parseDelimited", () => {
  it("splits rows and fields", () => {
    expect(parseDelimited("a,b,c\n1,2,3\n").rows).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("keeps delimiters, newlines and doubled quotes inside quoted fields", () => {
    const text = 'name,quote\n"Smith, J","He said ""hi""\nthen left"\n';
    expect(parseDelimited(text).rows).toEqual([
      ["name", "quote"],
      ["Smith, J", 'He said "hi"\nthen left'],
    ]);
  });

  it("reads CRLF, a BOM, and a last row with no newline", () => {
    expect(parseDelimited("﻿a,b\r\n1,2").rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps empty fields, including trailing ones", () => {
    expect(parseDelimited("a,,c,\n").rows).toEqual([["a", "", "c", ""]]);
    expect(parseDelimited('""\n').rows).toEqual([[""]]);
  });

  it("treats a quote in the middle of a bare field as a character", () => {
    expect(parseDelimited('pipe,5" wide\n').rows).toEqual([["pipe", '5" wide']]);
  });

  it("runs an unterminated quote to the end instead of failing", () => {
    expect(parseDelimited('a,"open\nstill open').rows).toEqual([
      ["a", "open\nstill open"],
    ]);
  });

  it("leaves ragged rows ragged", () => {
    expect(parseDelimited("a,b,c\n1\n1,2,3,4").rows).toEqual([
      ["a", "b", "c"],
      ["1"],
      ["1", "2", "3", "4"],
    ]);
  });

  it("splits on another delimiter when told to", () => {
    expect(parseDelimited("a\tb,c\n1\t2", "\t").rows).toEqual([
      ["a", "b,c"],
      ["1", "2"],
    ]);
  });

  it("stops at the row cap and says there was more", () => {
    const text = Array.from({ length: 10 }, (_, i) => `r${i}`).join("\n");
    const out = parseDelimited(text, ",", 3);
    expect(out.rows).toEqual([["r0"], ["r1"], ["r2"]]);
    expect(out.truncated).toBe(true);
  });

  it("does not claim more when the cap lands on the last row", () => {
    const out = parseDelimited("a\nb\nc\n", ",", 3);
    expect(out.rows).toHaveLength(3);
    expect(out.truncated).toBe(false);
  });

  it("does not claim more when only blank lines follow the cap", () => {
    expect(parseDelimited("a\nb\n\n  \n", ",", 2).truncated).toBe(false);
  });

  it("gives nothing for nothing", () => {
    expect(parseDelimited("")).toEqual({ rows: [], truncated: false });
  });
});

describe("delimiterFor", () => {
  it("uses a tab for a .tsv name whatever the type says", () => {
    expect(delimiterFor("data.TSV", "text/csv")).toBe("\t");
  });

  it("falls back to the media type when the name has no say", () => {
    expect(delimiterFor("export", "text/tab-separated-values; charset=utf-8")).toBe("\t");
    expect(delimiterFor("export", "text/csv")).toBe(",");
  });

  it("uses a comma for a .csv", () => {
    expect(delimiterFor("rows.csv", "")).toBe(",");
  });
});
