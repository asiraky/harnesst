/**
 * Byte ranges for artifact responses: what lets a video seek and a PDF viewer fetch one page. A
 * wrong answer here is either a broken player (bad 206 maths) or a resumed download spliced from
 * two different versions (a failed If-Range check).
 */
import { describe, expect, it } from "vitest";

import {
  artifactBytesResponse,
  artifactEtag,
  ifRangeMatches,
  parseByteRange,
} from "~/foh/artifact-http";
import { truncateUtf8 } from "~/foh/artifact-source";

describe("parseByteRange", () => {
  it("reads the three single-range forms, end inclusive", () => {
    expect(parseByteRange("bytes=0-99", 1000)).toEqual({
      type: "partial",
      start: 0,
      end: 99,
    });
    expect(parseByteRange("bytes=900-", 1000)).toEqual({
      type: "partial",
      start: 900,
      end: 999,
    });
    expect(parseByteRange("bytes=-100", 1000)).toEqual({
      type: "partial",
      start: 900,
      end: 999,
    });
  });

  it("clamps an end or suffix past the body", () => {
    expect(parseByteRange("bytes=10-5000", 100)).toEqual({
      type: "partial",
      start: 10,
      end: 99,
    });
    expect(parseByteRange("bytes=-5000", 100)).toEqual({
      type: "partial",
      start: 0,
      end: 99,
    });
  });

  it("is unsatisfiable only for a well-formed range that selects nothing", () => {
    expect(parseByteRange("bytes=100-", 100)).toEqual({
      type: "unsatisfiable",
    });
    expect(parseByteRange("bytes=-0", 100)).toEqual({ type: "unsatisfiable" });
  });

  it("serves the whole body for anything it does not honour", () => {
    for (const header of [
      null,
      "",
      "bytes=",
      "bytes=-",
      "items=0-1",
      "bytes=0-1,5-9",
      "bytes=9-3",
      "bytes=abc",
    ]) {
      expect(parseByteRange(header, 100)).toEqual({ type: "full" });
    }
    expect(parseByteRange("bytes=0-0", 0)).toEqual({ type: "full" });
  });
});

describe("ifRangeMatches", () => {
  const etag = artifactEtag("abc");

  it("holds with no precondition, or for the same strong tag", () => {
    expect(ifRangeMatches(null, etag)).toBe(true);
    expect(ifRangeMatches('"abc"', etag)).toBe(true);
  });

  it("fails for another tag, a weak tag, a date, or no tag of ours", () => {
    expect(ifRangeMatches('"def"', etag)).toBe(false);
    expect(ifRangeMatches('W/"abc"', etag)).toBe(false);
    expect(ifRangeMatches("Wed, 21 Oct 2015 07:28:00 GMT", etag)).toBe(false);
    expect(ifRangeMatches('"abc"', null)).toBe(false);
  });
});

describe("artifactBytesResponse", () => {
  const bytes = new TextEncoder().encode("0123456789");
  const respond = (headers: Record<string, string>, etag = '"v1"') =>
    artifactBytesResponse({
      request: new Request("http://x/a", { headers }),
      bytes,
      headers: new Headers({ "Content-Type": "text/plain" }),
      etag,
    });

  it("answers a range with a 206 of exactly those bytes", async () => {
    const res = respond({ range: "bytes=2-4" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 2-4/10");
    expect(await res.text()).toBe("234");
  });

  it("answers no range, or a stale If-Range, with the whole body", async () => {
    const plain = respond({});
    expect(plain.status).toBe(200);
    expect(plain.headers.get("accept-ranges")).toBe("bytes");
    expect(await plain.text()).toBe("0123456789");

    const stale = respond({ range: "bytes=2-4", "if-range": '"v0"' });
    expect(stale.status).toBe(200);
    expect(await stale.text()).toBe("0123456789");
  });

  it("answers a range past the end with a 416 naming the size", async () => {
    const res = respond({ range: "bytes=10-" });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */10");
    expect(await res.text()).toBe("");
  });

  it("serves a view of a larger buffer without leaking its neighbours", async () => {
    const backing = new TextEncoder().encode("XXabcdeYY");
    const res = artifactBytesResponse({
      request: new Request("http://x/a", { headers: { range: "bytes=1-" } }),
      bytes: backing.subarray(2, 7),
      headers: new Headers(),
    });
    expect(await res.text()).toBe("bcde");
  });
});

describe("truncateUtf8", () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it("leaves a body within the cap alone", () => {
    expect(truncateUtf8(enc("héllo"), 100)).toMatchObject({
      truncated: false,
    });
  });

  it("never cuts a character in half", () => {
    // "aé€" = 61 | c3 a9 | e2 82 ac
    const bytes = enc("aé€");
    const decode = (n: number) =>
      new TextDecoder().decode(truncateUtf8(bytes, n).bytes);
    expect(decode(2)).toBe("a");
    expect(decode(3)).toBe("aé");
    expect(decode(5)).toBe("aé");
    expect(truncateUtf8(bytes, 5).truncated).toBe(true);
  });
});
