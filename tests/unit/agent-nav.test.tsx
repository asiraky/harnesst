import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";

import { AgentNav, activeNavLabel, switchAgentHref } from "~/components/shell";
import { TooltipProvider } from "~/components/ui/tooltip";

// AgentNav's controls self-fetch via useFetcher, which needs a data router in
// context — render inside a routes stub so SSR can resolve the fetcher hooks.
function renderInRouter(ui: React.ReactElement): string {
  const Stub = createRoutesStub([{ path: "*", Component: () => ui }]);
  return renderToString(<Stub initialEntries={["/"]} />);
}

const EXPECTED_LABELS: Record<
  "single" | "repo" | "member" | "subagent",
  string[]
> = {
  single: ["Overview", "Deployment", "Playground", "Runs", "Assistant", "Settings"],
  repo: ["Agents", "Deployment", "Assistant", "Settings"],
  member: ["Overview", "Deployment", "Playground", "Runs", "Settings"],
  // A declared subagent deploys with its member and has no playground/runs of its own.
  subagent: ["Overview", "Settings"],
};

describe("AgentNav", () => {
  for (const level of ["single", "repo"] as const) {
    it(`renders every ${level}-level tab, including a reachable Settings link`, () => {
      const html = renderInRouter(
        <TooltipProvider>
          <AgentNav base="/repos/NuOMEPzKzcmQ" level={level} />
        </TooltipProvider>,
      );

      for (const label of EXPECTED_LABELS[level]) {
        expect(html).toContain(`>${label}</a>`);
      }
      if (level === "repo") {
        expect(html).not.toContain(">Overview</a>");
      }
      // Settings must be a link whose href ends in /settings (the tab users couldn't find on mobile).
      expect(html).toMatch(/href="\/repos\/NuOMEPzKzcmQ\/settings"/);
    });
  }

  it("renders every member-level tab plus the switcher, including a reachable Settings link", () => {
    const base = "/repos/sQLfctIEkNIA/agents/pm";
    const html = renderInRouter(
      <TooltipProvider>
        <AgentNav
          base={base}
          level="member"
          roster={[{ name: "pm" }]}
          activeAgent="pm"
        />
      </TooltipProvider>,
    );

    for (const label of EXPECTED_LABELS.member) {
      expect(html).toContain(`>${label}</a>`);
    }
    expect(html).toMatch(/href="\/repos\/sQLfctIEkNIA\/agents\/pm\/settings"/);
  });

  it("offers a subagent exactly Overview and Settings — nothing it does not own", () => {
    const base = "/repos/sQLfctIEkNIA/agents/pm/sub/researcher";
    const html = renderInRouter(
      <TooltipProvider>
        <AgentNav
          base={base}
          level="subagent"
          roster={[{ name: "pm" }]}
          activeAgent="pm"
        />
      </TooltipProvider>,
    );

    for (const label of EXPECTED_LABELS.subagent) {
      expect(html).toContain(`>${label}</a>`);
    }
    for (const label of ["Deployment", "Playground", "Runs", "Assistant"]) {
      expect(html).not.toContain(`>${label}</a>`);
    }
    expect(html).toMatch(
      /href="\/repos\/sQLfctIEkNIA\/agents\/pm\/sub\/researcher\/settings"/,
    );
  });

  it("stacks the tab row above the controls on mobile (regression guard for the merged-row bug)", () => {
    const html = renderInRouter(
      <TooltipProvider>
        <AgentNav base="/repos/NuOMEPzKzcmQ" level="single" />
      </TooltipProvider>,
    );

    // The responsive wrapper must be present so a regression that re-merges the two rows
    // (dropping flex-col) fails here — that merge is what hid Settings on ~375px.
    expect(html).toContain("flex-col");
    expect(html).toContain("sm:flex-row");
  });
});

/**
 * The primary nav folded behind a single menu (the header row was over its width budget with
 * five inline links). The trigger names the current section, so this mapping IS the "where am
 * I" signal — it replaces the active styling an inline row used to carry.
 */
describe("activeNavLabel", () => {
  it("resolves each nav destination to its own label", () => {
    expect(activeNavLabel("/")).toBe("Front of house");
    expect(activeNavLabel("/dashboard")).toBe("Repositories");
    expect(activeNavLabel("/marketplace")).toBe("Marketplace");
    expect(activeNavLabel("/org/members")).toBe("Members");
    expect(activeNavLabel("/org/settings")).toBe("Settings");
  });

  it("keeps a repository page under Repositories", () => {
    expect(activeNavLabel("/repos/abc")).toBe("Repositories");
    expect(activeNavLabel("/repos/abc/agents/ivy/runs")).toBe("Repositories");
  });

  // "/" prefixes every path, so a plain prefix match would label the whole app Front of house.
  it("does not let the Front of house root swallow every other path", () => {
    expect(activeNavLabel("/dashboard")).not.toBe("Front of house");
    expect(activeNavLabel("/marketplace/agent/x")).toBe("Marketplace");
  });

  // /org/settings starts with neither /org/members nor a shorter sibling by accident today, but
  // longest-match is what keeps that true as /org/* grows.
  it("prefers the longest matching destination", () => {
    expect(activeNavLabel("/org/settings/billing")).toBe("Settings");
  });

  it("returns null outside the primary nav", () => {
    expect(activeNavLabel("/login")).toBeNull();
  });
});

/**
 * The member picker's destination. Switching members keeps the TAB you are on, but everything
 * that names a place inside the member you are leaving has to go: the nested `/sub/<name>`
 * context and the editor's `?path=` (issue #344).
 */
describe("switchAgentHref", () => {
  const at = (url: string) => {
    const { pathname, search } = new URL(url, "https://h.example.com");
    return { pathname, search };
  };

  it("swaps the member and keeps the tab", () => {
    expect(switchAgentHref(at("/repos/p1/agents/ivy/runs"), "otto")).toBe(
      "/repos/p1/agents/otto/runs",
    );
  });

  it("drops a nested subagent context — the new member has its own", () => {
    expect(
      switchAgentHref(at("/repos/p1/agents/ivy/sub/researcher/settings"), "otto"),
    ).toBe("/repos/p1/agents/otto/settings");
  });

  it("drops the editor's ?path= (it names a file in the member being left)", () => {
    expect(
      switchAgentHref(
        at("/repos/p1/agents/ivy/edit?path=agents%2Fivy%2Fagent%2Ftools%2Fsearch.ts"),
        "otto",
      ),
    ).toBe("/repos/p1/agents/otto/edit");
  });

  it("keeps every other query param", () => {
    expect(
      switchAgentHref(
        at("/repos/p1/agents/ivy/runs?path=agents%2Fivy%2Fagent.ts&status=failed"),
        "otto",
      ),
    ).toBe("/repos/p1/agents/otto/runs?status=failed");
  });

  it("encodes a member name that needs it", () => {
    expect(switchAgentHref(at("/repos/p1/agents/ivy"), "a b")).toBe(
      "/repos/p1/agents/a%20b",
    );
  });
});
