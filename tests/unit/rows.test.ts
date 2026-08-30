/**
 * The row mapper's promises, checked (spec §33, §40).
 *
 * lib/data/rows.ts exists to make a database row's types HONEST before
 * anything downstream relies on them. Two of those promises are easy to make
 * and easy to break, and both have been broken here before:
 *
 *   a numeric column is a number or null, never a string and never a 0
 *   local_date is a `YYYY-MM-DD` string, because it is the key every series
 *   is built on
 *
 * The second is the one that bites hardest. A driver returning `date` as a
 * Date object does not misformat one figure - it makes '2026-11-02' fail to
 * match '2026-11-02T00:00:00.000Z', so every trailing window, latest reading
 * and chart finds nothing for a day that is sitting right there in the table.
 */
import { describe, it, expect } from 'vitest';
import { rowToDailyMetrics, toLocalDate } from '@/lib/data/rows';
import type { DailyMetricsRow } from '@/lib/supabase/types';

function row(overrides: Partial<DailyMetricsRow> = {}): DailyMetricsRow {
  return {
    id: 'd1',
    user_id: 'u1',
    created_at: '2026-11-02T00:00:00Z',
    updated_at: '2026-11-02T00:00:00Z',
    local_date: '2026-11-02',
    weight_kg: null, waist_cm: null, steps: null, active_calories: null,
    total_calories_burned: null, workout_minutes: null, cardio_minutes: null,
    zone2_minutes: null, resting_heart_rate: null, hrv_ms: null,
    sleep_duration_minutes: null, sleep_score: null, calories_consumed: null,
    protein_g: null, carbs_g: null, fat_g: null, fiber_g: null,
    fruit_veg_servings: null, training_sessions: null,
    provenance: {},
    ...overrides,
  } as DailyMetricsRow;
}

describe('toLocalDate', () => {
  it('passes a plain date string through', () => {
    expect(toLocalDate('2026-11-02')).toBe('2026-11-02');
  });

  it('reduces a Date to the calendar day it represents', () => {
    expect(toLocalDate(new Date('2026-11-02T00:00:00.000Z'))).toBe('2026-11-02');
  });

  /**
   * A `date` column carries no time zone. Reading one through local-time
   * getters west of Greenwich would move the whole series back a day, which is
   * the exact failure spec §40 exists to prevent - so UTC parts are read.
   */
  it('does not shift the day, whatever the machine timezone', () => {
    expect(toLocalDate(new Date(Date.UTC(2026, 10, 2)))).toBe('2026-11-02');
    expect(toLocalDate(new Date(Date.UTC(2026, 0, 1)))).toBe('2026-01-01');
    expect(toLocalDate(new Date(Date.UTC(2026, 11, 31)))).toBe('2026-12-31');
  });

  it('trims a timestamp back to its date', () => {
    expect(toLocalDate('2026-11-02T23:30:00.000Z')).toBe('2026-11-02');
  });
});

describe('rowToDailyMetrics', () => {
  it('gives the day a key a series can match on', () => {
    // The regression: a Date here made every downstream lookup miss.
    const mapped = rowToDailyMetrics(
      row({ local_date: new Date('2026-11-02T00:00:00.000Z') as never }),
    );
    expect(mapped.localDate).toBe('2026-11-02');
  });

  it('reads a numeric column returned as a string', () => {
    const mapped = rowToDailyMetrics(row({ weight_kg: '92.400' as never }));
    expect(mapped.weightKg).toBe(92.4);
  });

  it('keeps an unmeasured field null rather than turning it into a zero', () => {
    const mapped = rowToDailyMetrics(row({ steps: null }));
    expect(mapped.steps).toBeNull();
  });

  it('keeps a measured zero, which is a reading', () => {
    const mapped = rowToDailyMetrics(row({ steps: 0 }));
    expect(mapped.steps).toBe(0);
  });
});
