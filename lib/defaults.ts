/**
 * Fallback profile used only before the user has saved settings.
 *
 * Everything measurable is null: the app does not invent a height, a target or
 * a starting weight on the user's behalf (spec §48). Only genuinely neutral
 * defaults are set - a UTC timezone, imperial display units, and the
 * conventional 1%-per-week loss ceiling from spec §45.
 */
import type { UserProfile } from './types';

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
