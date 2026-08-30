/**
 * Raw rows -> what the day view shows (spec §17, §33, §39).
 *
 * This is the mapper the day view reads through, so it is where a stored
 * column silently stops being represented - the same class of bug that hid
 * resting heart rate, fruit and veg servings, and active calories. It is a
 * pure unit for exactly that reason.
 */
import { describe, it, expect } from 'vitest';
import {
  toDayRecords, formatDayField, presentFields, canonicalSummary,
  liveRecords, supersededRecords, formatDuration,
  type DayRows,
} from '@/lib/data/dayRecords';
import type { DailyMetrics } from '@/lib/types';
import type { DisplayUnits } from '@/lib/normalization/units';

const IMPERIAL: DisplayUnits = { weight: 'LB', length: 'IN', distance: 'MI' };
const METRIC: DisplayUnits = { weight: 'KG', length: 'CM', distance: 'KM' };

function rows(overrides: Partial<DayRows> = {}): DayRows {
  return {
    body: [], metrics: [], nutrition: [], sleep: [], cardio: [], workouts: [],
    ...overrides,
  };
}

const LIVE = { superseded_at: null, superseded_by: null };

describe('toDayRecords', () => {
  it('turns a body measurement into a record that names its fields', () => {
    const [record] = toDayRecords(rows({
      body: [{
        id: 'b1', source: 'MANUAL', notes: null, ...LIVE,
        measured_at: '2026-08-28T07:00:00Z', weight_kg: 92.4, waist_cm: 89.2,
      }],
    }));

    expect(record!.table).toBe('body_measurements');
    expect(record!.title).toBe('Body measurement');
    expect(record!.source).toBe('MANUAL');
    expect(presentFields(record!).map((f) => f.label)).toEqual(['Weight', 'Waist']);
  });

  it('drops a field the observation did not carry, rather than showing a zero', () => {
    const [record] = toDayRecords(rows({
      body: [{
        id: 'b1', source: 'MANUAL', notes: null, ...LIVE,
        measured_at: '2026-08-28T07:00:00Z', weight_kg: 92.4, waist_cm: null,
      }],
    }));

    expect(presentFields(record!).map((f) => f.label)).toEqual(['Weight']);
    // The field is still declared, holding null - "not recorded", not 0.
    expect(record!.fields.find((f) => f.label === 'Waist')!.value).toBeNull();
  });

  it('keeps a measured zero, which is a reading', () => {
    const [record] = toDayRecords(rows({
      metrics: [{
        id: 'm1', source: 'MANUAL', notes: null, ...LIVE,
        metric: 'STEPS', value: 0, measured_at: '2026-08-28T07:00:00Z',
      }],
    }));

    expect(presentFields(record!)).toHaveLength(1);
    expect(record!.fields[0]!.value).toBe(0);
  });

  it('reads a numeric column returned as a string', () => {
    // PostgREST and PGlite both do this for `numeric`; a naive Number(null)
    // elsewhere is how a missing value becomes a zero.
    const [record] = toDayRecords(rows({
      sleep: [{
        id: 's1', source: 'IMPORT_TEXT', notes: null, ...LIVE,
        created_at: '2026-08-28T07:00:00Z',
        duration_minutes: '450', sleep_score: null,
      }],
    }));

    expect(record!.fields[0]!.value).toBe(450);
  });

  it('carries every cardio column the table holds', () => {
    const [record] = toDayRecords(rows({
      cardio: [{
        id: 'c1', source: 'IMPORT_TEXT', notes: 'Incline walk', ...LIVE,
        created_at: '2026-08-28T07:00:00Z', cardio_type: 'INCLINE_WALKING',
        duration_minutes: 35, distance_km: 4.18, average_heart_rate: 128,
        max_heart_rate: 149, hr_zone: 2, calories: 260,
      }],
    }));

    expect(record!.title).toBe('Cardio · Incline walking');
    expect(presentFields(record!).map((f) => f.label)).toEqual([
      'Duration', 'Distance', 'Average HR', 'Maximum HR', 'Calories burned',
      'Heart-rate zone',
    ]);
    expect(record!.notes).toBe('Incline walk');
  });

  it('links a training session to its own page', () => {
    const [record] = toDayRecords(rows({
      workouts: [{
        id: 'w1', source: 'IMPORT_TEXT', notes: 'Pull', ...LIVE,
        created_at: '2026-08-28T07:00:00Z', session_type: 'PULL',
        duration_minutes: 58, average_heart_rate: 142, max_heart_rate: 171,
        calories: 412, completed: true,
      }],
    }));

    expect(record!.href).toBe('/training/w1');
    expect(record!.title).toBe('Training · Pull');
  });

  it('keeps an unrecognised metric under its own name rather than hiding it', () => {
    const [record] = toDayRecords(rows({
      metrics: [{
        id: 'm1', source: 'OTHER', notes: null, ...LIVE,
        metric: 'SOMETHING_NEW', value: 7, measured_at: '2026-08-28T07:00:00Z',
      }],
    }));

    expect(record!.title).toBe('Something new');
    expect(record!.fields[0]!.value).toBe(7);
  });

  it('tells a replacement apart from a withdrawal', () => {
    const records = toDayRecords(rows({
      body: [
        {
          id: 'replaced', source: 'MANUAL', notes: null,
          superseded_at: '2026-08-29T09:00:00Z', superseded_by: 'newer',
          measured_at: '2026-08-28T07:00:00Z', weight_kg: 92.4, waist_cm: null,
        },
        {
          id: 'withdrawn', source: 'MANUAL', notes: null,
          superseded_at: '2026-08-29T09:00:00Z', superseded_by: null,
          measured_at: '2026-08-28T08:00:00Z', weight_kg: 93.4, waist_cm: null,
        },
      ],
    }));

    expect(records.find((r) => r.id === 'replaced')!.replaced).toBe(true);
    expect(records.find((r) => r.id === 'withdrawn')!.replaced).toBe(false);
  });

  it('puts what still counts first, then the newest of the rest', () => {
    const records = toDayRecords(rows({
      body: [
        {
          id: 'old', source: 'MANUAL', notes: null, ...LIVE,
          measured_at: '2026-08-28T06:00:00Z', weight_kg: 92, waist_cm: null,
        },
        {
          id: 'gone', source: 'MANUAL', notes: null,
          superseded_at: '2026-08-29T09:00:00Z', superseded_by: null,
          measured_at: '2026-08-28T09:00:00Z', weight_kg: 91, waist_cm: null,
        },
        {
          id: 'new', source: 'MANUAL', notes: null, ...LIVE,
          measured_at: '2026-08-28T08:00:00Z', weight_kg: 93, waist_cm: null,
        },
      ],
    }));

    expect(records.map((r) => r.id)).toEqual(['new', 'old', 'gone']);
    expect(liveRecords(records).map((r) => r.id)).toEqual(['new', 'old']);
    expect(supersededRecords(records).map((r) => r.id)).toEqual(['gone']);
  });

  it('keeps superseded rows in the list, because the day view has to show them', () => {
    const records = toDayRecords(rows({
      sleep: [{
        id: 's1', source: 'MANUAL', notes: null,
        superseded_at: '2026-08-29T09:00:00Z', superseded_by: null,
        created_at: '2026-08-28T07:00:00Z', duration_minutes: 450, sleep_score: null,
      }],
    }));

    expect(records).toHaveLength(1);
    expect(records[0]!.supersededAt).not.toBeNull();
  });
});

describe('formatDayField', () => {
  it('writes a weight in the unit the user reads in', () => {
    const field = { label: 'Weight', value: 92.4, unit: 'WEIGHT' as const };
    expect(formatDayField(field, IMPERIAL)).toBe('203.7 lb');
    expect(formatDayField(field, METRIC)).toBe('92.4 kg');
  });

  it('writes a waist and a distance in their own units', () => {
    expect(formatDayField({ label: 'Waist', value: 89.2, unit: 'LENGTH' }, IMPERIAL))
      .toBe('35.1 in');
    expect(formatDayField({ label: 'Distance', value: 4.18, unit: 'DISTANCE' }, IMPERIAL))
      .toBe('2.6 mi');
    expect(formatDayField({ label: 'Distance', value: 4.18, unit: 'DISTANCE' }, METRIC))
      .toBe('4.18 km');
  });

  it('returns null for a field that was not recorded, never a zero', () => {
    expect(formatDayField({ label: 'Waist', value: null, unit: 'LENGTH' }, IMPERIAL))
      .toBeNull();
  });

  it('writes a duration the way a person reads one', () => {
    expect(formatDuration(35)).toBe('35 min');
    expect(formatDuration(450)).toBe('7h 30m');
    expect(formatDuration(60)).toBe('1h 0m');
  });

  it('labels the unit-free figures', () => {
    expect(formatDayField({ label: 'Calories', value: 2001, unit: 'KCAL' }, IMPERIAL))
      .toBe('2001 kcal');
    expect(formatDayField({ label: 'Protein', value: 172, unit: 'GRAMS' }, IMPERIAL))
      .toBe('172 g');
    expect(formatDayField({ label: 'RHR', value: 57, unit: 'BPM' }, IMPERIAL))
      .toBe('57 bpm');
    expect(formatDayField({ label: 'Zone', value: 2, unit: 'ZONE' }, IMPERIAL))
      .toBe('zone 2');
    expect(formatDayField({ label: 'Steps', value: 15000, unit: 'COUNT' }, IMPERIAL))
      .toBe('15000');
  });
});

describe('canonicalSummary', () => {
  function day(partial: Partial<DailyMetrics>): DailyMetrics {
    return {
      localDate: '2026-08-28',
      weightKg: null, waistCm: null, steps: null, activeCalories: null,
      totalCaloriesBurned: null, workoutMinutes: null, cardioMinutes: null,
      zone2Minutes: null, restingHeartRate: null, hrvMs: null,
      sleepDurationMinutes: null, sleepScore: null, caloriesConsumed: null,
      proteinG: null, carbsG: null, fatG: null, fiberG: null,
      fruitVegServings: null, trainingSessions: null,
      ...partial,
    };
  }

  it('covers every measurement column, so none can be resolved and unseen', () => {
    const keys = canonicalSummary(day({})).map((field) => field.key);
    const measurements = Object.keys(day({})).filter((key) => key !== 'localDate');
    for (const key of measurements) {
      expect(keys, `${key} is canonical but the day view does not list it`).toContain(key);
    }
  });

  it('marks the summed fields as aggregates, which have no source', () => {
    const summary = canonicalSummary(day({}));
    const aggregates = summary.filter((f) => f.aggregate).map((f) => f.key);
    // These are totals of the day's sessions (lib/data/canonicalise.ts), not
    // resolutions between competing observations, so they carry no provenance
    // entry and the view must not print a blank where a source belongs.
    expect(aggregates.sort()).toEqual(
      ['cardioMinutes', 'trainingSessions', 'workoutMinutes', 'zone2Minutes'],
    );
  });

  it('uses the same provenance keys the resolver writes', () => {
    const summary = canonicalSummary(day({ weightKg: 92.4, restingHeartRate: 57 }));
    // These are the keys lib/data/canonicalise.ts resolves under; a mismatch
    // would show every field as "source not recorded".
    expect(summary.find((f) => f.key === 'weightKg')!.value).toBe(92.4);
    expect(summary.find((f) => f.key === 'restingHeartRate')!.value).toBe(57);
  });
});
