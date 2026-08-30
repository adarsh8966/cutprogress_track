/**
 * Fallback profile used only before the user has saved settings.
 *
 * Everything measurable is null: the app does not invent a height, a target or
 * a starting weight on the user's behalf (spec §48). Only genuinely neutral
 * defaults are set - a UTC timezone, imperial display units, and the
 * conventional 1%-per-week loss ceiling from spec §45.
 */
import type { DailyMetrics, LocalDate, UserProfile } from './types';

export const DEFAULT_PROFILE: UserProfile = {
  heightCm: null,
  sex: null,
  dateOfBirth: null,
  timezone: 'UTC',
  startingWeightKg: null,
  targetWeightKg: null,
  phase: 'CUT',
  targets: {
    calories: null,
    proteinG: null,
    fiberG: null,
    steps: null,
    trainingSessionsPerWeek: null,
    cardioMinutesPerWeek: null,
  },
  maxWeeklyLossRatePct: 1.0,
  cutStartDate: null,
  weightDisplayUnit: 'LB',
  distanceDisplayUnit: 'MI',
  lengthDisplayUnit: 'IN',
};

/**
 * A day with nothing measured on it.
 *
 * EVERY FIELD IS NULL, and null means NOT LOGGED - never zero (§33). This is
 * the shape to spread over when only some fields matter:
 *
 *   { ...emptyDay('2026-08-29'), weightKg: 92.4 }
 *
 * It exists because DailyMetrics grows. Before this, five test files each
 * carried their own hand-written list of every field, so adding a canonical
 * column meant editing all five - and the tempting fix in that moment is to
 * loosen the type rather than update the lists, which is how a field ends up
 * silently absent from the fixtures that are supposed to prove it works.
 */
export function emptyDay(localDate: LocalDate): DailyMetrics {
  return {
    localDate,
    weightKg: null,
    waistCm: null,
    steps: null,
    activeCalories: null,
    totalCaloriesBurned: null,
    workoutMinutes: null,
    cardioMinutes: null,
    zone2Minutes: null,
    restingHeartRate: null,
    hrvMs: null,
    sleepDurationMinutes: null,
    sleepScore: null,
    bodyFatPct: null,
    vo2Max: null,
    distanceKm: null,
    floors: null,
    activeMinutes: null,
    activeZoneMinutes: null,
    respiratoryRate: null,
    oxygenSaturationPct: null,
    remMinutes: null,
    deepMinutes: null,
    lightMinutes: null,
    awakeMinutes: null,
    sleepTemperatureDeltaC: null,
    caloriesConsumed: null,
    proteinG: null,
    carbsG: null,
    fatG: null,
    fiberG: null,
    fruitVegServings: null,
    trainingSessions: null,
  };
}
