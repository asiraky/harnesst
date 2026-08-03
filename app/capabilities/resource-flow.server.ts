/**
 * Post-consent resource picker flow (issue #166) — the loader/action bodies behind
 * `/connections/:provider/resource`. A capability provider whose account spans several
 * provider-side resources (a Xero login with access to multiple organisations) can't be bound
 * silently at the connect callback; the callback stores the grant UNBOUND and sends the user
 * here to pick. Until a resource is bound, deploys fail with a readable message and every
 * capability call refuses — binding is what makes the connection usable.
 *
 * Everything is deps-injected (grant reads/writes, token acquisition, resource listing,
 * redeploy) so the decision logic unit-tests with fakes; the route passes the real modules.
 */
import { data, redirect, type LoaderFunctionArgs } from "react-router";

import { sessionLoader, type SessionAuth } from "~/auth/session.server";
import type { BrokerResult } from "~/connections/broker.server";
import { capabilityAccessToken } from "~/connections/broker.server";
import {
  findGrant as realFindGrant,
  setGrantResource as realSetGrantResource,
  type ConnectionGrant,
} from "~/connections/grants.server";
import { getProvider } from "~/connections/providers.server";
import { redeployAfterConnect } from "~/connections/redeploy.server";
import { listAgents } from "~/db/queries.server";
import { safeReturnTo } from "~/lib/signed-state.server";
import { requireProject, requireRepo } from "~/project/guard.server";
import { getRuntime } from "~/seams/index.server";
import { getCapability } from "./registry.server";

export interface ResourcePickerDeps {
  findGrant: typeof realFindGrant;
  setGrantResource: typeof realSetGrantResource;
  accessToken: (input: {
    projectId: string;
    agentId: string;
    provider: string;
  }) => Promise<BrokerResult>;
  /** Resource listing override (tests); defaults to the capability definition's `list`. */
  listResources?: (
    providerId: string,
    accessToken: string,
  ) => Promise<Array<{ id: string; name: string }>>;
  redeploy: typeof redeployAfterConnect;
}

export function defaultResourcePickerDeps(): ResourcePickerDeps {
  return {
    findGrant: realFindGrant,
    setGrantResource: realSetGrantResource,
    accessToken: (input) => capabilityAccessToken(input),
    redeploy: redeployAfterConnect,
  };
}

export interface ResourcePickerData {
  /** Non-empty renders the shared error page instead of the picker. */
  error: string;
  backUrl: string;
  providerLabel: string;
  /** The capability's resource noun, e.g. "organisation". */
  resourceLabel: string;
  options: Array<{ id: string; name: string }>;
  /** Currently bound resource id, when re-picking. */
  current: string | null;
}

interface ResolvedPickerContext {
  projectId: string;
  agent: { id: string; name: string };
  provider: NonNullable<ReturnType<typeof getProvider>>;
  capability: NonNullable<ReturnType<typeof getCapability>>;
  resource: NonNullable<NonNullable<ReturnType<typeof getCapability>>["resource"]>;
  grant: ConnectionGrant;
  backUrl: string;
  orgId: string;
}

/**
 * Shared request resolution for loader and action: tenancy guard, provider/capability lookup,
 * roster agent, active grant. Returns a readable failure string instead of throwing so both
 * surfaces render it the same way.
 */
async function resolvePickerContext(
  args: LoaderFunctionArgs,
  providerId: string,
  auth: SessionAuth,
  deps: ResourcePickerDeps,
): Promise<{ ok: true; ctx: ResolvedPickerContext } | { ok: false; error: string; backUrl: string }> {
  const url = new URL(args.request.url);
  const projectId = url.searchParams.get("project") ?? "";
  const agentName = url.searchParams.get("agent") ?? "";
  const backUrl = safeReturnTo(url.searchParams.get("returnTo")) ?? "/dashboard";

  const provider = getProvider(providerId);
  const capability = provider ? getCapability(provider.id) : null;
  if (!provider || !capability?.resource) {
    return {
      ok: false,
      backUrl,
      error: `"${providerId}" is not a capability provider with a resource to pick.`,
    };
  }

  const project = requireRepo(await requireProject(auth, projectId));
  const roster = (await listAgents(project.id)).filter(
    (a) => a.kind === "member",
  );
  const agent = roster.find((a) => a.name === agentName);
  if (!agent) throw data("Unknown agent", { status: 404 });

  const grant = await deps.findGrant({
    projectId: project.id,
    agentId: agent.id,
    provider: provider.id,
  });
  if (!grant || grant.status !== "active") {
    return {
      ok: false,
      backUrl,
      error: `This agent has no active ${provider.label} connection — connect it first, then pick the ${capability.resource.label}.`,
    };
  }

  return {
    ok: true,
    ctx: {
      projectId: project.id,
      agent: { id: agent.id, name: agent.name },
      provider,
      capability,
      resource: capability.resource,
      grant,
      backUrl,
      orgId: project.orgId,
    },
  };
}

async function listResourcesFor(
  ctx: ResolvedPickerContext,
  deps: ResourcePickerDeps,
): Promise<
  { ok: true; resources: Array<{ id: string; name: string }> } | { ok: false; error: string }
> {
  const token = await deps.accessToken({
    projectId: ctx.projectId,
    agentId: ctx.agent.id,
    provider: ctx.provider.id,
  });
  if (!token.ok) return { ok: false, error: token.error };
  try {
    const resources = deps.listResources
      ? await deps.listResources(ctx.provider.id, token.accessToken)
      : await ctx.resource.list(token.accessToken, fetch);
    return { ok: true, resources };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/** GET: list the account's resources and render the picker. */
export function resourcePickerLoader(
  args: LoaderFunctionArgs,
  providerId: string,
  deps: ResourcePickerDeps = defaultResourcePickerDeps(),
) {
  return sessionLoader(
    args,
    async ({ auth }): Promise<ResourcePickerData> => {
      const resolved = await resolvePickerContext(args, providerId, auth, deps);
      const empty = { options: [] as Array<{ id: string; name: string }>, current: null };
      if (!resolved.ok) {
        return {
          ...empty,
          error: resolved.error,
          backUrl: resolved.backUrl,
          providerLabel: getProvider(providerId)?.label ?? providerId,
          resourceLabel: "resource",
        };
      }
      const { ctx } = resolved;
      const listed = await listResourcesFor(ctx, deps);
      if (!listed.ok) {
        return {
          ...empty,
          error: listed.error,
          backUrl: ctx.backUrl,
          providerLabel: ctx.provider.label,
          resourceLabel: ctx.resource.label,
        };
      }
      if (listed.resources.length === 0) {
        return {
          ...empty,
          error: `The connected ${ctx.provider.label} account has no ${ctx.resource.label} harnesst can use — connect an account that does.`,
          backUrl: ctx.backUrl,
          providerLabel: ctx.provider.label,
          resourceLabel: ctx.resource.label,
        };
      }
      return {
        error: "",
        backUrl: ctx.backUrl,
        providerLabel: ctx.provider.label,
        resourceLabel: ctx.resource.label,
        options: listed.resources,
        current: ctx.grant.resourceId,
      };
    },
    { ensureSignedIn: true },
  );
}

/**
 * POST: bind the picked resource. The picked id is validated against a FRESH provider listing —
 * the form is browser-controlled and must never bind a resource the account can't reach.
 * Success audits, auto-redeploys (the binding is deploy-validated state), and returns to the
 * wizard/Deployment tab.
 */
export function resourcePickerAction(
  args: LoaderFunctionArgs,
  providerId: string,
  deps: ResourcePickerDeps = defaultResourcePickerDeps(),
) {
  return sessionLoader(
    args,
    async ({ auth }): Promise<ResourcePickerData> => {
      const resolved = await resolvePickerContext(args, providerId, auth, deps);
      const empty = { options: [] as Array<{ id: string; name: string }>, current: null };
      if (!resolved.ok) {
        return {
          ...empty,
          error: resolved.error,
          backUrl: resolved.backUrl,
          providerLabel: getProvider(providerId)?.label ?? providerId,
          resourceLabel: "resource",
        };
      }
      const { ctx } = resolved;
      const fail = (error: string): ResourcePickerData => ({
        ...empty,
        error,
        backUrl: ctx.backUrl,
        providerLabel: ctx.provider.label,
        resourceLabel: ctx.resource.label,
      });

      const form = await args.request.formData();
      const resourceId = String(form.get("resourceId") ?? "");
      if (!resourceId) return fail(`Pick ${ctx.resource.label} to continue.`);

      const listed = await listResourcesFor(ctx, deps);
      if (!listed.ok) return fail(listed.error);
      const picked = listed.resources.find((r) => r.id === resourceId);
      if (!picked) {
        return fail(
          `That ${ctx.resource.label} isn't available to the connected ${ctx.provider.label} account — pick again.`,
        );
      }

      await deps.setGrantResource(ctx.grant.id, picked.id, picked.name);
      await getRuntime().data.audit.record({
        orgId: ctx.orgId,
        actorUserId: auth.user.id,
        action: "connection.resource-bound",
        target: ctx.agent.name,
        meta: {
          provider: ctx.provider.id,
          resourceId: picked.id,
          resourceName: picked.name,
        },
      });

      // Same post-connect redeploy contract as the callback (issue #69): the binding gates
      // deploys, so binding it re-validates live environments. Never lose the write on a queue
      // hiccup.
      let outcome: Awaited<ReturnType<typeof redeployAfterConnect>>;
      try {
        outcome = await deps.redeploy({
          projectId: ctx.projectId,
          agentId: ctx.agent.id,
          createdBy: auth.user.id,
        });
      } catch {
        throw redirect(ctx.backUrl);
      }
      const params = new URLSearchParams({ connected: ctx.provider.id });
      if (outcome.status === "redeployed") params.set("redeploy", "queued");
      else if (outcome.status === "error") {
        params.set("redeploy", "error");
        params.set("redeployError", outcome.message.slice(0, 200));
      }
      const joiner = ctx.backUrl.includes("?") ? "&" : "?";
      throw redirect(`${ctx.backUrl}${joiner}${params.toString()}`);
    },
    { ensureSignedIn: true },
  );
}
