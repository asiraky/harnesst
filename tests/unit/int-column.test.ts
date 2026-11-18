/** Integer ingest columns: a bad reading becomes a rounded or capped number, never a failed insert. */
import { describe, expect, it } from "vitest";

import { INT4_MAX, intColumn, intKey } from "~/observability/int-column";

describe("intColumn", () => {
  it("passes integers through and rounds fractions", () => {
    expect(intColumn(272_000)).toBe(272_000);
    expect(intColumn(288661.5)).toBe(288662);
    expect(intColumn(0.25)).toBe(0);
  });

  it("caps values past int4 and nulls what isn't a finite number", () => {
    expect(intColumn(3_000_000_000)).toBe(INT4_MAX);
    expect(intColumn(-3_000_000_000)).toBe(-INT4_MAX);
    expect(intColumn(undefined)).toBeNull();
    expect(intColumn(null)).toBeNull();
    expect(intColumn(Number.NaN)).toBeNull();
    expect(intColumn(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("intKey", () => {
  it("keeps exact integers and drops anything it would have to guess", () => {
    expect(intKey(3)).toBe(3);
    expect(intKey(1.5)).toBeNull();
    expect(intKey(3_000_000_000)).toBeNull();
    expect(intKey(undefined)).toBeNull();
  });
});
