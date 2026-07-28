import { defineTool } from "eve/tools";
import { z } from "zod";

import { harnesstCall } from "../lib/harnesstApi";

export default defineTool({
  description:
    "Learn the repository at a glance: whether it is a single agent or a team, the roster of " +
    "members (name, root directory, the NAMES of secrets each has set), your own configured " +
    "instructions/skills/schedules, and current project state. It also lists the marketplace " +
    "installs recorded in harnesst-lock.json — which template owns which files, at what version, " +
    "and whether the catalog has a newer one — so you can tell a template-owned file from a " +
    "hand-authored one before you touch it. This is required before proposing " +
    "any plan, suggestion, or change; pair it with inspecting the actual git checkout so work is " +
    "grounded in both harnesst's control-plane context and the repository on disk.",
  inputSchema: z.object({}),
  async execute() {
    return harnesstCall("project-context");
  },
});
