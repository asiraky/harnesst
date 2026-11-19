/**
 * The assistant's read-only debugging actions (#432): runs are read only from the assistant's
 * own project (by id or by pasted link), lists and chunks page under the response budget, and
 * excerpts and logs come back with secrets removed.
 */
import { describe, expect, it } from "vitest";

import type { AssistantContext, AuthoringProject } from "~/assistant/authoring.server";
import {
  byteSize,
  fitChunk,
  fitItems,
  parseRunRef,
  parseSince,
  RESPONSE_BUDGET_BYTES,
} from "~/assistant/debug";
import {
  deploymentsAction,
  listRunsAction,
  runTraceAction,
  scrubLogs,
  type DebugDeps,
} from "~/assistant/debug.server";
import { redactText } from "~/observability/capture.server";
import type { RunRow } from "~/usage/queries.server";
import type { TraceStepRow } from "~/usage/trace";
import { makeFakeStore, type FakeStore } from "../fakes/store";

const project: AuthoringProject = {
  id: "p1",
  orgId: "o",
  name: "repo",
  slug: "repo",
  layout: "single",
  repoOwner: "acme",
  repoName: "repo",
  repoInstallationId: "inst",
  defaultBranch: "main",
  liveEnvironmentName: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};
const ctx: AssistantContext = { project, agentId: "asst", environmentId: "e-asst", deploymentId: "d-asst" };

function step(over: Partial<TraceStepRow> & { seq: number; type: string }): TraceStepRow {
  return {
    model: null,
    toolName: null,
    tokensInput: null,
    tokensOutput: null,
    tokensCacheRead: null,
    tokensCacheWrite: null,
    costUsd: null,
    contextWindow: null,
    eveSessionId: null,
    turnId: null,
    stepIndex: null,
    subagentName: null,
    callId: null,
    childSessionId: null,
    resultTokens: null,
    resultCapped: null,
    durationMs: null,
    isError: false,
    startedAt: null,
    withheld: null,
    compaction: null,
    errorCode: null,
    summary: null,
    inputHash: null,
    ...over,
  };
}

type RunFixture = { id: string; projectId: string; steps: TraceStepRow[]; inputs?: Record<number, string>; outputs?: Record<number, unknown> };

function harness(opts: { runs?: RunFixture[]; store?: FakeStore; listRunRows?: RunRow[]; logs?: string; secrets?: string[]; secretsFail?: boolean } = {}) {
  const runs = opts.runs ?? [];
  const calls = { getRunRow: [] as string[][], traceSteps: [] as string[], logsTail: [] as string[] };
  const deps: DebugDeps = {
    store: opts.store ?? makeFakeStore(),
    listRunRows: async (input) => (opts.listRunRows ?? []).slice(input.offset ?? 0, (input.offset ?? 0) + input.limit),
    getRunRow: async (projectId, runId) => {
      calls.getRunRow.push([projectId, runId]);
      const r = runs.find((x) => x.id === runId && x.projectId === projectId);
      if (!r) return undefined;
      return {
        id: r.id,
        projectId: r.projectId,
        agentId: null,
        externalRunId: null,
        status: "completed",
        channel: "schedule",
        tokensInput: null,
        tokensOutput: null,
        tokensCachedInput: null,
        costUsd: null,
        compactionCount: null,
        peakContextTokens: null,
        wallClockMs: null,
        error: null,
        settledBy: null,
        startedAt: new Date("2026-11-19T00:00:00Z"),
        finishedAt: null,
        externalSessionId: null,
      };
    },
    traceSteps: async (runId) => {
      calls.traceSteps.push(runId);
      return runs.find((r) => r.id === runId)?.steps ?? [];
    },
    traceGatewayRows: async () => [],
    childRuns: async () => new Map(),
    stepEvidence: async (items) => {
      const out = new Map<string, { callSeq: number | null; inputPreview: string | null; message: string | null }>();
      for (const i of items) {
        const input = runs.find((r) => r.id === i.runId)?.inputs?.[i.seq];
        if (input != null) out.set(`${i.runId}:${i.seq}`, { callSeq: null, inputPreview: input.slice(0, 300), message: null });
      }
      return out;
    },
    toolPayloads: async (runId, fromSeq, toSeq) => {
      const r = runs.find((x) => x.id === runId);
      return (r?.steps ?? [])
        .filter((s) => s.type === "tool_call" && s.seq > fromSeq && (toSeq == null || s.seq < toSeq))
        .map((s) => ({
          seq: s.seq,
          toolName: s.toolName,
          input: r?.inputs?.[s.seq] ?? null,
          output: r?.outputs?.[s.seq] ?? null,
          exitCode: null,
          truncated: false,
          withheld: null,
          resultTokens: s.resultTokens,
          capped: false,
          isError: s.isError,
          durationMs: null,
        }));
    },
    runAggregates: async () => [],
    toolRanking: async () => [],
    loadWarnings: async () => [],
    logsTail: async (id) => {
      calls.logsTail.push(id);
      return opts.logs ?? "";
    },
    secretValues: async () => {
      if (opts.secretsFail) throw new Error("secrets store down");
      return opts.secrets ?? [];
    },
    now: () => new Date("2026-11-19T12:00:00Z"),
  };
  return { deps, calls };
}

describe("parseRunRef", () => {
  it("reads a bare run id", () => {
    expect(parseRunRef("ujbkfoqdsftw", "p1")).toEqual({ ok: true, runId: "ujbkfoqdsftw" });
  });

  it("reads relative and absolute usage links, with a call and a query", () => {
    expect(parseRunRef("/usage/repos/p1/runs/abc", "p1")).toEqual({ ok: true, runId: "abc" });
    expect(parseRunRef(" https://harnesst.example/usage/repos/p1/runs/abc/calls/12?days=7 ", "p1")).toEqual({
      ok: true,
      runId: "abc",
    });
  });

  it("reads transcript links, team and single", () => {
    expect(parseRunRef("/repos/p1/agents/pm/runs/abc", "p1")).toEqual({ ok: true, runId: "abc" });
    expect(parseRunRef("/repos/p1/runs/abc", "p1")).toEqual({ ok: true, runId: "abc" });
  });

  it("refuses a link to another repository's run", () => {
    const ref = parseRunRef("https://harnesst.example/usage/repos/p2/runs/abc", "p1");
    expect(ref.ok).toBe(false);
  });

  it("refuses links that are not run links and ids with odd characters", () => {
    expect(parseRunRef("/usage/repos/p1", "p1").ok).toBe(false);
    expect(parseRunRef("abc def", "p1").ok).toBe(false);
    expect(parseRunRef("", "p1").ok).toBe(false);
    expect(parseRunRef(42, "p1").ok).toBe(false);
  });
});

describe("parseSince", () => {
  const now = new Date("2026-11-19T12:00:00Z");

  it("reads relative hours and days and ISO times", () => {
    expect(parseSince("24h", now, 7).toISOString()).toBe("2026-11-18T12:00:00.000Z");
    expect(parseSince("2d", now, 7).toISOString()).toBe("2026-11-17T12:00:00.000Z");
    expect(parseSince("2026-11-19T00:00:00Z", now, 7).toISOString()).toBe("2026-11-19T00:00:00.000Z");
  });

  it("falls back on junk and clamps to 90 days", () => {
    expect(parseSince("soon", now, 7).toISOString()).toBe("2026-11-12T12:00:00.000Z");
    expect(parseSince("400d", now, 7).toISOString()).toBe("2026-08-21T12:00:00.000Z");
  });
});

describe("run-trace scoping", () => {
  const runs: RunFixture[] = [
    { id: "mine", projectId: "p1", steps: [step({ seq: 1, type: "model_call" })] },
    { id: "theirs", projectId: "p2", steps: [step({ seq: 1, type: "model_call" })] },
  ];

  it("reads a run of its own project", async () => {
    const { deps } = harness({ runs });
    expect(await runTraceAction(ctx, { run: "mine" }, deps)).toMatchObject({ ok: true, run: { id: "mine" } });
  });

  it("does not find another project's run by id, and reads none of its steps", async () => {
    const { deps, calls } = harness({ runs });
    const res = await runTraceAction(ctx, { run: "theirs" }, deps);
    expect(res.ok).toBe(false);
    expect(calls.getRunRow).toEqual([["p1", "theirs"]]);
    expect(calls.traceSteps).toEqual([]);
  });

  it("refuses another project's link before reading anything", async () => {
    const { deps, calls } = harness({ runs });
    const res = await runTraceAction(ctx, { run: "/usage/repos/p2/runs/theirs" }, deps);
    expect(res.ok).toBe(false);
    expect(calls.getRunRow).toEqual([]);
  });

  it("refuses another project's run through the step output path too", async () => {
    const { deps } = harness({ runs });
    expect((await runTraceAction(ctx, { run: "theirs", step: 1 }, deps)).ok).toBe(false);
  });
});

describe("run-trace paging", () => {
  // A long run: model call, then a tool call with a large input, 400 times.
  const steps: TraceStepRow[] = [];
  const inputs: Record<number, string> = {};
  for (let i = 0; i < 400; i++) {
    steps.push(step({ seq: i * 2 + 1, type: "model_call", tokensInput: 1000 + i, contextWindow: 272_000 }));
    const seq = i * 2 + 2;
    steps.push(step({ seq, type: "tool_call", toolName: "sheets__get", resultTokens: i === 7 ? 135_000 : 50 }));
    inputs[seq] = JSON.stringify({ range: `'Run history'!A:P`, pad: "x".repeat(500) });
  }
  const runs: RunFixture[] = [{ id: "long", projectId: "p1", steps, inputs }];

  it("keeps each page under the budget and pages through every step once", async () => {
    const { deps } = harness({ runs });
    const seen: number[] = [];
    let offset: number | null = 0;
    let pages = 0;
    while (offset != null) {
      const res: Record<string, unknown> = await runTraceAction(ctx, { run: "long", offset, limit: 200 }, deps);
      expect(byteSize(res)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
      const page = res.steps as { seq: number }[];
      expect(page.length).toBeGreaterThan(0);
      seen.push(...page.map((s) => s.seq));
      offset = res.nextOffset as number | null;
      expect(res.truncated).toBe(offset != null);
      pages++;
    }
    expect(pages).toBeGreaterThan(4);
    expect(seen).toEqual(steps.map((s) => s.seq));
  });

  it("names the largest tool result with its input", async () => {
    const { deps } = harness({ runs });
    const res = await runTraceAction(ctx, { run: "long" }, deps);
    const [top] = res.largestToolResults as { seq: number; resultTokens: number; input: string }[];
    expect(top).toMatchObject({ seq: 16, resultTokens: 135_000 });
    expect(top.input).toContain("Run history");
  });

  it("filters to problems: the oversized result only", async () => {
    const { deps } = harness({ runs });
    const res = await runTraceAction(ctx, { run: "long", only: "problems" }, deps);
    expect((res.steps as { seq: number }[]).map((s) => s.seq)).toEqual([16]);
    expect(res.nextOffset).toBeNull();
  });
});

describe("run-trace step output", () => {
  const big = { rows: Array.from({ length: 3000 }, (_, i) => [`row ${i}`, "a\"quoted\" value\n"]), access_token: "ya29.secretvalue" };
  const runs: RunFixture[] = [
    {
      id: "r",
      projectId: "p1",
      steps: [step({ seq: 1, type: "model_call" }), step({ seq: 2, type: "tool_call", toolName: "sheets__get" })],
      inputs: { 2: JSON.stringify({ range: "A:P", password: "hunter22" }) },
      outputs: { 2: big },
    },
  ];

  it("returns the output in chunks under the budget that join back to the redacted whole", async () => {
    const { deps } = harness({ runs });
    let chunkOffset: number | null = 0;
    let text = "";
    let first: Record<string, unknown> | null = null;
    while (chunkOffset != null) {
      const res: Record<string, unknown> = await runTraceAction(ctx, { run: "r", step: 2, chunkOffset }, deps);
      first ??= res;
      expect(byteSize(res)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
      text += res.output as string;
      chunkOffset = res.nextChunkOffset as number | null;
    }
    expect(text).toBe(redactText(JSON.stringify(big)));
    expect(text).not.toContain("ya29.secretvalue");
  });

  it("returns the full redacted input in chunks with part=input", async () => {
    const { deps } = harness({ runs });
    const res = await runTraceAction(ctx, { run: "r", step: 2, part: "input" }, deps);
    expect(res.input).toBe(redactText(JSON.stringify({ range: "A:P", password: "hunter22" })));
    expect(res.input).not.toContain("hunter22");
    expect(res.output).toBeUndefined();
  });

  it("refuses a step that is not a tool call", async () => {
    const { deps } = harness({ runs });
    expect((await runTraceAction(ctx, { run: "r", step: 1 }, deps)).ok).toBe(false);
  });
});

describe("runs", () => {
  const row = (id: string): RunRow => ({
    id,
    projectId: "p1",
    agentId: null,
    externalRunId: null,
    deploymentId: "d1",
    status: "failed",
    channel: "schedule",
    error: `Error: auth failed with "api_key": "sk-live-abcdefghij" ${"x".repeat(1000)}`,
    startedAt: "2026-11-19T00:00:00.000Z",
    finishedAt: null,
    input: null,
    cached: null,
    output: null,
    costUsd: null,
    peakContext: null,
    compactions: null,
    wallClockMs: null,
    settledBy: null,
    calls: 0,
    toolCalls: 0,
    toolErrors: 0,
    callErrors: 0,
    compactionsRequested: 0,
    window: null,
    medianContext: null,
  });

  it("pages with nextOffset and keeps error excerpts short and redacted", async () => {
    const { deps } = harness({ listRunRows: Array.from({ length: 30 }, (_, i) => row(`r${i}`)) });
    const res = await listRunsAction(ctx, { limit: 20 }, deps);
    const list = res.runs as { id: string; error: string }[];
    expect(list).toHaveLength(20);
    expect(res).toMatchObject({ truncated: true, nextOffset: 20 });
    expect(list[0].error.length).toBeLessThan(260);
    expect(list[0].error).not.toContain("sk-live-abcdefghij");
    const next = await listRunsAction(ctx, { limit: 20, offset: 20 }, deps);
    expect((next.runs as unknown[]).length).toBe(10);
    expect(next).toMatchObject({ truncated: false, nextOffset: null });
  });

  it("refuses an agent name not in this project", async () => {
    const { deps } = harness();
    expect((await listRunsAction(ctx, { agent: "nobody" }, deps)).ok).toBe(false);
  });
});

describe("deployments", () => {
  async function seeded() {
    const store = makeFakeStore();
    for (const p of ["p1", "p2"]) {
      store.seedProject({ id: p, orgId: "o" });
      store.seedAgent({ id: `a-${p}`, projectId: p, name: "pm" });
      store.seedEnvironment({ id: `e-${p}`, projectId: p, agentId: `a-${p}` });
      const rel = await store.releases.insert({ projectId: p, agentId: `a-${p}`, version: "v1", gitSha: "abcdef1234567890" });
      await store.deployments.insert({ environmentId: `e-${p}`, releaseId: rel.id, status: "live", trafficWeight: 100 });
    }
    const [mine] = await store.deployments.listByEnvironment("e-p1");
    const [theirs] = await store.deployments.listByEnvironment("e-p2");
    return { store, mine: mine.id, theirs: theirs.id };
  }

  it("lists only this project's deployments", async () => {
    const { store, mine } = await seeded();
    const { deps } = harness({ store });
    const res = await deploymentsAction(ctx, {}, deps);
    expect((res.deployments as { id: string }[]).map((d) => d.id)).toEqual([mine]);
  });

  it("withholds logs when the environment's secrets can't be loaded to mask them", async () => {
    const { store, mine } = await seeded();
    const { deps, calls } = harness({ store, logs: "SHEETS_KEY plainsecretvalue", secretsFail: true });
    const res = await deploymentsAction(ctx, { logs: mine }, deps);
    expect(res.logs).toMatchObject({ available: false });
    expect(JSON.stringify(res)).not.toContain("plainsecretvalue");
    expect(calls.logsTail).toEqual([]);
  });

  it("refuses logs for another project's deployment without reading them", async () => {
    const { store, theirs } = await seeded();
    const { deps, calls } = harness({ store, logs: "boom" });
    expect((await deploymentsAction(ctx, { logs: theirs }, deps)).ok).toBe(false);
    expect(calls.logsTail).toEqual([]);
  });

  it("removes the environment's secret values and colour codes from the log tail and keeps it under budget", async () => {
    const { store, mine } = await seeded();
    const noisy = `\x1b[31mstarting with SHEETS_KEY=plainsecretvalue\x1b[0m\n` + "line of log output\n".repeat(5000) + "last line";
    const { deps } = harness({ store, logs: noisy, secrets: ["plainsecretvalue"] });
    const res = await deploymentsAction(ctx, { logs: mine }, deps);
    const logs = res.logs as { text: string; truncated: boolean };
    expect(byteSize(res)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    expect(logs.truncated).toBe(true);
    expect(logs.text.endsWith("last line")).toBe(true);
    expect(scrubLogs(noisy.split("\n")[0], ["plainsecretvalue"])).toBe("starting with SHEETS_KEY=[redacted]");
  });
});

describe("fitItems / fitChunk", () => {
  it("keeps the largest prefix that fits", () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ i, pad: "x".repeat(1000) }));
    const { body, kept } = fitItems(items, (k) => ({ items: k }), 10_000);
    expect(byteSize(body)).toBeLessThanOrEqual(10_000);
    expect(byteSize({ items: items.slice(0, kept + 1) })).toBeGreaterThan(10_000);
  });

  it("shrinks a chunk whose escaping outgrows the budget", () => {
    const text = "\u0001".repeat(10_000); // six bytes each once JSON-escaped
    const body = fitChunk(text, 0, 10_000, (chunk, next) => ({ chunk, next }), 20_000);
    expect(byteSize(body)).toBeLessThanOrEqual(20_000);
    expect(body.next).toBe((body.chunk as string).length);
  });
});

describe("redactText", () => {
  it("masks secret-named JSON fields whatever the value's shape", () => {
    expect(redactText(`{"password":"hunter2","refresh_token":"1//abc def","tokens":120}`)).toBe(
      `{"password":"[redacted]","refresh_token":"[redacted]","tokens":120}`,
    );
  });

  it("masks a field an excerpt cut off mid-value", () => {
    expect(redactText(`{"range":"A:P","apiKey":"abcd1234ef`)).toBe(`{"range":"A:P","apiKey":"[redacted]`);
  });

  it("masks fields inside JSON held in a JSON string", () => {
    expect(redactText(`{"body":"{\\"client_secret\\":\\"s3cr3t\\",\\"n\\":1}"}`)).toBe(
      `{"body":"{\\"client_secret\\":\\"[redacted]\\",\\"n\\":1}"}`,
    );
  });

  it("masks quoted env assignments and connection URI passwords", () => {
    expect(redactText(`export API_KEY="plainsecretvalue"`)).toBe(`export API_KEY="[redacted]"`);
    expect(redactText("DATABASE_URL=postgres://harnesst:plainsecretvalue@db:5432/world")).toBe(
      "DATABASE_URL=postgres://harnesst:[redacted]@db:5432/world",
    );
  });

  it("masks key=value pairs and Slack and harnesst tokens", () => {
    expect(redactText("GET /x?access_token=abcd1234&page=2")).toBe("GET /x?access_token=[redacted]&page=2");
    expect(redactText("xoxb-1234567890-abcdefghij")).toBe("[redacted]");
    expect(redactText("edna_abcdefghijkl.mnopqrstuvwx")).toBe("[redacted]");
  });

  it("leaves token counts and ordinary text alone", () => {
    const text = `{"max_tokens":4096,"tokenizer":"o200k","note":"the token budget"} max_tokens=4096`;
    expect(redactText(text)).toBe(text);
  });
});
