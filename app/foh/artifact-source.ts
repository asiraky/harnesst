/**
 * Contract and pure helpers for the artifact source view (`api.foh.artifact-source.ts`). Client+
 * server safe; the URL builder is `artifactSourceUrl` in `artifact-media.ts`.
 */

/** Most bytes of one file the source endpoint returns; longer files are cut (see the route). */
export const ARTIFACT_SOURCE_MAX_BYTES = 1024 * 1024;

/** Response header set to "1" when the source text was cut at `ARTIFACT_SOURCE_MAX_BYTES`. */
export const ARTIFACT_SOURCE_TRUNCATED_HEADER = "X-Artifact-Truncated";
/** Response header carrying the file's full byte size, cut or not. */
export const ARTIFACT_SOURCE_SIZE_HEADER = "X-Artifact-Byte-Size";

/** The JSON a source request without `?path=` answers with. */
export interface ArtifactSourceListing {
  versionId: string;
  /** The file the viewer opens at: the bundle's entry document, or the single file's own name. */
  entry: string;
  files: { path: string; contentType: string; byteSize: number }[];
}

/**
 * The longest prefix of `bytes` that is at most `max` bytes AND ends on a UTF-8 character
 * boundary, so a cut source file never ends in half a glyph (which a decoder would render as
 * U+FFFD). Bytes that are not UTF-8 at all are cut at `max` — there is no boundary to respect.
 */
export function truncateUtf8(
  bytes: Uint8Array,
  max: number,
): { bytes: Uint8Array; truncated: boolean } {
  if (bytes.length <= max) return { bytes, truncated: false };
  let end = Math.max(0, max);
  // Walk back over continuation bytes (10xxxxxx) to the lead byte of the character that straddles
  // the cut; drop it too unless the whole sequence fits.
  let back = 0;
  while (
    back < 3 &&
    end - back > 0 &&
    (bytes[end - back - 1] & 0xc0) === 0x80
  ) {
    back++;
  }
  const leadIndex = end - back - 1;
  if (leadIndex >= 0) {
    const lead = bytes[leadIndex];
    const length = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    // A lead byte whose sequence runs past the cut: drop the partial character.
    if (length > 1 && length > back + 1) end = leadIndex;
  }
  return { bytes: bytes.subarray(0, end), truncated: true };
}
