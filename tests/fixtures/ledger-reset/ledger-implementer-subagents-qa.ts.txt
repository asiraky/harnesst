import { defineAgent } from "eve";
export default defineAgent({
  description:
    "Use for browser QA of a preview: verify acceptance criteria and failure paths against the supplied head SHA, and return pass/fail with reproducible evidence.",
  model: "anthropic/claude-sonnet-5",
  modelContextWindowTokens: 200_000,
});
