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

/**
 * An absolute moment, ISO-8601 with an offset.
 *
 * NOT a LocalDate. This is a point on the timeline, so it is the same instant
 * in every timezone; a LocalDate is the calendar day the USER experienced it
 * on, which is a question only the profile's timezone can answer (spec §40).
 * The two are stored separately for that reason and neither is derived from
 * the other at read time.
 */
export type Instant = string;

export type DataSource =
  | 'MANUAL'
  | 'HEVY'
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
  /**
   * True when the figure cannot be computed at all - no target is set, or the
   * metric is not supported - as opposed to there being too little data for it
   * yet. See unavailable() and stateOf() below.
   */
  unavailable?: true;
  /**
   * How many real measurements the method found, where it counted them.
   *
   * This exists so that a null value can say WHICH kind of nothing it is. Zero
   * means the metric was never logged; a positive number means measurements do
   * exist but were not enough to compute this particular figure. Rendering
   * those two as the same sentence tells the user their data was never
   * recorded, which is a different - and false - claim (spec §33).
   *
   * Optional: a method that has no meaningful count of inputs simply omits it.
   */
  observations?: number;
}

export function derived<T>(
  value: T | null,
  method: string,
  inputs: Record<string, unknown>,
  confidence: DerivedConfidence,
  notes: string[] = [],
  observations?: number,
): Derived<T> {
  return {
    value, method, inputs, confidence, notes,
    ...(observations === undefined ? {} : { observations }),
  };
}

/**
 * A derived value that could not be computed, with the reason recorded.
 *
 * `observations` is how many measurements were found anyway. Pass it whenever
 * the method knows: it is the difference between "not logged" and "not enough
 * data" everywhere this value is displayed.
 */
export function insufficient<T>(
  method: string,
  inputs: Record<string, unknown>,
  reason: string,
  observations?: number,
): Derived<T> {
  return {
    value: null,
    method,
    inputs,
    confidence: 'INSUFFICIENT',
    notes: [reason],
    ...(observations === undefined ? {} : { observations }),
  };
}

/**
 * A figure that cannot be computed AT ALL, however much data arrives.
 *
 * Distinct from insufficient(): "no calorie target is set" and "only one of
 * twenty-eight days is logged" are answered by different actions - one by
 * Settings, the other by waiting - and a screen that says "not logged" for
 * either is telling the user their measurements were never recorded. That is
 * how the Dashboard came to report Training as not logged on a day with a
 * training session on it: adherence had no target to score against, said so
 * with an uncounted insufficient(), and the UI had nothing else to call it.
 *
 * `observations` is still accepted and still means what it always did, because
 * "no target set" says nothing about whether the metric was logged.
 */
export function unavailable<T>(
  method: string,
  inputs: Record<string, unknown>,
  reason: string,
  observations?: number,
): Derived<T> {
  return {
    value: null,
    method,
    inputs,
    confidence: 'INSUFFICIENT',
    notes: [reason],
    unavailable: true,
    ...(observations === undefined ? {} : { observations }),
  };
}

/**
 * The four claims a figure can make about itself, plus the one it must not.
 *
 * Spec §33 distinguishes these and the codebase kept collapsing them into the
 * single sentence "not logged", which is a statement about the DATABASE and is
 * false in three of the five cases:
 *
 *   PRESENT       a value was computed - show it
 *   UNAVAILABLE   cannot be computed at all: no target, not supported
 *   INSUFFICIENT  measurements exist, too few for THIS figure - show coverage,
 *                 and show the latest actual reading beside it
 *   NOT_LOGGED    nothing was ever recorded. The only case that sentence fits
 *   UNKNOWN       the method did not count, so it cannot say which of the last
 *                 two applies - and must not guess
 *
 * UNKNOWN exists to make the old bug unrepresentable rather than merely rare:
 * a method that omits `observations` can no longer be rendered as "not logged"
 * by default. tests/unit/coverage-states.test.ts fails the build if anything in
 * lib/analytics produces one.
 */
export type ValueState =
  | 'PRESENT'
  | 'UNAVAILABLE'
  | 'INSUFFICIENT'
  | 'NOT_LOGGED'
  | 'UNKNOWN';

export function stateOf(d: Derived<unknown>): ValueState {
  if (d.value !== null) return 'PRESENT';
  if (d.unavailable) return 'UNAVAILABLE';
  if (d.observations === undefined) return 'UNKNOWN';
  return d.observations > 0 ? 'INSUFFICIENT' : 'NOT_LOGGED';
}

/**
 * True when a Derived<T> has no value BUT measurements exist - the figure was
 * refused for want of coverage, not for want of data. The UI and the Context
 * Pack both need this distinction, so it is defined once here.
 */
export function isInsufficientNotAbsent(d: Derived<unknown>): boolean {
  return stateOf(d) === 'INSUFFICIENT';
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
