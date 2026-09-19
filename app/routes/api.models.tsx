/** Active workspace's connected-provider model union for every ModelSelect surface. */
import { sessionLoader } from "~/auth/session.server";
import type { LoaderFunctionArgs } from "react-router";

import { resolveActiveWorkspace } from "~/auth/workspace.server";
import {
  listModelConnections,
  resolveModelConnectionId,
} from "~/models/provider-connections.server";
import { parseProviderModelReference } from "~/models/provider-reference";
import { auth as betterAuth } from "~/lib/auth.server";
import type { ModelsApiResponse } from "~/components/model-select";
import {
  findWorkspaceModel,
  listWorkspaceModelCatalog,
} from "~/models/union.server";

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }): Promise<ModelsApiResponse> => {
      const active = await resolveActiveWorkspace(auth);
      const requestedModel =
        new URL(args.request.url).searchParams.get("selected") || null;
      if (!active?.org)
        return {
          models: [],
          unavailable: [],
          requestedModel,
          selectedModel: null,
        };

      const reference = parseProviderModelReference(requestedModel ?? "");
      const [connections, resolvedId, permission] = await Promise.all([
        listModelConnections(active.org.id),
        reference
          ? resolveModelConnectionId(active.org.id, reference.connectionId)
          : Promise.resolve(null),
        betterAuth.api.hasPermission({
          headers: auth.requestHeaders,
          body: {
            organizationId: active.org.id,
            permissions: { organization: ["update"] },
          },
        }),
      ]);
      const selectedConnection = reference
        ? connections.find(
            (connection) =>
              connection.id === resolvedId &&
              connection.provider === reference.provider,
          )
        : undefined;
      const connectionMetadata = {
        canManageConnections: permission.success,
        inactiveConnections: connections
          .filter((connection) => connection.status !== "active")
          .map((connection) => ({
            id: connection.id,
            label: connection.label,
            status: connection.status,
          })),
        selectedConnection: reference
          ? {
              connectionId: selectedConnection?.id ?? null,
              status: selectedConnection?.status ?? ("missing" as const),
              settingsUrl: selectedConnection
                ? `/settings/connections#connection-${selectedConnection.id}`
                : "/settings/connections",
            }
          : null,
      };

      try {
        const catalog = await listWorkspaceModelCatalog(active.org.id);
        // Recovered IDs resolve existing selections without becoming new picker options.
        const selectedModel = requestedModel
          ? (catalog.models.find((model) => model.id === requestedModel) ??
            (await findWorkspaceModel(active.org.id, requestedModel)))
          : null;
        return {
          ...catalog,
          requestedModel,
          selectedModel,
          ...connectionMetadata,
        };
      } catch (error) {
        console.warn("[api.models] model catalog unavailable:", error);
        return {
          ...connectionMetadata,
          models: [],
          requestedModel,
          selectedModel: null,
          unavailable: [
            {
              connectionId: "workspace",
              provider: "unknown",
              connectionLabel: "workspace model providers",
              message:
                error instanceof Error ? error.message : "Catalog unavailable",
            },
          ],
        };
      }
    },
    { ensureSignedIn: true },
  );
