import { defineAgent } from "eve";
export default defineAgent({
  description:
    "Use to review work on a branch along two axes, standards and spec: pass the repository, branch, fixed point and specs; it returns both reports side by side.",
  model: "anthropic/claude-sonnet-5",
  modelContextWindowTokens: 200_000,
});
