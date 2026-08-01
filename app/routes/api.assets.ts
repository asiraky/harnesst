/**
 * Agent-facing repo-backed asset relay (issue #322). Bad bearer → 401; every model-readable
 * failure → 200 `{ ok:false }`. The body is capped while streaming because instances reach the
 * control plane directly and a 25 MB asset expands to roughly 34 MB in base64 JSON.
 */
import { data, type ActionFunctionArgs } from "react-router";

import { runAssetOperation } from "~/assets/store.server";
import { verifyDelegationToken } from "~/team/token.server";

export const ASSET_ROUTE_MAX_BODY_BYTES = 36 * 1024 * 1024;

type BoundedBody = { over: true } | { over: false; text: string };

export async function readAssetRequestBody(
  request: Request,
): Promise<BoundedBody> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > ASSET_ROUTE_MAX_BODY_BYTES) {
    return { over: true };
  }
  if (!request.body) return { over: false, text: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > ASSET_ROUTE_MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return { over: true };
    }
    chunks.push(value);
  }
  return { over: false, text: Buffer.concat(chunks).toString("utf8") };
}

export async function action({ request }: ActionFunctionArgs) {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const deploymentId = token ? verifyDelegationToken(token) : null;
  if (!deploymentId)
    throw data({ ok: false, error: "unauthorized" }, { status: 401 });

  const bounded = await readAssetRequestBody(request);
  if (bounded.over) {
    return data({
      ok: false,
      error: "The asset request body exceeds the 36 MB transport limit.",
    });
  }
  let body: unknown;
  try {
    body = JSON.parse(bounded.text);
  } catch {
    return data({
      ok: false,
      error: "Send the asset operation as a JSON body.",
    });
  }
  return data(await runAssetOperation(deploymentId, body));
}
