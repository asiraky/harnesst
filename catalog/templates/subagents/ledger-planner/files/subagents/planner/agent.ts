import { defineAgent } from "eve";
export default defineAgent({
  description: "Break one settled issue specification into internal tickets and dependencies; return unresolved decisions to intake.",
  model: "anthropic/claude-sonnet-5",
  modelContextWindowTokens: 200_000,
});
