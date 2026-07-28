/**
 * Path guard for the agent surface (PRD §7.9): the root agent, team members'
 * agents/<member>/agent/ directories, and the dependency manifests — nothing else. Plus the
 * platform surface (issue #254), which is refused by name rather than by "invalid path".
 */
import { describe, expect, it } from "vitest";

import { isPlatformPath, platformRootForAgentRoot } from "~/eve/parse";
import { memberFromPath } from "~/project/agent-context.server";
import {
  normalizeAgentPath,
  PLATFORM_PATH_REFUSAL,
  platformPathRefusal,
} from "~/project/guard.server";

describe("normalizeAgentPath", () => {
  it("accepts root-agent paths and the manifest allowlist", () => {
    expect(normalizeAgentPath("agent/instructions.md")).toBe("agent/instructions.md");
    expect(normalizeAgentPath("agent/tools/x.ts")).toBe("agent/tools/x.ts");
    expect(normalizeAgentPath("package.json")).toBe("package.json");
    expect(normalizeAgentPath("package-lock.json")).toBe("package-lock.json");
  });

  it("accepts team member paths and their manifests", () => {
    expect(normalizeAgentPath("agents/pm/agent/tools/x.ts")).toBe(
      "agents/pm/agent/tools/x.ts",
    );
    expect(normalizeAgentPath("agents/pm/package.json")).toBe("agents/pm/package.json");
    expect(normalizeAgentPath("agents/pm/package-lock.json")).toBe(
      "agents/pm/package-lock.json",
    );
  });

  it("rejects escapes and everything outside the agent surface", () => {
    expect(normalizeAgentPath("agents/pm/agent/../../../etc/passwd")).toBeNull();
    expect(normalizeAgentPath("agents/pm/secrets.txt")).toBeNull();
    expect(normalizeAgentPath("agents/pm/agent/")).toBeNull();
    expect(normalizeAgentPath("Dockerfile")).toBeNull();
    expect(normalizeAgentPath("src/index.ts")).toBeNull();
    expect(normalizeAgentPath("agents/../package.json")).toBeNull();
  });
});

describe("platform paths (issue #254)", () => {
  it("derives the platform root as a sibling of the agent root", () => {
    expect(platformRootForAgentRoot("agent")).toBe("harnesst");
    expect(platformRootForAgentRoot("agents/ivy/agent")).toBe("agents/ivy/harnesst");
  });

  it("matches platform files in both layouts", () => {
    expect(isPlatformPath("harnesst/model.ts")).toBe(true);
    expect(isPlatformPath("harnesst/nested/github-channel.ts")).toBe(true);
    expect(isPlatformPath("agents/ivy/harnesst/github-channel.ts")).toBe(true);
  });

  it("does NOT match the assistant's config surface", () => {
    // `.harnesst/assistant/**` is a different surface with a different owner — the leading dot
    // is the whole difference, and matching it here would lock the assistant out of its own
    // instructions.
    expect(isPlatformPath(".harnesst/assistant/instructions.md")).toBe(false);
    expect(isPlatformPath(".harnesst/assistant/skills/x.md")).toBe(false);
  });

  it("matches neither bare roots, traversals, nor lookalikes", () => {
    expect(isPlatformPath("harnesst")).toBe(false);
    expect(isPlatformPath("harnesst/")).toBe(false);
    expect(isPlatformPath("harnesst/../package.json")).toBe(false);
    expect(isPlatformPath("harnesst/./model.ts")).toBe(false);
    expect(isPlatformPath("harnesst/nested/")).toBe(false);
    expect(isPlatformPath("agents/../harnesst/model.ts")).toBe(false);
    expect(isPlatformPath("agent/harnesst-model.ts")).toBe(false);
    expect(isPlatformPath("app/harnesst/model.ts")).toBe(false);
    expect(isPlatformPath("harnesst-lock.json")).toBe(false);
  });

  it("stays outside the editable surface, and refuses by name", () => {
    expect(normalizeAgentPath("harnesst/model.ts")).toBeNull();
    expect(normalizeAgentPath("agents/ivy/harnesst/github-channel.ts")).toBeNull();
    expect(platformPathRefusal("harnesst/model.ts")).toBe(PLATFORM_PATH_REFUSAL);
    // Leading-slash tolerance matches normalizeAgentPath's, so a `/harnesst/...` write refuses
    // for the right reason instead of falling through to the generic rejection.
    expect(platformPathRefusal(" /agents/ivy/harnesst/model.ts")).toBe(PLATFORM_PATH_REFUSAL);
    expect(platformPathRefusal("agent/instructions.md")).toBeNull();
    expect(platformPathRefusal(".harnesst/assistant/instructions.md")).toBeNull();
  });
});

describe("memberFromPath", () => {
  it("extracts the member from team paths, null otherwise", () => {
    expect(memberFromPath("agents/deployer/agent/tools/x.ts")).toBe("deployer");
    expect(memberFromPath("agent/tools/x.ts")).toBeNull();
    expect(memberFromPath("package.json")).toBeNull();
  });
});
