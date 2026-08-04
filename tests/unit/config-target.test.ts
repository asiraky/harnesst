/**
 * Configuration-target resolution (issue #344): which agent root a nested `/sub/:subPath` URL
 * actually addresses, and — because this is the authorization boundary for every nested
 * loader/action — which URLs must not resolve at all.
 */
import { describe, expect, it } from "vitest";

import { subagentRootFor } from "~/eve/parse";
import {
  resolveConfigTarget,
  subagentSegmentsFromParams,
} from "~/project/config-target.server";
import { makeFakeStore, type FakeStore } from "../fakes/store";

const TEAM_PATHS = [
  "agents/ivy/agent/agent.ts",
  "agents/ivy/agent/instructions.md",
  "agents/ivy/agent/subagents/researcher/agent.ts",
  "agents/ivy/agent/subagents/researcher/subagents/fact-checker/agent.ts",
  "agents/sam/agent/agent.ts",
  "agents/sam/agent/subagents/dana/agent.ts",
];

function seedTeam(): FakeStore {
  const store = makeFakeStore();
  store.seedProject({ id: "p1", orgId: "o1", layout: "team" });
  store.seedAgent({ id: "a-ivy", projectId: "p1", name: "ivy", root: "agents/ivy/agent" });
  store.seedAgent({ id: "a-sam", projectId: "p1", name: "sam", root: "agents/sam/agent" });
  return store;
}

function seedSingle(): FakeStore {
  const store = makeFakeStore();
  store.seedProject({ id: "p1", orgId: "o1", layout: "single" });
  store.seedAgent({ id: "a1", projectId: "p1", name: "agent", root: "agent" });
  return store;
}

const source = (paths: string[]) => ({ paths, files: {} });

async function status(op: Promise<unknown>): Promise<number> {
  try {
    await op;
    return 200;
  } catch (thrown) {
    const init = (thrown as { init?: { status?: number } }).init;
    return init?.status ?? 500;
  }
}

describe("subagentSegmentsFromParams", () => {
  it("decodes the `~`-joined chain, and reports 'no nested segment' as null", () => {
    expect(subagentSegmentsFromParams({})).toBeNull();
    expect(subagentSegmentsFromParams({ subPath: "researcher" })).toEqual(["researcher"]);
    expect(subagentSegmentsFromParams({ subPath: "researcher~fact-checker" })).toEqual([
      "researcher",
      "fact-checker",
    ]);
  });
});

describe("subagentRootFor", () => {
  it("interleaves `subagents/` between the member root and each segment", () => {
    expect(subagentRootFor("agents/ivy/agent", [])).toBe("agents/ivy/agent");
    expect(subagentRootFor("agents/ivy/agent", ["researcher"])).toBe(
      "agents/ivy/agent/subagents/researcher",
    );
    expect(subagentRootFor("agent", ["a", "b"])).toBe("agent/subagents/a/subagents/b");
  });
});

describe("resolveConfigTarget", () => {
  it("resolves the member itself when there is no nested segment", async () => {
    const store = seedTeam();
    const { target } = await resolveConfigTarget({
      projectId: "p1",
      agentName: "ivy",
      subSegments: null,
      source: source(TEAM_PATHS),
      store,
    });
    expect(target).toEqual({
      kind: "agent",
      member: "ivy",
      root: "agents/ivy/agent",
      deploymentRoot: "agents/ivy/agent",
    });
  });

  it("resolves a nested subagent, keeping the member as the deployment root", async () => {
    const store = seedTeam();
    const { target } = await resolveConfigTarget({
      projectId: "p1",
      agentName: "ivy",
      subSegments: ["researcher", "fact-checker"],
      source: source(TEAM_PATHS),
      store,
    });
    expect(target).toEqual({
      kind: "subagent",
      member: "ivy",
      subagentPath: ["researcher", "fact-checker"],
      root: "agents/ivy/agent/subagents/researcher/subagents/fact-checker",
      deploymentRoot: "agents/ivy/agent",
    });
  });

  it("resolves a single-agent repo's subagent with no member segment", async () => {
    const store = seedSingle();
    const { target } = await resolveConfigTarget({
      projectId: "p1",
      agentName: null,
      subSegments: ["reader"],
      source: source(["agent/agent.ts", "agent/subagents/reader/agent.ts"]),
      store,
    });
    expect(target.root).toBe("agent/subagents/reader");
    expect(target.deploymentRoot).toBe("agent");
  });

  it("404s an unknown member instead of falling back to roster[0]", async () => {
    // `resolveAgentContext` deliberately falls back to the first member for a member URL. Combined
    // with an arbitrary subagent path that would mint a phantom root under an unrelated member.
    const store = seedTeam();
    expect(
      await status(
        resolveConfigTarget({
          projectId: "p1",
          agentName: "nobody",
          subSegments: ["researcher"],
          source: source(TEAM_PATHS),
          store,
        }),
      ),
    ).toBe(404);
  });

  it("404s a team-level nested URL with no member segment", async () => {
    const store = seedTeam();
    expect(
      await status(
        resolveConfigTarget({
          projectId: "p1",
          agentName: null,
          subSegments: ["researcher"],
          source: source(TEAM_PATHS),
          store,
        }),
      ),
    ).toBe(404);
  });

  it("404s a segment that does not exist under the target's parent", async () => {
    const store = seedTeam();
    // `dana` exists — under SAM, not ivy. Sibling escape must not resolve.
    expect(
      await status(
        resolveConfigTarget({
          projectId: "p1",
          agentName: "ivy",
          subSegments: ["dana"],
          source: source(TEAM_PATHS),
          store,
        }),
      ),
    ).toBe(404);
    // Right names, wrong nesting: fact-checker is under researcher, not directly under ivy.
    expect(
      await status(
        resolveConfigTarget({
          projectId: "p1",
          agentName: "ivy",
          subSegments: ["fact-checker"],
          source: source(TEAM_PATHS),
          store,
        }),
      ),
    ).toBe(404);
  });

  it("404s segments outside the validated charset", async () => {
    const store = seedTeam();
    for (const subPath of ["..", ".", "", "-bad", "a/b", "res~earcher"]) {
      expect(
        await status(
          resolveConfigTarget({
            projectId: "p1",
            agentName: "ivy",
            subSegments: [subPath],
            source: source(TEAM_PATHS),
            store,
          }),
        ),
      ).toBe(404);
    }
  });

  it("resolves a draft-only subagent, and stops resolving a draft-deleted one", async () => {
    const store = seedTeam();
    const drafts = [
      { path: "agents/ivy/agent/subagents/drafty/agent.ts", content: "export default {};" },
      { path: "agents/ivy/agent/subagents/researcher/agent.ts", content: null },
      {
        path: "agents/ivy/agent/subagents/researcher/subagents/fact-checker/agent.ts",
        content: null,
      },
    ];
    const { target } = await resolveConfigTarget({
      projectId: "p1",
      agentName: "ivy",
      subSegments: ["drafty"],
      source: source(TEAM_PATHS),
      drafts,
      store,
    });
    expect(target.root).toBe("agents/ivy/agent/subagents/drafty");

    expect(
      await status(
        resolveConfigTarget({
          projectId: "p1",
          agentName: "ivy",
          subSegments: ["researcher"],
          source: source(TEAM_PATHS),
          drafts,
          store,
        }),
      ),
    ).toBe(404);
  });
});
