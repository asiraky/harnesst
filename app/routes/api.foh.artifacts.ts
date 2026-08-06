/**
 * Artifact publish endpoint (#290, #291). The `publish-artifact` tool POSTs here with
 * `Authorization: Bearer <HARNESST_TEAM_TOKEN>`. Images/pages are copied from the root agent's
 * volume; a PDF from an isolated subagent arrives as bounded base64 in the private tool request.
 * Transport shell only — the same division as
 * `routes/api.foh.park.ts`: the token authenticates the CALLER DEPLOYMENT and nothing else, a bad
 * token is the only 401, malformed JSON or a missing path is a 400, and every business outcome the
 * agent should be able to read comes back 200 `{ ok:false, error }`.
 *
 * Resource route (action only).
 */
import { data, type ActionFunctionArgs } from "react-router";

import {
  defaultPublishArtifactDeps,
  publishArtifact,
} from "~/foh/artifacts.server";
import { ARTIFACT_DOCUMENT_MAX_BYTES } from "~/foh/artifact-media";
import { verifyDelegationToken } from "~/team/token.server";

const MAX_DOCUMENT_BYTES = ARTIFACT_DOCUMENT_MAX_BYTES;
const MAX_DOCUMENT_BASE64_CHARS = Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4;
const MAX_REQUEST_BYTES = MAX_DOCUMENT_BASE64_CHARS + 16 * 1024;

async function readBoundedJson(
  request: Request,
): Promise<
  { ok: true; body: Record<string, unknown> } | { ok: false; error: string }
> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    return { ok: false, error: "The artifact request is too large." };
  }
  const reader = request.body?.getReader();
  if (!reader) return { ok: false, error: "Send a JSON body." };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, error: "The artifact request is too large." };
    }
    chunks.push(value);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return body && typeof body === "object" && !Array.isArray(body)
      ? { ok: true, body: body as Record<string, unknown> }
      : { ok: false, error: "Send a JSON object." };
  } catch {
    return { ok: false, error: "Malformed JSON body." };
  }
}

function decodeDocument(value: unknown): Buffer | null {
  if (typeof value !== "string" || value.length > MAX_DOCUMENT_BASE64_CHARS) {
    return null;
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(value) || value.length % 4 === 1) {
    return null;
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.length > MAX_DOCUMENT_BYTES) return null;
  return bytes.toString("base64").replace(/=+$/u, "") ===
    value.replace(/=+$/u, "")
    ? bytes
    : null;
}

export async function action({ request }: ActionFunctionArgs) {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const deploymentId = token ? verifyDelegationToken(token) : null;
  if (!deploymentId)
    throw data({ ok: false, error: "unauthorized" }, { status: 401 });

  const parsed = await readBoundedJson(request);
  if (!parsed.ok)
    throw data({ ok: false, error: parsed.error }, { status: 400 });
  const body = parsed.body;

  const path = typeof body.path === "string" ? body.path : "";
  const title = typeof body.title === "string" ? body.title : null;
  const kind = typeof body.kind === "string" ? body.kind : null;
  const decodedDocument = body.contentBase64
    ? decodeDocument(body.contentBase64)
    : undefined;
  if (!path) {
    throw data(
      { ok: false, error: "Send the path of the file to publish." },
      { status: 400 },
    );
  }
  if (body.contentBase64 && !decodedDocument) {
    throw data(
      {
        ok: false,
        error: "contentBase64 is not a valid PDF-sized base64 payload.",
      },
      { status: 400 },
    );
  }
  const documentBytes = decodedDocument ?? undefined;

  const result = await publishArtifact(
    { deploymentId, path, title, kind, documentBytes },
    defaultPublishArtifactDeps(),
  );
  return data(result);
}
