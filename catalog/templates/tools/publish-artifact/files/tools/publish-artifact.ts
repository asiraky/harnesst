import { defineTool } from "eve/tools";
import { z } from "zod";

// Publishes via harnesst's control plane (issues #290, #291) rather than uploading bytes: the file
// already sits on the agent's home volume, which the control plane can read over the Docker socket,
// so this call carries only the PATH. harnesst copies the bytes at publish time — the card keeps
// working after the agent scales to zero or redeploys.
//
// Two kinds, two safety stories. An IMAGE has its real type sniffed from the bytes and is served
// back behind the user's own sign-in. A PAGE is agent-authored HTML, so harnesst never serves it
// same-origin-and-trusted: it goes out through a short-lived preview URL whose response sandboxes
// itself (no network, no forms, no storage, no cookies), which is why a page has no permanent link
// to quote back — the user opens it from the card.
//
// The unit is a NAME in a conversation, not a file: publishing the same name again appends a
// VERSION to the card that is already on screen instead of adding a second one, which is what makes
// the "show me" → "change it" → "show me again" loop read as one thing being refined.
//
// HARNESST_FOH_ARTIFACTS_URL and HARNESST_TEAM_TOKEN are injected at deploy when this tool is
// installed; both absent means the agent is running somewhere that has no Front of House, which is
// reported as an ordinary refusal rather than a crash.
export default defineTool({
  description:
    "Show the user a file you produced, as a card in this conversation. What you publish and how " +
    "it renders is set by `kind`. The path must exist under /workspace/home; 25 MB max. To revise " +
    "something, publish the same file name again — the existing card updates to a new version " +
    "instead of adding a second card. Mention in your reply that you published it; only call this " +
    "while answering the user (a background run has nowhere to land).",
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .describe(
        "Path of the image file, HTML file or page directory to publish, under /workspace/home — " +
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
      .enum(["image", "html"])
      .describe(
        "How the artifact renders for the user. 'image': a single PNG, JPEG, WebP or SVG file, " +
          "displayed directly as a picture in the card. 'html': a page (a single .html file, or a " +
          "directory with index.html and the css/js/image files it loads), which the user opens " +
          "from the card in a sandboxed iframe preview — the page runs live with its styles and " +
          "scripts, but has no network access: fetch() fails even for sibling files, so inline " +
          "any data into the page.",
      ),
  }),
  async execute({ path, title, kind }) {
    const publishUrl = process.env.HARNESST_FOH_ARTIFACTS_URL;
    const token = process.env.HARNESST_TEAM_TOKEN;
    if (!publishUrl || !token) {
      return {
        ok: false,
        error: "Publishing artifacts is not configured for this deployment.",
      };
    }
    try {
      const res = await fetch(publishUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ path, title, kind }),
        // The copy happens inside this request, so the budget covers reading up to 25 MB out of a
        // volume — generous, but still bounded so a wedged daemon can never hold the turn open.
        signal: AbortSignal.timeout(60_000),
      });
      const body = (await res.json().catch(() => null)) as
        | {
            ok: true;
            artifactId: string;
            kind: string;
            /** Null for a page: it is reachable only through the preview the user opens. */
            url: string | null;
            name: string;
            byteSize: number;
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
