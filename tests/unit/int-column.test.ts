/** Integer ingest columns: a bad reading becomes a rounded number or null, never a failed insert. */
import { describe, expect, it } from "vitest";

import { intColumn } from "~/observability/int-column";

describe("intColumn", () => {
  it("passes integers through and rounds fractions", () => {
    expect(intColumn(272_000)).toBe(272_000);
    expect(intColumn(288661.5)).toBe(288662);
    expect(intColumn(0.25)).toBe(0);
  });

  it("maps missing, non-finite and out-of-int4 values to null", () => {
    expect(intColumn(undefined)).toBeNull();
    expect(intColumn(null)).toBeNull();
    expect(intColumn(Number.NaN)).toBeNull();
    expect(intColumn(Number.POSITIVE_INFINITY)).toBeNull();
    expect(intColumn(2_147_483_648)).toBeNull();
    expect(intColumn(2_147_483_647)).toBe(2_147_483_647);
  });
});
