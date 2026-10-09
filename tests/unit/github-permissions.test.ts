import { describe, expect, it } from "vitest";

import { missingAppPermissions } from "~/github/app-manifest.server";
import {
  emptyLock,
  githubPermissionsForMember,
  teamRoster,
  upsertInstall,
  type InstallEntry,
} from "~/marketplace/lock";
import {
  mergeGitHubPermissions,
  templateManifestSchema,
} from "~/marketplace/manifest";

function entry(extra: Partial<InstallEntry>): InstallEntry {
  return {
    id: "x",
    type: "skill",
    name: "X",
    version: "1.0.0",
    hash: "h",
    registry: "fixture",
    member: null,
    files: [],
    ...extra,
  };
}

describe("mergeGitHubPermissions", () => {
  it("unions and lets write beat read in either order", () => {
    expect(
      mergeGitHubPermissions(
        { contents: "read", issues: "write" },
        { contents: "write" },
      ),
    ).toEqual({ contents: "write", issues: "write" });
    expect(
      mergeGitHubPermissions({ contents: "write" }, { contents: "read" }),
    ).toEqual({
      contents: "write",
    });
    expect(mergeGitHubPermissions(undefined, undefined)).toEqual({});
  });
});

describe("missingAppPermissions", () => {
  it("reports absent and under-granted permissions; admin covers write", () => {
    expect(
      missingAppPermissions(
        {
          contents: "write",
          issues: "write",
          workflows: "write",
          actions: "read",
        },
        { contents: "read", issues: "admin", actions: "read" },
      ),
    ).toEqual(["contents:write", "workflows:write"]);
  });
});

describe("githubPermissionsForMember", () => {
  it("merges only that member's installs", () => {
    let lock = emptyLock();
    lock = upsertInstall(
      lock,
      entry({
        id: "a",
        member: "atlas",
        github: { permissions: { administration: "write" } },
      }),
    );
    lock = upsertInstall(
      lock,
      entry({
        id: "b",
        member: "atlas",
        github: { permissions: { actions: "read" } },
      }),
    );
    lock = upsertInstall(
      lock,
      entry({
        id: "c",
        member: "hermes",
        github: { permissions: { secrets: "write" } },
      }),
    );
    expect(githubPermissionsForMember(lock, "atlas")).toEqual({
      administration: "write",
      actions: "read",
    });
    expect(githubPermissionsForMember(lock, "nobody")).toEqual({});
  });
});

describe("teamRoster", () => {
  it("returns null without a team install, else its role map", () => {
    expect(teamRoster(emptyLock())).toBeNull();
    const lock = upsertInstall(
      emptyLock(),
      entry({
        id: "crew",
        type: "team",
        roster: [{ role: "intake", member: "hermes" }],
      }),
    );
    expect(teamRoster(lock)).toEqual({
      templateId: "crew",
      roster: [{ role: "intake", member: "hermes" }],
    });
  });
});

describe("team manifest rules", () => {
  const team = {
    id: "crew",
    type: "team",
    name: "Crew",
    description: "A crew.",
    version: "0.1.0",
    eve: ">=0.1.0",
    subagentCompatible: false,
    files: [],
    roster: [{ role: "intake", agent: "front", name: "hermes" }],
  };

  it("accepts a roster-only team", () => {
    expect(templateManifestSchema.safeParse(team).success).toBe(true);
  });

  it.each([
    ["no roster", { roster: undefined }],
    ["files", { files: ["x.md"] }],
    ["includes", { includes: [{ type: "skill", id: "s" }] }],
    [
      "a duplicate role",
      {
        roster: [
          { role: "intake", agent: "front", name: "a" },
          { role: "intake", agent: "front", name: "b" },
        ],
      },
    ],
    [
      "a duplicate name",
      {
        roster: [
          { role: "intake", agent: "front", name: "a" },
          { role: "infra", agent: "ops", name: "a" },
        ],
      },
    ],
  ])("rejects a team with %s", (_label, patch) => {
    expect(
      templateManifestSchema.safeParse({ ...team, ...patch }).success,
    ).toBe(false);
  });

  it("rejects a roster on a non-team template", () => {
    const skill = {
      ...team,
      type: "skill",
      files: ["skills/x.md"],
      roster: undefined,
    };
    expect(templateManifestSchema.safeParse(skill).success).toBe(true);
    expect(
      templateManifestSchema.safeParse({ ...skill, roster: team.roster })
        .success,
    ).toBe(false);
  });
});
