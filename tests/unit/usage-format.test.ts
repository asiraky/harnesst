/**
 * Usage formatting (#418): unknown figures render as unknown, never as zero, and the thresholds
 * the views colour by.
 */
import { describe, expect, it } from "vitest";

import { contextLevel, formatPercent, formatTokens, median, parseWindowDays, planWindowLabel, ratio } from "~/usage/format";

describe("parseWindowDays", () => {
  it("accepts the offered windows and falls back to a week", () => {
    expect(parseWindowDays("1")).toBe(1);
    expect(parseWindowDays("30")).toBe(30);
    expect(parseWindowDays("90")).toBe(7);
    expect(parseWindowDays(null)).toBe(7);
  });
});

describe("formatTokens", () => {
  it("scales and marks unknown", () => {
    expect([999, 12_345, 718_000, 1_234_567, 242_000_000].map(formatTokens)).toEqual(["999", "12.3k", "718k", "1.2M", "242M"]);
    expect(formatTokens(null)).toBe("—");
  });
});

describe("ratio", () => {
  it("is null when either side is unknown or the whole is zero", () => {
    expect(ratio(1, 4)).toBe(0.25);
    expect(ratio(null, 4)).toBeNull();
    expect(ratio(1, null)).toBeNull();
    expect(ratio(0, 0)).toBeNull();
  });
});

describe("formatPercent", () => {
  it("keeps a decimal under 10%", () => {
    expect(formatPercent(0.004)).toBe("0.4%");
    expect(formatPercent(0.9)).toBe("90%");
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(null)).toBe("—");
  });
});

describe("contextLevel", () => {
  it("warns past half the window and is critical from the compaction threshold", () => {
    expect([0.5, 0.51, 0.89, 0.9].map(contextLevel)).toEqual(["ok", "warn", "warn", "crit"]);
    expect(contextLevel(null)).toBeNull();
  });
});

describe("median", () => {
  it("handles odd, even and empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("planWindowLabel", () => {
  it("names plan windows the way people say them", () => {
    expect([300, 10080, 1440, 90].map(planWindowLabel)).toEqual(["5h", "weekly", "1d", "90m"]);
  });
});
