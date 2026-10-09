import { defineTool } from "eve/tools";
import { z } from "zod";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function homePath(value: string): string | null {
  if (!value.trim() || value.includes("\0")) return null;
  const absolute = value.startsWith("/") ? value : `/workspace/home/${value}`;
  if (
    !absolute.startsWith("/workspace/home/") ||
    absolute.split("/").includes("..")
  ) {
    return null;
  }
  return absolute;
}

async function readUpload(
  stream: ReadableStream<Uint8Array> | null,
): Promise<{ ok: true; contentBase64: string } | { ok: false; error: string }> {
  if (!stream) return { ok: false, error: "There is no file at that path." };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_UPLOAD_BYTES) {
      await reader.cancel().catch(() => undefined);
      return {
        ok: false,
        error: "Published files are capped at 25 MB.",
      };
    }
    chunks.push(value);
  }
  return {
    ok: true,
    contentBase64: Buffer.concat(chunks).toString("base64"),
  };
}

// Publishes via harnesst's control plane (issues #290, #291). Images and pages need only a path:
// the control plane copies them from the root agent's home volume. A declared subagent has an
// isolated sandbox, so a PDF document or any other file is read by this tool and carried in the
// private tool request. It never enters model context, and the durable artifact keeps working
// after scale-down/redeploy.
//
// The safety stories differ by kind. An IMAGE or PDF has its real type sniffed from the bytes. A
// FILE is typed by its extension and served back in a form that cannot run (text as plain text,
// unknown formats as downloads). A PAGE is agent-authored HTML, so harnesst never serves it
// same-origin-and-trusted: it opens through URLs whose responses sandbox themselves into an opaque
// origin (no cookies, no harnesst storage) — the in-app preview, and since issue #370 the stable
// public `shareUrl` every publish returns, which anyone can open with no sign-in. Inside that
// sandbox the page may use the network: CDN scripts, styles and fonts, and fetch() of its own
// sibling files, all work.
//
// The unit is a NAME, not a file: publishing the same name again appends a VERSION to the same
// artifact instead of creating a second one, which is what makes the "show me" → "change it" →
// "show me again" loop read as one thing being refined. In a live conversation the artifact also
// lands as a card there; from a background run there is no conversation and no card (#370) — the
// artifact belongs to the agent, reachable through its shareUrl and the repo's Artifacts page.
//
// HARNESST_FOH_ARTIFACTS_URL and HARNESST_TEAM_TOKEN are injected at deploy when this tool is
// installed; both absent means the agent is running somewhere that has no Front of House, which is
// reported as an ordinary refusal rather than a crash.
export default defineTool({
  description:
    "Publish a file from /workspace/home as durable evidence the user can open. Images render, " +
    "HTML pages open in a sandboxed live preview, PDFs open in a viewer, and any other file — " +
    "markdown, CSV, JSON, code or text, audio, video, or anything else — opens in a matching " +
    "viewer or as a download. Files are capped at 25 MB. To revise something, publish the same " +
    "file name again — the existing artifact updates to a new version instead of duplicating. " +
    "Every publish returns a stable public shareUrl anyone can open without signing in — quote " +
    "it in your reply when the user should share the result. Works from a live conversation (the " +
    "file also lands as a card there) and from background/scheduled runs (no card; the shareUrl " +
    "and the repository's Artifacts page are how people reach it).",
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .describe(
        "Path of the file or page directory to publish, under /workspace/home — either absolute " +
          "(/workspace/home/artifacts/chart.png) or relative to it (artifacts/chart.png, " +
          "artifacts/report).",
      ),
    title: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Short caption shown on the card, e.g. 'Checkout page after the fix'. Defaults to the file name.",
      ),
    kind: z
      .enum(["image", "html", "document", "file"])
      .describe(
        "How the artifact is exposed. 'image': a single PNG, JPEG, WebP, GIF, AVIF or SVG file, " +
          "displayed directly as a picture in the card. 'html': a page (a single .html file, or a " +
          "directory with index.html and the css/js/image/data files it loads), which the user " +
          "opens from the card in a sandboxed live preview — scripts run, and the page may load " +
          "scripts, styles and fonts from public CDNs and fetch() its own sibling files (e.g. " +
          "./data.json), but has no access to the user's harnesst session or storage. 'document': " +
          "a PDF, shown in a PDF viewer. 'file': anything else — markdown, CSV/TSV, JSON, code or " +
          "plain text, audio (mp3, wav, m4a, ogg, flac), video (mp4, webm, mov), or any other " +
          "file — shown in a matching viewer, or offered as a download when there is none.",
      ),
  }),
  async execute({ path, title, kind }, ctx) {
    const publishUrl = process.env.HARNESST_FOH_ARTIFACTS_URL;
    const token = process.env.HARNESST_TEAM_TOKEN;
    if (!publishUrl || !token) {
      return {
        ok: false,
        error: "Publishing artifacts is not configured for this deployment.",
      };
    }
    try {
      let contentBase64: string | undefined;
      // A document or file is read HERE, from this tool's own sandbox — which, in a declared
      // subagent, is not the one the control plane's copy would reach.
      if (kind === "document" || kind === "file") {
        const resolved = homePath(path);
        if (!resolved) {
          return {
            ok: false,
            error: "Published files must be inside /workspace/home.",
          };
        }
        const sandbox = await ctx.getSandbox();
        const loaded = await readUpload(
          await sandbox.readFile({
            path: resolved,
            abortSignal: ctx.abortSignal,
          }),
        );
        if (!loaded.ok) return loaded;
        contentBase64 = loaded.contentBase64;
      }
      const res = await fetch(publishUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ path, title, kind, contentBase64 }),
        // The copy/store happens inside this request, bounded so a wedged daemon cannot hold the
        // turn open indefinitely.
        signal: AbortSignal.timeout(60_000),
      });
      const body = (await res.json().catch(() => null)) as
        | {
            ok: true;
            artifactId: string;
            /** Immutable id for this exact published version. */
            artifactVersionId: string;
            kind: string;
            /** Null for a page: it is reachable only through the preview the user opens. */
            url: string | null;
            /**
             * Stable PUBLIC link to the artifact's newest version — no sign-in needed, safe to
             * quote in a reply or send to a channel. Null only when sharing was revoked.
             */
            shareUrl: string | null;
            name: string;
            contentType: string;
            byteSize: number;
            /** SHA-256 of the exact stored bytes (or bundle manifest). */
            sha256: string;
            /** 1 on the first publish of this name; higher when the card was updated in place. */
            version: number;
            /** False when the bytes matched the version already on the card, so nothing changed. */
            updated: boolean;
            /** Page bundles only: how many files were stored. */
            fileCount?: number;
          }
        | { ok: false; error: string }
        | null;
      if (!body) {
        return { ok: false, error: `Publishing failed (HTTP ${res.status}).` };
      }
      return body;
    } catch (error) {
      return {
        ok: false,
        error: `Couldn't reach harnesst to publish the file: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  },
});
