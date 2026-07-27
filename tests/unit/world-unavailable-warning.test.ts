/**
 * WS2 — the swallow at the bottom of `listWorldSessions`.
 *
 * `3D000` (no such database) and `42P01` (no such table) both still return `[]` — throwing would
 * take out the sweep for every other environment — but they used to do it in complete silence,
 * and that silence hid a total outage: a production review found ZERO reconciled runs for ANY
 * channel on ANY environment, because the deployed eve writes no Postgres workflow world at all.
 *
 * So the two codes must be TOLD APART in the log (an absent database is a never-deployed
 * environment; an empty database is the architectural dead end), the message must name the cause
 * rather than the symptom, and it must fire once per world per process — the reconciler sweeps
 * every 60s, and 1,440 identical lines a day is indistinguishable from silence.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  resetWorldWarnings,
  warnWorldUnavailable,
  worldDbName,
} from "~/seams/oss/deploy.localdocker.server";

function capture(fn: () => void): string[] {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  fn();
  const lines = warn.mock.calls.map((c) => String(c[0]));
  warn.mockRestore();
  return lines;
}

beforeEach(() => {
  resetWorldWarnings();
});

describe("warnWorldUnavailable", () => {
  it("names the database, so an operator can go look at it", () => {
    const [line] = capture(() => warnWorldUnavailable("env_1", "42P01"));

    expect(line).toContain(worldDbName("env_1"));
    expect(line).toContain("[worlds]");
  });

  it("distinguishes an empty world (42P01) from an absent one (3D000)", () => {
    const missingTable = capture(() => warnWorldUnavailable("env_1", "42P01"))[0];
    const missingDb = capture(() => warnWorldUnavailable("env_2", "3D000"))[0];

    expect(missingTable).toContain("42P01");
    expect(missingTable).toContain("no workflow.workflow_runs table");
    // The cause, not the symptom: eve never writes this world.
    expect(missingTable).toContain("WORKFLOW_LOCAL_DATA_DIR");
    expect(missingTable).toContain("INOPERATIVE");

    expect(missingDb).toContain("3D000");
    expect(missingDb).toContain("does not exist");
    expect(missingDb).not.toContain("42P01");
  });

  it("tells the operator runs still arrive, so this does not read as total breakage", () => {
    const [line] = capture(() => warnWorldUnavailable("env_1", "42P01"));

    expect(line).toContain("/api/agent/runs");
  });

  it("warns once per world per process, not once per 60s sweep", () => {
    const lines = capture(() => {
      for (let i = 0; i < 5; i += 1) warnWorldUnavailable("env_1", "42P01");
      warnWorldUnavailable("env_2", "42P01");
    });

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(worldDbName("env_1"));
    expect(lines[1]).toContain(worldDbName("env_2"));
  });
});
