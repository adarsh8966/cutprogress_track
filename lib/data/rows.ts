/**
 * Database rows -> domain objects. Pure, and deliberately importable without
 * `server-only`.
 *
 * The mapping is where a stored value most easily stops being represented: a
 * column selected but never mapped is invisible to every page while looking
 * perfectly healthy in the database. That has happened twice in this codebase
 * already, so the mapper is a testable unit rather than a closure inside a
 * query function no test can call.
 *
 * Every numeric column goes through toNumber(), which preserves null as null:
 * PostgREST returns numerics as strings in some configurations, and Number(null)
 * would produce 0 - the missing-data bug spec §33 exists to prevent.
 */
import type { DailyMetrics, LocalDate, UserProfile } from '@/lib/types';
import type { DailyMetricsRow, ProfileRow } from '@/lib/supabase/types';
import { toNumber } from '@/lib/normalization/numbers';

/**
 * A `date` column as the `YYYY-MM-DD` string LocalDate claims to be.
 *
 * Same reasoning as toNumber() below, for the column that matters most. What a
 * driver hands back for a `date` is not guaranteed to be a string: PostgREST
 * serialises it to text, other drivers return a Date object at UTC midnight.
 *
 * And localDate is not just another field - it is the KEY every series is
 * built on. A Date arriving where a string was expected does not misformat one
 * figure; it makes `'2026-11-02'` fail to match `'2026-11-02T00:00:00.000Z'`,
 * so every trailing window, every latest reading and every chart silently
 * finds nothing for a day that is sitting right there.
 *
 * The UTC parts are read deliberately. A date column carries no time zone, and
 * reading it through local-time getters west of Greenwich would move the whole
 * series back a day.
 */
export function toLocalDate(value: unknown): LocalDate {
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

export function rowToProfile(row: ProfileRow): UserProfile {
  return {
    heightCm: toNumber(row.height_cm),
    sex: row.sex,
    dateOfBirth: row.date_of_birth,
    timezone: row.timezone,
    startingWeightKg: toNumber(row.starting_weight_kg),
    targetWeightKg: toNumber(row.target_weight_kg),
    phase: row.phase,
    targets: {
      calories: toNumber(row.target_calories),
      proteinG: toNumber(row.target_protein_g),
      fiberG: toNumber(row.target_fiber_g),
      steps: toNumber(row.target_steps),
      trainingSessionsPerWeek: toNumber(row.target_training_sessions_per_week),
      cardioMinutesPerWeek: toNumber(row.target_cardio_minutes_per_week),
    },
    maxWeeklyLossRatePct: toNumber(row.max_weekly_loss_rate_pct) ?? 1,
    cutStartDate: row.cut_start_date,
    weightDisplayUnit: row.weight_display_unit,
    distanceDisplayUnit: row.distance_display_unit,
    lengthDisplayUnit: row.length_display_unit,
  };
}

/**
 * One canonical day.
 *
 * EVERY measurement column on daily_metrics is mapped here. A column added to
 * the table and to DailyMetrics but forgotten here is stored, resolved and
 * unreachable - see tests/unit/canonical-readers.test.ts, which fails when a
 * field has no reader.
 */
export function rowToDailyMetrics(row: DailyMetricsRow): DailyMetrics {
  return {
    localDate: toLocalDate(row.local_date),
    weightKg: toNumber(row.weight_kg),
    waistCm: toNumber(row.waist_cm),
    steps: toNumber(row.steps),
    activeCalories: toNumber(row.active_calories),
    totalCaloriesBurned: toNumber(row.total_calories_burned),
    workoutMinutes: toNumber(row.workout_minutes),
    cardioMinutes: toNumber(row.cardio_minutes),
    zone2Minutes: toNumber(row.zone2_minutes),
    restingHeartRate: toNumber(row.resting_heart_rate),
    hrvMs: toNumber(row.hrv_ms),
    sleepDurationMinutes: toNumber(row.sleep_duration_minutes),
    sleepScore: toNumber(row.sleep_score),
    caloriesConsumed: toNumber(row.calories_consumed),
    proteinG: toNumber(row.protein_g),
    carbsG: toNumber(row.carbs_g),
    fatG: toNumber(row.fat_g),
    fiberG: toNumber(row.fiber_g),
    fruitVegServings: toNumber(row.fruit_veg_servings),
    trainingSessions: toNumber(row.training_sessions),
  };
}

export function rowsToDailyMetrics(rows: DailyMetricsRow[]): DailyMetrics[] {
  return rows.map(rowToDailyMetrics);
}
