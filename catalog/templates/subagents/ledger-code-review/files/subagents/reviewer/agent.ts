import { defineAgent } from "eve";
export default defineAgent({
  description: "Execute the verbatim two-axis code-review procedure on supplied committed base/head revisions and scope.",
  model: "anthropic/claude-sonnet-5",
  modelContextWindowTokens: 200_000,
});
