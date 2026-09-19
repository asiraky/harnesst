/** Active workspace's connected-provider model union for every ModelSelect surface. */
import { sessionLoader } from "~/auth/session.server";
import type { LoaderFunctionArgs } from "react-router";

import { resolveActiveWorkspace } from "~/auth/workspace.server";
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

      try {
        const catalog = await listWorkspaceModelCatalog(active.org.id);
        // Recovered IDs resolve existing selections without becoming new picker options.
        const selectedModel = requestedModel
          ? (catalog.models.find((model) => model.id === requestedModel) ??
            (await findWorkspaceModel(active.org.id, requestedModel)))
          : null;
        return { ...catalog, requestedModel, selectedModel };
      } catch (error) {
        console.warn("[api.models] model catalog unavailable:", error);
        return {
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
