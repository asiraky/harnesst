/**
 * Chat attachments, server side: parse + validate the multipart `attachments` files a stream route
 * receives, store their bytes for later display, and build the eve `UserContent` that carries them.
 *
 * Storage is content-addressed under the artifacts root, scoped to one conversation:
 *
 *   <artifactsDir>/uploads/<projectId>/<playgroundSessionId>/<sha256>        bytes
 *   <artifactsDir>/uploads/<projectId>/<playgroundSessionId>/<sha256>.json   sidecar metadata
 *   <artifactsDir>/uploads/<projectId>/<playgroundSessionId>/index.json      per-session index
 *
 * Eve never hands the bytes back (its `message.received` parts carry only name/type/size), so the
 * index is what lets the transcript replay map a received file part to the stored upload. No DB
 * row: a conversation's uploads live and die with its directory.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { data } from "react-router";

import {
  admitAttachments,
  MAX_TOTAL_ATTACHMENT_BYTES,
  isImageMediaType,
  resolveAttachmentMediaType,
} from "~/chat/attachment-rules";
import {
  composeSentText,
  type UploadIndexEntry,
  type UserContentPart,
  type UserMessage,
} from "~/chat/user-content";
import { artifactsDir } from "~/foh/artifact-store.server";

/** The multipart field name the composer sends each file under (repeated). */
export const ATTACHMENTS_FIELD = "attachments";

export interface ParsedAttachment {
  name: string;
  mediaType: string;
  size: number;
  sha256: string;
  bytes: Buffer;
}

/** A 400 whose JSON body is `{ error }` — the shape every stream route already returns. */
export class AttachmentRejectedError extends Error {}

/** Magic numbers for the binary types we accept; a mismatch means the declared type is a lie. */
function sniffMatches(mediaType: string, bytes: Buffer): boolean {
  const starts = (sig: number[], offset = 0) =>
    bytes.length >= offset + sig.length &&
    sig.every((b, i) => bytes[offset + i] === b);
  switch (mediaType) {
    case "image/png":
      return starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return starts([0xff, 0xd8, 0xff]);
    case "image/gif":
      return starts([0x47, 0x49, 0x46, 0x38]);
    case "image/webp":
      return starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8);
    case "application/pdf":
      return starts([0x25, 0x50, 0x44, 0x46, 0x2d]);
    default:
      // Text: a NUL byte in the head means it is binary wearing a text extension.
      return !bytes.subarray(0, 8192).includes(0);
  }
}

/** A display/download-safe file name (no path, no control chars, bounded). */
export function safeUploadName(name: string): string {
  const base = (name.replaceAll("\\", "/").split("/").pop() ?? "").trim();
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, "").slice(0, 200);
  return cleaned || "attachment";
}

/**
 * Validate already-read files against the shared rules and sniff their bytes. Pure over its input
 * (exported for tests); throws `AttachmentRejectedError` naming the offending file.
 */
export function validateAttachments(
  files: ReadonlyArray<{ name: string; type: string; bytes: Buffer }>,
): ParsedAttachment[] {
  const candidates = files.map((file) => ({
    name: safeUploadName(file.name),
    type: file.type,
    size: file.bytes.length,
    bytes: file.bytes,
  }));
  const { accepted, rejected } = admitAttachments([], candidates);
  if (rejected.length > 0) {
    const [first] = rejected;
    const more = rejected.length > 1 ? ` (and ${rejected.length - 1} more)` : "";
    throw new AttachmentRejectedError(
      `Can't attach "${first!.name}": ${first!.reason}${more}.`,
    );
  }
  return accepted.map((file) => {
    const mediaType = resolveAttachmentMediaType(file.name, file.type)!;
    if (!sniffMatches(mediaType, file.bytes)) {
      throw new AttachmentRejectedError(
        `Can't attach "${file.name}": its contents don't match a ${mediaType} file.`,
      );
    }
    return {
      name: file.name,
      mediaType,
      size: file.size,
      sha256: createHash("sha256").update(file.bytes).digest("hex"),
      bytes: file.bytes,
    };
  });
}

/** Attachments cap plus room for the message text and multipart framing. */
export const MAX_CHAT_BODY_BYTES = MAX_TOTAL_ATTACHMENT_BYTES + 2 * 1024 * 1024;

/**
 * Cap a body stream at `limit` bytes: errors the stream as soon as more arrive, so an oversized
 * (or chunked, length-less) upload is cut off without ever being buffered whole.
 */
export function limitBody(
  body: ReadableStream<Uint8Array>,
  limit: number,
): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > limit) controller.error(new BodyTooLargeError());
        else controller.enqueue(chunk);
      },
    }),
  );
}

class BodyTooLargeError extends Error {
  constructor() {
    super("Request body too large");
  }
}

/**
 * A chat stream route's form, read with a hard size cap. The per-file limits in
 * `parseAttachments` only run once the form is parsed, which buffers the whole body; this stops a
 * multi-GB POST before it can exhaust memory. Throws a 413 `{ error }` response.
 */
export async function readChatForm(
  request: Request,
  limit: number = MAX_CHAT_BODY_BYTES,
): Promise<FormData> {
  const tooLarge = () =>
    data(
      { error: `That message is too large (attachments are limited to ${Math.round(MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024)} MB in total).` },
      { status: 413 },
    );
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw tooLarge();
  if (!request.body) return request.formData();
  const capped = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: limitBody(request.body, limit),
    // @ts-expect-error -- Node's fetch Request requires duplex for streaming bodies; not in DOM types.
    duplex: "half",
  });
  try {
    return await capped.formData();
  } catch (error) {
    if (error instanceof BodyTooLargeError || (error as { cause?: unknown })?.cause instanceof BodyTooLargeError)
      throw tooLarge();
    throw error;
  }
}

/**
 * Read + validate every `attachments` entry of a stream route's form. Non-file entries under the
 * field are ignored. Throws a 400 `{ error }` response naming the rejected file.
 */
export async function parseAttachments(
  form: FormData,
): Promise<ParsedAttachment[]> {
  const files = form
    .getAll(ATTACHMENTS_FIELD)
    .filter((entry): entry is File => typeof entry !== "string");
  if (files.length === 0) return [];
  // Cheap pre-check before buffering anything: the rules reject on declared size/count too.
  const precheck = admitAttachments(
    [],
    files.map((f) => ({ name: safeUploadName(f.name), type: f.type, size: f.size })),
  );
  if (precheck.rejected.length > 0) {
    const [first] = precheck.rejected;
    throw data(
      { error: `Can't attach "${first!.name}": ${first!.reason}.` },
      { status: 400 },
    );
  }
  const read = await Promise.all(
    files.map(async (file) => ({
      name: file.name,
      type: file.type,
      bytes: Buffer.from(await file.arrayBuffer()),
    })),
  );
  try {
    return validateAttachments(read);
  } catch (error) {
    if (error instanceof AttachmentRejectedError) {
      throw data({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}

/** Ids we put in paths: harnesst-minted ids only, never anything that can climb out. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function sessionDir(projectId: string, sessionId: string): string | null {
  if (!SAFE_SEGMENT.test(projectId) || !SAFE_SEGMENT.test(sessionId)) return null;
  return path.join(artifactsDir(), "uploads", projectId, sessionId);
}

/** Per-directory write chain so two concurrent turns can't lose each other's index entries. */
const indexLocks = new Map<string, Promise<unknown>>();

async function writeAtomic(file: string, contents: string | Buffer) {
  // Unique per call: the same file attached twice in one turn writes the same path concurrently.
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, contents);
  await rename(tmp, file);
}

export async function loadUploadIndex(
  projectId: string,
  sessionId: string,
): Promise<UploadIndexEntry[]> {
  const dir = sessionDir(projectId, sessionId);
  if (!dir) return [];
  try {
    const parsed = JSON.parse(
      await readFile(path.join(dir, "index.json"), "utf8"),
    ) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (e): e is UploadIndexEntry =>
            typeof e === "object" &&
            e !== null &&
            typeof (e as UploadIndexEntry).sha256 === "string" &&
            SHA256.test((e as UploadIndexEntry).sha256) &&
            typeof (e as UploadIndexEntry).name === "string" &&
            typeof (e as UploadIndexEntry).mediaType === "string",
        )
      : [];
  } catch {
    return [];
  }
}

/** Store the bytes + sidecar + index entry for each attachment of one turn. */
export async function storeAttachments(input: {
  projectId: string;
  sessionId: string;
  attachments: ReadonlyArray<ParsedAttachment>;
}): Promise<UploadIndexEntry[]> {
  if (input.attachments.length === 0) return [];
  const dir = sessionDir(input.projectId, input.sessionId);
  if (!dir) throw new Error("Invalid upload scope.");
  await mkdir(dir, { recursive: true });
  const createdAt = new Date().toISOString();
  const entries: UploadIndexEntry[] = input.attachments.map((a) => ({
    sha256: a.sha256,
    name: a.name,
    mediaType: a.mediaType,
    size: a.size,
    createdAt,
  }));
  await Promise.all(
    input.attachments.map(async (a, i) => {
      await writeAtomic(path.join(dir, a.sha256), a.bytes);
      await writeAtomic(
        path.join(dir, `${a.sha256}.json`),
        JSON.stringify(entries[i]),
      );
    }),
  );
  const previous = indexLocks.get(dir) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      const existing = await loadUploadIndex(input.projectId, input.sessionId);
      await writeAtomic(
        path.join(dir, "index.json"),
        JSON.stringify([...existing, ...entries]),
      );
    });
  indexLocks.set(dir, next);
  try {
    await next;
  } finally {
    if (indexLocks.get(dir) === next) indexLocks.delete(dir);
  }
  return entries;
}

/** One stored upload's bytes + metadata, or null (bad ids, missing file, missing sidecar). */
export async function readUpload(input: {
  projectId: string;
  sessionId: string;
  sha256: string;
}): Promise<{ bytes: Buffer; meta: UploadIndexEntry } | null> {
  const dir = sessionDir(input.projectId, input.sessionId);
  if (!dir || !SHA256.test(input.sha256)) return null;
  try {
    const [bytes, metaRaw] = await Promise.all([
      readFile(path.join(dir, input.sha256)),
      readFile(path.join(dir, `${input.sha256}.json`), "utf8"),
    ]);
    const meta = JSON.parse(metaRaw) as UploadIndexEntry;
    if (typeof meta.mediaType !== "string" || typeof meta.name !== "string") {
      return null;
    }
    return { bytes, meta };
  } catch {
    return null;
  }
}

/**
 * The message eve receives: a plain string when there are no files (byte-identical to before),
 * else a text part carrying exactly the text that would have been sent, then one file part per
 * attachment.
 */
export function buildUserMessage(input: {
  prefix: string | null | undefined;
  message: string;
  attachments: ReadonlyArray<Pick<ParsedAttachment, "name" | "mediaType" | "bytes">>;
}): UserMessage {
  const hasFiles = input.attachments.length > 0;
  const text = composeSentText(input.prefix, input.message, hasFiles);
  if (!hasFiles) return text;
  const parts: UserContentPart[] = [];
  // Eve's channel rejects an empty text part — a files-only message has none.
  if (text) parts.push({ type: "text", text });
  for (const a of input.attachments) {
    parts.push({
      type: "file",
      data: a.bytes.toString("base64"),
      mediaType: a.mediaType,
      filename: a.name,
    });
  }
  return parts;
}

/** Whether an upload may render inline (raster images only; SVG is never accepted at all). */
export function uploadRendersInline(mediaType: string): boolean {
  return isImageMediaType(mediaType);
}

/**
 * The line observability/title inference see for a turn: the typed text, else the file names —
 * so a files-only message still records and titles as something.
 */
export function describeUserTurn(
  message: string,
  attachments: ReadonlyArray<Pick<ParsedAttachment, "name">>,
): string {
  if (attachments.length === 0) return message;
  const names = attachments.map((a) => a.name).join(", ");
  return message ? `${message}\n[attached: ${names}]` : `[attached: ${names}]`;
}

/** What a new conversation is titled from: the typed text, else the attached file names. */
export function attachmentTitleSource(
  message: string,
  attachments: ReadonlyArray<Pick<ParsedAttachment, "name">>,
): string {
  return message || attachments.map((a) => a.name).join(", ");
}

/**
 * A Content-Disposition header for a stored upload. Header values must be Latin-1, so the plain
 * `filename` is an ASCII fallback and the real (possibly non-ASCII) name rides in `filename*`.
 */
export function uploadContentDisposition(inline: boolean, name: string): string {
  const safe = safeUploadName(name);
  const ascii = safe.replace(/[^\x20-\x7e]/g, "_").replace(/[\\"]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}
