import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";

import { AgentNav, activeNavLabel } from "~/components/shell";
import { TooltipProvider } from "~/components/ui/tooltip";

// AgentNav's controls (InviteMember) self-fetch via useFetcher, which needs a data router in
// context — render inside a routes stub so SSR can resolve the fetcher hooks.
function renderInRouter(ui: React.ReactElement): string {
  const Stub = createRoutesStub([{ path: "*", Component: () => ui }]);
  return renderToString(<Stub initialEntries={["/"]} />);
}

const EXPECTED_LABELS: Record<"single" | "repo" | "member", string[]> = {
  single: ["Overview", "Deployment", "Playground", "Runs", "Assistant", "Settings"],
  repo: ["Overview", "Deployment", "Assistant", "Settings"],
  member: ["Overview", "Deployment", "Playground", "Runs", "Settings"],
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
