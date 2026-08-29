/**
 * Numeric coercion at the database boundary.
 *
 * PostgREST returns `numeric` columns as STRINGS in some configurations, so a
 * value read back from Postgres cannot be trusted to already be a number. The
 * naive fixes are both wrong: `Number(value)` turns null into 0, which is the
 * missing-data bug spec §33 exists to prevent, and leaving the string alone
 * makes every `value: number` type in the layer above a lie.
 *
 * This lives in lib/normalization rather than lib/data because the canonical
 * resolver needs it too, and lib/ stays free of I/O and Supabase imports.
 */

/** null and undefined stay null. Only a real, finite value becomes a number. */
export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
