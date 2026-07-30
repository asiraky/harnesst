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
 * Every failure — garbled token, forged signature, expired token, wrong artifact, an image, a path
 * that is not in the bundle, bytes missing from the store — is the same 404. See
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
  readArtifactBytes,
} from "~/foh/artifact-store.server";
import { getFohSessionForViewer } from "~/playground/sessions.server";

const notFound = () => data("Not found", { status: 404 });

export async function loader({ params, request }: LoaderFunctionArgs) {
  const artifactId = params.artifactId ?? "";
  const claim = artifactId
    ? verifyArtifactPreviewToken(params.token ?? "", artifactId)
    : null;
  if (!claim) throw notFound();

  const artifact = await findArtifactById(artifactId);
  if (!artifact || artifact.kind !== "html" || !artifact.entryPath) {
    throw notFound();
  }
  if (artifact.projectId !== claim.projectId) throw notFound();

  const session = await getFohSessionForViewer({
    id: artifact.sessionId,
    projectId: artifact.projectId,
    viewerId: claim.userId,
    includeAll: claim.backOfHouse,
  });
  if (!session) throw notFound();

  // An empty splat is the entry document, so `/artifacts/preview/<token>/<id>/` opens the page.
  const relPath = normalizeBundleRelPath(params["*"] || artifact.entryPath);
  if (!relPath) throw notFound();
  const file = await findArtifactFile({ artifactId, relPath });
  if (!file) throw notFound();

  const bytes = await readArtifactBytes(file.storagePath);
  if (!bytes) throw notFound();

  // `new Uint8Array(...)`: a Node Buffer is not a `BodyInit` as far as the DOM lib is concerned,
  // and the copy is a view, not a duplicate of the bytes.
  return new Response(new Uint8Array(bytes), {
    headers: artifactPreviewHeaders({
      contentType: file.contentType,
      byteSize: bytes.length,
      requestUrl: request.url,
    }),
  });
}
