/**
 * Shared connection connect/callback flow (issues #30, #163) — the provider-parameterized loader
 * bodies behind BOTH the generic /connections/:provider/* routes and the legacy /google/* alias
 * routes, so the two cannot drift.
 *
 * The calling route module resolves the per-provider seams and passes them as deps:
 *  - callback staging (google keeps its dedicated cookie + /google/callback path; generic routes
 *    use the shared connection-callback staging), and
 *  - operator config + the exchange/userinfo network calls (the google routes pass the
 *    google.server shim's old-signature functions, keeping that module the single mock point for
 *    existing tests; generic routes pass the provider-generic ones).
 * Everything else — tenancy guard, signed state, nonce, PKCE, grant persistence, audit,
 * auto-redeploy — is identical across providers and lives here.
 */
import { sessionLoader } from "~/auth/session.server";
import { redirect, data, type LoaderFunctionArgs } from "react-router";

import { getCapability } from "~/capabilities/registry.server";

import type { OAuthClientConfig } from "./config.server";
import type { OAuthCallbackPayload } from "./oauth-callback-staging.server";
import {
  CONNECT_STATE_TTL_MS,
  authorizeUrl,
  codeChallengeS256,
  connectStateKey,
  generateCodeVerifier,
  missingScopes,
  registerOAuthClient,
  signConnectState,
  verifyConnectState,
  type TokenGrant,
} from "./oauth.server";
import { findGrant, upsertGrant } from "./grants.server";
import {
  consumeOAuthStateNonce,
  createOAuthStateNonce,
} from "./oauth-state.server";
import {
  getProvider,
  providerRedirectPath,
  type ProviderDefinition,
} from "./providers.server";
import { redeployAfterConnect } from "./redeploy.server";
import { listAgentEnvironments, listAgents } from "~/db/queries.server";
import { listDrafts } from "~/drafts/drafts.server";
import { getAgentSource } from "~/github/cached.server";
import { fetchAgentSource } from "~/github/repo.server";
import { envIngressUrl, publicOrigin } from "~/lib/ingress";
import { safeReturnTo } from "~/lib/signed-state.server";
import { overlayLock, requiredScopesByProvider } from "~/marketplace/lock";
import { requireProject, requireRepo } from "~/project/guard.server";
import { getRuntime } from "~/seams/index.server";

export interface ConnectionFlowData {
  error: string;
  backUrl: string;
  /** Registry label, or the raw URL id when the provider isn't registered. */
  providerLabel: string;
}

export interface ConnectFlowDeps {
  /** Operator client config for the provider, or null when unconfigured. */
  getConfig: (provider: ProviderDefinition) => OAuthClientConfig | null;
  /** Dynamic client registration (issue #167); defaults to the real RFC 7591 POST. */
  registerClient?: typeof registerOAuthClient;
}

export interface CallbackFlowDeps extends ConnectFlowDeps {
  isStagingRequest: (request: Request) => boolean;
  stage: (request: Request) => Response;
  readStaged: (request: Request) => OAuthCallbackPayload | null;
  exchangeCode: (input: {
    provider: ProviderDefinition;
    config: OAuthClientConfig;
    code: string;
    redirectUri: string;
    codeVerifier?: string;
  }) => Promise<TokenGrant>;
  fetchAccountEmail: (
    provider: ProviderDefinition,
    accessToken: string,
  ) => Promise<string | null>;
  /**
   * Capability resource listing override (issue #166, tests). Defaults to the provider's
   * capability definition (`resource.list` with the exchange's fresh access token).
   */
  listCapabilityResources?: (
    providerId: string,
    accessToken: string,
  ) => Promise<Array<{ id: string; name: string }>>;
}

function unknownProviderError(providerId: string): string {
  return (
    `"${providerId}" is not a connection provider this harnesst installation supports. ` +
    "Check the connection template's provider id, or update harnesst to a version that " +
    "registers this provider."
  );
}

/**
 * Append query params to a same-origin relative path (`backUrl` is already validated by
 * `safeReturnTo`). Parsed against a dummy base so `URL`/`URLSearchParams` do the encoding; only the
 * path + search are returned, so the dummy origin never leaks into the redirect.
 */
function withParams(backUrl: string, params: Record<string, string>): string {
  const url = new URL(backUrl, "http://x");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.pathname + url.search;
}

/**
 * Step 1: sign a (project, agent, Better Auth user/session, provider, scopes, returnTo) state and
 * redirect the user to the provider's OAuth consent screen for harnesst's shared client. After
 * approval, the provider returns to its registered callback path, which exchanges the code and
 * stores the grant.
 */
export function connectionConnectLoader(
  args: LoaderFunctionArgs,
  providerId: string,
  deps: ConnectFlowDeps,
) {
  return sessionLoader(
    args,
    async ({ auth }): Promise<ConnectionFlowData> => {
      const url = new URL(args.request.url);
      const projectId = url.searchParams.get("project") ?? "";
      const agentName = url.searchParams.get("agent") ?? "";
      const returnTo =
        safeReturnTo(url.searchParams.get("returnTo")) ?? "/dashboard";

      const provider = getProvider(providerId);
      if (!provider) {
        return {
          error: unknownProviderError(providerId),
          backUrl: returnTo,
          providerLabel: providerId,
        };
      }

      const project = requireRepo(await requireProject(auth, projectId));

      const roster = (await listAgents(project.id)).filter(
        (a) => a.kind === "member",
      );
      const agent = roster.find((a) => a.name === agentName);
      if (!agent) throw data("Unknown agent", { status: 404 });
      const backUrl = returnTo;

      // Registration providers (issue #167) mint their client per grant below — no operator
      // client env exists for them, so the unconfigured guard applies only to shared-client
      // providers.
      const config = deps.getConfig(provider);
      if (!config && !provider.clientRegistration) {
        return {
          error:
            `This harnesst installation has no ${provider.label} OAuth client configured. An operator must set ` +
            `EDEN_${provider.envPrefix}_CLIENT_ID and EDEN_${provider.envPrefix}_CLIENT_SECRET on the control plane (see the ` +
            `self-host docs) before ${provider.label} can be connected.`,
          backUrl,
          providerLabel: provider.label,
        };
      }

      // Derive requested scopes from harnesst's server-side install ledger. Query parameters are
      // attacker-controlled and must never widen the consent requested by the shared OAuth client.
      // Old lock entries predate the auth snapshot, so a stored grant is their trusted fallback.
      const [source, drafts, existingGrant] = await Promise.all([
        getAgentSource(project.repoInstallationId, {
          owner: project.repoOwner,
          repo: project.repoName,
        }),
        listDrafts(project.id),
        findGrant({
          projectId: project.id,
          agentId: agent.id,
          provider: provider.id,
        }),
      ]);
      const lock = overlayLock(
        source.files["eden-lock.json"] ?? null,
        drafts.map((draft) => ({
          path: draft.path,
          content: draft.content,
        })),
      );
      const requiredScopes = requiredScopesByProvider(
        lock,
        agent.root === "agent" ? null : agent.name,
      ).get(provider.id);
      // The grant fallback exists ONLY for lock entries with no auth snapshot at all (undefined).
      // A present-but-empty requirement is an EXPLICIT choice — every scope group deselected —
      // and must never fall back to the old grant's scopes, which would re-request exactly the
      // permissions the user just removed (issue #165).
      const scopes =
        requiredScopes !== undefined
          ? requiredScopes.join(" ")
          : (existingGrant?.scopes.trim() ?? "");

      if (!scopes) {
        return {
          error:
            requiredScopes !== undefined
              ? "Every permission for this connection is deselected — nothing to authorize. " +
                "Select at least one permission from the agent's Deployment tab, then connect."
              : "No scopes were requested for this connection — nothing to authorize.",
          backUrl,
          providerLabel: provider.label,
        };
      }

      const redirectUri = `${publicOrigin(args.request)}${providerRedirectPath(provider)}`;

      // Per-grant dynamic client registration (issue #167, RFC 7591-shaped): providers whose
      // clients are immutable with exact-match callback URIs can't share one operator client
      // across environments, so Connect registers a FRESH client covering the exact instance
      // callback URL of every environment the agent currently has (environment rows exist from
      // project creation, so their ids are stable here). The minted client_id rides inside the
      // HMAC-signed state and is persisted on the grant by the callback. Adding an environment
      // LATER invalidates coverage — the Connections card flips to needs-reconnect and the
      // reconnect registers a fresh client (same UX as a scope change, issue #165).
      let registeredClientId: string | undefined;
      // The exact environment set the minted client's approval callbacks cover — carried in the
      // signed state so the callback can refuse the flow if an environment appeared while the
      // consent tab was open (the client is immutable; see the callback's coverage check).
      let registeredEnvironmentIds: string[] | undefined;
      if (provider.clientRegistration) {
        // Instance callbacks must be publicly reachable — prefer the operator's EDEN_PUBLIC_ORIGIN
        // (the same origin EVE_PUBLIC_ORIGIN injection uses) over the request-derived origin.
        const callbackBase =
          process.env.EDEN_PUBLIC_ORIGIN?.trim() || publicOrigin(args.request);
        const callbackPath = provider.clientRegistration.approvalCallbackPath;
        const environments = callbackPath
          ? await listAgentEnvironments(agent.id)
          : [];
        try {
          const registered = await (deps.registerClient ?? registerOAuthClient)({
            provider,
            clientName: `harnesst — ${project.name ?? project.id} / ${agent.name}`,
            redirectUris: [redirectUri],
            approvalCallbackUris: environments.map((env) =>
              envIngressUrl(callbackBase, env.id, callbackPath),
            ),
          });
          registeredClientId = registered.clientId;
          if (callbackPath) {
            registeredEnvironmentIds = environments.map((env) => env.id);
          }
        } catch (error) {
          return {
            error:
              `${(error as Error).message} ${provider.label} requires every callback URL to be ` +
              "public HTTPS, so this harnesst installation needs a publicly reachable " +
              "EDEN_PUBLIC_ORIGIN (a local-dev host can't receive approval callbacks).",
            backUrl,
            providerLabel: provider.label,
          };
        }
      }
      const clientId = registeredClientId ?? config?.clientId;
      if (!clientId) {
        // Unreachable by construction (config or registration produced one), kept for safety.
        return {
          error: `No ${provider.label} OAuth client is available for this connection.`,
          backUrl,
          providerLabel: provider.label,
        };
      }

      const expiresAt = Date.now() + CONNECT_STATE_TTL_MS;
      const nonce = await createOAuthStateNonce({
        userId: auth.user.id,
        sessionId: auth.session.id,
        expiresAt: new Date(expiresAt),
      });
      // PKCE (RFC 7636): the verifier rides inside the HMAC-signed state — it only ever
      // round-trips through the user's redirect, the same trust model as the nonce.
      const codeVerifier = provider.pkce ? generateCodeVerifier() : undefined;
      const state = signConnectState(
        {
          projectId: project.id,
          agentId: agent.id,
          userId: auth.user.id,
          sessionId: auth.session.id,
          nonce,
          provider: provider.id,
          scopes,
          returnTo,
          exp: expiresAt,
          ...(codeVerifier ? { codeVerifier } : {}),
          ...(registeredClientId ? { clientId: registeredClientId } : {}),
          ...(registeredEnvironmentIds
            ? { environmentIds: registeredEnvironmentIds }
            : {}),
        },
        connectStateKey(),
      );
      throw redirect(
        authorizeUrl(provider, {
          clientId,
          redirectUri,
          state,
          scopes,
          ...(codeVerifier
            ? { codeChallenge: codeChallengeS256(codeVerifier) }
            : {}),
        }),
      );
    },
    { ensureSignedIn: true },
  );
}

/**
 * Step 2: the provider redirects back after consent with the signed `?state=` and a `?code=` (or
 * an `?error=` if the user declined). Verifies the state + tenancy, exchanges the code for a
 * refresh token against harnesst's shared client, fetches the account email for display (when the
 * provider has a userinfo endpoint), seals and stores the grant, and returns the user to the
 * wizard/Deployment tab it came from. Mirrors the Discord callback's readable-error (`fail`)
 * pattern.
 */
export function connectionCallbackLoader(
  args: LoaderFunctionArgs,
  providerId: string,
  deps: CallbackFlowDeps,
) {
  // The provider's response contains a one-time authorization code and signed state. Leave that
  // URL before session/database work so credentials never survive in history, logs, rendered
  // errors, or a framework error document. The encrypted HttpOnly cookie is cleared by root
  // middleware.
  if (deps.isStagingRequest(args.request)) {
    return deps.stage(args.request);
  }

  return sessionLoader(
    args,
    async ({ auth }): Promise<ConnectionFlowData> => {
      const provider = getProvider(providerId);
      const label = provider?.label ?? providerId;

      const fail = (
        error: string,
        backUrl = "/dashboard",
      ): ConnectionFlowData => ({
        error,
        backUrl,
        providerLabel: label,
      });

      if (!provider) {
        return fail(unknownProviderError(providerId));
      }

      // A staging failure is authoritative. Never allow an older valid cookie to be processed
      // after a malformed/oversized callback has replaced it.
      const stagingFailed = new URL(args.request.url).searchParams.has(
        "failure",
      );
      const callback = stagingFailed ? null : deps.readStaged(args.request);

      if (!callback?.state) {
        return fail(
          `This ${label} callback is invalid or has expired. Start again from the agent's ` +
            "install page or Deployment tab.",
        );
      }
      const state = verifyConnectState(callback.state, connectStateKey());
      // The provider pin keeps a signed state for one provider from driving another provider's
      // exchange (and vice versa) — the registry validation in verify is not enough.
      if (!state || state.provider !== provider.id) {
        return fail(
          "This link is invalid or has expired (it lives one hour). Start again from the " +
            "agent's install page or Deployment tab.",
        );
      }
      if (
        state.userId !== auth.user.id ||
        state.sessionId !== auth.session.id
      ) {
        return fail(
          `This ${label} connection was started in a different harnesst session. Start again from ` +
            "the agent's install page or Deployment tab.",
        );
      }

      // Consume before exchanging the authorization code. DELETE ... RETURNING makes concurrent
      // callbacks race safely: exactly one request can proceed, even across multiple app replicas.
      const consumed = await consumeOAuthStateNonce({
        nonce: state.nonce,
        userId: auth.user.id,
        sessionId: auth.session.id,
      });
      if (!consumed) {
        return fail(
          `This ${label} connection link is invalid, expired, or has already been used. Start ` +
            "again from the agent's install page or Deployment tab.",
        );
      }

      if (callback.error) {
        return fail(
          `${label} authorization was cancelled or denied — the connection was not made. ` +
            "Start again from the agent's install page or Deployment tab.",
        );
      }
      if (!callback.code) {
        return fail(
          `${label} didn't send back an authorization code — the connection was not made. ` +
            "Start again from the agent's install page or Deployment tab.",
        );
      }

      // Tenancy: the signed state names the project, but the SESSION must own it too.
      const project = requireRepo(await requireProject(auth, state.projectId));
      const backUrl = safeReturnTo(state.returnTo) ?? "/dashboard";

      const roster = (await listAgents(project.id)).filter(
        (a) => a.kind === "member",
      );
      const agent = roster.find((a) => a.id === state.agentId);
      if (!agent) {
        return fail("This agent no longer exists in the project.", backUrl);
      }

      // Lock currency (issue #165): the signed state carries the scope set computed when this
      // flow STARTED, and several unconsumed nonces can be valid at once — so a consent tab left
      // open across a Permissions edit + newer reconnect could, completed later, silently
      // re-broaden a just-narrowed grant (or clobber a widened one with an under-scoped token).
      // Re-derive the requirement from a FRESH lock read and refuse a stale flow. Undefined = no
      // auth snapshot for this provider (legacy lock / grant-fallback flows) — nothing to compare
      // against, so the check is skipped exactly where the fallback applies.
      //
      // The read is RAW, never the SWR cache (issue #173): the cache's invalidation is
      // process-local, so with more than one control-plane replica a Permissions edit through
      // replica A leaves replica B's cached lock stale — exactly the broad-over-narrow overwrite
      // this guard exists to refuse. A guard that claims freshness must actually read fresh; a
      // callback is rare and latency-tolerant, so correctness beats cache economy here. (Same
      // rule as cached.server's module doc: reads composed into a write stay raw.)
      const selectionStale = async (): Promise<boolean> => {
        const [source, drafts] = await Promise.all([
          fetchAgentSource(project.repoInstallationId, {
            owner: project.repoOwner,
            repo: project.repoName,
          }),
          listDrafts(project.id),
        ]);
        const lock = overlayLock(
          source.files["eden-lock.json"] ?? null,
          drafts.map((draft) => ({ path: draft.path, content: draft.content })),
        );
        const requiredNow = requiredScopesByProvider(
          lock,
          agent.root === "agent" ? null : agent.name,
        ).get(provider.id);
        if (requiredNow === undefined) return false;
        const started = new Set(state.scopes.split(/\s+/).filter(Boolean));
        return (
          started.size !== requiredNow.length ||
          requiredNow.some((s) => !started.has(s))
        );
      };
      const staleSelectionFail = () =>
        fail(
          `The permissions selected for ${label} changed while this consent was in progress — ` +
            "no connection was made. Start again from the agent's Deployment tab.",
          backUrl,
        );
      // Callback-coverage currency (issue #167): the per-grant client registered when this flow
      // STARTED is immutable, and its approval callbacks cover exactly the environments captured
      // in the signed state. An environment created while the consent tab was open would be
      // silently unregistered — and, predating the grant, would never trip the Connections
      // card's needs-reconnect watermark — so the grant must not be stored. Undefined = no
      // approval callbacks were registered for this flow (operator-client providers, providers
      // without an approvalCallbackPath, or an in-flight pre-coverage state) — nothing to check.
      // Environments REMOVED during consent stay fine: extra registered URIs are harmless.
      const environmentCoverageStale = async (): Promise<boolean> => {
        if (state.environmentIds === undefined) return false;
        const registered = new Set(state.environmentIds);
        const environments = await listAgentEnvironments(agent.id);
        return environments.some((env) => !registered.has(env.id));
      };
      const staleCoverageFail = () =>
        fail(
          `An environment was added to this agent while the ${label} consent was in progress — ` +
            "its approval callbacks aren't covered by the connection's OAuth client, so no " +
            "connection was made. Start again from the agent's Deployment tab.",
          backUrl,
        );
      // First pass BEFORE the exchange: refuse an obviously stale flow without minting tokens.
      if (await selectionStale()) return staleSelectionFail();
      if (await environmentCoverageStale()) return staleCoverageFail();

      // Per-grant registered client (issue #167): the exchange must run against the SAME client
      // the authorize URL named — the signed state carries it. Operator-client providers resolve
      // config exactly as before.
      const config = state.clientId
        ? { clientId: state.clientId }
        : deps.getConfig(provider);
      if (!config) {
        return fail(
          `This harnesst installation no longer has a ${label} OAuth client configured — ask an ` +
            `operator to set the EDEN_${provider.envPrefix}_* env vars.`,
          backUrl,
        );
      }

      const redirectUri = `${publicOrigin(args.request)}${providerRedirectPath(provider)}`;
      let grant;
      try {
        grant = await deps.exchangeCode({
          provider,
          config,
          code: callback.code,
          redirectUri,
          ...(state.codeVerifier ? { codeVerifier: state.codeVerifier } : {}),
        });
      } catch (error) {
        return fail((error as Error).message, backUrl);
      }

      // Granular consent (issue #30): Google lets the user UNCHECK individual scopes on the consent
      // screen. Storing a partial grant as "active" would 403 at runtime — a silent dead-end — so we
      // refuse it here and tell the user to reconnect with every requested permission left checked.
      const missing = missingScopes(state.scopes, grant.scope);
      if (missing.length > 0) {
        return fail(
          `${label} connected, but the following permission was not granted: ${missing.join(", ")}. ` +
            "Reconnect and leave all requested permissions checked.",
          backUrl,
        );
      }

      const accountEmail = await deps.fetchAccountEmail(
        provider,
        grant.accessToken,
      );

      // Capability resource binding (issue #166): providers whose capability declares a
      // provider-side resource (Xero: the tenant/organisation) resolve it here, POST-consent,
      // with the exchange's fresh access token. Exactly one listed resource binds silently; the
      // previously bound resource is kept when still listed (a reconnect must not silently
      // re-target); anything else stores the grant UNBOUND and sends the user to the picker —
      // an unbound capability grant refuses every call and fails deploys with a readable message.
      const capability =
        provider.credentialDelivery === "capability"
          ? getCapability(provider.id)
          : null;
      let resourceId: string | null = null;
      let resourceName: string | null = null;
      let needsResourcePicker = false;
      if (capability?.resource) {
        let resources: Array<{ id: string; name: string }>;
        try {
          resources = deps.listCapabilityResources
            ? await deps.listCapabilityResources(provider.id, grant.accessToken)
            : await capability.resource.list(grant.accessToken, fetch);
        } catch (error) {
          return fail((error as Error).message, backUrl);
        }
        if (resources.length === 0) {
          return fail(
            `The connected ${label} account has no ${capability.resource.label} harnesst can use — ` +
              `connect an account with access to the ${capability.resource.label} this agent should work in.`,
            backUrl,
          );
        }
        const existing = await findGrant({
          projectId: project.id,
          agentId: agent.id,
          provider: provider.id,
        });
        const kept = existing?.resourceId
          ? resources.find((r) => r.id === existing.resourceId)
          : undefined;
        const bound = resources.length === 1 ? resources[0] : kept;
        if (bound) {
          resourceId = bound.id;
          resourceName = bound.name;
        } else {
          needsResourcePicker = true;
        }
      }

      // Second pass IMMEDIATELY before the write: the pre-exchange check reads the lock before
      // the exchange + userinfo network round-trips, so a Permissions edit + newer reconnect
      // could complete entirely inside that gap and this older flow — its exchange finishing
      // last — would still overwrite the fresher grant. Re-checking here shrinks the remaining
      // window to the upsert itself (no network calls inside it), which a full consent
      // round-trip cannot fit into. The freshly minted token is simply discarded, exactly like
      // the granular-consent refusal above. Environment coverage gets the same second pass: an
      // environment created during the exchange round-trip must also refuse the flow, so a
      // stored grant's creation time is a SOUND watermark for the Connections card (every
      // environment older than the grant is covered by its client).
      if (await selectionStale()) return staleSelectionFail();
      if (await environmentCoverageStale()) return staleCoverageFail();

      await upsertGrant({
        projectId: project.id,
        agentId: agent.id,
        provider: provider.id,
        accountEmail,
        scopes: grant.scope || state.scopes,
        refreshToken: grant.refreshToken,
        // The per-grant registered client (issue #167) — every later refresh uses it. Null for
        // operator-client providers (no behavior change).
        clientId: state.clientId ?? null,
        // The capability resource binding (issue #166); null for non-capability providers AND
        // for the picker case (bound by /connections/:provider/resource before first use).
        resourceId,
        resourceName,
        createdBy: auth.user.id,
      });

      await getRuntime().data.audit.record({
        orgId: project.orgId,
        actorUserId: auth.user.id,
        action: "connection.connect",
        target: agent.name,
        meta: {
          provider: provider.id,
          accountEmail,
          scopes: grant.scope || state.scopes,
        },
      });

      // Several resources and no prior binding (issue #166): straight to the picker — the grant
      // exists but is unusable until one is bound, so a redeploy now would fail its validation.
      if (needsResourcePicker) {
        const params = new URLSearchParams({
          project: project.id,
          agent: agent.name,
          returnTo: backUrl,
        });
        throw redirect(`/connections/${provider.id}/resource?${params}`);
      }

      // Auto-redeploy (issue #69): the grant only reaches the RUNNING container on the next deploy,
      // so the connect action itself redeploys every live environment (image reused, fresh grant
      // re-injected). The helper never throws — queue errors come back as an "error" outcome — but
      // wrap defensively so an unexpected reject can never lose the just-saved grant.
      let outcome: Awaited<ReturnType<typeof redeployAfterConnect>>;
      try {
        outcome = await redeployAfterConnect({
          projectId: project.id,
          agentId: agent.id,
          createdBy: auth.user.id,
        });
      } catch {
        throw redirect(withParams(backUrl, { connected: provider.id }));
      }

      const params: Record<string, string> = { connected: provider.id };
      if (outcome.status === "redeployed") params.redeploy = "queued";
      else if (outcome.status === "staged") params.redeploy = "staged";
      else if (outcome.status === "error") {
        params.redeploy = "error";
        params.redeployError = outcome.message.slice(0, 200);
      }
      throw redirect(withParams(backUrl, params));
    },
    // OAuth state is bound to the initiating Better Auth session. If that session expired, the
    // round-trip cannot safely resume; keep the provider's code/state out of the login returnTo
    // URL.
    { ensureSignedIn: true, returnTo: "/dashboard" },
  );
}
