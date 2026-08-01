import { defineTool } from "eve/tools";
import { z } from "zod";

import { callAssetRelay } from "../lib/asset-library";

export default defineTool({
  description:
    "List the durable shared assets available to every agent in this repository.",
  inputSchema: z.object({}),
  async execute() {
    return callAssetRelay({ op: "list" });
  },
});
