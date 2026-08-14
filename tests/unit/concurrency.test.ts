/**
 * mapWithConcurrency (issue #375) — the bounded pool under the parallel publish build step.
 * The settled-not-rejected contract is load-bearing: a failed root build must not abandon
 * sibling docker builds mid-flight.
 */
import { describe, expect, it } from "vitest";

import { concurrencyFromEnv, mapWithConcurrency } from "~/lib/concurrency";

/** A promise that resolves only when `release()` is called — for observing in-flight counts. */
function gate<T>(value: T) {
  let release!: () => void;
  const promise = new Promise<T>((resolve) => {
    release = () => resolve(value);
  });
  return { promise, release };
}

describe("mapWithConcurrency", () => {
  it("never exceeds the limit and eventually processes every item", async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Yield so other workers get a chance to (illegally) overlap.
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return n * 10;
    });
    expect(peak).toBe(2);
    expect(results).toHaveLength(5);
  });

  it("holds items back while the pool is full", async () => {
    const gates = [gate(1), gate(2), gate(3)];
    const started: number[] = [];
    const run = mapWithConcurrency([0, 1, 2], 2, (i) => {
      started.push(i);
      return gates[i].promise;
    });
    await Promise.resolve();
    expect(started).toEqual([0, 1]); // third item waits for a slot
    gates[0].release();
    await gates[0].promise;
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2]);
    gates[1].release();
    gates[2].release();
    await run;
  });

  it("returns results in item order regardless of completion order", async () => {
    const delays = [30, 1, 15];
    const results = await mapWithConcurrency(delays, 3, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return `item-${i}`;
    });
    expect(results).toEqual([
      { status: "fulfilled", value: "item-0" },
      { status: "fulfilled", value: "item-1" },
      { status: "fulfilled", value: "item-2" },
    ]);
  });

  it("settles failures in place — siblings still run to completion", async () => {
    const completed: number[] = [];
    const results = await mapWithConcurrency([0, 1, 2], 1, async (i) => {
      if (i === 0) throw new Error("boom");
      completed.push(i);
      return i;
    });
    expect(completed).toEqual([1, 2]);
    expect(results[0]).toEqual({
      status: "rejected",
      reason: expect.objectContaining({ message: "boom" }),
    });
    expect(results[1]).toEqual({ status: "fulfilled", value: 1 });
    expect(results[2]).toEqual({ status: "fulfilled", value: 2 });
  });

  it("a limit at or above the item count degenerates to allSettled", async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapWithConcurrency([1, 2, 3], 10, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return n;
    });
    expect(peak).toBe(3);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  });

  it("handles an empty list and clamps a nonsense limit to 1", async () => {
    expect(await mapWithConcurrency([], 3, async (n) => n)).toEqual([]);
    const order: number[] = [];
    await mapWithConcurrency([1, 2], 0, async (n) => {
      order.push(n);
    });
    expect(order).toEqual([1, 2]);
  });

  it("a NaN limit still processes every item — zero workers would fake an all-clear", async () => {
    const seen: number[] = [];
    const results = await mapWithConcurrency([1, 2, 3], NaN, async (n) => {
      seen.push(n);
      return n;
    });
    expect(seen).toEqual([1, 2, 3]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  });
});

describe("concurrencyFromEnv", () => {
  it("parses a positive integer and rejects everything else in favor of the fallback", () => {
    expect(concurrencyFromEnv("4", 3)).toBe(4);
    expect(concurrencyFromEnv("1", 3)).toBe(1);
    // A typo'd knob must degrade to the default — NaN would mean zero pool workers in the
    // build step and an UNBOUNDED in-flight check in the job worker.
    expect(concurrencyFromEnv("two", 3)).toBe(3);
    expect(concurrencyFromEnv("", 3)).toBe(3); // Number("") is 0
    expect(concurrencyFromEnv("0", 3)).toBe(3);
    expect(concurrencyFromEnv("-2", 3)).toBe(3);
    expect(concurrencyFromEnv("2.5", 3)).toBe(3);
    expect(concurrencyFromEnv(undefined, 3)).toBe(3);
  });
});
