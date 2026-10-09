import { describe, expect, it } from "vitest";

import type { ResolvedTemplate } from "~/marketplace/compose.server";
import {
  emptyLock,
  findInstall,
  parseLock,
  teamRoster,
} from "~/marketplace/lock";
import { planTeamInstall } from "~/marketplace/team-install.server";

function agent(
  id: string,
  extra: Partial<ResolvedTemplate["manifest"]> = {},
): ResolvedTemplate {
  return {
    manifest: {
      id,
      type: "agent",
      name: id,
      description: `${id} agent`,
      version: "1.0.0",
      eve: ">=0.1.0",
      subagentCompatible: false,
      files: ["instructions.md"],
      ...extra,
    },
    files: { "instructions.md": `# ${id}\n` },
    hash: `hash-${id}`,
    assistantSkill: null,
    includes: [],
    auths: [],
  };
}

const team: ResolvedTemplate = {
  manifest: {
    id: "crew",
    type: "team",
    name: "Crew",
    description: "A crew.",
    version: "0.1.0",
    eve: ">=0.1.0",
    subagentCompatible: false,
    files: [],
    roster: [
      { role: "intake", agent: "front", name: "hermes" },
      { role: "infra", agent: "ops", name: "atlas" },
    ],
  },
  files: {},
  hash: "hash-crew",
  assistantSkill: null,
  includes: [],
  auths: [],
};

const base = {
  team,
  registry: "fixture",
  repoPaths: [],
  drafts: [],
  lock: emptyLock(),
  rosterNames: [],
  model: null,
  effort: null,
};

function lockOf(plan: ReturnType<typeof planTeamInstall>) {
  const writes = plan.writes.filter((w) => w.path === "harnesst-lock.json");
  expect(writes).toHaveLength(1);
  return parseLock(JSON.parse(writes[0].content));
}

describe("planTeamInstall", () => {
  it("installs every member and records the role map in one lock", () => {
    const plan = planTeamInstall({
      ...base,
      members: [
        { role: "intake", name: "hermes", template: agent("front") },
        {
          role: "infra",
          name: "atlas",
          template: agent("ops", {
            secrets: [{ name: "CLOUDFLARE_API_TOKEN" }],
            provisioning: ["supabase-ledger"],
          }),
        },
      ],
    });
    expect(plan.conflicts).toEqual([]);
    const paths = plan.writes.map((w) => w.path);
    expect(paths).toContain("agents/hermes/agent/instructions.md");
    expect(paths).toContain("agents/atlas/agent/instructions.md");
    expect(paths).toContain("agents/hermes/package.json");
    expect(paths).toContain("agents/atlas/package.json");
    expect(paths.at(-1)).toBe("harnesst-lock.json");

    const lock = lockOf(plan);
    expect(findInstall(lock, "front", "hermes")).toBeDefined();
    expect(findInstall(lock, "ops", "atlas")).toBeDefined();
    expect(teamRoster(lock)).toEqual({
      templateId: "crew",
      roster: [
        { role: "intake", member: "hermes" },
        { role: "infra", member: "atlas" },
      ],
    });
    expect(plan.members.find((m) => m.name === "atlas")).toMatchObject({
      secrets: [{ name: "CLOUDFLARE_API_TOKEN" }],
      provisioning: ["supabase-ledger"],
    });
  });

  it("keeps installs already in the lock", () => {
    const first = planTeamInstall({
      ...base,
      members: [{ role: "intake", name: "hermes", template: agent("front") }],
    });
    const plan = planTeamInstall({
      ...base,
      lock: lockOf(first),
      rosterNames: ["hermes"],
      members: [{ role: "intake", name: "iris", template: agent("front") }],
    });
    const lock = lockOf(plan);
    expect(findInstall(lock, "front", "hermes")).toBeDefined();
    expect(findInstall(lock, "front", "iris")).toBeDefined();
  });

  it("blocks on a name that already exists, naming the member", () => {
    const plan = planTeamInstall({
      ...base,
      rosterNames: ["atlas"],
      members: [
        { role: "intake", name: "hermes", template: agent("front") },
        { role: "infra", name: "atlas", template: agent("ops") },
      ],
    });
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatch(/^atlas: /);
  });

  it("blocks when two roles are given the same name", () => {
    const plan = planTeamInstall({
      ...base,
      members: [
        { role: "intake", name: "same", template: agent("front") },
        { role: "infra", name: "same", template: agent("ops") },
      ],
    });
    expect(plan.conflicts.length).toBeGreaterThan(0);
  });

  it("blocks an invalid member name", () => {
    const plan = planTeamInstall({
      ...base,
      members: [
        { role: "intake", name: "Not Valid", template: agent("front") },
      ],
    });
    expect(plan.conflicts).toHaveLength(1);
  });
});
