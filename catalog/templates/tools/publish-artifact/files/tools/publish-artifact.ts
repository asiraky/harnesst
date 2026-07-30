import { defineTool } from "eve/tools";
import { z } from "zod";

// Publishes via harnesst's control plane (issue #290) rather than uploading bytes: the file already
// sits on the agent's home volume, which the control plane can read over the Docker socket, so this
// call carries only the PATH. harnesst copies the bytes at publish time — the card keeps working
// after the agent scales to zero or redeploys — sniffs the real image type from the bytes, and
// serves the image back behind the user's own sign-in.
//
// HARNESST_FOH_ARTIFACTS_URL and HARNESST_TEAM_TOKEN are injected at deploy when this tool is
// installed; both absent means the agent is running somewhere that has no Front of House, which is
// reported as an ordinary refusal rather than a crash.
export default defineTool({
  description:
    "Publish an image file so the person you are talking to can SEE it in this conversation. " +
    "Use it whenever you have produced a screenshot, chart, diagram or rendered image and the " +
    "point is for the user to look at it — describing it in words is not the same thing. " +
    "The file must already exist under /workspace/home (anything you wrote to " +
    "/workspace/home/artifacts/, and browser screenshots in " +
    "/workspace/home/agent-browser/screenshots/, both qualify). Images only for now: PNG, JPEG, " +
    "WebP or SVG, up to 25 MB. It returns the artifact's URL inside harnesst — mention in your " +
    "reply that you published it; the image itself appears as its own card, so do not try to " +
    "embed it in markdown. Call it while you are answering the person in harnesst: the card goes " +
    "to the conversation whose turn is running, so publishing from a background run has nowhere " +
    "to land and is refused.",
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .describe(
        "Path of the image file to publish, under /workspace/home — either absolute " +
          "(/workspace/home/artifacts/chart.png) or relative to it (artifacts/chart.png).",
      ),
    title: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Short caption shown under the image, e.g. 'Checkout page after the fix'. Defaults to the file name.",
      ),
    kind: z
      .literal("image")
      .optional()
      .describe("What kind of artifact this is. Only 'image' is supported today."),
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
        | { ok: true; artifactId: string; url: string; name: string; byteSize: number }
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
