import { defineAgent } from "eve";
export default defineAgent({
  description:
    "Use for independent review of a pull request: inspect the supplied head SHA against the specification and return concrete defects or approval.",
  model: "anthropic/claude-sonnet-5",
  modelContextWindowTokens: 200_000,
});
