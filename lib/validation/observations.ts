/**
 * Plausible ranges for an OBSERVED measurement (spec §8, §33).
 *
 * lib/validation/safety.ts guards the targets a user sets for themselves. This
 * file guards the numbers arriving from outside - a pasted report, a form - and
 * it exists because the real rails used to be the database CHECK constraints
 * alone. A value the database would refuse produced a silently swallowed insert
 * error and a cheerful "imported" message, which is precisely the failure this
 * application must not have.
 *
 * Every bound here MIRRORS a CHECK constraint in supabase/migrations. Keeping
 * the two in step is the point, so tests/unit/observations.test.ts asserts the
 * numbers and tests/integration exercises the constraints themselves. If a
 * migration widens a range, widen it here too.
 *
 * This module is pure. It reports; it never coerces, clamps or drops a value.
 * The caller decides, and the user sees the value either way.
 */

export interface RangeRule {
  min: number;
  max: number;
  /** Rendered in the message, so it reads as the user wrote it. */
  unit: string;
}

/**
 * Keyed by the parser's field names. `max: Infinity` means the database
 * constrains only the lower bound (`>= 0`); the value is still checked for
 * negativity, which is the mistake that actually happens.
 */
export const OBSERVATION_RANGES = {
  // body_measurements: weight_kg between 20 and 400, waist_cm between 30 and 250
  weightKg: { min: 20, max: 400, unit: 'kg' },
  waistCm: { min: 30, max: 250, unit: 'cm' },

  // nutrition_logs: every macro >= 0. The upper bounds match app/actions/log.ts,
  // which is where a human-scale ceiling was already agreed.
  calories: { min: 0, max: 20000, unit: 'kcal' },
  proteinG: { min: 0, max: 2000, unit: 'g' },
  carbsG: { min: 0, max: 3000, unit: 'g' },
  fatG: { min: 0, max: 2000, unit: 'g' },
  fiberG: { min: 0, max: 500, unit: 'g' },

  // metric_observations: value >= 0, with the ceilings from app/actions/log.ts
  steps: { min: 0, max: 200000, unit: 'steps' },
  activeCalories: { min: 0, max: 10000, unit: 'kcal' },
  restingHeartRate: { min: 25, max: 250, unit: 'bpm' },
  hrvMs: { min: 0, max: 500, unit: 'ms' },

  // sleep_records: duration_minutes between 0 and 1440
  sleepMinutes: { min: 0, max: 1440, unit: 'min' },

  // workout_sessions.duration_minutes between 0 and 1440.
  // cardio_sessions.duration_minutes has no ceiling in SQL; the same day-length
  // bound is applied here because a session cannot outlast its own day.
  sessionMinutes: { min: 0, max: 1440, unit: 'min' },
  // cardio_sessions: distance_km >= 0
  distanceKm: { min: 0, max: 1000, unit: 'km' },
  // cardio_sessions / workout_sessions: heart rates between 25 and 250
  averageHeartRate: { min: 25, max: 250, unit: 'bpm' },
  maxHeartRate: { min: 25, max: 250, unit: 'bpm' },
  // cardio_sessions / workout_sessions: calories >= 0
  sessionCalories: { min: 0, max: 10000, unit: 'kcal' },
  // cardio_sessions: hr_zone between 1 and 5
  hrZone: { min: 1, max: 5, unit: '' },
} as const satisfies Record<string, RangeRule>;

export type ObservationKey = keyof typeof OBSERVATION_RANGES;

export function isObservationKey(key: string): key is ObservationKey {
  return Object.prototype.hasOwnProperty.call(OBSERVATION_RANGES, key);
}

/** Groups digits so a wrong-by-1000 value is obvious at a glance. */
function readable(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return Math.abs(value) >= 1000
    ? value.toLocaleString('en-US', { maximumFractionDigits: 2 })
    : String(Math.round(value * 1000) / 1000);
}

function describe(rule: RangeRule): string {
  const suffix = rule.unit ? ` ${rule.unit}` : '';
  return rule.max === Infinity
    ? `${readable(rule.min)}${suffix} or more`
    : `${readable(rule.min)} to ${readable(rule.max)}${suffix}`;
}

/**
 * Returns a sentence explaining why the value cannot be recorded, or null when
 * it is within range. An unknown key is not an error here - the parser reads
 * some fields (a workout label) that carry no numeric range at all.
 */
export function checkObservation(key: string, value: number): string | null {
  if (!Number.isFinite(value)) {
    return 'That is not a number this can record.';
  }
  if (!isObservationKey(key)) return null;

  const rule: RangeRule = OBSERVATION_RANGES[key];
  if (value < rule.min || value > rule.max) {
    const suffix = rule.unit ? ` ${rule.unit}` : '';
    return `${readable(value)}${suffix} is outside the recordable range (${describe(rule)}).`;
  }
  return null;
}

/**
 * True when the value would be refused by the database. Used by the import
 * action to fail loudly BEFORE the insert, so the user is never told a row was
 * written that was not.
 */
export function isRecordable(key: string, value: number): boolean {
  return checkObservation(key, value) === null;
}
