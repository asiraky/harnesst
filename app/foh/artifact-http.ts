/**
 * HTTP byte-serving for artifacts: single `Range` requests (RFC 9110 §14), so a `<video>` or
 * `<audio>` element can seek and a PDF viewer can fetch the page it is on, plus the conditional
 * `If-Range` that keeps a resumed download from splicing two different files together.
 *
 * Only ONE range is honoured. A multi-range request (`bytes=0-1,5-9`) is answered with the whole
 * body — RFC-legal (a server may ignore Range), and `multipart/byteranges` is a lot of code for a
 * case no media element issues. A malformed header is ignored the same way. Only a well-formed
 * single range that starts past the end is a 416.
 *
 * Pure (no node builtins), so the parser unit-tests and the routes share one implementation.
 */

export type ByteRange =
  | { type: "full" }
  | { type: "partial"; start: number; end: number }
  | { type: "unsatisfiable" };

/**
 * Parse a `Range` header against a body of `size` bytes. `end` is INCLUSIVE, as on the wire.
 *
 *   `bytes=0-99` → 0..99   `bytes=100-` → 100..size-1   `bytes=-100` → the last 100 bytes
 *
 * An end past the body is clamped (the RFC's rule); a start past it is unsatisfiable. An empty
 * body satisfies no range at all, but an empty body is also never worth a 416 — it is served whole.
 */
export function parseByteRange(
  header: string | null | undefined,
  size: number,
): ByteRange {
  if (!header) return { type: "full" };
  const match = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!match) return { type: "full" };
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return { type: "full" };
  if (size <= 0) return { type: "full" };

  if (rawStart === "") {
    // Suffix range: the last N bytes. `-0` asks for nothing, which nothing satisfies.
    const length = Number(rawEnd);
    if (!Number.isSafeInteger(length)) return { type: "full" };
    if (length === 0) return { type: "unsatisfiable" };
    return {
      type: "partial",
      start: Math.max(0, size - length),
      end: size - 1,
    };
  }

  const start = Number(rawStart);
  if (!Number.isSafeInteger(start)) return { type: "full" };
  if (start >= size) return { type: "unsatisfiable" };
  if (rawEnd === "") return { type: "partial", start, end: size - 1 };
  const end = Number(rawEnd);
  if (!Number.isSafeInteger(end)) return { type: "full" };
  // `bytes=9-3` is syntactically invalid, so it is ignored rather than refused.
  if (end < start) return { type: "full" };
  return { type: "partial", start, end: Math.min(end, size - 1) };
}

/**
 * Whether an `If-Range` precondition still holds — i.e. whether the client's partial copy is of
 * THESE bytes. Only a strong entity tag can match (dates are too coarse to prove two bodies equal,
 * so a date validator, or a missing ETag, falls back to the full body).
 */
export function ifRangeMatches(
  ifRange: string | null | undefined,
  etag: string | null | undefined,
): boolean {
  if (!ifRange) return true;
  const validator = ifRange.trim();
  if (!etag || !validator.startsWith('"')) return false;
  return validator === etag;
}

/** A strong entity tag from a content hash, quoted as the header wants it. */
export function artifactEtag(sha256: string | null | undefined): string | null {
  return sha256 ? `"${sha256}"` : null;
}

/** A Buffer/Uint8Array as a `BodyInit` — a VIEW over the same memory, not a copy. */
function bodyOf(
  bytes: Uint8Array,
  start = 0,
  end = bytes.length,
): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    bytes.buffer as ArrayBuffer,
    bytes.byteOffset + start,
    end - start,
  );
}

/**
 * The response for a stored artifact's bytes, honouring `Range`/`If-Range`. `headers` carries the
 * route's own policy (type, disposition, CSP, cache); this adds `Accept-Ranges`, `ETag` and the
 * length/range headers, and picks 200, 206 or 416.
 */
export function artifactBytesResponse(input: {
  request: Request;
  bytes: Uint8Array;
  headers: Headers;
  etag?: string | null;
}): Response {
  const { request, bytes, headers } = input;
  const size = bytes.length;
  headers.set("Accept-Ranges", "bytes");
  if (input.etag) headers.set("ETag", input.etag);

  const range = ifRangeMatches(request.headers.get("if-range"), input.etag)
    ? parseByteRange(request.headers.get("range"), size)
    : ({ type: "full" } as const);

  if (range.type === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${size}`);
    headers.set("Content-Length", "0");
    return new Response(null, { status: 416, headers });
  }
  if (range.type === "partial") {
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
    headers.set("Content-Length", String(range.end - range.start + 1));
    return new Response(bodyOf(bytes, range.start, range.end + 1), {
      status: 206,
      headers,
    });
  }
  headers.set("Content-Length", String(size));
  return new Response(bodyOf(bytes), { status: 200, headers });
}
