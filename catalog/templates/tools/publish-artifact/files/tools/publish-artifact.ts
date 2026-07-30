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
// HARNESST_FOH_ARTIFACTS_URL and HARNESST_TEAM_TOKEN are injected at deploy when this tool is
// installed; both absent means the agent is running somewhere that has no Front of House, which is
// reported as an ordinary refusal rather than a crash.
export default defineTool({
  description:
    "Publish an image or a static HTML page so the person you are talking to can SEE it in this " +
    "conversation. Use it whenever you have produced a screenshot, chart, diagram, rendered image " +
    "or a built page and the point is for the user to look at it — describing it in words is not " +
    "the same thing. The path must already exist under /workspace/home (anything you wrote to " +
    "/workspace/home/artifacts/, and browser screenshots in " +
    "/workspace/home/agent-browser/screenshots/, both qualify). Images: PNG, JPEG, WebP or SVG. " +
    "Pages: a single .html file, or a DIRECTORY holding index.html plus the css/js/font/image files " +
    "it loads (at most 40 files, plain names, no symlinks). 25 MB in total either way. An image " +
    "returns its URL inside harnesst; a page returns no URL by design — it is opened from the card " +
    "in a sandboxed preview panel, where it cannot reach the network, submit forms or read " +
    "anything of the user's. fetch()/XHR are dead there even for the page's own sibling files, so " +
    "inline any data into the page rather than fetching a .json next to it. Either way the " +
    "artifact appears as its own card, so mention in your " +
    "reply that you published it rather than trying to embed it in markdown. Call it while you are " +
    "answering the person in harnesst: the card goes to the conversation whose turn is running, so " +
    "publishing from a background run has nowhere to land and is refused.",
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
      .optional()
      .describe(
        "What is being published: 'image' for a single image file, 'html' for a page (a single " +
          ".html file or a directory containing index.html). Required when publishing a page " +
          "DIRECTORY, since the path alone does not say; otherwise inferred from the extension.",
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
