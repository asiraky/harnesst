import { defineAgent } from "eve";
export default defineAgent({
  description:
    "Use for the spec axis of a code review: pass the repository, branch, diff command, spec and brief.",
  model: "anthropic/claude-sonnet-5",
  modelContextWindowTokens: 200_000,
});
