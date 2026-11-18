/**
 * Values bound for Postgres `integer` columns at ingest. A fraction is rounded and a value past
 * int4 is capped (as `wall_clock_ms` already is elsewhere), so one odd reading from a producer
 * can't fail the insert and drop the whole run. Not a finite number: null.
 */
export const INT4_MAX = 2_147_483_647;

export function intColumn(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(-INT4_MAX, Math.min(INT4_MAX, Math.round(value)));
}

/** A join key (eve's step index): exact or nothing, since a rounded key would join the wrong row. */
export function intKey(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && Math.abs(value) <= INT4_MAX
    ? value
    : null;
}
