import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  callAssetRelay,
  readAssetDirectory,
  validAssetId,
} from "../lib/asset-library.js";

export default defineTool({
  description:
    "Create or replace a durable shared asset with every file from a local directory. Put replaces the whole asset; get-modify-put for partial edits.",
  inputSchema: z.object({
    id: z
      .string()
      .refine(validAssetId)
      .describe("Asset id, for example templates/property-page."),
    sourcePath: z
      .string()
      .min(1)
      .describe("Directory under /workspace/home to upload."),
    description: z
      .string()
      .max(2000)
      .optional()
      .describe("What the asset is for."),
  }),
  async execute({ id, sourcePath, description }) {
    const source = await readAssetDirectory(sourcePath);
    if (!source.ok) return source;
    return callAssetRelay({ op: "put", id, description, files: source.files });
  },
});
