/**
 * The multi-part user message harnesst sends to eve when a turn carries attachments, and the
 * pure helpers that read it back. Client+server safe (no IO).
 *
 * Wire shape is eve's `UserContent` subset its HTTP channel accepts: `text` parts and `file` parts
 * whose `data` is base64. Plain base64 rather than a `data:` URL on purpose — eve echoes a data URL
 * verbatim into `message.received` `parts[].url`, which would put every attachment's bytes into the
 * durable event stream harnesst replays on each transcript load. Eve decodes both forms identically.
 */
import type { ChatAttachment } from "~/chat/types";

export type UserTextPart = { type: "text"; text: string };
export type UserFilePart = {
  type: "file";
  /** Base64 of the bytes (no `data:` prefix). */
  data: string;
  mediaType: string;
  filename?: string;
};
export type UserContentPart = UserTextPart | UserFilePart;
/** What eve's session routes accept as `message`. */
export type UserMessage = string | UserContentPart[];

/**
 * Eve's `summarizeUserContent` (protocol/message.js), reproduced exactly: it is what eve echoes as
 * `message.received` `data.message`, and `streamTurn` identifies its own turn by comparing against
 * it. Text parts verbatim, a file part as `[file: <filename ?? mediaType> (<mediaType>)]`, an image
 * part as `[image: <mediaType>]`, joined by newlines.
 */
export function summarizeUserContent(
  message: string | ReadonlyArray<Record<string, unknown>>,
): string {
  if (typeof message === "string") return message;
  const lines: string[] = [];
  for (const part of message) {
    if (part.type === "text") lines.push(String(part.text));
    else if (part.type === "file") {
      const mediaType = String(part.mediaType);
      const label =
        typeof part.filename === "string" ? part.filename : mediaType;
      lines.push(`[file: ${label} (${mediaType})]`);
    } else if (part.type === "image") {
      lines.push(
        `[image: ${typeof part.mediaType === "string" ? part.mediaType : "image"}]`,
      );
    }
  }
  return lines.join("\n");
}

/** Just the text a user message carries (text parts joined the way eve joins them). */
export function userMessageText(message: UserMessage): string {
  if (typeof message === "string") return message;
  return message
    .filter((part): part is UserTextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export function userMessageHasFiles(message: UserMessage): boolean {
  return typeof message !== "string" && message.some((p) => p.type === "file");
}

/**
 * The text eve receives for a turn: the system prefix (model directive, notes) and the typed
 * message separated by a blank line. When files ride along and a prefix exists, the separator is
 * kept even for an empty message — the agent-side directive parser requires `\n\n` after the
 * signature line.
 */
export function composeSentText(
  prefix: string | null | undefined,
  message: string,
  hasFiles: boolean,
): string {
  if (!prefix) return message;
  if (!message && !hasFiles) return prefix;
  return `${prefix}\n\n${message}`;
}

/**
 * The body a model directive must be signed over for a turn with `fileCount` file parts. The
 * deployed agent's resolver (see `HARNESST_MODEL_HELPER`) rebuilds the message by joining every
 * content part's text with `\n`, file parts contributing an empty string — so each file appends one
 * `\n` to what it verifies.
 */
export function directiveSignedBody(message: string, fileCount: number): string {
  return message + "\n".repeat(fileCount);
}

/** One stored upload, as recorded in the per-session index. */
export interface UploadIndexEntry {
  sha256: string;
  name: string;
  mediaType: string;
  size: number;
  createdAt: string;
}

/** A file part as eve projects it onto `message.received` `data.parts` (bytes never included). */
export interface ReceivedFilePart {
  filename?: string;
  mediaType?: string;
  size?: number;
}

/** Eve's staging filename sanitiser collapses unsafe runs; compare names with that tolerance. */
function looseName(name: string): string {
  const base = name.replaceAll("\\", "/").split("/").pop() ?? name;
  return base.replace(/[^\w.-]+/g, "_").toLowerCase();
}

/**
 * Map a turn's received file parts back to harnesst's stored uploads. Pure: the caller supplies
 * the session's upload index and the URL minting. Matches by name + media type (+ size when eve
 * knows it), preferring the newest upload not after the message time, and never assigns one
 * upload to two parts of the same message. Unresolved parts still produce a chip (url null).
 */
export function resolveReceivedAttachments(input: {
  parts: ReadonlyArray<ReceivedFilePart>;
  index: ReadonlyArray<UploadIndexEntry>;
  urlFor: (sha256: string) => string;
  /** When the message was received (ms); uploads stored after it cannot be its files. */
  receivedAt?: number | null;
  /** Stable id prefix for unresolved parts (turn-scoped). */
  idPrefix: string;
}): ChatAttachment[] {
  const used = new Set<string>();
  const candidates = [...input.index]
    .filter((entry) => {
      if (input.receivedAt == null || Number.isNaN(input.receivedAt)) return true;
      const created = Date.parse(entry.createdAt);
      // Generous skew: the upload is written moments before the POST reaches eve.
      return Number.isNaN(created) || created <= input.receivedAt + 60_000;
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return input.parts.map((part, i) => {
    const name = part.filename ?? part.mediaType ?? "attachment";
    const mediaType = part.mediaType ?? "application/octet-stream";
    const matches = (entry: UploadIndexEntry, loose: boolean) =>
      !used.has(entry.sha256) &&
      entry.mediaType === mediaType &&
      (part.size == null || entry.size === part.size) &&
      (loose
        ? looseName(entry.name) === looseName(name)
        : entry.name === name);
    const hit =
      candidates.find((entry) => matches(entry, false)) ??
      candidates.find((entry) => matches(entry, true));
    if (hit) {
      used.add(hit.sha256);
      return {
        id: hit.sha256,
        name: hit.name,
        mediaType: hit.mediaType,
        size: hit.size,
        url: input.urlFor(hit.sha256),
      };
    }
    return {
      id: `${input.idPrefix}:${i}`,
      name,
      mediaType,
      size: part.size ?? null,
      url: null,
    };
  });
}

/** The same-origin app path serving one stored upload. */
export function chatUploadUrl(
  projectId: string,
  sessionId: string,
  sha256: string,
): string {
  return `/api/chat/uploads/${encodeURIComponent(projectId)}/${encodeURIComponent(sessionId)}/${sha256}`;
}
