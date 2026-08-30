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
import { rowToDailyMetrics, rowToTrainingSession, toInstant, toLocalDate } from '@/lib/data/rows';
import type { DailyMetricsRow, WorkoutSessionRow } from '@/lib/supabase/types';

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

/**
 * The third promise, added when the session timing columns were finally read.
 *
 * `start_time` and `end_time` had been written since migration 0004 by all
 * three writers and mapped by nothing, so the true order of two sessions on
 * one day was unknowable to every consumer of a table that had recorded it all
 * along. Mapping them puts the same driver hazard toLocalDate exists for onto a
 * second column type: a timestamptz comes back as text from PostgREST and as a
 * Date object from PGlite, and an unnormalised pair of those neither compares
 * as a string nor orders correctly.
 */
describe('toInstant', () => {
  it('normalises an ISO string to UTC', () => {
    expect(toInstant('2026-08-29T22:00:00Z')).toBe('2026-08-29T22:00:00.000Z');
  });

  it('reads the Date object a driver hands back', () => {
    expect(toInstant(new Date('2026-08-29T22:00:00Z')))
      .toBe('2026-08-29T22:00:00.000Z');
  });

  it("parses Postgres' own space-separated form", () => {
    expect(toInstant('2026-08-29 22:00:00+00')).toBe('2026-08-29T22:00:00.000Z');
  });

  /**
   * The point of normalising rather than passing through. These are the same
   * moment written three ways, and a consumer comparing them as text would
   * order them by their punctuation.
   */
  it('makes the same instant the same string, however it was written', () => {
    const written = [
      '2026-08-29T22:00:00Z',
      '2026-08-29T22:00:00+00:00',
      '2026-08-29T18:00:00-04:00',
    ].map(toInstant);
    expect(new Set(written).size).toBe(1);
  });

  it('keeps an offset session at the instant it happened, not the wall clock', () => {
    // 18:00 in New York on the 29th IS 22:00 UTC on the 29th.
    expect(toInstant('2026-08-29T18:00:00-04:00')).toBe('2026-08-29T22:00:00.000Z');
  });

  it('leaves an absent time absent', () => {
    expect(toInstant(null)).toBeNull();
    expect(toInstant(undefined)).toBeNull();
  });

  /**
   * Not an epoch, and not a guess. A time that cannot be read is not known,
   * and null already means exactly that everywhere else here (spec §7, §33).
   */
  it('refuses to invent a time it cannot read', () => {
    expect(toInstant('yesterday evening')).toBeNull();
    expect(toInstant('')).toBeNull();
    expect(toInstant(new Date('nonsense'))).toBeNull();
    expect(toInstant(1756504800000)).toBeNull();
  });
});

describe('rowToTrainingSession', () => {
  function session(overrides: Partial<WorkoutSessionRow> = {}): WorkoutSessionRow {
    return {
      id: 's1',
      user_id: 'u1',
      created_at: '2026-08-29T23:10:00Z',
      local_date: '2026-08-29',
      start_time: '2026-08-29T22:00:00Z',
      end_time: '2026-08-29T23:04:00Z',
      duration_minutes: 64,
      session_type: 'PULL',
      average_heart_rate: null,
      max_heart_rate: null,
      calories: null,
      notes: null,
      completed: true,
      source: 'HEVY',
      import_id: null,
      superseded_at: null,
      superseded_by: null,
      title: 'Pull',
      external_source: 'HEVY',
      external_id: 'hevy-1',
      external_updated_at: '2026-08-29T23:10:00Z',
      ...overrides,
    } as WorkoutSessionRow;
  }

  it('maps the start and end times the writers have always stored', () => {
    const mapped = rowToTrainingSession(session());
    expect(mapped.startTime).toBe('2026-08-29T22:00:00.000Z');
    expect(mapped.endTime).toBe('2026-08-29T23:04:00.000Z');
  });

  it('reads the Date objects PGlite returns for a timestamptz', () => {
    const mapped = rowToTrainingSession(session({
      start_time: new Date('2026-08-29T22:00:00Z') as never,
      end_time: new Date('2026-08-29T23:04:00Z') as never,
    }));
    expect(mapped.startTime).toBe('2026-08-29T22:00:00.000Z');
    expect(mapped.endTime).toBe('2026-08-29T23:04:00.000Z');
  });

  /** The paste importer's shape: a summary records the day and nothing finer. */
  it('leaves a date-only session with no times at all', () => {
    const mapped = rowToTrainingSession(
      session({ start_time: null, end_time: null, source: 'IMPORT_TEXT' }),
    );
    expect(mapped.startTime).toBeNull();
    expect(mapped.endTime).toBeNull();
    // And it is still a whole session. Nothing about it is degraded by the
    // absence, which is the case a date-only import has to keep working in.
    expect(mapped.date).toBe('2026-08-29');
    expect(mapped.durationMinutes).toBe(64);
  });

  /** The logger's shape: a session in progress has started and not ended. */
  it('keeps a started session with no end null-ended, not ended now', () => {
    const mapped = rowToTrainingSession(session({ end_time: null }));
    expect(mapped.startTime).toBe('2026-08-29T22:00:00.000Z');
    expect(mapped.endTime).toBeNull();
  });

  /**
   * The one inference that would look helpful and be forbidden. Deriving the
   * duration from the interval would report a measurement the source never
   * made, and it feeds the duration-weighted average HR in summariseSessions.
   */
  it('does not derive a missing duration from the interval', () => {
    const mapped = rowToTrainingSession(session({ duration_minutes: null }));
    expect(mapped.startTime).not.toBeNull();
    expect(mapped.endTime).not.toBeNull();
    expect(mapped.durationMinutes).toBeNull();
  });

  /**
   * `local_date` was resolved in the user's timezone when the row was written
   * (spec §40). 22:00 UTC is still the 29th in New York and already the 30th in
   * Tokyo, so a reader re-deriving the day from the instant - with no timezone
   * to do it with - would move the session. The stored day wins.
   */
  it('takes the day from local_date, never from the start time', () => {
    const mapped = rowToTrainingSession(session({
      local_date: '2026-08-29',
      start_time: '2026-08-30T01:30:00Z',
    }));
    expect(mapped.date).toBe('2026-08-29');
  });
});
