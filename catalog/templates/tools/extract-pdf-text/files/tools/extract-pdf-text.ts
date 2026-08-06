/**
 * Extract embedded text from a PDF staged under /workspace/home, or from compatibility base64,
 * without sending the document over the network.
 *
 * This deliberately does not perform OCR. Scanned/image-only documents return a distinct,
 * actionable error so an agent cannot mistake missing text for a verified empty document.
 */
import { defineTool } from "eve/tools";
import path from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { z } from "zod";

const MAX_PDF_BYTES = 4 * 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_PDF_BYTES / 3) * 4;
const MAX_PDF_PAGES = 200;
const DEFAULT_TEXT_CHARS = 50_000;
const MAX_TEXT_CHARS = 100_000;
const HOME_ROOT = "/workspace/home";

type DecodeResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; code: "invalid_base64" | "pdf_too_large"; error: string };

function decodeBase64(value: string): DecodeResult {
  if (value.length > MAX_BASE64_CHARS) {
    return {
      ok: false,
      code: "pdf_too_large",
      error: `contentBase64 is too long to represent a PDF within the ${MAX_PDF_BYTES}-byte (4 MiB) limit.`,
    };
  }
  // Buffer.from(value, "base64") is intentionally lenient. Validate and round-trip so typos,
  // whitespace, base64url, and data-URL prefixes cannot silently turn into different bytes.
  if (
    value.length === 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(value) ||
    value.length % 4 === 1
  ) {
    return {
      ok: false,
      code: "invalid_base64",
      error:
        "contentBase64 is not valid base64 data. Pass the raw base64 string without a data-URL prefix or whitespace.",
    };
  }

  const unpadded = value.replace(/=+$/u, "");
  const padded = unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, "=");
  const bytes = Buffer.from(padded, "base64");
  if (bytes.toString("base64").replace(/=+$/u, "") !== unpadded) {
    return {
      ok: false,
      code: "invalid_base64",
      error:
        "contentBase64 is not valid base64 data. Pass the raw base64 string without a data-URL prefix or whitespace.",
    };
  }
  if (bytes.byteLength > MAX_PDF_BYTES) {
    return {
      ok: false,
      code: "pdf_too_large",
      error: `The decoded PDF is ${bytes.byteLength} bytes; the limit is ${MAX_PDF_BYTES} bytes (4 MiB).`,
    };
  }

  return { ok: true, bytes: new Uint8Array(bytes) };
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/gu, " ").trim().slice(0, 500);
}

type ReadPathResult =
  | { ok: true; bytes: Uint8Array }
  | {
      ok: false;
      code: "invalid_path" | "file_not_found" | "pdf_too_large";
      error: string;
    };

function resolveHomePath(value: string): string | null {
  if (!value.trim() || value.includes("\0")) return null;
  const absolute = value.startsWith("/")
    ? path.resolve(value)
    : path.resolve(HOME_ROOT, value);
  if (
    absolute !== HOME_ROOT &&
    !absolute.startsWith(`${HOME_ROOT}${path.sep}`)
  ) {
    return null;
  }
  return absolute;
}

async function readHomeFile(
  value: string,
  read: (path: string) => Promise<ReadableStream<Uint8Array> | null>,
): Promise<ReadPathResult> {
  const absolute = resolveHomePath(value);
  if (!absolute) {
    return {
      ok: false,
      code: "invalid_path",
      error: "path must name a PDF file inside /workspace/home.",
    };
  }
  try {
    const stream = await read(absolute);
    if (!stream) {
      return {
        ok: false,
        code: "file_not_found",
        error: "The PDF path does not exist.",
      };
    }
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      total += chunk.byteLength;
      if (total > MAX_PDF_BYTES) {
        await reader.cancel().catch(() => undefined);
        return {
          ok: false,
          code: "pdf_too_large",
          error: `The PDF is over the ${MAX_PDF_BYTES}-byte (4 MiB) limit.`,
        };
      }
      chunks.push(chunk);
    }
    return { ok: true, bytes: new Uint8Array(Buffer.concat(chunks)) };
  } catch (error) {
    return {
      ok: false,
      code: "file_not_found",
      error: `The PDF path could not be read: ${errorMessage(error)}`,
    };
  }
}

export default defineTool({
  description:
    "Extract embedded text from a PDF locally. Prefer a /workspace/home path returned by another " +
    "tool so file bytes never enter model context; base64 remains available for compatibility. " +
    "Returns text, page count, and truncation status. It does not perform OCR.",
  inputSchema: z.object({
    contentBase64: z
      .string()
      .min(1)
      .max(MAX_BASE64_CHARS)
      .optional()
      .describe(
        "Compatibility input: raw base64 PDF bytes. Prefer path for tool-to-tool workflows.",
      ),
    path: z
      .string()
      .min(1)
      .max(1000)
      .optional()
      .describe(
        "PDF path inside /workspace/home, as returned by a file-producing tool.",
      ),
    maxTextChars: z
      .number()
      .int()
      .min(1_000)
      .max(MAX_TEXT_CHARS)
      .optional()
      .describe(
        `Maximum text characters to return. Defaults to ${DEFAULT_TEXT_CHARS}; hard cap ${MAX_TEXT_CHARS}.`,
      ),
  }),
  async execute(input, ctx) {
    if (Boolean(input.path) === Boolean(input.contentBase64)) {
      return {
        ok: false,
        code: "invalid_input",
        error:
          "Pass exactly one of path or contentBase64. Prefer path when another tool staged the PDF.",
      };
    }
    const loaded = input.path
      ? await readHomeFile(input.path, async (path) => {
          const sandbox = await ctx.getSandbox();
          return Promise.resolve(
            sandbox.readFile({ path, abortSignal: ctx.abortSignal }),
          );
        })
      : decodeBase64(input.contentBase64!);
    if (!loaded.ok) return loaded;

    const signature = Buffer.from(loaded.bytes.subarray(0, 5)).toString(
      "ascii",
    );
    if (signature !== "%PDF-") {
      return {
        ok: false,
        code: "not_a_pdf",
        error: "The decoded data does not start with a PDF header (%PDF-).",
      };
    }

    let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
    try {
      pdf = await getDocumentProxy(loaded.bytes);
      if (pdf.numPages > MAX_PDF_PAGES) {
        return {
          ok: false,
          code: "too_many_pages",
          pageCount: pdf.numPages,
          error: `The PDF has ${pdf.numPages} pages; the extraction limit is ${MAX_PDF_PAGES}.`,
        };
      }

      const extracted = await extractText(pdf, { mergePages: true });
      const text = extracted.text.trim();
      if (!text) {
        return {
          ok: false,
          code: "no_extractable_text",
          pageCount: extracted.totalPages,
          error:
            "The PDF contains no extractable embedded text. It may be scanned or image-only; this tool does not perform OCR.",
        };
      }

      const maxTextChars = input.maxTextChars ?? DEFAULT_TEXT_CHARS;
      const truncated = text.length > maxTextChars;
      return {
        ok: true,
        text: truncated ? text.slice(0, maxTextChars) : text,
        pageCount: extracted.totalPages,
        characterCount: text.length,
        truncated,
      };
    } catch (error) {
      return {
        ok: false,
        code: "invalid_pdf",
        error: `The PDF could not be parsed or its text could not be extracted: ${errorMessage(error)}`,
      };
    }
  },
});
