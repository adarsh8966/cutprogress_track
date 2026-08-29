/**
 * The Recovery page's figures, on the data that exposed the bug (spec §14).
 *
 * recoverySummary is what the page renders. Asserting it here means the page
 * cannot regress into showing "not logged" for measurements that exist without
 * a test going red first.
 */
import { describe, it, expect } from 'vitest';
import { recoverySummary } from '@/lib/analytics/recovery';
import type { DailyMetrics } from '@/lib/types';

function day(partial: Partial<DailyMetrics> & { localDate: string }): DailyMetrics {
  return {
    weightKg: null, waistCm: null, steps: null, activeCalories: null,
    totalCaloriesBurned: null, workoutMinutes: null, cardioMinutes: null,
    zone2Minutes: null, restingHeartRate: null, hrvMs: null,
    sleepDurationMinutes: null, sleepScore: null, caloriesConsumed: null,
    proteinG: null, carbsG: null, fatG: null, fiberG: null,
    fruitVegServings: null, trainingSessions: null,
    ...partial,
  };
}

/** The live stress test: four days imported, the 27th missing. */
const DAYS: DailyMetrics[] = [
  day({ localDate: '2026-08-24', restingHeartRate: 62, hrvMs: 51, sleepDurationMinutes: 430 }),
  day({ localDate: '2026-08-25', restingHeartRate: 59, hrvMs: 57, sleepDurationMinutes: 445 }),
  day({ localDate: '2026-08-26', restingHeartRate: 58, hrvMs: 64, sleepDurationMinutes: 420 }),
  day({ localDate: '2026-08-27' }),
  day({ localDate: '2026-08-28', restingHeartRate: 58, hrvMs: 62, sleepDurationMinutes: 460 }),
];

const END = '2026-08-29';

describe('recoverySummary', () => {
  it('shows the latest resting heart rate and HRV', () => {
    const r = recoverySummary(DAYS, END);
    expect(r.restingHeartRate.latest.value).toBe(58);
    expect(r.hrv.latest.value).toBe(62);
  });

  it('attributes each reading to the day it was measured', () => {
    const r = recoverySummary(DAYS, END);
    expect(r.restingHeartRate.latest.inputs.observedOn).toBe('2026-08-28');
    expect(r.hrv.latest.inputs.observedOn).toBe('2026-08-28');
  });

  it('keeps the 30-day averages gated, and says how much data there was', () => {
    const r = recoverySummary(DAYS, END);
    expect(r.restingHeartRate.average30.value).toBeNull();
    expect(r.restingHeartRate.average30.confidence).toBe('INSUFFICIENT');
    // Not zero: this is "not enough data", not "not logged".
    expect(r.restingHeartRate.average30.observations).toBe(4);
    expect(r.hrv.average30.observations).toBe(4);
  });

  it('reports a metric nobody logged as absent', () => {
    const r = recoverySummary(DAYS, END);
    expect(r.totalCaloriesBurned.latest.value).toBeNull();
    expect(r.totalCaloriesBurned.latest.observations).toBe(0);
  });

  it('leaves the unlogged day as a gap in the chart series, not a zero', () => {
    const r = recoverySummary(DAYS, END);
    const gap = r.restingHeartRate.series.find((p) => p.date === '2026-08-27');
    expect(gap?.value).toBeNull();
  });

  it('reports sleep, which cleared the gate and was visible all along', () => {
    const r = recoverySummary(DAYS, END);
    expect(r.sleep7.value).not.toBeNull();
  });

  it('distinguishes no cardio at all from cardio with no zone 2', () => {
    const none = recoverySummary(DAYS, END).zone2Minutes;
    expect(none.value).toBeNull();
    expect(none.observations).toBe(0);

    const someCardio = recoverySummary(
      [...DAYS, day({ localDate: '2026-08-29', zone2Minutes: 0 })],
      END,
    ).zone2Minutes;
    // A real measured zero: cardio happened, none of it in zone 2.
    expect(someCardio.value).toBe(0);
    expect(someCardio.observations).toBe(1);
  });

  it('flags a week below the user’s own baseline, informationally', () => {
    const belowBaseline = recoverySummary(
      [
        ...Array.from({ length: 30 }, (_, i) =>
          day({ localDate: `2026-07-${String(i + 1).padStart(2, '0')}`, sleepDurationMinutes: 480 })),
        ...Array.from({ length: 7 }, (_, i) =>
          day({ localDate: `2026-08-${String(i + 1).padStart(2, '0')}`, sleepDurationMinutes: 360 })),
      ],
      '2026-08-07',
    );
    expect(belowBaseline.belowBaseline).toBe(true);
  });
});
