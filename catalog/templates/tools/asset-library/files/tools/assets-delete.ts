import { defineTool } from "eve/tools";
import { z } from "zod";

import { callAssetRelay, validAssetId } from "../lib/asset-library.js";

export default defineTool({
  description:
    "Delete a complete shared asset from the repository. The deletion is committed and recoverable from git history.",
  inputSchema: z.object({
    id: z.string().refine(validAssetId).describe("Asset id to delete."),
  }),
  async execute({ id }) {
    return callAssetRelay({ op: "delete", id });
  },
});
