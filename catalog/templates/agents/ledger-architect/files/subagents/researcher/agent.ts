import { defineAgent } from "eve";
export default defineAgent({
  description:
    "Use to find a fact in the product repository during a grilling session: pass the repository, branch and question; it returns the fact with file references.",
  model: "anthropic/claude-sonnet-5",
  modelContextWindowTokens: 200_000,
});
