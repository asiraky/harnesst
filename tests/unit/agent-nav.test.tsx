import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";

import { AgentNav } from "~/components/shell";
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
  single: ["Overview", "Deployment", "Runs", "Assistant", "Settings"],
  repo: ["Agents", "Deployment", "Assistant", "Settings"],
  member: ["Overview", "Deployment", "Runs", "Settings"],
  // A declared subagent deploys with its member and has no runs of its own.
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

  it("renders every member-level tab including a reachable Settings link", () => {
    const base = "/repos/sQLfctIEkNIA/agents/pm";
    const html = renderInRouter(
      <TooltipProvider>
        <AgentNav
          base={base}
          level="member"
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
        />
      </TooltipProvider>,
    );

    for (const label of EXPECTED_LABELS.subagent) {
      expect(html).toContain(`>${label}</a>`);
    }
    for (const label of ["Deployment", "Runs", "Assistant"]) {
      expect(html).not.toContain(`>${label}</a>`);
    }
    expect(html).toMatch(
      /href="\/repos\/sQLfctIEkNIA\/agents\/pm\/sub\/researcher\/settings"/,
    );
  });
});
