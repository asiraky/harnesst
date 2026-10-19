import { defineAgent } from "eve";
export default defineAgent({
  description:
    "Use at breakdown to split an issue into tracer-bullet tickets: pass the issue spec, repository and issue branch; it returns numbered tickets with their blocking edges.",
  model: "anthropic/claude-sonnet-5",
  modelContextWindowTokens: 200_000,
});
