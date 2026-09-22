import { defineAgent } from "eve";
export default defineAgent({
  description: "Investigate a bounded codebase question for intake; report file references, facts and unknowns without making product decisions.",
  model: "anthropic/claude-sonnet-5",
  modelContextWindowTokens: 200_000,
});
