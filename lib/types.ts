/**
 * Shared domain types.
 *
 * CANONICAL UNITS (spec §39). Everything inside the system is metric:
 *   mass        kilograms   (kg)
 *   length      centimetres (cm)
 *   distance    kilometres  (km)
 *   energy      kilocalories(kcal)
 *   duration    minutes     (min)
 * Conversion to display units happens only at the UI boundary, and parsing
 * happens only at the import boundary. Nothing in between converts.
 *
 * MISSING DATA (spec §7, §33). `null` means "not logged". It is never zero, and
 * the four states the spec distinguishes map as follows:
 *   0               a real measured zero (e.g. zero cardio minutes on a rest day)
 *   null            not logged / unknown
 *   absent key      not applicable for that record type
 * Analytics never coerce null to 0. See presentValues() in lib/analytics/series.ts.
 */

/** ISO calendar date in the user's local timezone, `YYYY-MM-DD`. */
export type LocalDate = string;

export type DataSource =
  | 'MANUAL'
  | 'HEALTH_CONNECT'
  | 'GOOGLE_HEALTH'
  | 'BEVEL'
  | 'IMPORT_TEXT'
  | 'ESTIMATED'
  | 'OTHER';

export type ConfidenceLevel = 'HIGH' | 'MODERATE' | 'LOW';

export type Phase = 'CUT' | 'MAINTENANCE' | 'REVERSE_DIET' | 'LEAN_GAIN';

/**
 * The confidence attached to a derived value. INSUFFICIENT is distinct from
 * LOW: LOW means "computed, but treat it gently"; INSUFFICIENT means "not
 * computed at all, there wasn't enough data". Spec §32.
 */
export type DerivedConfidence = ConfidenceLevel | 'INSUFFICIENT';

/**
 * The return shape of every calculation in this codebase (spec §57).
 *
 * A number on its own is not a permitted output. Any figure the app displays
 * must be able to answer "why?" with the method that produced it and the exact
 * inputs it consumed, which is what the Evidence component renders and what the
 * Context Pack hands to ChatGPT.
 *
 * `value: null` is a first-class result meaning "not computable from the data
 * available". It is never a stand-in for zero.
 */
export interface Derived<T> {
  value: T | null;
  /** Documented formula name, cross-referenced in docs/analytics.md. */
  method: string;
  /** The exact inputs used, for audit and display. */
  inputs: Record<string, unknown>;
  confidence: DerivedConfidence;
  /** Human-readable caveats, e.g. why the value is null. */
  notes: string[];
}

export function derived<T>(
  value: T | null,
  method: string,
  inputs: Record<string, unknown>,
  confidence: DerivedConfidence,
  notes: string[] = [],
): Derived<T> {
  return { value, method, inputs, confidence, notes };
}

/** A derived value that could not be computed, with the reason recorded. */
export function insufficient<T>(
  method: string,
  inputs: Record<string, unknown>,
  reason: string,
): Derived<T> {
  return {
    value: null,
    method,
    inputs,
    confidence: 'INSUFFICIENT',
    notes: [reason],
  };
}

/** One day of canonical, resolved metrics. Every measurement may be null. */
export interface DailyMetrics {
  localDate: LocalDate;

  weightKg: number | null;
  waistCm: number | null;

  steps: number | null;
  activeCalories: number | null;
  totalCaloriesBurned: number | null;
  workoutMinutes: number | null;
  cardioMinutes: number | null;
  zone2Minutes: number | null;

  restingHeartRate: number | null;
  hrvMs: number | null;
  sleepDurationMinutes: number | null;
  sleepScore: number | null;

  caloriesConsumed: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  fiberG: number | null;
  fruitVegServings: number | null;

  trainingSessions: number | null;
}

/** A day-indexed series of one metric. Gaps are explicit nulls, not absences. */
export interface DatedValue {
  date: LocalDate;
  value: number | null;
}

export interface Targets {
  calories: number | null;
  proteinG: number | null;
  fiberG: number | null;
  steps: number | null;
  trainingSessionsPerWeek: number | null;
  cardioMinutesPerWeek: number | null;
}

export interface UserProfile {
  heightCm: number | null;
  sex: 'MALE' | 'FEMALE' | 'UNSPECIFIED' | null;
  dateOfBirth: LocalDate | null;
  timezone: string;
  startingWeightKg: number | null;
  targetWeightKg: number | null;
  phase: Phase;
  targets: Targets;
  maxWeeklyLossRatePct: number;
  cutStartDate: LocalDate | null;
  weightDisplayUnit: 'LB' | 'KG';
  distanceDisplayUnit: 'MI' | 'KM';
  lengthDisplayUnit: 'IN' | 'CM';
}

/** Version stamped onto everything the analytics engine produces (spec §43). */
export const ANALYTICS_VERSION = '0.1.0';
