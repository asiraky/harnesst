/**
 * Usage rollups (#418): nullable totals stay null until something reports, connection burn is
 * attributed without leaking repositories the viewer can't open, and the hourly axis is
 * continuous with overflow groups merged.
 */
import { describe, expect, it } from "vitest";

import { addTotals, attribute, burnBy, emptyTotals, hourlySeries, rollupRuns, type BurnHour, type RunAggregate } from "~/usage/rollup";

const agg = (over: Partial<RunAggregate>): RunAggregate => ({
  projectId: "p1",
  agentId: null,
  ...emptyTotals(),
  ...over,
});

const burn = (over: Partial<BurnHour>): BurnHour => ({
  hour: "2026-11-01T00:00:00.000Z",
  projectId: "p1",
  agentName: "alpha",
  calls: 1,
  input: 100,
  cached: 0,
  output: 10,
  rateLimited: 0,
  ...over,
});

describe("addTotals", () => {
  it("keeps unknown figures null and takes the max peak", () => {
    const a = agg({ runs: 1, input: 100, peakContext: 50, cached: null });
    const b = agg({ runs: 2, input: null, peakContext: 80, cached: null });
    const t = addTotals(addTotals(emptyTotals(), a), b);
    expect(t.runs).toBe(3);
    expect(t.input).toBe(100);
    expect(t.peakContext).toBe(80);
    expect(t.cached).toBeNull();
  });
});

describe("rollupRuns", () => {
  it("sums rows per key", () => {
    const out = rollupRuns(
      [agg({ projectId: "a", runs: 1 }), agg({ projectId: "a", runs: 2 }), agg({ projectId: "b", runs: 5 })],
      (r) => r.projectId,
    );
    expect(out.get("a")?.runs).toBe(3);
    expect(out.get("b")?.runs).toBe(5);
  });
});

describe("attribute", () => {
  const visible = new Set(["p1"]);
  const names = new Map([["p1", "Repo One"]]);

  it("names a visible repository and agent", () => {
    expect(attribute({ projectId: "p1", agentName: "alpha" }, "agent", visible, names)).toMatchObject({
      key: "p1/alpha",
      label: "Repo One · alpha",
      kind: "project",
    });
  });

  it("hides the identity of a repository the viewer can't open", () => {
    const a = attribute({ projectId: "p2", agentName: "secret" }, "agent", visible, names);
    expect(a).toMatchObject({ kind: "hidden", projectId: null, agentName: null, label: "Other repositories" });
  });

  it("labels calls with no repository as unattributed", () => {
    expect(attribute({ projectId: null, agentName: "x" }, "project", visible, names).kind).toBe("unattributed");
  });
});

describe("burnBy", () => {
  it("merges hidden repositories into one group and computes shares", () => {
    const out = burnBy(
      [
        burn({ projectId: "p1", input: 300 }),
        burn({ projectId: "p2", input: 50 }),
        burn({ projectId: "p3", input: 50, rateLimited: 2 }),
      ],
      "project",
      new Set(["p1"]),
      new Map([["p1", "Repo One"]]),
    );
    expect(out.map((g) => [g.label, g.input, g.share, g.rateLimited])).toEqual([
      ["Repo One", 300, 0.75, 0],
      ["Other repositories", 100, 0.25, 2],
    ]);
  });

  it("keeps cached input unknown for a group where no call reported it", () => {
    const out = burnBy(
      [burn({ projectId: "p1", cached: null }), burn({ projectId: "p1", cached: null }), burn({ projectId: "p2", cached: 40 }), burn({ projectId: "p2", cached: null })],
      "project",
      new Set(["p1", "p2"]),
      new Map(),
    );
    expect(Object.fromEntries(out.map((g) => [g.projectId, g.cached]))).toEqual({ p1: null, p2: 40 });
  });
});

describe("hourlySeries", () => {
  const since = new Date("2026-11-01T00:30:00.000Z");
  const until = new Date("2026-11-01T03:10:00.000Z");

  it("fills empty hours so the axis is real time", () => {
    const s = hourlySeries([burn({ hour: "2026-11-01T02:00:00.000Z" })], since, until, (r) => r.agentName!, ["alpha"]);
    expect(s.buckets.map((b) => new Date(b.hour).toISOString().slice(11, 13))).toEqual(["00", "01", "02", "03"]);
    expect(s.buckets.map((b) => b.values.alpha ?? 0)).toEqual([0, 0, 100, 0]);
  });

  it("merges groups beyond the limit into the rest", () => {
    const rows = ["a", "b", "c"].map((agentName) => burn({ hour: "2026-11-01T01:00:00.000Z", agentName }));
    const s = hourlySeries(rows, since, until, (r) => r.agentName!, ["a", "b", "c"], 2);
    expect(s.keys).toEqual(["a", "b", "__rest"]);
    expect(s.buckets[1].values).toEqual({ a: 100, b: 100, __rest: 100 });
  });

  it("drops rows outside the window", () => {
    const s = hourlySeries([burn({ hour: "2026-10-31T00:00:00.000Z" })], since, until, () => "k", ["k"]);
    expect(s.buckets.every((b) => Object.keys(b.values).length === 0)).toBe(true);
  });
});
