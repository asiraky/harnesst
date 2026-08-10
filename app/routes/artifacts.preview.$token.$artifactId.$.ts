/**
 * Serves one file of a page-bundle artifact, sandboxed (#291). Resource route, loader only.
 *
 * NO COOKIE IS READ HERE, on purpose. The path token is the whole authentication: `getSessionAuth`
 * is never called, so the response cannot vary by browser session and the URL means the same thing
 * to the iframe (a null-origin context that would not send a `SameSite` cookie anyway) as it does to
 * a new tab. The token is in the PATH rather than a query string so that every relative `href`/`src`
 * inside the page authenticates itself — the entry document and its stylesheet arrive through the
 * same gate.
 *
 * The token is not, however, the whole AUTHORIZATION. Each request re-derives the artifact and
 * re-runs the per-conversation visibility check for the user the token was minted for, so access
 * revoked inside the 10-minute window stops working. What the token carries rather than re-derives
 * is the repo-scope decision (`projectId` + back-of-house), because that needs org/team membership
 * and therefore a cookie this route deliberately does not have.
 *
 * Every failure — garbled token, forged signature, expired token, wrong artifact, a version that is
 * not this artifact's or has been pruned, an image, a path that is not in the bundle, bytes missing
 * from the store — is the same 404. See
 * `artifact-preview.server.ts` for the response header set and why each directive is load-bearing.
 */
import { data, type LoaderFunctionArgs } from "react-router";

import { normalizeBundleRelPath } from "~/foh/artifact-media";
import {
  artifactPreviewHeaders,
  verifyArtifactPreviewToken,
} from "~/foh/artifact-preview.server";
import {
  findArtifactById,
  findArtifactFile,
  findArtifactVersion,
  latestArtifactVersion,
  readArtifactBytes,
} from "~/foh/artifact-store.server";
import { previewHostRedirect } from "~/lib/preview-origin.server";
import { getFohSessionForViewer } from "~/playground/sessions.server";

const notFound = () => data("Not found", { status: 404 });

export async function loader({ params, request }: LoaderFunctionArgs) {
  // With PREVIEW_ORIGIN configured (#296) the app origin does not serve agent-authored HTML at
  // all: it bounces to the sandbox origin, carrying the path token. This runs BEFORE any token or
  // database work so the app origin's answer never depends on whether the capability was valid —
  // and so a stale URL minted before the split (or one pasted from history) still opens. Unset,
  // this is null and the route behaves exactly as it did.
  const toPreviewOrigin = previewHostRedirect(request);
  if (toPreviewOrigin) return toPreviewOrigin;

  const artifactId = params.artifactId ?? "";
  const claim = artifactId
    ? verifyArtifactPreviewToken(params.token ?? "", artifactId)
    : null;
  if (!claim) throw notFound();

  const artifact = await findArtifactById(artifactId);
  if (!artifact || artifact.kind !== "html") throw notFound();
  if (artifact.projectId !== claim.projectId) throw notFound();

  // WHICH VERSION comes from the signed claim, never from the request (#292): the token is the
  // scope, so a capability minted for v1 keeps showing v1 after the agent republishes, and cannot
  // be re-aimed at a version it was not minted for. Constrained to this artifact, so a claim naming
  // another artifact's version finds nothing. A claim with no version at all is a token minted
  // before versions shipped; it opens the newest, which is what it meant.
  const version = claim.versionId
    ? await findArtifactVersion({ artifactId, versionId: claim.versionId })
    : await latestArtifactVersion(artifactId);
  if (!version || !version.entryPath) throw notFound();

  // A session-less artifact (#370) has no conversation whose visibility could be re-checked; the
  // signed claim's project match above is the whole authorization, as it is for the share route.
  if (artifact.sessionId) {
    const session = await getFohSessionForViewer({
      id: artifact.sessionId,
      projectId: artifact.projectId,
      viewerId: claim.userId,
      includeAll: claim.backOfHouse,
    });
    if (!session) throw notFound();
  }

  // An empty splat is the entry document, so `/artifacts/preview/<token>/<id>/` opens the page —
  // the SELECTED version's, which is what makes the panel's picker work with no change to the URL
  // shape (and therefore none to how the page's own relative URLs resolve).
  const relPath = normalizeBundleRelPath(params["*"] || version.entryPath);
  if (!relPath) throw notFound();
  const file = await findArtifactFile({ versionId: version.id, relPath });
  if (!file) throw notFound();

  const bytes = await readArtifactBytes(file.storagePath);
  if (!bytes) throw notFound();

  // A Node Buffer is not a `BodyInit` as far as the DOM lib is concerned. The three-argument
  // constructor is the one that makes a VIEW over the same memory — `new Uint8Array(buffer)` on a
  // Buffer takes the typed-array-copy overload and would duplicate up to 25 MB per subresource.
  // The cast is what tells TypeScript this is not a SharedArrayBuffer, which `fs` never returns;
  // the offset and length are what keep the view to THIS file's bytes when Buffer pooled them.
  const body = new Uint8Array(
    bytes.buffer as ArrayBuffer,
    bytes.byteOffset,
    bytes.length,
  );
  return new Response(body, {
    headers: artifactPreviewHeaders({
      contentType: file.contentType,
      byteSize: bytes.length,
      requestUrl: request.url,
    }),
  });
}
