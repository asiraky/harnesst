/**
 * Extract embedded text from a base64-encoded PDF without sending the document over the network.
 *
 * This deliberately does not perform OCR. Scanned/image-only documents return a distinct,
 * actionable error so an agent cannot mistake missing text for a verified empty document.
 */
import { defineTool } from "eve/tools";
import { extractText, getDocumentProxy } from "unpdf";
import { z } from "zod";

const MAX_PDF_BYTES = 4 * 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_PDF_BYTES / 3) * 4;
const MAX_PDF_PAGES = 200;
const DEFAULT_TEXT_CHARS = 50_000;
const MAX_TEXT_CHARS = 100_000;

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
      error: "contentBase64 is not valid base64 data. Pass the raw base64 string without a data-URL prefix or whitespace.",
    };
  }

  const unpadded = value.replace(/=+$/u, "");
  const padded = unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, "=");
  const bytes = Buffer.from(padded, "base64");
  if (bytes.toString("base64").replace(/=+$/u, "") !== unpadded) {
    return {
      ok: false,
      code: "invalid_base64",
      error: "contentBase64 is not valid base64 data. Pass the raw base64 string without a data-URL prefix or whitespace.",
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

export default defineTool({
  description:
    "Extract embedded text from a base64-encoded PDF locally. Use it for PDF bytes returned " +
    "by another tool, including mail attachments. Returns text, page count, and whether output " +
    "was truncated. It does not perform OCR, so scanned or image-only PDFs return a clear error.",
  inputSchema: z.object({
    contentBase64: z
      .string()
      .min(1)
      .max(MAX_BASE64_CHARS)
      .describe(
        "Raw base64-encoded PDF bytes, without a data-URL prefix. Maximum decoded size: 4 MiB.",
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
  async execute(input) {
    const decoded = decodeBase64(input.contentBase64);
    if (!decoded.ok) return decoded;

    const signature = Buffer.from(decoded.bytes.subarray(0, 5)).toString("ascii");
    if (signature !== "%PDF-") {
      return {
        ok: false,
        code: "not_a_pdf",
        error: "The decoded data does not start with a PDF header (%PDF-).",
      };
    }

    let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
    try {
      pdf = await getDocumentProxy(decoded.bytes);
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
    } finally {
      // The bundled serverless PDF.js proxy does not expose destroy() in every runtime/build,
      // despite the upstream PDFDocumentProxy type declaring it.
      if (pdf && typeof pdf.destroy === "function") {
        await pdf.destroy().catch(() => undefined);
      }
    }
  },
});
