/**
 * Which records can be withdrawn from a day, and what to call one.
 *
 * Pure, and separate from app/actions/corrections.ts on purpose. That file is
 * a 'use server' module, where every export must be an async server action - a
 * plain object and a type guard cannot live there. Keeping them here also lets
 * a test read the vocabulary without a database.
 *
 * THE SET IS CLOSED, AND MEMBERSHIP MEANS TWO THINGS AT ONCE:
 *
 *   1. the table has superseded_at / superseded_by (migration 0011 for the two
 *      session tables, 0012 for the four scalar observation tables), and
 *   2. the canonical rebuild in lib/data/canonicalise.ts EXCLUDES superseded
 *      rows from that table.
 *
 * A table listed here without (2) would let the user withdraw a record from
 * the screen while it went on counting in every figure derived from the day -
 * the app agreeing it was removed and the analytics disagreeing. So the two
 * are asserted together in tests/unit/corrections.test.ts rather than left as
 * a rule someone has to remember.
 */
export const WITHDRAWABLE = {
  body_measurements: 'body measurement',
  metric_observations: 'daily metric',
  nutrition_logs: 'nutrition log',
  sleep_records: 'sleep record',
  cardio_sessions: 'cardio session',
  workout_sessions: 'training session',
} as const;

export type WithdrawableTable = keyof typeof WITHDRAWABLE;

export function isWithdrawableTable(value: string): value is WithdrawableTable {
  return Object.prototype.hasOwnProperty.call(WITHDRAWABLE, value);
}

/** The name to use in a sentence: "Withdrew a body measurement". */
export function withdrawableLabel(table: WithdrawableTable): string {
  return WITHDRAWABLE[table];
}
