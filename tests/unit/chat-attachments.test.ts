import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { attachmentRefusal } from "~/agent/talk.server";
import {
  AttachmentRejectedError,
  buildUserMessage,
  loadUploadIndex,
  parseAttachments,
  readUpload,
  storeAttachments,
  uploadContentDisposition,
  validateAttachments,
} from "~/chat/attachments.server";
import {
  composeSentText,
  directiveSignedBody,
  resolveReceivedAttachments,
  summarizeUserContent,
  type UploadIndexEntry,
} from "~/chat/user-content";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const text = (s: string) => Buffer.from(s, "utf8");

describe("summarizeUserContent (eve's message.received summary)", () => {
  it("returns a string message unchanged", () => {
    expect(summarizeUserContent("hello")).toBe("hello");
  });

  it("renders text parts verbatim and file parts as labelled lines, joined by newlines", () => {
    expect(
      summarizeUserContent([
        { type: "text", text: "look at these" },
        { type: "file", data: "AAA", mediaType: "image/png", filename: "a.png" },
        { type: "file", data: "AAA", mediaType: "application/pdf" },
        { type: "image", image: "AAA", mediaType: "image/gif" },
        { type: "image", image: "AAA" },
      ]),
    ).toBe(
      [
        "look at these",
        "[file: a.png (image/png)]",
        "[file: application/pdf (application/pdf)]",
        "[image: image/gif]",
        "[image: image]",
      ].join("\n"),
    );
  });

  it("matches what eve would echo for a message built by buildUserMessage", () => {
    const message = buildUserMessage({
      prefix: "PREFIX",
      message: "hi",
      attachments: [{ name: "a.png", mediaType: "image/png", bytes: PNG }],
    });
    expect(summarizeUserContent(message as never)).toBe(
      "PREFIX\n\nhi\n[file: a.png (image/png)]",
    );
  });
});

describe("buildUserMessage", () => {
  it("stays a plain string (prefix + blank line + message) when nothing is attached", () => {
    expect(
      buildUserMessage({ prefix: "P", message: "hi", attachments: [] }),
    ).toBe("P\n\nhi");
    expect(
      buildUserMessage({ prefix: null, message: "hi", attachments: [] }),
    ).toBe("hi");
  });

  it("puts the text part first, then one base64 file part per attachment", () => {
    const message = buildUserMessage({
      prefix: null,
      message: "hi",
      attachments: [
        { name: "a.png", mediaType: "image/png", bytes: PNG },
        { name: "b.txt", mediaType: "text/plain", bytes: text("abc") },
      ],
    });
    expect(message).toEqual([
      { type: "text", text: "hi" },
      {
        type: "file",
        data: PNG.toString("base64"),
        mediaType: "image/png",
        filename: "a.png",
      },
      {
        type: "file",
        data: text("abc").toString("base64"),
        mediaType: "text/plain",
        filename: "b.txt",
      },
    ]);
  });

  it("omits the text part for a files-only message with no prefix (eve rejects empty text)", () => {
    const message = buildUserMessage({
      prefix: null,
      message: "",
      attachments: [{ name: "a.png", mediaType: "image/png", bytes: PNG }],
    });
    expect(Array.isArray(message) && message.map((p) => p.type)).toEqual([
      "file",
    ]);
  });

  it("keeps the prefix's blank-line separator for a files-only message", () => {
    expect(composeSentText("DIRECTIVE", "", true)).toBe("DIRECTIVE\n\n");
    expect(composeSentText("DIRECTIVE", "", false)).toBe("DIRECTIVE");
  });
});

describe("directiveSignedBody", () => {
  it("equals what the agent-side resolver rebuilds after the directive", () => {
    // The resolver joins every part's text with "\n", file parts contributing "".
    const directive = "D1\nD2";
    const files = 3;
    const sent = composeSentText(directive, "hello", true);
    const rebuilt = [sent, ...Array(files).fill("")].join("\n");
    const body = rebuilt.slice(`${directive}\n\n`.length);
    expect(directiveSignedBody("hello", files)).toBe(body);
    expect(directiveSignedBody("hello", 0)).toBe("hello");
  });
});

describe("validateAttachments", () => {
  it("accepts supported files, normalising text types and hashing the bytes", () => {
    const [png, notes] = validateAttachments([
      { name: "a.png", type: "image/png", bytes: PNG },
      { name: "notes.md", type: "", bytes: text("# hi") },
    ]);
    expect(png).toMatchObject({ name: "a.png", mediaType: "image/png", size: PNG.length });
    expect(png!.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(notes!.mediaType).toBe("text/plain");
  });

  it("rejects more than 10 files, naming the first file over the limit", () => {
    const files = Array.from({ length: 11 }, (_, i) => ({
      name: `f${i}.txt`,
      type: "text/plain",
      bytes: text(`file ${i}`),
    }));
    expect(() => validateAttachments(files)).toThrow(/"f10\.txt"/);
    expect(() => validateAttachments(files.slice(0, 10))).not.toThrow();
  });

  it("rejects a single file over 10 MB", () => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0x61);
    expect(() =>
      validateAttachments([{ name: "big.txt", type: "text/plain", bytes: big }]),
    ).toThrow(/"big\.txt"/);
  });

  it("rejects the file that pushes the batch over 25 MB in total", () => {
    const nine = Buffer.alloc(9 * 1024 * 1024, 0x61);
    const files = ["a.txt", "b.txt", "c.txt"].map((name) => ({
      name,
      type: "text/plain",
      bytes: nine,
    }));
    expect(() => validateAttachments(files)).toThrow(/"c\.txt"/);
    expect(() => validateAttachments(files.slice(0, 2))).not.toThrow();
  });

  it("rejects unsupported types (including SVG) and empty files", () => {
    expect(() =>
      validateAttachments([
        { name: "x.svg", type: "image/svg+xml", bytes: text("<svg/>") },
      ]),
    ).toThrow(AttachmentRejectedError);
    expect(() =>
      validateAttachments([{ name: "e.txt", type: "text/plain", bytes: Buffer.alloc(0) }]),
    ).toThrow(/"e\.txt"/);
  });

  it("rejects bytes that don't match the declared type", () => {
    expect(() =>
      validateAttachments([{ name: "fake.png", type: "image/png", bytes: text("hello") }]),
    ).toThrow(/"fake\.png"/);
    expect(() =>
      validateAttachments([
        { name: "bin.txt", type: "text/plain", bytes: Buffer.from([0x61, 0, 0x62]) },
      ]),
    ).toThrow(/"bin\.txt"/);
  });

  it("strips path components from the reported file name", () => {
    const [file] = validateAttachments([
      { name: "../../etc/notes.txt", type: "text/plain", bytes: text("x") },
    ]);
    expect(file!.name).toBe("notes.txt");
  });
});

describe("parseAttachments", () => {
  it("returns [] when the form carries no files", async () => {
    const form = new FormData();
    form.set("message", "hi");
    expect(await parseAttachments(form)).toEqual([]);
  });

  it("reads every repeated `attachments` file", async () => {
    const form = new FormData();
    form.append("attachments", new File([PNG], "a.png", { type: "image/png" }));
    form.append("attachments", new File(["hello"], "b.txt", { type: "text/plain" }));
    const parsed = await parseAttachments(form);
    expect(parsed.map((a) => [a.name, a.mediaType])).toEqual([
      ["a.png", "image/png"],
      ["b.txt", "text/plain"],
    ]);
  });

  it("throws a 400 { error } naming the rejected file", async () => {
    const form = new FormData();
    form.append("attachments", new File(["<svg/>"], "x.svg", { type: "image/svg+xml" }));
    const thrown = await parseAttachments(form).catch((e: unknown) => e);
    const response = thrown as { init: { status: number }; data: { error: string } };
    expect(response.init.status).toBe(400);
    expect(response.data.error).toContain('"x.svg"');
  });
});

describe("upload storage", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "harnesst-uploads-"));
    vi.stubEnv("HARNESST_ARTIFACTS_DIR", dir);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips bytes and metadata, and indexes every upload across turns", async () => {
    const [png] = validateAttachments([{ name: "a.png", type: "image/png", bytes: PNG }]);
    const [txt] = validateAttachments([{ name: "b.txt", type: "text/plain", bytes: text("b") }]);
    await Promise.all([
      storeAttachments({ projectId: "proj", sessionId: "sess", attachments: [png!] }),
      storeAttachments({ projectId: "proj", sessionId: "sess", attachments: [txt!] }),
    ]);
    const index = await loadUploadIndex("proj", "sess");
    expect(index.map((e) => e.name).sort()).toEqual(["a.png", "b.txt"]);
    const read = await readUpload({ projectId: "proj", sessionId: "sess", sha256: png!.sha256 });
    expect(read?.bytes.equals(PNG)).toBe(true);
    expect(read?.meta.mediaType).toBe("image/png");
  });

  it("refuses ids that could escape the uploads root", async () => {
    const [png] = validateAttachments([{ name: "a.png", type: "image/png", bytes: PNG }]);
    await expect(
      storeAttachments({ projectId: "..", sessionId: "sess", attachments: [png!] }),
    ).rejects.toThrow();
    expect(await readUpload({ projectId: "proj", sessionId: "../x", sha256: png!.sha256 })).toBeNull();
    expect(await readUpload({ projectId: "proj", sessionId: "sess", sha256: "../index.json" })).toBeNull();
    expect(await loadUploadIndex("proj", "..")).toEqual([]);
  });

  it("is scoped per conversation", async () => {
    const [png] = validateAttachments([{ name: "a.png", type: "image/png", bytes: PNG }]);
    await storeAttachments({ projectId: "proj", sessionId: "one", attachments: [png!] });
    expect(await readUpload({ projectId: "proj", sessionId: "two", sha256: png!.sha256 })).toBeNull();
  });
});

describe("uploadContentDisposition", () => {
  it("produces a Latin-1-safe header for non-ASCII names", () => {
    const header = uploadContentDisposition(false, 'résumé "final".pdf');
    expect(() => new Headers({ "content-disposition": header })).not.toThrow();
    expect(header.startsWith("attachment;")).toBe(true);
    expect(decodeURIComponent(header.split("filename*=UTF-8''")[1]!)).toBe(
      "résumé final.pdf",
    );
  });
});

describe("resolveReceivedAttachments", () => {
  const urlFor = (sha: string) => `/u/${sha}`;
  const entry = (over: Partial<UploadIndexEntry>): UploadIndexEntry => ({
    sha256: "a".repeat(64),
    name: "a.png",
    mediaType: "image/png",
    size: 10,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  });

  it("maps each received part to its stored upload, never reusing one upload twice", () => {
    const index = [
      entry({ sha256: "1".repeat(64), name: "same.png" }),
      entry({ sha256: "2".repeat(64), name: "same.png" }),
    ];
    const out = resolveReceivedAttachments({
      parts: [
        { filename: "same.png", mediaType: "image/png" },
        { filename: "same.png", mediaType: "image/png" },
      ],
      index,
      urlFor,
      idPrefix: "t",
    });
    expect(new Set(out.map((a) => a.id)).size).toBe(2);
    expect(out.every((a) => a.url?.startsWith("/u/"))).toBe(true);
  });

  it("prefers the newest upload that isn't newer than the message", () => {
    const index = [
      entry({ sha256: "1".repeat(64), createdAt: "2026-01-01T00:00:00.000Z" }),
      entry({ sha256: "2".repeat(64), createdAt: "2026-01-02T00:00:00.000Z" }),
      entry({ sha256: "3".repeat(64), createdAt: "2026-01-09T00:00:00.000Z" }),
    ];
    const [hit] = resolveReceivedAttachments({
      parts: [{ filename: "a.png", mediaType: "image/png" }],
      index,
      urlFor,
      receivedAt: Date.parse("2026-01-02T00:00:05.000Z"),
      idPrefix: "t",
    });
    expect(hit!.id).toBe("2".repeat(64));
  });

  it("never gives an earlier message a same-named resend from seconds later", () => {
    const index = [
      entry({ sha256: "1".repeat(64), createdAt: "2026-01-01T00:00:00.000Z" }),
      entry({ sha256: "2".repeat(64), createdAt: "2026-01-01T00:00:30.000Z" }),
    ];
    const resolve = (at: string) =>
      resolveReceivedAttachments({
        parts: [{ filename: "a.png", mediaType: "image/png", size: 10 }],
        index,
        urlFor,
        receivedAt: Date.parse(at),
        idPrefix: "t",
      })[0]!.id;
    expect(resolve("2026-01-01T00:00:01.000Z")).toBe("1".repeat(64));
    expect(resolve("2026-01-01T00:00:31.000Z")).toBe("2".repeat(64));
  });

  it("falls back to the nearest upload stored just after the message (clock skew)", () => {
    const index = [
      entry({ sha256: "1".repeat(64), createdAt: "2026-01-01T00:00:02.000Z" }),
      entry({ sha256: "2".repeat(64), createdAt: "2026-01-01T00:00:40.000Z" }),
    ];
    const [hit] = resolveReceivedAttachments({
      parts: [{ filename: "a.png", mediaType: "image/png" }],
      index,
      urlFor,
      receivedAt: Date.parse("2026-01-01T00:00:00.000Z"),
      idPrefix: "t",
    });
    expect(hit!.id).toBe("1".repeat(64));
  });

  it("tolerates eve's sanitised staging names and respects a known size", () => {
    const index = [entry({ name: "My Photo (1).png", size: 10 })];
    const [loose] = resolveReceivedAttachments({
      parts: [{ filename: "my_photo_1_.png", mediaType: "image/png" }],
      index,
      urlFor,
      idPrefix: "t",
    });
    expect(loose!.url).not.toBeNull();
    const [wrongSize] = resolveReceivedAttachments({
      parts: [{ filename: "My Photo (1).png", mediaType: "image/png", size: 99 }],
      index,
      urlFor,
      idPrefix: "t",
    });
    expect(wrongSize!.url).toBeNull();
  });

  it("still yields a chip (no url) for a part with no stored upload", () => {
    const [chip] = resolveReceivedAttachments({
      parts: [{ filename: "gone.pdf", mediaType: "application/pdf", size: 5 }],
      index: [],
      urlFor,
      idPrefix: "turn",
    });
    expect(chip).toEqual({
      id: "turn:0",
      name: "gone.pdf",
      mediaType: "application/pdf",
      size: 5,
      url: null,
    });
  });
});

describe("attachmentRefusal", () => {
  const predates = /predates attachments/;

  it("treats an old channel's missing-message 400 as a pre-attachments build", () => {
    expect(attachmentRefusal(400, "Missing message.", true)).toMatch(predates);
  });

  it("treats a private-channel 5xx as a pre-attachments build", () => {
    expect(attachmentRefusal(500, null, true)).toMatch(predates);
    expect(attachmentRefusal(500, null, false)).not.toMatch(predates);
  });

  it("passes eve's upload-policy refusals through", () => {
    expect(attachmentRefusal(413, "too big", false)).toContain("too big");
    expect(attachmentRefusal(415, "nope", true)).not.toMatch(predates);
  });
});
