/** Connected-only workspace model union and ownership lookup (issue #28, Phase 2). */
import type { ModelCatalogEntry } from "~/models/catalog.server";
import { SwrCache } from "~/github/cache.server";
import {
  getActiveModelConnection,
  getApiKeyConnection,
  listActiveModelConnections,
  type ModelConnection,
} from "~/models/provider-connections.server";
import { listProviderModels } from "~/models/provider-catalog.server";
import {
  MODEL_PROVIDERS,
  buildProviderModelReference,
  parseProviderModelReference,
  type ModelProviderId,
} from "~/models/provider-reference";

export interface UnavailableProviderCatalog {
  connectionId: string;
  provider: ModelProviderId;
  connectionLabel: string;
  message: string;
}

export interface WorkspaceModelCatalog {
  models: ModelCatalogEntry[];
  unavailable: UnavailableProviderCatalog[];
}

export interface WorkspaceModelDeps {
  listConnections: typeof listActiveModelConnections;
  getConnection: typeof getActiveModelConnection;
  getApiKey: typeof getApiKeyConnection;
  listProvider: typeof listProviderModels;
}

const defaultDeps: WorkspaceModelDeps = {
  listConnections: listActiveModelConnections,
  getConnection: getActiveModelConnection,
  getApiKey: getApiKeyConnection,
  listProvider: listProviderModels,
};

const MODEL_CATALOG_TTL_MS = 60 * 60 * 1000;
const globalForCatalogCache = globalThis as unknown as {
  __harnesstProviderModelCatalogCache?: SwrCache;
};
const providerModelCatalogCache =
  globalForCatalogCache.__harnesstProviderModelCatalogCache ?? new SwrCache();
if (process.env.NODE_ENV !== "production") {
  globalForCatalogCache.__harnesstProviderModelCatalogCache =
    providerModelCatalogCache;
}

/** Attach provider + connection ownership to one provider-native catalog. */
export function qualifyConnectionCatalog(
  connection: ModelConnection,
  catalog: ModelCatalogEntry[],
): ModelCatalogEntry[] {
  const definition = MODEL_PROVIDERS[connection.provider];
  return catalog.map((model) => {
    const upstreamModelId = model.upstreamModelId ?? model.id;
    const description =
      connection.provider === "codex"
        ? `OpenAI Codex subscription${
            connection.accountEmail ? ` (${connection.accountEmail})` : ""
          }`
        : (model.description ?? definition.displayName);
    return {
      ...model,
      id: buildProviderModelReference(
        connection.provider,
        connection.id,
        upstreamModelId,
      ),
      name: model.name,
      description,
      providers: [connection.provider],
      provider: connection.provider,
      providerName: definition.displayName,
      connectionId: connection.id,
      connectionLabel: connection.label,
      upstreamModelId,
    };
  });
}

async function catalogForConnection(
  orgId: string,
  connection: ModelConnection,
  deps: WorkspaceModelDeps,
): Promise<ModelCatalogEntry[]> {
  const apiKeyConnection =
    connection.provider === "codex"
      ? null
      : await deps.getApiKey(orgId, connection.id);
  if (connection.provider !== "codex" && !apiKeyConnection) {
    throw new Error("The connection has no usable API key.");
  }
  const fetchCatalog = () =>
    deps.listProvider(connection.provider, apiKeyConnection?.apiKey ?? null);
  // Picker opens and playground sends can ask for the same catalog repeatedly. Cache only the
  // production accessors (injected unit-test providers remain perfectly isolated), and qualify
  // after the cache so a connection rename is reflected immediately.
  const catalog =
    deps === defaultDeps
      ? await providerModelCatalogCache.get(
          `provider-models:${orgId}:${connection.provider}:${connection.id}`,
          MODEL_CATALOG_TTL_MS,
          fetchCatalog,
        )
      : await fetchCatalog();
  return qualifyConnectionCatalog(connection, catalog);
}

/**
 * Fetch every active connection's catalog independently. One provider outage never hides healthy
 * connections; callers get explicit unavailable metadata so the UI can distinguish an empty
 * workspace from a partial upstream failure.
 */
export async function listWorkspaceModelCatalog(
  orgId: string,
  deps: WorkspaceModelDeps = defaultDeps,
): Promise<WorkspaceModelCatalog> {
  const connections = await deps.listConnections(orgId);
  const results = await Promise.all(
    connections.map(async (connection) => {
      try {
        return {
          models: await catalogForConnection(orgId, connection, deps),
          unavailable: null,
        };
      } catch (error) {
        return {
          models: [] as ModelCatalogEntry[],
          unavailable: {
            connectionId: connection.id,
            provider: connection.provider,
            connectionLabel: connection.label,
            message:
              error instanceof Error
                ? error.message
                : "The provider catalog is unavailable.",
          } satisfies UnavailableProviderCatalog,
        };
      }
    }),
  );
  return {
    models: results.flatMap((result) => result.models),
    unavailable: results.flatMap((result) =>
      result.unavailable ? [result.unavailable] : [],
    ),
  };
}

/** Models-only wrapper retained for existing `/api/models` consumers. Never falls back. */
export async function listWorkspaceModels(
  orgId: string,
  deps: WorkspaceModelDeps = defaultDeps,
): Promise<ModelCatalogEntry[]> {
  return (await listWorkspaceModelCatalog(orgId, deps)).models;
}

/** Resolve only a model owned by an active connection in this exact workspace. */
export async function findWorkspaceModel(
  orgId: string,
  id: string,
  deps: WorkspaceModelDeps = defaultDeps,
): Promise<ModelCatalogEntry | null> {
  const reference = parseProviderModelReference(id);
  if (!reference) return null;
  const connection = await deps.getConnection(orgId, reference.connectionId);
  if (!connection || connection.provider !== reference.provider) return null;
  try {
    const models = await catalogForConnection(orgId, connection, deps);
    return models.find((model) => model.id === id) ?? null;
  } catch {
    return null;
  }
}

/**
 * Cheap request-time ownership check for a model that was already selected and stored. Unlike
 * `findWorkspaceModel`, this does not refetch a provider's full catalog on every playground turn;
 * it only proves the exact connection is still active in this workspace.
 */
export async function ownsWorkspaceModelReference(
  orgId: string,
  id: string,
  deps: Pick<WorkspaceModelDeps, "getConnection"> = defaultDeps,
): Promise<boolean> {
  const reference = parseProviderModelReference(id);
  if (!reference) return false;
  const connection = await deps.getConnection(orgId, reference.connectionId);
  return connection?.provider === reference.provider;
}
