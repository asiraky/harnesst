import { defineTool } from "eve/tools";
import { z } from "zod";

const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;

function documentPath(value: string): string | null {
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

async function readDocument(
  stream: ReadableStream<Uint8Array> | null,
): Promise<{ ok: true; contentBase64: string } | { ok: false; error: string }> {
  if (!stream) return { ok: false, error: "The document path does not exist." };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_DOCUMENT_BYTES) {
      await reader.cancel().catch(() => undefined);
      return {
        ok: false,
        error: "PDF document artifacts are capped at 4 MiB.",
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
// isolated sandbox, so a PDF document is read by this tool and carried in the private tool request.
// It never enters model context, and the durable artifact keeps working after scale-down/redeploy.
//
// Two kinds, two safety stories. An IMAGE has its real type sniffed from the bytes and is served
// back behind the user's own sign-in. A PAGE is agent-authored HTML, so harnesst never serves it
// same-origin-and-trusted: it opens through URLs whose responses sandbox themselves (no network,
// no forms, no storage, no cookies) — the in-app preview, and since issue #370 the stable public
// `shareUrl` every publish returns, which anyone can open with no sign-in.
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
    "HTML pages open in a sandboxed preview, and PDF documents get a download link. PDF documents " +
    "are capped at 4 MiB; other artifacts at 25 MB. To revise something, publish the same file " +
    "name again — the existing artifact updates to a new version instead of duplicating. Every " +
    "publish returns a stable public shareUrl anyone can open without signing in — quote it in " +
    "your reply when the user should share the result. Works from a live conversation (the file " +
    "also lands as a card there) and from background/scheduled runs (no card; the shareUrl and " +
    "the repository's Artifacts page are how people reach it).",
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .describe(
        "Path of the image, PDF, HTML file or page directory to publish, under /workspace/home — " +
          "either absolute (/workspace/home/artifacts/chart.png) or relative to it " +
          "(artifacts/chart.png, artifacts/report).",
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
      .enum(["image", "html", "document"])
      .describe(
        "How the artifact is exposed. 'image': a single PNG, JPEG, WebP or SVG file, " +
          "displayed directly as a picture in the card. 'html': a page (a single .html file, or a " +
          "directory with index.html and the css/js/image files it loads), which the user opens " +
          "from the card in a sandboxed iframe preview — the page runs live with its styles and " +
          "scripts, but has no network access: fetch() fails even for sibling files, so inline " +
          "any data into the page. 'document': a PDF served as an authenticated download link; " +
          "harnesst does not execute or render it inside the app.",
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
      if (kind === "document") {
        const resolved = documentPath(path);
        if (!resolved) {
          return {
            ok: false,
            error: "Document paths must be inside /workspace/home.",
          };
        }
        const sandbox = await ctx.getSandbox();
        const loaded = await readDocument(
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
