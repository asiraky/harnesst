/**
 * In-place marketplace install targets: the `?member=` round-trip, per-target installed keys, the
 * wizard deep link, and the dialog's search/filter.
 */
import { describe, expect, it } from "vitest";

import { emptyLock, type HarnesstLock } from "~/marketplace/lock";
import {
  declaredSubagentPaths,
  decodeMemberSelection,
  encodeMemberSelection,
  filterTemplates,
  installWizardHref,
  installedKeysAtTarget,
  type PickableTemplate,
} from "~/marketplace/targets";

type Entry = HarnesstLock["installs"][number];

function entry(overrides: Partial<Entry> & Pick<Entry, "id" | "type">): Entry {
  return {
    name: overrides.id,
    version: "1.0.0",
    hash: "abc",
    registry: "fixture",
    member: null,
    files: [],
    ...overrides,
  };
}

function lockOf(...installs: Entry[]): HarnesstLock {
  return { ...emptyLock(), installs };
}

describe("member selection encoding", () => {
  it("round-trips a member and a nested subagent path", () => {
    const value = encodeMemberSelection("researcher", "reader/skim");
    expect(decodeMemberSelection(value)).toEqual({
      memberName: "researcher",
      subagentPath: "reader/skim",
    });
  });

  it("encodes a member with no subagent as the bare name", () => {
    expect(encodeMemberSelection("researcher")).toBe("researcher");
    expect(decodeMemberSelection("researcher")).toEqual({
      memberName: "researcher",
      subagentPath: "",
    });
  });
});

describe("declaredSubagentPaths", () => {
  it("lists nested subagents parent-first below the member root", () => {
    const paths = [
      "agents/a/agent/agent.ts",
      "agents/a/agent/subagents/reader/agent.ts",
      "agents/a/agent/subagents/reader/subagents/skim/agent.ts",
      "agents/a/agent/subagents/writer/instructions.md",
      "agents/b/agent/subagents/other/agent.ts",
    ];
    expect(declaredSubagentPaths(paths, "agents/a/agent")).toEqual([
      "reader",
      "reader/skim",
      "writer",
    ]);
  });
});

describe("installedKeysAtTarget", () => {
  const lock = lockOf(
    entry({ id: "web-search", type: "tool", member: "alpha" }),
    entry({
      id: "github-bundle",
      type: "bundle",
      member: "alpha",
      includes: [
        {
          id: "github",
          type: "channel",
          name: "GitHub",
          version: "1.0.0",
          hash: "h",
        },
      ],
    }),
    entry({ id: "summarize", type: "skill", member: "alpha", subagent: "reader" }),
    entry({ id: "web-search", type: "tool", member: "beta" }),
  );

  it("scopes to the member itself, including a bundle's materialized children", () => {
    expect(installedKeysAtTarget(lock, "alpha", "").sort()).toEqual([
      "bundle/github-bundle",
      "channel/github",
      "tool/web-search",
    ]);
  });

  it("scopes to one declared subagent, not its member", () => {
    expect(installedKeysAtTarget(lock, "alpha", "reader")).toEqual([
      "skill/summarize",
    ]);
  });

  it("does not leak another member's installs", () => {
    expect(installedKeysAtTarget(lock, "beta", "")).toEqual(["tool/web-search"]);
    expect(installedKeysAtTarget(lock, "gamma", "")).toEqual([]);
  });

  it("matches a single-agent repo's root agent by the null member", () => {
    const single = lockOf(entry({ id: "web-search", type: "tool", member: null }));
    expect(installedKeysAtTarget(single, null, "")).toEqual(["tool/web-search"]);
    expect(installedKeysAtTarget(single, "agent", "")).toEqual([]);
  });
});

describe("installWizardHref", () => {
  it("preselects the repo, target and return page", () => {
    const href = installWizardHref({
      type: "skill",
      id: "summarize",
      projectId: "p1",
      member: encodeMemberSelection("alpha", "reader"),
      returnTo: "/repos/p1/agents/alpha",
    });
    const url = new URL(href, "http://x");
    expect(url.pathname).toBe("/marketplace/skill/summarize/install");
    expect(url.searchParams.get("project")).toBe("p1");
    expect(url.searchParams.get("member")).toBe("alpha:reader");
    expect(url.searchParams.get("returnTo")).toBe("/repos/p1/agents/alpha");
  });

  it("leaves the member out for an agent template", () => {
    const url = new URL(
      installWizardHref({
        type: "agent",
        id: "designer",
        projectId: "p1",
        member: null,
      }),
      "http://x",
    );
    expect(url.searchParams.has("member")).toBe(false);
    expect(url.searchParams.has("returnTo")).toBe(false);
  });
});

describe("filterTemplates", () => {
  const templates: PickableTemplate[] = [
    { id: "designer", type: "agent", name: "Designer", description: "Builds sites" },
    { id: "github-bundle", type: "bundle", name: "GitHub", description: "App channel and gh CLI" },
    { id: "web-search", type: "tool", name: "Web search", description: "Search the web" },
    { id: "summarize", type: "skill", name: "Summarize", description: "Condense long documents" },
  ];
  const intoAgent = ["tool", "skill", "subagent", "channel", "connection", "bundle"] as const;

  it("drops types the target can't take", () => {
    const shown = filterTemplates(templates, {
      query: "",
      type: "all",
      allowedTypes: intoAgent,
    });
    expect(shown.map((t) => t.id)).toEqual(["github-bundle", "web-search", "summarize"]);
  });

  it("requires every query word, case-insensitively, across name, id and description", () => {
    const shown = filterTemplates(templates, {
      query: "  SEARCH web ",
      type: "all",
      allowedTypes: intoAgent,
    });
    expect(shown.map((t) => t.id)).toEqual(["web-search"]);
    expect(
      filterTemplates(templates, { query: "gh cli", type: "all", allowedTypes: intoAgent }).map(
        (t) => t.id,
      ),
    ).toEqual(["github-bundle"]);
  });

  it("narrows to one type", () => {
    const shown = filterTemplates(templates, {
      query: "",
      type: "skill",
      allowedTypes: intoAgent,
    });
    expect(shown.map((t) => t.id)).toEqual(["summarize"]);
  });

  it("never shows a disallowed type even when it's the selected filter", () => {
    expect(
      filterTemplates(templates, { query: "", type: "agent", allowedTypes: intoAgent }),
    ).toEqual([]);
  });
});
