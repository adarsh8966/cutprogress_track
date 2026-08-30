/**
 * "Not logged" and "not enough data" are different claims (spec §33).
 *
 * A Derived<T> with a null value covers both, and for a long time nothing
 * downstream could tell them apart - so a 30-day average that declined to be
 * computed from four real readings was displayed with the same words as a
 * metric that had never been recorded. The user reasonably read that as their
 * import having failed.
 *
 * `observations` is what carries the difference out of the analytics layer, and
 * isInsufficientNotAbsent is the single predicate the UI and the Context Pack
 * both ask. These tests pin the distinction where it is produced.
 */
import { describe, it, expect } from 'vitest';
import { trailingAverage } from '@/lib/analytics/movingAverage';
import {
  isInsufficientNotAbsent, derived, insufficient, unavailable, stateOf,
} from '@/lib/types';
import type { DatedValue } from '@/lib/types';

/** The live import: four readings inside a thirty-day window. */
const SPARSE: DatedValue[] = [
  { date: '2026-08-24', value: 62 },
  { date: '2026-08-25', value: 59 },
  { date: '2026-08-26', value: 58 },
  { date: '2026-08-28', value: 58 },
];

describe('a refused average reports the data it did find', () => {
  it('still refuses to average four days over thirty', () => {
    // The gate is correct and stays. Reporting 4/30 as a "30-day average"
    // would be the fabrication the working agreement forbids.
    const average = trailingAverage(SPARSE, '2026-08-29', 30);
    expect(average.value).toBeNull();
    expect(average.confidence).toBe('INSUFFICIENT');
  });

  it('counts the readings it had, so the refusal is not read as absence', () => {
    const average = trailingAverage(SPARSE, '2026-08-29', 30);
    expect(average.observations).toBe(4);
    expect(isInsufficientNotAbsent(average)).toBe(true);
  });

  it('reports zero observations when nothing was ever logged', () => {
    const average = trailingAverage([], '2026-08-29', 30);
    expect(average.observations).toBe(0);
    // This one really is "not logged", and must keep saying so.
    expect(isInsufficientNotAbsent(average)).toBe(false);
  });

  it('counts observations on a computed average too', () => {
    const dense: DatedValue[] = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-08-${String(i + 1).padStart(2, '0')}`,
      value: 60,
    }));
    const average = trailingAverage(dense, '2026-08-30', 30);
    expect(average.value).toBe(60);
    expect(average.observations).toBe(30);
    // A value that exists is never an absence of any kind.
    expect(isInsufficientNotAbsent(average)).toBe(false);
  });

  it('treats a null day as no reading, never as a zero reading', () => {
    const withGap: DatedValue[] = [...SPARSE, { date: '2026-08-27', value: null }];
    expect(trailingAverage(withGap, '2026-08-29', 30).observations).toBe(4);
  });
});

describe('the Derived constructors', () => {
  it('omit observations when the method does not count them', () => {
    expect(derived(1, 'm', {}, 'HIGH')).not.toHaveProperty('observations');
    expect(insufficient('m', {}, 'why')).not.toHaveProperty('observations');
  });

  it('treat an uncounted absence as absence, not as insufficiency', () => {
    // Absent `observations` must not be guessed at: a method that never
    // counted cannot claim data exists.
    expect(isInsufficientNotAbsent(insufficient('m', {}, 'why'))).toBe(false);
  });
});

/**
 * The fourth state, and the one that must never be claimed by default.
 *
 * "No target is set" is answered in Settings; "one of twenty-eight days is
 * logged" is answered by waiting; "nothing was ever recorded" is answered by
 * logging. A screen that says "not logged" for all three is wrong about two of
 * them, and it was wrong about the one that mattered: the Dashboard reported
 * Training as never logged on a day carrying a training session, because
 * adherence had no target to score against and no way to say so.
 */
describe('stateOf separates the four claims', () => {
  it('calls a computed value PRESENT', () => {
    expect(stateOf(derived(1, 'm', {}, 'HIGH'))).toBe('PRESENT');
    // A measured zero is a value, not an absence (spec §33).
    expect(stateOf(derived(0, 'm', {}, 'HIGH'))).toBe('PRESENT');
  });

  it('calls a counted, empty window NOT_LOGGED', () => {
    expect(stateOf(insufficient('m', {}, 'why', 0))).toBe('NOT_LOGGED');
  });

  it('calls a counted, sparse window INSUFFICIENT', () => {
    expect(stateOf(insufficient('m', {}, 'why', 4))).toBe('INSUFFICIENT');
    expect(stateOf(trailingAverage(SPARSE, '2026-08-29', 30))).toBe('INSUFFICIENT');
  });

  it('calls a figure that cannot be computed at all UNAVAILABLE', () => {
    expect(stateOf(unavailable('m', {}, 'No target is set.'))).toBe('UNAVAILABLE');
  });

  it('keeps UNAVAILABLE distinct even when data exists', () => {
    // Days logged and no target set: both facts are true, and the actionable
    // one is the target.
    const d = unavailable('m', {}, 'No target is set.', 28);
    expect(stateOf(d)).toBe('UNAVAILABLE');
    expect(d.observations).toBe(28);
  });

  it('refuses to guess when the method did not count', () => {
    // The old default was to render this as "not logged", which asserts
    // something about the database that the method never checked.
    expect(stateOf(insufficient('m', {}, 'why'))).toBe('UNKNOWN');
  });

  it('keeps isInsufficientNotAbsent meaning exactly INSUFFICIENT', () => {
    expect(isInsufficientNotAbsent(insufficient('m', {}, 'why', 4))).toBe(true);
    expect(isInsufficientNotAbsent(insufficient('m', {}, 'why', 0))).toBe(false);
    expect(isInsufficientNotAbsent(unavailable('m', {}, 'why', 4))).toBe(false);
    expect(isInsufficientNotAbsent(derived(1, 'm', {}, 'HIGH'))).toBe(false);
  });
});
