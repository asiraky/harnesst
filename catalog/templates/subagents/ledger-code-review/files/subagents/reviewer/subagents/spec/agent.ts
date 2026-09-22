import { defineAgent } from "eve";
export default defineAgent({
  description: "Perform only the spec axis of the supplied code review; return findings to reviewer.",
  model: "anthropic/claude-sonnet-5",
  modelContextWindowTokens: 200_000,
});
