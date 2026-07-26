/**
 * The assistant instance's callback API. The built-in assistant's baked-in
 * tools, its boot entrypoint, and its checkout sidecar call `POST|GET /api/assistant/<action>` with
 * a Bearer `HARNESST_ASSISTANT_TOKEN`. The token authenticates a DEPLOYMENT; everything else
 * (environment → agent → project) is derived from the DB, and the agent must be kind 'assistant'. A
 * bad token is the only 401 — business failures return `{ ok:false, error }` at HTTP 200 so the
 * model reads the text (the ask.server.ts convention).
 *
 * Under the coding-agent model the write/read/list/dependency/scaffold/run-checks actions are gone
 * (the model edits a real git checkout with bash; the control plane mirrors it to a PR). What's left
 * is control-plane KNOWLEDGE (`project-context`, `catalog`, the boot `bundle`), marketplace
 * `install`, plus `read-token` — the narrowed, single-repo `contents:read` installation token the
 * sidecar uses to clone/fetch. The read token is scoped to one repo and is NEVER a write
 * credential; the `edna_` token never leaves the instance.
 */
import {
  data,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import {
  assembleBundle,
  catalogOp,
  defaultAuthoringDeps,
  projectContext,
  resolveAssistantContext,
  type AuthoringDeps,
} from "~/assistant/authoring.server";
import { installMarketplaceTemplate } from "~/assistant/install.server";
import { bearerToken, verifyAssistantToken } from "~/assistant/token.server";
import { mintNarrowedReadToken } from "~/github/client.server";

async function authenticate(request: Request, deps: AuthoringDeps) {
  const token = bearerToken(request);
  const deploymentId = token ? verifyAssistantToken(token) : null;
  if (!deploymentId) return null;
  return resolveAssistantContext(deploymentId, deps.store);
}

/** GET is only for `bundle` (the container entrypoint). */
export async function loader({ request, params }: LoaderFunctionArgs) {
  if (params.action !== "bundle") {
    throw data({ error: "Not found" }, { status: 404 });
  }
  const deps = defaultAuthoringDeps();
  const ctx = await authenticate(request, deps);
  if (!ctx) throw data({ error: "Invalid assistant token" }, { status: 401 });
  const bundle = await assembleBundle(ctx.project, deps);
  return Response.json(bundle);
}

export async function action({ request, params }: ActionFunctionArgs) {
  const deps = defaultAuthoringDeps();
  const ctx = await authenticate(request, deps);
  if (!ctx) throw data({ error: "Invalid assistant token" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const { project } = ctx;

  switch (params.action) {
    case "project-context":
      return Response.json(await projectContext(project, deps));
    case "catalog":
      return Response.json(
        await catalogOp(
          {
            op: str(body.op),
            type: str(body.type) || undefined,
            id: str(body.id) || undefined,
          },
          deps,
        ),
      );
    case "install":
      return Response.json(await installMarketplaceTemplate(project, body));
    case "read-token": {
      // A short-lived installation token narrowed to THIS repo, contents:read only — the sidecar's
      // credential to clone/fetch the conversation checkout. Never a write credential; the sidecar
      // passes it per git invocation and never persists it to the shared volume.
      try {
        const { token, expiresAt } = await mintNarrowedReadToken({
          installationId: project.repoInstallationId,
          repo: project.repoName,
        });
        return Response.json({
          ok: true,
          token,
          expiresAt,
          owner: project.repoOwner,
          repo: project.repoName,
          defaultBranch: project.defaultBranch,
        });
      } catch (error) {
        return Response.json({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    default:
      throw data(
        { error: `Unknown action "${params.action}"` },
        { status: 404 },
      );
  }
}
