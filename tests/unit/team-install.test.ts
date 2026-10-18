import { describe, expect, it } from "vitest";

import type { ResolvedTemplate } from "~/marketplace/compose.server";
import {
  emptyLock,
  findInstall,
  parseLock,
  teamRoster,
} from "~/marketplace/lock";
import {
  installIsCurrent,
  matchTeamRoster,
  planTeamInstall,
  planTeamUpdate,
} from "~/marketplace/team-install.server";

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

function lockOf(plan: { writes: Array<{ path: string; content: string }> }) {
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

describe("planTeamUpdate", () => {
  // The team as installed at v0.1.0, with intake renamed to "iris" at install time.
  const installed = planTeamInstall({
    ...base,
    members: [
      { role: "intake", name: "iris", template: agent("front") },
      {
        role: "infra",
        name: "atlas",
        template: {
          ...agent("ops", { files: ["instructions.md", "old.md"] }),
          files: { "instructions.md": "# ops\n", "old.md": "old\n" },
        },
      },
    ],
  });
  const lock = lockOf(installed);
  const repoPaths = installed.writes.map((w) => w.path);
  const nextTeam: ResolvedTemplate = {
    ...team,
    manifest: { ...team.manifest, version: "0.2.0" },
    hash: "hash-crew-2",
  };
  const front2: ResolvedTemplate = {
    ...agent("front", { version: "1.1.0" }),
    files: { "instructions.md": "# front, revised\n" },
    hash: "hash-front-2",
  };
  const ops2: ResolvedTemplate = {
    ...agent("ops", { version: "1.1.0" }),
    hash: "hash-ops-2",
  };
  const member = (role: string, name: string, template: ResolvedTemplate) => ({
    role,
    name,
    template,
    root: `agents/${name}/agent`,
    packageJson: null,
    model: null,
    effort: null,
  });
  const updateBase = {
    team: nextTeam,
    registry: "fixture",
    repoPaths,
    drafts: [],
    lock,
    rosterNames: ["iris", "atlas"],
  };

  it("updates every stale member and the team row in one lock, keeping the role map", () => {
    const plan = planTeamUpdate({
      ...updateBase,
      members: [
        member("intake", "iris", front2),
        member("infra", "atlas", ops2),
      ],
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.updated).toEqual(["iris", "atlas"]);
    expect(
      plan.writes.find((w) => w.path === "agents/iris/agent/instructions.md")
        ?.content,
    ).toBe("# front, revised\n");
    expect(plan.deletions).toEqual(["agents/atlas/agent/old.md"]);

    const next = lockOf(plan);
    expect(findInstall(next, "front", "iris")?.version).toBe("1.1.0");
    expect(findInstall(next, "ops", "atlas")?.version).toBe("1.1.0");
    expect(findInstall(next, "crew", null)?.version).toBe("0.2.0");
    expect(teamRoster(next)?.roster).toEqual([
      { role: "intake", member: "iris" },
      { role: "infra", member: "atlas" },
    ]);
  });

  it("leaves members already on the catalog version alone", () => {
    const plan = planTeamUpdate({
      ...updateBase,
      members: [
        member("intake", "iris", front2),
        member("infra", "atlas", {
          ...agent("ops", { files: ["instructions.md", "old.md"] }),
          files: { "instructions.md": "# ops\n", "old.md": "old\n" },
        }),
      ],
    });
    expect(plan.updated).toEqual(["iris"]);
    expect(plan.deletions).toEqual([]);
    expect(plan.writes.some((w) => w.path.startsWith("agents/atlas/"))).toBe(
      false,
    );
  });

  it("treats a changed bundled include as stale even when the parent hash is unchanged", () => {
    const withSkill = (hash: string): ResolvedTemplate => ({
      ...agent("front"),
      includes: [
        {
          type: "skill",
          id: "onboard",
          name: "onboard",
          version: "1.0.0",
          hash,
        },
      ],
    });
    const entry = findInstall(lock, "front", "iris")!;
    const recorded = { ...entry, includes: withSkill("h1").includes };
    expect(installIsCurrent(recorded, withSkill("h1"))).toBe(true);
    expect(installIsCurrent(recorded, withSkill("h2"))).toBe(false);
  });

  it("blocks the whole team when one member's new files collide with local ones", () => {
    const plan = planTeamUpdate({
      ...updateBase,
      repoPaths: [...repoPaths, "agents/atlas/agent/notes.md"],
      members: [
        member("intake", "iris", front2),
        member("infra", "atlas", {
          ...agent("ops", {
            version: "1.1.0",
            files: ["instructions.md", "notes.md"],
          }),
          files: { "instructions.md": "# ops\n", "notes.md": "notes\n" },
          hash: "hash-ops-2",
        }),
      ],
    });
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatch(/^atlas: /);
  });
});

describe("matchTeamRoster", () => {
  const lock = lockOf(
    planTeamInstall({
      ...base,
      members: [
        { role: "intake", name: "iris", template: agent("front") },
        { role: "infra", name: "atlas", template: agent("ops") },
      ],
    }),
  );

  it("maps each installed role to its member and the catalog agent", () => {
    expect(matchTeamRoster(lock, team.manifest)).toMatchObject({
      error: null,
      members: [
        { role: "intake", name: "iris", agentId: "front" },
        { role: "infra", name: "atlas", agentId: "ops" },
      ],
    });
  });

  it("refuses a role that now runs a different agent template", () => {
    const moved = {
      ...team.manifest,
      roster: [
        { role: "intake", agent: "front", name: "hermes" },
        { role: "infra", agent: "ops-v2", name: "atlas" },
      ],
    };
    expect(matchTeamRoster(lock, moved).error).toMatch(/"infra" role/);
  });

  it("refuses a role the catalog dropped or added", () => {
    const dropped = {
      ...team.manifest,
      roster: [{ role: "intake", agent: "front", name: "hermes" }],
    };
    expect(matchTeamRoster(lock, dropped).error).toMatch(/no longer has/);
    const added = {
      ...team.manifest,
      roster: [
        ...team.manifest.roster!,
        { role: "qa", agent: "tester", name: "argus" },
      ],
    };
    expect(matchTeamRoster(lock, added).error).toMatch(/"qa"/);
  });

  it("refuses when the team isn't installed", () => {
    expect(matchTeamRoster(emptyLock(), team.manifest).error).toMatch(
      /isn't installed/,
    );
  });
});
