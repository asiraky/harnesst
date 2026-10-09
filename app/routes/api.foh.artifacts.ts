/**
 * Artifact publish endpoint (#290, #291). The `publish-artifact` tool POSTs here with
 * `Authorization: Bearer <HARNESST_TEAM_TOKEN>`. Images/pages are copied from the root agent's
 * volume; a PDF `document` or any `file` arrives as bounded base64 in the private tool request (the
 * tool reads it from its own, possibly subagent, sandbox — one `docker cp` cannot reach).
 *
 * BODY SIZE. The supplied-bytes cap is the artifact cap (25 MB), so a request is up to ~33.4 MiB of
 * base64 plus framing — under the edge's `client_max_body_size 40m`. Buffering that is the same
 * heap cost as a `docker cp`, so a body that may be large (no `Content-Length`, or one over 64 KiB)
 * is read inside one of the same copy slots (`withArtifactCopySlot`), and refused as busy when none
 * is free. One request never holds two slots: a supplied-bytes publish runs in the read's slot (it
 * does not copy), and a path-only publish releases the read's slot before its copy takes one.
 *
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
  withArtifactCopySlot,
} from "~/foh/artifacts.server";
import { ARTIFACT_MAX_BYTES } from "~/foh/artifact-media";
import { verifyDelegationToken } from "~/team/token.server";

const MAX_DOCUMENT_BYTES = ARTIFACT_MAX_BYTES;
const MAX_DOCUMENT_BASE64_CHARS = Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4;
const MAX_REQUEST_BYTES = MAX_DOCUMENT_BASE64_CHARS + 16 * 1024;
/** Bodies at or under this are small enough to read outside a copy slot (a path-only publish). */
const SMALL_REQUEST_BYTES = 64 * 1024;

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

function decodeDocument(value: string): Buffer | null {
  if (value.length > MAX_DOCUMENT_BASE64_CHARS) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(value) || value.length % 4 === 1) {
    return null;
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > MAX_DOCUMENT_BYTES) return null;
  return bytes.toString("base64").replace(/=+$/u, "") ===
    value.replace(/=+$/u, "")
    ? bytes
    : null;
}

/**
 * The publish request's fields, from its parsed JSON body. `contentBase64` is PRESENT whenever it
 * is a string — `""` included, which is how the tool sends an empty file. Treating `""` as absent
 * would turn the publish into a path-only one, and harnesst would copy whatever sits at that path
 * in the ROOT agent's sandbox: for a subagent, a different file or none at all. Empty bytes are
 * then judged like any others (an empty `file` publishes; an empty PDF fails its sniff).
 */
export function artifactPublishFields(body: Record<string, unknown>):
  | {
      ok: true;
      path: string;
      title: string | null;
      kind: string | null;
      suppliedBytes: Buffer | undefined;
    }
  | { ok: false; error: string } {
  const path = typeof body.path === "string" ? body.path : "";
  if (!path)
    return { ok: false, error: "Send the path of the file to publish." };
  const raw = body.contentBase64;
  let suppliedBytes: Buffer | undefined;
  if (raw !== undefined && raw !== null) {
    const decoded = typeof raw === "string" ? decodeDocument(raw) : null;
    if (!decoded) {
      return {
        ok: false,
        error:
          "contentBase64 is not a valid base64 payload within the 25 MB artifact limit.",
      };
    }
    suppliedBytes = decoded;
  }
  return {
    ok: true,
    path,
    title: typeof body.title === "string" ? body.title : null,
    kind: typeof body.kind === "string" ? body.kind : null,
    suppliedBytes,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const deploymentId = token ? verifyDelegationToken(token) : null;
  if (!deploymentId)
    throw data({ ok: false, error: "unauthorized" }, { status: 401 });

  const declared = Number(request.headers.get("content-length"));
  const small =
    request.headers.has("content-length") &&
    Number.isFinite(declared) &&
    declared <= SMALL_REQUEST_BYTES;
  if (small) return publish(await readFields(request), deploymentId);

  // A body that may be large is read inside a copy slot. Supplied bytes are published in that same
  // slot (that publish never copies, so it takes no second one). A path-only body is small once
  // read, so its slot is released BEFORE the publish — whose copy takes a slot of its own. Holding
  // the read slot through it would make each request need two, and three at once would all fail.
  const slot = await withArtifactCopySlot(async () => {
    const fields = await readFields(request);
    return fields.suppliedBytes
      ? { published: await publish(fields, deploymentId) }
      : { pending: fields };
  });
  if (!slot.ok) {
    await request.body?.cancel().catch(() => undefined);
    return data({
      ok: false,
      error:
        "harnesst is already copying as many files as it can at once. Try publishing again in a moment.",
    });
  }
  return "published" in slot.value
    ? slot.value.published
    : publish(slot.value.pending, deploymentId);
}

type PublishFields = Extract<
  ReturnType<typeof artifactPublishFields>,
  { ok: true }
>;

/** The request's fields, or the 400 a malformed body earns. */
async function readFields(request: Request): Promise<PublishFields> {
  const parsed = await readBoundedJson(request);
  if (!parsed.ok)
    throw data({ ok: false, error: parsed.error }, { status: 400 });
  const fields = artifactPublishFields(parsed.body);
  if (!fields.ok)
    throw data({ ok: false, error: fields.error }, { status: 400 });
  return fields;
}

async function publish(fields: PublishFields, deploymentId: string) {
  const result = await publishArtifact(
    {
      deploymentId,
      path: fields.path,
      title: fields.title,
      kind: fields.kind,
      suppliedBytes: fields.suppliedBytes,
    },
    defaultPublishArtifactDeps(),
  );
  return data(result);
}
