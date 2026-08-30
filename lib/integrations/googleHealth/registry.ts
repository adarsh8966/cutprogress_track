/**
 * Google Health data type -> CUT OS canonical destination.
 *
 * THE ONE MAPPING TABLE. Every fact about a data type lives in its entry here:
 * the id used in a URL path, the different id used in a filter, its record
 * shape, the scope that unlocks it, the endpoint that reads it, its page-size
 * and range ceilings, where its value belongs in CUT OS, and how to get the
 * value out of a payload. Nothing about a data type is scattered anywhere else.
 *
 * WHY THAT MATTERS MORE THAN TIDINESS. Google Health is adding data types on a
 * published roadmap - blood pressure, basal metabolic rate, mindfulness and
 * more are dated for 2026 - and the question this file exists to answer is
 * "what does it cost to support one?". With the table, the answer is: an entry
 * here, and (if the metric is new to CUT OS) a canonical column, a METRIC_FIELD
 * line and a reader. Without it, the answer is a search through the whole
 * integration for the places a data type is named.
 *
 * A TYPE WITH NOWHERE TO GO IS STILL INGESTED. `destination.kind === 'UNMAPPED'`
 * means supported, fetched, and written to external_observations with its
 * payload intact - detected and preserved rather than dropped on the floor.
 * Promoting one later reads its history back out of the raw layer; discarding
 * it would have meant re-syncing a window the API may no longer return.
 *
 * EVERY extract() IS TOLERANT AND NULL-PRESERVING. It returns null for a field
 * it cannot find, and null means "not measured" the whole way down. It never
 * substitutes zero - except where the API's own true-zero semantics say a
 * present record with an absent count IS a zero, which is handled explicitly
 * and only for the five data types the documentation names.
 */
import type { MetricKeyEnum } from '@/lib/supabase/types';
import {
  ACTIVITY_SCOPE, METRICS_SCOPE, SLEEP_SCOPE, type GoogleHealthScope,
} from './scopes';
import { MAX_PAGE_SIZE, at, asObject, numAt, durationSeconds } from './types';

/** How the API shapes a record, which decides how it is timed and filtered. */
export type RecordType = 'SAMPLE' | 'INTERVAL' | 'DAILY' | 'SESSION';

/** Which endpoint reads it. `list` is the default; some types have no list. */
export type ReadMethod = 'LIST' | 'DAILY_ROLLUP';

export type Destination =
  /** A scalar that resolves into daily_metrics through metric_observations. */
  | { kind: 'METRIC'; metric: MetricKeyEnum; unit: string }
  /** Body weight, which has a table of its own. */
  | { kind: 'BODY'; field: 'weight_kg'; unit: string }
  /** A sleep session, with stages. */
  | { kind: 'SLEEP' }
  /** An exercise session: correlated with training, or written as cardio. */
  | { kind: 'EXERCISE' }
  /** Per-session physiology. Never a daily metric on its own. */
  | { kind: 'TELEMETRY' }
  /** Supported and stored, with no canonical destination yet. */
  | { kind: 'UNMAPPED'; note: string };

/** What extract() found: a scalar, and whatever context the caller needs. */
export interface ExtractedValue {
  value: number | null;
  unit: string | null;
  /**
   * True when the record is present but its metric field is absent, which the
   * true-zeros guide defines as a measured zero rather than missing data. Only
   * ever set for the five data types that support it.
   */
  trueZero?: boolean;
}

export interface DataTypeSpec {
  /** Kebab-case, as it appears in the endpoint path. */
  readonly dataType: string;
  /**
   * Snake-case, as it must appear in a filter expression. Different from the
   * path form for any multi-word type, and using the wrong one is a 400 with
   * INVALID_DATA_POINT_FILTER - which is why both are stated rather than one
   * being derived from the other at a call site.
   */
  readonly filterField: string;
  readonly record: RecordType;
  readonly scope: GoogleHealthScope;
  readonly read: ReadMethod;
  readonly pageSize: number;
  /** The rollup range ceiling, where one applies. */
  readonly maxRangeDays: 14 | 90 | null;
  /** Whether an absent metric field on a present record means zero. */
  readonly trueZeros: boolean;
  readonly destination: Destination;
  /** Human-readable, for the coverage table in Settings. */
  readonly label: string;
  /** Pulls the measurement out of a data point's body. */
  readonly extract: (body: unknown) => ExtractedValue | null;
}

/**
 * A scalar reader for the common shape: one field, one unit.
 *
 * `trueZeros` inverts the usual rule for the five types that support it. On
 * those, the documentation is explicit that a record returned WITHOUT its count
 * property means the device was worn and the user was still - a measured zero -
 * while a missing record means the device was off-wrist. Reading both as null
 * would throw away the distinction the API was rebuilt to provide.
 */
function scalar(
  unit: string,
  paths: string[],
  options: { trueZeros?: boolean } = {},
): (body: unknown) => ExtractedValue | null {
  return (body) => {
    const value = numAt(body, ...paths);
    if (value !== null) return { value, unit };
    if (options.trueZeros && asObject(body) !== null) {
      return { value: 0, unit, trueZero: true };
    }
    return { value: null, unit };
  };
}

/** A duration field read as minutes. The API reports durations in seconds. */
function durationMinutes(paths: string[]): (body: unknown) => ExtractedValue | null {
  return (body) => {
    for (const path of paths) {
      const seconds = durationSeconds(at(body, path));
      if (seconds !== null) return { value: seconds / 60, unit: 'min' };
    }
    // Some interval types report a plain minute count rather than a Duration.
    const minutes = numAt(body, ...paths);
    return { value: minutes, unit: 'min' };
  };
}

/**
 * The catalogue.
 *
 * Ordered by scope, then by name, so the shape of what each permission buys is
 * readable down the page.
 */
export const DATA_TYPES: readonly DataTypeSpec[] = [
  /* ---------------------------------------------------------------- activity */
  {
    dataType: 'steps',
    filterField: 'steps',
    record: 'INTERVAL',
    scope: ACTIVITY_SCOPE,
    read: 'DAILY_ROLLUP',
    pageSize: MAX_PAGE_SIZE.standard,
    maxRangeDays: 90,
    trueZeros: true,
    label: 'Steps',
    destination: { kind: 'METRIC', metric: 'STEPS', unit: 'count' },
    // The steps guide is explicit: do not sum intervals client-side across a
    // day, because travel and daylight saving make the arithmetic wrong.
    // dailyRollUp reconciles the offsets and returns countSum.
    extract: scalar('count', ['countSum', 'count', 'steps.count'], { trueZeros: true }),
  },
  {
    dataType: 'distance',
    filterField: 'distance',
    record: 'INTERVAL',
    scope: ACTIVITY_SCOPE,
    read: 'DAILY_ROLLUP',
    pageSize: MAX_PAGE_SIZE.standard,
    maxRangeDays: 90,
    trueZeros: true,
    label: 'Distance',
    destination: { kind: 'METRIC', metric: 'DISTANCE_KM', unit: 'km' },
    extract: (body) => {
      // Millimetres, as the workouts guide states for the summary field. Both
      // spellings are read: the guide says distanceMillimeters, the observed
      // response says distanceMillimiters.
      const mm = numAt(
        body,
        'distanceMillimetersSum', 'distanceMillimitersSum',
        'distanceMillimeters', 'distanceMillimiters',
      );
      if (mm !== null) return { value: mm / 1_000_000, unit: 'km' };
      const metres = numAt(body, 'meters', 'metersSum');
      if (metres !== null) return { value: metres / 1000, unit: 'km' };
      if (asObject(body) !== null) return { value: 0, unit: 'km', trueZero: true };
      return { value: null, unit: 'km' };
    },
  },
  {
    dataType: 'floors',
    filterField: 'floors',
    record: 'INTERVAL',
    scope: ACTIVITY_SCOPE,
    // No list operation: the data-types table gives floors reconcile, rollup and
    // dailyRollup only.
    read: 'DAILY_ROLLUP',
    pageSize: MAX_PAGE_SIZE.standard,
    maxRangeDays: 90,
    trueZeros: true,
    label: 'Floors',
    destination: { kind: 'METRIC', metric: 'FLOORS', unit: 'count' },
    extract: scalar('count', ['countSum', 'count'], { trueZeros: true }),
  },
  {
    dataType: 'active-minutes',
    filterField: 'active_minutes',
    record: 'INTERVAL',
    scope: ACTIVITY_SCOPE,
    read: 'DAILY_ROLLUP',
    pageSize: MAX_PAGE_SIZE.standard,
    // One of the four short-range types.
    maxRangeDays: 14,
    trueZeros: false,
    label: 'Active minutes',
    destination: { kind: 'METRIC', metric: 'ACTIVE_MINUTES', unit: 'min' },
    extract: durationMinutes(['durationSum', 'duration', 'minutesSum', 'minutes']),
  },
  {
    dataType: 'active-zone-minutes',
    filterField: 'active_zone_minutes',
    record: 'INTERVAL',
    scope: ACTIVITY_SCOPE,
    read: 'DAILY_ROLLUP',
    pageSize: MAX_PAGE_SIZE.standard,
    maxRangeDays: 90,
    trueZeros: false,
    label: 'Active zone minutes',
    destination: { kind: 'METRIC', metric: 'ACTIVE_ZONE_MINUTES', unit: 'min' },
    extract: scalar('min', ['minutesSum', 'minutes', 'activeZoneMinutes', 'countSum']),
  },
  {
    dataType: 'active-energy-burned',
    filterField: 'active_energy_burned',
    record: 'INTERVAL',
    scope: ACTIVITY_SCOPE,
    read: 'DAILY_ROLLUP',
    pageSize: MAX_PAGE_SIZE.standard,
    maxRangeDays: 90,
    trueZeros: false,
    label: 'Active calories',
    // EXPENDITURE, not intake. It lands in daily_metrics.active_calories and
    // must never reach calories_consumed: nutrition is entered by hand and this
    // integration has no path to it (asserted in the boundary test).
    destination: { kind: 'METRIC', metric: 'ACTIVE_CALORIES', unit: 'kcal' },
    extract: scalar('kcal', ['kcalSum', 'kcal']),
  },
  {
    dataType: 'total-calories',
    filterField: 'total_calories',
    record: 'INTERVAL',
    scope: ACTIVITY_SCOPE,
    // Rollup only, per the data-types table. (The calories guide shows a `list`
    // example for this type; the table is taken as authoritative because it is
    // the page that enumerates operations per type.)
    read: 'DAILY_ROLLUP',
    pageSize: MAX_PAGE_SIZE.standard,
    maxRangeDays: 14,
    trueZeros: true,
    label: 'Total calories burned',
    destination: { kind: 'METRIC', metric: 'TOTAL_CALORIES_BURNED', unit: 'kcal' },
    extract: scalar('kcal', ['kcalSum', 'kcal'], { trueZeros: true }),
  },
  {
    dataType: 'sedentary-period',
    filterField: 'sedentary_period',
    record: 'INTERVAL',
    scope: ACTIVITY_SCOPE,
    read: 'DAILY_ROLLUP',
    pageSize: MAX_PAGE_SIZE.standard,
    maxRangeDays: 90,
    trueZeros: false,
    label: 'Sedentary time',
    // Stored and preserved. There is no canonical column and no reader for
    // sedentary minutes yet, and adding a column with nothing reading it would
    // be a value that is stored, confirmed and invisible. SEDENTARY_MINUTES
    // exists in metric_key so the promotion is a column and a reader, no more.
    destination: {
      kind: 'UNMAPPED',
      note: 'Sedentary minutes are ingested and kept. Promoting them means a '
        + 'daily_metrics column, a METRIC_FIELD entry and a reader.',
    },
    extract: durationMinutes(['durationSum', 'duration', 'minutesSum', 'minutes']),
  },
  {
    dataType: 'vo2-max',
    filterField: 'vo2_max',
    record: 'SAMPLE',
    scope: ACTIVITY_SCOPE,
    read: 'LIST',
    pageSize: MAX_PAGE_SIZE.standard,
    maxRangeDays: null,
    trueZeros: false,
    label: 'VO2 max',
    destination: { kind: 'METRIC', metric: 'VO2_MAX', unit: 'ml/kg/min' },
    extract: scalar('ml/kg/min', [
      'vo2Max', 'value', 'millilitersPerKilogramPerMinute',
    ]),
  },
  {
    dataType: 'daily-vo2-max',
    filterField: 'daily_vo2_max',
    record: 'DAILY',
    scope: ACTIVITY_SCOPE,
    read: 'LIST',
    pageSize: MAX_PAGE_SIZE.standard,
    maxRangeDays: null,
    trueZeros: false,
    label: 'VO2 max (daily)',
    destination: { kind: 'METRIC', metric: 'VO2_MAX', unit: 'ml/kg/min' },
    extract: scalar('ml/kg/min', [
      'vo2Max', 'value', 'millilitersPerKilogramPerMinute',
    ]),
  },
  {
    dataType: 'run-vo2-max',
    filterField: 'run_vo2_max',
    record: 'SAMPLE',
    scope: ACTIVITY_SCOPE,
    read: 'LIST',
    pageSize: MAX_PAGE_SIZE.standard,
    maxRangeDays: null,
    trueZeros: false,
    label: 'Running VO2 max',
    destination: { kind: 'METRIC', metric: 'VO2_MAX', unit: 'ml/kg/min' },
    extract: scalar('ml/kg/min', [
      'vo2Max', 'value', 'millilitersPerKilogramPerMinute',
    ]),
  },
  {
    dataType: 'exercise',
    filterField: 'exercise',
    record: 'SESSION',
    scope: ACTIVITY_SCOPE,
    read: 'LIST',
    // 25 is both the default AND the maximum for exercise and sleep.
    pageSize: MAX_PAGE_SIZE.session,
    maxRangeDays: null,
    trueZeros: false,
    label: 'Workouts',
    destination: { kind: 'EXERCISE' },
    // A session's value is its shape, not a scalar. mapper.ts reads it.
    extract: () => null,
  },
  {
    dataType: 'activity-level',
    filterField: 'activity_level',
    record: 'INTERVAL',
    scope: ACTIVITY_SCOPE,
    read: 'LIST',
    pageSize: MAX_PAGE_SIZE.standard,
    maxRangeDays: null,
    trueZeros: false,
    label: 'Activity level',
    destination: {
      kind: 'UNMAPPED',
      note: 'Minute-by-minute activity intensity bands. Kept for a future '
        + 'intraday view; no daily field expresses it.',
    },
    extract: scalar('level', ['level', 'activityLevel']),
  },
  {
    dataType: 'time-in-heart-rate-zone',
    filterField: 'time_in_heart_rate_zone',
    record: 'INTERVAL',
    scope: ACTIVITY_SCOPE,
    read: 'LIST',
    pageSize: MAX_PAGE_SIZE.standard,
    maxRangeDays: null,
    trueZeros: false,
    label: 'Time in heart-rate zone',
    // Evidence for the zone calculation, in the provider's own bands. It is not
    // a daily metric of its own: zone2_minutes is computed against the USER'S
    // definitions, and quietly filling it from someone else's boundaries would
    // make the number unattributable.
    destination: { kind: 'TELEMETRY' },
    extract: durationMinutes(['duration', 'minutes']),
  },
  {
    dataType: 'swim-lengths-data',
    filterField: 'swim_lengths_data',
    record: 'INTERVAL',
    scope: ACTIVITY_SCOPE,
    read: 'LIST',
    pageSize: MAX_PAGE_SIZE.standard,
    maxRangeDays: null,
    trueZeros: false,
    label: 'Swim lengths',
    destination: {
      kind: 'UNMAPPED',
      note: 'Pool lengths and stroke detail. No canonical destination; the '
        + 'swim itself arrives as an exercise session.',
    },
    extract: scalar('count', ['lengths', 'count']),
  },

  /* ------------------------------------------------- metrics & measurements */
  {
    dataType: 'weight',
    filterField: 'weight',
    record: 'SAMPLE',
    scope: METRICS_SCOPE,
    read: 'LIST',
    pageSize: MAX_PAGE_SIZE.standard,
    maxRangeDays: null,
    trueZeros: false,
    label: 'Weight',
    destination: { kind: 'BODY', field: 'weight_kg', unit: 'kg' },
    extract: (body) => {
      const kg = numAt(body, 'kilograms', 'weightKilograms', 'kg', 'value');
      if (kg !== null) return { value: kg, unit: 'kg' };
      // Grams, if that is what arrives. Never pounds: the API normalised units
      // as one of its stated goals, and guessing at an imperial reading would
      // be a 2.2x error in the field the whole app is built around.
      const grams = numAt(body, 'grams');
      if (grams !== null) return { value: grams / 1000, unit: 'kg' };
      return { value: null, unit: 'kg' };
    },
  },
  {
    dataType: 'body-fat',
    filterField: 'body_fat',
    record: 'SAMPLE',
    scope: METRICS_SCOPE,
    read: 'LIST',
    pageSize: MAX_PAGE_SIZE.standard,
    maxRangeDays: null,
    trueZeros: false,
    label: 'Body fat',
    destination: { kind: 'METRIC', metric: 'BODY_FAT_PCT', unit: '%' },
    extract: scalar('%', ['percentage', 'percent', 'value']),
  },
  {
    dataType: 'daily-resting-heart-rate',
    filterField: 'daily_resting_heart_rate',
    record: 'DAILY',
    scope: METRICS_SCOPE,
    read: 'LIST',
    pageSize: MAX_PAGE_SIZE.standard,
    maxRangeDays: null,
    trueZeros: false,
    label: 'Resting heart rate',
    destination: { kind: 'METRIC', metric: 'RESTING_HEART_RATE', unit: 'bpm' },
    extract: scalar('bpm', [
      'beatsPerMinute', 'restingHeartRate', 'value', 'bpm',
    ]),
  },
  {
    dataType: 'daily-heart-rate-variability',
    filterField: 'daily_heart_rate_variability',
    record: 'DAILY',
    scope: METRICS_SCOPE,
    read: 'LIST',
    pageSize: MAX_PAGE_SIZE.standard,
    maxRangeDays: null,
    trueZeros: false,
    label: 'Heart-rate variability',
    destination: { kind: 'METRIC', metric: 'HRV_MS', unit: 'ms' },
    // The vitals guide names rmssd - root mean square of successive
    // differences - in milliseconds, as the representation of HRV.
    extract: scalar('ms', ['rmssd', 'rmssdMilliseconds', 'dailyRmssd', 'value']),
  },
  {
    dataType: 'heart-rate-variability',
    filterField: 'heart_rate_variability',
    record: 'SAMPLE',
    scope: METRICS_SCOPE,
    read: 'LIST',
    pageSize: MAX_PAGE_SIZE.standard,
    maxRangeDays: null,
    trueZeros: false,
    label: 'Heart-rate variability (samples)',
    destination: { kind: 'METRIC', metric: 'HRV_MS', unit: 'ms' },
    extract: scalar('ms', ['rmssd', 'rmssdMilliseconds', 'value']),
  },
  {
    dataType: 'heart-rate',
    filterField: 'heart_rate',
    record: 'SAMPLE',
    scope: METRICS_SCOPE,
    read: 'LIST',
    pageSize: MAX_PAGE_SIZE.standard,
    maxRangeDays: 14,
    trueZeros: false,
    label: 'Heart rate',
    // Samples are the raw material for the zone calculation and the session
    // summary. They are emphatically NOT a daily metric: "your heart rate today
    // was 96" is not a statement about a day.
    destination: { kind: 'TELEMETRY' },
    extract: scalar('bpm', ['beatsPerMinute', 'bpm', 'value']),
  },
  {
    dataType: 'daily-heart-rate-zones',
    filterField: 'daily_heart_rate_zones',
    record: 'DAILY',
    scope: METRICS_SCOPE,
    read: 'LIST',
    pageSize: MAX_PAGE_SIZE.standard,
    maxRangeDays: null,
    trueZeros: false,
    label: 'Heart-rate zones (daily)',
    destination: { kind: 'TELEMETRY' },
    extract: () => null,
  },
  {
    dataType: 'daily-respiratory-rate',
    filterField: 'daily_respiratory_rate',
    record: 'DAILY',
    scope: METRICS_SCOPE,
    read: 'LIST',
    pageSize: MAX_PAGE_SIZE.standard,
    maxRangeDays: null,
    trueZeros: false,
    label: 'Respiratory rate',
    destination: { kind: 'METRIC', metric: 'RESPIRATORY_RATE', unit: 'breaths/min' },
    extract: scalar('breaths/min', [
      'breathsPerMinute', 'respiratoryRate', 'value',
    ]),
  },
  {
    dataType: 'respiratory-rate-sleep-summary',
    filterField: 'respiratory_rate_sleep_summary',
    record: 'SAMPLE',
    scope: METRICS_SCOPE,
    read: 'LIST',
    pageSize: MAX_PAGE_SIZE.standard,
    maxRangeDays: null,
    trueZeros: false,
    label: 'Respiratory rate (sleep)',
    destination: { kind: 'METRIC', metric: 'RESPIRATORY_RATE', unit: 'breaths/min' },
    extract: scalar('breaths/min', [
      'breathsPerMinute', 'respiratoryRate', 'fullSleepSummary.breathsPerMinute',
      'value',
    ]),
  },
  {
    dataType: 'daily-oxygen-saturation',
    filterField: 'daily_oxygen_saturation',
    record: 'DAILY',
    scope: METRICS_SCOPE,
    read: 'LIST',
    pageSize: MAX_PAGE_SIZE.standard,
    maxRangeDays: null,
    trueZeros: false,
    label: 'Blood oxygen',
    destination: { kind: 'METRIC', metric: 'OXYGEN_SATURATION_PCT', unit: '%' },
    extract: scalar('%', [
      'averagePercentage', 'percentage', 'average', 'value',
    ]),
  },
  {
    dataType: 'oxygen-saturation',
    filterField: 'oxygen_saturation',
    record: 'SAMPLE',
    scope: METRICS_SCOPE,
    read: 'LIST',
    pageSize: MAX_PAGE_SIZE.standard,
    maxRangeDays: null,
    trueZeros: false,
    label: 'Blood oxygen (samples)',
    destination: { kind: 'METRIC', metric: 'OXYGEN_SATURATION_PCT', unit: '%' },
    extract: scalar('%', ['percentage', 'percent', 'value']),
  },
  {
    dataType: 'daily-sleep-temperature-derivations',
    filterField: 'daily_sleep_temperature_derivations',
    record: 'DAILY',
    scope: METRICS_SCOPE,
    read: 'LIST',
    pageSize: MAX_PAGE_SIZE.standard,
    maxRangeDays: null,
    trueZeros: false,
    label: 'Sleep skin temperature',
    // Written onto the night's sleep_records row, which is where a sleep-derived
    // measurement belongs, and resolved from there into daily_metrics.
    destination: { kind: 'SLEEP' },
    extract: scalar('°C', [
      'nightlyRelativeCelsius', 'relativeCelsius', 'deltaCelsius',
      'temperatureDelta', 'value',
    ]),
  },

  /* ------------------------------------------------------------------ sleep */
  {
    dataType: 'sleep',
    filterField: 'sleep',
    record: 'SESSION',
    scope: SLEEP_SCOPE,
    read: 'LIST',
    pageSize: MAX_PAGE_SIZE.session,
    maxRangeDays: null,
    trueZeros: false,
    label: 'Sleep',
    destination: { kind: 'SLEEP' },
    extract: () => null,
  },
] as const;

export const DATA_TYPE_BY_ID: Record<string, DataTypeSpec> = Object.fromEntries(
  DATA_TYPES.map((spec) => [spec.dataType, spec]),
);

/** The data types the granted scopes actually permit. */
export function dataTypesForScopes(granted: readonly string[]): DataTypeSpec[] {
  const held = new Set(granted);
  return DATA_TYPES.filter((spec) => held.has(spec.scope));
}

/**
 * The window ceiling for a data type, in days.
 *
 * Exceeding it is a 400 from the aggregation endpoints, so the sync chunks to
 * fit rather than discovering the limit one failed request at a time. A type
 * with no documented ceiling still gets one, because a single request for ten
 * years of samples is a bad idea whatever the API permits.
 */
export function windowDaysFor(spec: DataTypeSpec): number {
  return spec.maxRangeDays ?? 90;
}
