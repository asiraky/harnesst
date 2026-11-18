/**
 * Values bound for Postgres `integer` columns at ingest. A fraction is rounded and anything
 * outside int4 (or not a finite number) becomes null, so one odd reading from a producer can't
 * fail the insert and drop the whole run.
 */
const INT4_MAX = 2_147_483_647;

export function intColumn(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return Math.abs(rounded) <= INT4_MAX ? rounded : null;
}
