import { defineAgent } from "eve";
export default defineAgent({
  description: "Independently find correctness, failure-handling and security defects in the supplied ticket or integrated issue diff.",
  model: "anthropic/claude-sonnet-5",
  modelContextWindowTokens: 200_000,
});
