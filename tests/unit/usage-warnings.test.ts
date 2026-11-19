/**
 * Usage warnings (#419): which signals trip which rule at what severity, how occurrences group
 * into warnings, and the repeated-call detection stored on a run at ingest.
 */
import { describe, expect, it } from "vitest";

import { assistantDraftHref, fitDraft } from "~/components/usage-warnings";
import {
  compactionSeverity,
  connectionOccurrences,
  contextSeverity,
  describeWarning,
  groupWarnings,
  lowCache,
  parseToolRepeats,
  runOccurrences,
  stableJson,
  toolRepeats,
  warningLink,
  withRunEvidence,
  type ConnectionSignal,
  type Occurrence,
  type RunSignal,
  type StepSignal,
} from "~/usage/warnings";

function run(over: Partial<RunSignal> & { runId: string }): RunSignal {
  return {
    projectId: "p1",
    agentId: "a1",
    startedAt: "2026-11-10T10:00:00.000Z",
    settledBy: null,
    finishedAt: null,
    medianContext: null,
    window: null,
    peakContext: null,
    calls: 0,
    repeats: null,
    ...over,
  };
}

function step(over: Partial<StepSignal> & { runId: string; kind: StepSignal["kind"] }): StepSignal {
  return {
    projectId: "p1",
    agentId: "a1",
    startedAt: "2026-11-10T10:00:00.000Z",
    group: "bash",
    errorKind: null,
    count: 1,
    completed: 0,
    firstSeq: 4,
    maxTokens: null,
    limitTokens: null,
    ...over,
  };
}

function conn(over: Partial<ConnectionSignal> = {}): ConnectionSignal {
  return {
    connectionId: "c1",
    calls: 10,
    cacheCalls: 10,
    input: 1000,
    cached: 900,
    rateLimited: 0,
    lastAt: "2026-11-10T12:00:00.000Z",
    lastRateLimitedAt: null,
    windows: [],
    ...over,
  };
}

function occ(over: Partial<Occurrence> = {}): Occurrence {
  return {
    rule: "tool_error",
    severity: "warn",
    projectId: "p1",
    agentId: "a1",
    connectionId: null,
    runId: "r1",
    callSeq: null,
    stepSeq: 3,
    at: "2026-11-10T10:00:00.000Z",
    group: "bash\u0000exit 1",
    evidence: { tool: "bash", kind: "exit 1", count: 1 },
    ...over,
  };
}

describe("severity thresholds", () => {
  it("compaction: one in a turn warns, three is critical", () => {
    expect(compactionSeverity(0)).toBeNull();
    expect(compactionSeverity(1)).toBe("warn");
    expect(compactionSeverity(2)).toBe("warn");
    expect(compactionSeverity(3)).toBe("critical");
  });

  it("context: over half the window warns, near the compaction threshold is critical, unknown is silent", () => {
    expect(contextSeverity(50, 100)).toBeNull();
    expect(contextSeverity(51, 100)).toBe("warn");
    expect(contextSeverity(95, 100)).toBe("critical");
    expect(contextSeverity(null, 100)).toBeNull();
    expect(contextSeverity(80, null)).toBeNull();
  });

  it("low cache needs 50+ calls and under 20% hit rate, and known numbers", () => {
    expect(lowCache(50, 19, 100)).toBe(true);
    expect(lowCache(49, 0, 100)).toBe(false);
    expect(lowCache(50, 20, 100)).toBe(false);
    expect(lowCache(500, null, 100)).toBe(false);
    expect(lowCache(500, 0, 0)).toBe(false);
  });
});

describe("runOccurrences", () => {
  it("gives one compaction per run at the severity of its worst turn", () => {
    const out = runOccurrences(
      [run({ runId: "r1", window: 200_000, peakContext: 190_000 })],
      [
        step({ runId: "r1", kind: "compaction", group: "t1", count: 1, completed: 1 }),
        step({ runId: "r1", kind: "compaction", group: "t2", count: 3, completed: 2 }),
      ],
    );
    const c = out.filter((o) => o.rule === "compaction");
    expect(c).toHaveLength(1);
    expect(c[0].severity).toBe("critical");
    expect(c[0].evidence).toMatchObject({ count: 3, requested: 4, completed: 3, window: 200_000, peak: 190_000 });
  });

  it("separates tool errors by tool and error kind", () => {
    const out = runOccurrences(
      [],
      [
        step({ runId: "r1", kind: "tool_error", group: "bash", errorKind: "exit 1" }),
        step({ runId: "r1", kind: "tool_error", group: "bash", errorKind: null }),
      ],
    );
    expect(out.map((o) => o.group)).toEqual(["bash\u0000exit 1", "bash\u0000error"]);
    expect(out[1].evidence.kind).toBe("error");
  });

  it("reports repeats only at three or more identical calls", () => {
    const out = runOccurrences(
      [
        run({
          runId: "r1",
          repeats: [
            { tool: "bash", count: 3, firstSeq: 7, input: '{"cmd":"sleep 30"}' },
            { tool: "read", count: 2, firstSeq: 9, input: "{}" },
          ],
        }),
      ],
      [],
    );
    const rep = out.filter((o) => o.rule === "repeated_call");
    expect(rep).toHaveLength(1);
    expect(rep[0]).toMatchObject({ group: "bash", stepSeq: 7, evidence: { count: 3, inputPreview: '{"cmd":"sleep 30"}' } });
  });

  it("flags stale-sweep settlement at the finish time, and high context", () => {
    const out = runOccurrences(
      [
        run({ runId: "r1", settledBy: "stale-run-sweep", finishedAt: "2026-11-10T11:00:00.000Z" }),
        run({ runId: "r2", settledBy: "something-else", medianContext: 60, window: 100 }),
      ],
      [],
    );
    expect(out.find((o) => o.rule === "stale_sweep")).toMatchObject({ runId: "r1", at: "2026-11-10T11:00:00.000Z" });
    expect(out.filter((o) => o.rule === "stale_sweep")).toHaveLength(1);
    expect(out.find((o) => o.rule === "context_high")).toMatchObject({ runId: "r2", severity: "warn" });
  });

  it("emits nothing for a run with no signals or null usage", () => {
    expect(runOccurrences([run({ runId: "r1" })], [])).toEqual([]);
  });
});

describe("connectionOccurrences", () => {
  const window = (pct: number | null) => ({ label: "5h", pct, resetsAt: null, observedAt: "2026-11-10T12:00:00.000Z" });

  it("warns over 80% of a plan window and is critical at 100%", () => {
    const out = connectionOccurrences([conn({ windows: [window(80), window(81), window(100), window(null)] })]);
    expect(out.map((o) => o.severity)).toEqual(["warn", "critical"]);
    expect(out.every((o) => o.rule === "plan" && o.projectId == null)).toBe(true);
  });

  it("treats any 429 as critical, dated by the last 429", () => {
    const out = connectionOccurrences([conn({ rateLimited: 2, lastRateLimitedAt: "2026-11-10T09:00:00.000Z" })]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ group: "429", severity: "critical", at: "2026-11-10T09:00:00.000Z" });
  });

  it("flags low cache on a busy connection", () => {
    const out = connectionOccurrences([conn({ calls: 60, cacheCalls: 60, input: 1000, cached: 100 })]);
    expect(out.map((o) => o.rule)).toEqual(["low_cache"]);
    expect(out[0].evidence.hitRate).toBeCloseTo(0.1);
  });

  it("counts only calls that report cache toward the 50-call minimum", () => {
    expect(connectionOccurrences([conn({ calls: 400, cacheCalls: 49, input: 1000, cached: 100 })])).toEqual([]);
  });

  it("drops plan readings whose window has reset or that predate the window", () => {
    const at = { now: new Date("2026-11-10T12:00:00.000Z"), since: new Date("2026-11-03T12:00:00.000Z") };
    const reading = (resetsAt: string | null, observedAt: string) => ({ label: "5h", pct: 95, resetsAt, observedAt });
    const out = connectionOccurrences(
      [
        conn({
          windows: [
            reading("2026-11-10T11:00:00.000Z", "2026-11-10T08:00:00.000Z"),
            reading("2026-11-10T14:00:00.000Z", "2026-11-01T08:00:00.000Z"),
            reading("2026-11-10T14:00:00.000Z", "2026-11-10T10:00:00.000Z"),
            reading(null, "2026-11-10T10:00:00.000Z"),
          ],
        }),
      ],
      at,
    );
    expect(out.map((o) => o.evidence.resetsAt)).toEqual(["2026-11-10T14:00:00.000Z", null]);
  });
});

describe("groupWarnings", () => {
  it("groups by rule, agent and group, counting occurrences and distinct runs", () => {
    const ws = groupWarnings([
      occ({ runId: "r1", evidence: { tool: "bash", count: 1 } }),
      occ({ runId: "r2", evidence: { tool: "bash", count: 5 }, at: "2026-11-11T10:00:00.000Z" }),
      occ({ runId: "r2", evidence: { tool: "bash", count: 2 } }),
      occ({ agentId: "a2", runId: "r3" }),
    ]);
    expect(ws).toHaveLength(2);
    const a1 = ws.find((w) => w.agentId === "a1")!;
    expect(a1).toMatchObject({ count: 3, runs: 2, firstSeen: "2026-11-10T10:00:00.000Z", lastSeen: "2026-11-11T10:00:00.000Z" });
    expect(a1.worst.evidence.count).toBe(5);
  });

  it("takes the worst severity and sorts critical first, then most recent", () => {
    const ws = groupWarnings([
      occ({ rule: "withheld", group: "read", at: "2026-11-12T00:00:00.000Z" }),
      occ({ rule: "compaction", group: "", severity: "warn", runId: "r1", evidence: { count: 1 } }),
      occ({ rule: "compaction", group: "", severity: "critical", runId: "r2", evidence: { count: 3 } }),
      occ({ rule: "stale_sweep", group: "", at: "2026-11-13T00:00:00.000Z" }),
    ]);
    expect(ws.map((w) => w.rule)).toEqual(["compaction", "stale_sweep", "withheld"]);
    expect(ws[0].severity).toBe("critical");
  });

  it("marks plan, cache and unowned warnings as platform", () => {
    const ws = groupWarnings([
      occ({ rule: "plan", projectId: null, agentId: null, connectionId: "c1", runId: null, group: "429" }),
      occ({ rule: "low_cache", projectId: null, agentId: null, connectionId: "c1", runId: null, group: "" }),
      occ({ rule: "tool_error" }),
    ]);
    expect(ws.find((w) => w.rule === "plan")!.platform).toBe(true);
    expect(ws.find((w) => w.rule === "low_cache")!.platform).toBe(true);
    expect(ws.find((w) => w.rule === "tool_error")!.platform).toBe(false);
    expect(ws.find((w) => w.rule === "plan")!.runs).toBe(0);
  });

  it("gives the same warning the same id across loads", () => {
    const a = groupWarnings([occ({ runId: "r1" })])[0].id;
    const b = groupWarnings([occ({ runId: "r9", at: "2026-11-15T00:00:00.000Z" })])[0].id;
    const c = groupWarnings([occ({ agentId: "a2" })])[0].id;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("warningLink", () => {
  it("opens the call when known, else the run, and nothing for connection warnings", () => {
    expect(warningLink({ projectId: "p1", worst: occ({ callSeq: 12 }) })).toBe("/usage/repos/p1/runs/r1/calls/12");
    expect(warningLink({ projectId: "p1", worst: occ() })).toBe("/usage/repos/p1/runs/r1");
    expect(warningLink({ projectId: null, worst: occ({ runId: null }) })).toBeNull();
  });
});

describe("describeWarning", () => {
  const names = { agentName: "triage", projectName: "acme", connectionLabel: "Codex Pro" };

  it("drafts an agent warning for the assistant with evidence and a review request", () => {
    const [w] = groupWarnings([occ({ callSeq: 8, evidence: { tool: "bash", kind: "exit 1", count: 4, message: "no such file" } })]);
    const t = describeWarning(w, names);
    expect(t.title).toContain("triage");
    expect(t.draft.startsWith("Warning (warn):")).toBe(true);
    expect(t.draft).toContain("- Error: no such file");
    expect(t.draft).toContain("- Link: /usage/repos/p1/runs/r1/calls/8");
    expect(t.draft).toContain("Show me the diff before deploying.");
  });

  it("drafts a platform issue for connection warnings, not an agent change", () => {
    const [w] = groupWarnings(connectionOccurrences([conn({ rateLimited: 3, calls: 40 })]));
    const t = describeWarning(w, names);
    expect(t.title).toBe("Codex Pro: 3 × HTTP 429");
    expect(t.draft.startsWith("Platform issue (critical):")).toBe(true);
    expect(t.draft).not.toContain("- Link:");
  });

  const sheetsGet = {
    seq: 41,
    tool: "google-sheets__spreadsheets_values_get",
    tokens: 135_000,
    input: `{"range":"'Run history'!A:P","spreadsheetId":"${"x".repeat(200)}"}`,
  };
  const filled = {
    largest: [sheetsGet, { seq: 7, tool: "bash", tokens: 2_100, input: null }],
    compactions: [
      { seq: 43, atTokens: 180_000, tools: [sheetsGet] },
      { seq: 90, atTokens: null, tools: [] },
    ],
  };
  const compaction = (): Occurrence =>
    occ({ rule: "compaction", severity: "critical", group: "compaction", evidence: { count: 2, requested: 2, completed: 2 } });

  it("names what filled the context of a compaction warning's run", () => {
    const [w] = groupWarnings([withRunEvidence("compaction", compaction(), filled)]);
    const draft = describeWarning(w, names).draft;
    expect(draft).toContain("- Largest tool results in that run:");
    expect(draft).toContain(`step 41 google-sheets__spreadsheets_values_get, ~135,000 tokens, input {"range":"'Run history'!A:P"`);
    expect(draft).toContain("step 7 bash, ~2,100 tokens");
    // Long inputs are cut, so one huge argument can't crowd out the rest of the draft.
    expect(draft).not.toContain("x".repeat(150));
    expect(draft).toContain("- Tool calls just before each compaction:");
    expect(draft).toMatch(/compaction \(step 43\) at .+ context: step 41 google-sheets__spreadsheets_values_get/);
    expect(draft).toContain("compaction (step 90): no tool calls before it");
  });

  it("lists compactions only for compaction warnings, and adds nothing when the run has no tool results", () => {
    const high = withRunEvidence("context_high", occ({ rule: "context_high", group: "context_high", evidence: {} }), filled);
    expect(high.evidence.largestResults).toHaveLength(2);
    expect(high.evidence.beforeCompactions).toBeUndefined();

    const empty = withRunEvidence("compaction", compaction(), { largest: [], compactions: [] });
    const draft = describeWarning(groupWarnings([empty])[0], names).draft;
    expect(draft).not.toContain("Largest tool results");
    expect(draft).not.toContain("just before each compaction");
  });

  it("falls back when names are unknown", () => {
    const [w] = groupWarnings([occ()]);
    expect(describeWarning(w, { agentName: null, projectName: null, connectionLabel: null }).title).toContain("Unattributed runs");
  });
});

describe("toolRepeats", () => {
  const call = (seq: number, toolName: string | null, input: unknown) => ({ seq, type: "tool_call", toolName, data: { input } });

  it("stableJson ignores key order and undefined keys", () => {
    expect(stableJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } })).toBe(stableJson({ a: { d: [1, { x: 1, y: 2 }] }, b: 1 }));
    expect(stableJson({ a: 1 })).not.toBe(stableJson({ a: "1" }));
  });

  it("counts identical tool and input three or more times, earliest seq first", () => {
    const out = toolRepeats([
      call(9, "bash", { cmd: "sleep 30", t: 1 }),
      call(3, "bash", { t: 1, cmd: "sleep 30" }),
      call(5, "bash", { cmd: "sleep 30", t: 1 }),
      call(6, "read", { cmd: "sleep 30", t: 1 }),
      call(7, "read", { path: "a" }),
      call(8, "read", { path: "a" }),
      { seq: 10, type: "model_call", toolName: "bash", data: { input: { cmd: "sleep 30", t: 1 } } },
      call(11, null, { cmd: "sleep 30", t: 1 }),
    ]);
    expect(out).toEqual([{ tool: "bash", count: 3, firstSeq: 3, input: '{"cmd":"sleep 30","t":1}' }]);
  });

  it("skips calls without an input, truncates long inputs, and keeps the most repeated", () => {
    const long = { body: "x".repeat(400) };
    const steps = [
      ...[1, 2, 3].map((s) => ({ seq: s, type: "tool_call", toolName: "bash", data: {} })),
      ...[4, 5, 6].map((s) => call(s, "write", long)),
      ...[7, 8, 9, 10].map((s) => call(s, "read", { p: 1 })),
    ];
    const out = toolRepeats(steps, 1);
    expect(out.map((r) => r.tool)).toEqual(["read"]);
    const all = toolRepeats(steps);
    const w = all.find((r) => r.tool === "write")!;
    expect(w.input.length).toBe(301);
    expect(w.input.endsWith("…")).toBe(true);
    expect(all.some((r) => r.tool === "bash")).toBe(false);
  });

  it("parseToolRepeats reads valid entries and returns null for old rows", () => {
    expect(parseToolRepeats(undefined)).toBeNull();
    expect(parseToolRepeats({})).toBeNull();
    expect(
      parseToolRepeats([{ tool: "bash", count: 3, firstSeq: 2, input: "{}" }, { tool: "x" }, null, { tool: "y", count: 4, firstSeq: 1 }]),
    ).toEqual([
      { tool: "bash", count: 3, firstSeq: 2, input: "{}" },
      { tool: "y", count: 4, firstSeq: 1, input: "" },
    ]);
  });
});

describe("assistantDraftHref", () => {
  it("carries a short draft whole and encoded", () => {
    expect(assistantDraftHref("p1", "a&b c")).toBe("/repos/p1/assistant?draft=a%26b%20c");
    expect(fitDraft("a&b c").truncated).toBe(false);
  });

  it("cuts plain text at the loader's 6000 characters", () => {
    const fit = fitDraft("x".repeat(7000));
    expect(fit).toMatchObject({ truncated: true });
    expect(fit.text.length).toBe(6000);
  });

  it("cuts encoding-heavy text at the URL budget, on whole code points", () => {
    const fit = fitDraft("×😀".repeat(3000));
    expect(fit.truncated).toBe(true);
    expect(fit.encoded.length).toBeLessThanOrEqual(8000);
    expect(decodeURIComponent(fit.encoded)).toBe(fit.text);
    expect(fit.text.endsWith("\ud83d")).toBe(false);
    expect(() => assistantDraftHref("p1", "😀".repeat(5000))).not.toThrow();
  });
});
