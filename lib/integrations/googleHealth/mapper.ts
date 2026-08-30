/**
 * PURE: a Google Health data point -> a normalised CUT OS observation.
 *
 * No Supabase, no I/O, no clock. Everything this file needs - the profile's
 * timezone, the registry entry - is passed in, so the whole translation layer
 * is testable with a JSON literal and no credentials.
 *
 * THREE RULES IT ENFORCES, EACH THE ANSWER TO A WAY THIS GOES WRONG:
 *
 *  1. UNITS CONVERT AT THIS BOUNDARY AND NOWHERE ELSE. Millimetres become
 *     kilometres here, seconds become minutes here, and everything downstream
 *     is metric because storage is metric. A conversion further in is a
 *     conversion that some code path can miss.
 *
 *  2. AN IMPLAUSIBLE VALUE IS DROPPED WITH A WARNING, NOT CLAMPED. The bounds
 *     mirror the SQL CHECK constraints, so a value that would be refused by the
 *     database is refused here with an explanation instead of failing an insert
 *     halfway through a batch. Clamping a heart rate of 400 to 250 would store
 *     a number nobody measured - the same reasoning as ../hevy/mapper.ts.
 *
 *  3. THE DAY IS THE PROFILE'S DAY. toLocalDate renders the instant in the
 *     user's timezone (§40). A workout at 23:30 belongs to that day; a sleep
 *     session belongs to the morning it ended on, which is what
 *     sleep_records.local_date has always meant.
 *
 * IDENTITY IS RESOLVED HERE, AND IT HAS TWO FORMS. Google sends `name` for some
 * data types and not for others, so every function below reads the timing
 * FIRST and then asks for an identity: the provider's name when there is one,
 * preserved exactly, and otherwise one minted from the fields that identify the
 * observation (identity.ts). A point is refused only when it has neither - a
 * record that cannot say when it was measured has no identity to mint and no
 * place on a timeline, which was always the rule and still is.
 */
import type { LocalDate } from '@/lib/types';
import { toLocalDate } from '@/lib/normalization/dates';
import { toSessionType, toCardioType } from '@/lib/health/sessionTypes';
import type { SessionTypeEnum, CardioTypeEnum } from '@/lib/supabase/types';
import type { DataTypeSpec, RecordType } from './registry';
import {
  contentVersion, derivedExternalId, GOOGLE_HEALTH_PROVIDER,
  type IdentitySource, type IdentityTiming,
} from './identity';
import {
  asObject, at, civilDateAt, durationSeconds, instantAt, numAt,
  offsetSecondsAt, strAt, type GoogleDataPoint,
} from './types';

export const GOOGLE_HEALTH_SOURCE = 'GOOGLE_HEALTH' as const;

/**
 * Plausible ranges, mirroring the SQL CHECK constraints the value will meet.
 *
 * A number outside one of these is not a measurement, it is a parsing mistake
 * or a unit that was not what this code assumed - and either way the honest
 * outcome is a warning and a null, not a stored value that is wrong.
 */
const LIMITS = {
  weightKg: { min: 20, max: 400 },
  bodyFatPct: { min: 1, max: 75 },
  heartRate: { min: 25, max: 250 },
  hrvMs: { min: 0, max: 500 },
  vo2Max: { min: 10, max: 100 },
  respiratoryRate: { min: 1, max: 60 },
  oxygenSaturationPct: { min: 50, max: 100 },
  temperatureDeltaC: { min: -15, max: 15 },
  minutes: { min: 0, max: 1440 },
  nonNegative: { min: 0, max: Number.MAX_SAFE_INTEGER },
} as const;

const LIMIT_FOR: Record<string, keyof typeof LIMITS> = {
  weight: 'weightKg',
  'body-fat': 'bodyFatPct',
  'daily-resting-heart-rate': 'heartRate',
  'heart-rate': 'heartRate',
  'daily-heart-rate-variability': 'hrvMs',
  'heart-rate-variability': 'hrvMs',
  'vo2-max': 'vo2Max',
  'daily-vo2-max': 'vo2Max',
  'run-vo2-max': 'vo2Max',
  'daily-respiratory-rate': 'respiratoryRate',
  'respiratory-rate-sleep-summary': 'respiratoryRate',
  'daily-oxygen-saturation': 'oxygenSaturationPct',
  'oxygen-saturation': 'oxygenSaturationPct',
  'daily-sleep-temperature-derivations': 'temperatureDeltaC',
  'active-minutes': 'minutes',
};

/** The camelCase key a data point nests its body under. */
export function bodyKey(dataType: string): string {
  return dataType.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * The measurement body of a data point.
 *
 * The list endpoints nest it under the data type's camelCase name, as the
 * codelab's exercise response shows. The rollup endpoints have been observed to
 * put the aggregate at the top level instead. Rather than guess which shape
 * arrived, both are tried and the point itself is the fallback - a permissive
 * read whose worst case is that extract() finds nothing and returns null.
 */
export function bodyOf(point: GoogleDataPoint, dataType: string): unknown {
  const nested = at(point, bodyKey(dataType));
  if (asObject(nested) !== null) return nested;
  return point;
}

/** The timing a record carries, which depends on its record type. */
export interface RecordTiming {
  observedAt: string | null;
  intervalStart: string | null;
  intervalEnd: string | null;
  utcOffsetSeconds: number | null;
  /** The date this belongs to, in the profile's timezone. */
  localDate: LocalDate;
}

/**
 * Reads whatever timing a record has, and decides its day.
 *
 * Returns null when there is none. A record that cannot say when it was
 * measured cannot be placed on a timeline, correlated with a workout, or
 * corrected later - so it is refused rather than filed under today, which would
 * be a fabricated timestamp.
 */
export function timingOf(
  point: GoogleDataPoint,
  spec: DataTypeSpec,
  timezone: string,
): RecordTiming | null {
  const body = bodyOf(point, spec.dataType);

  const observedAt = instantAt(
    body, 'sampleTime.physicalTime', 'sampleTime.instant', 'time', 'timestamp',
  );
  const intervalStart = instantAt(body, 'interval.startTime', 'startTime');
  const intervalEnd = instantAt(body, 'interval.endTime', 'endTime');
  const utcOffsetSeconds = offsetSecondsAt(
    body, 'interval.startUtcOffset', 'startUtcOffset', 'sampleTime.utcOffset', 'utcOffset',
  );

  /**
   * A DAILY record has a date and no instant, and that is the whole point of
   * the record type: it is a statement about the user's calendar day. Using it
   * directly - rather than synthesising midnight and rendering that back - is
   * what keeps it on the right day for every timezone.
   */
  if (spec.record === 'DAILY') {
    const date = civilDateAt(body, 'date', 'localDate', 'civilDate');
    if (date !== null) {
      return {
        observedAt: null, intervalStart, intervalEnd, utcOffsetSeconds,
        localDate: date as LocalDate,
      };
    }
  }

  // Sleep belongs to the morning it ended on - which is what
  // sleep_records.local_date has meant since 0003, and what the API's own
  // civil_end_time filter is shaped for.
  const anchor = spec.dataType === 'sleep'
    ? intervalEnd ?? intervalStart ?? observedAt
    : observedAt ?? intervalStart ?? intervalEnd;
  if (anchor === null) {
    const fallbackDate = civilDateAt(body, 'date', 'localDate', 'civilDate');
    if (fallbackDate === null) return null;
    return {
      observedAt: null, intervalStart, intervalEnd, utcOffsetSeconds,
      localDate: fallbackDate as LocalDate,
    };
  }

  return {
    observedAt: spec.record === 'SAMPLE' ? anchor : observedAt,
    intervalStart,
    intervalEnd,
    utcOffsetSeconds,
    localDate: toLocalDate(new Date(anchor), timezone),
  };
}

/** An external identity, and which of the two kinds it is. */
export interface ResolvedIdentity {
  externalId: string;
  identitySource: IdentitySource;
}

/**
 * The provider's id, or one minted from what identifies the observation.
 *
 * A NAME IS TAKEN VERBATIM. It is Google's own resource name, it is stable, and
 * the only correct thing to do with it is store it as it arrived - anything
 * else and a record already on file under that name stops matching itself.
 *
 * The derived form is only reached when there is no name, and is built from the
 * data type, the timing and the recording source (identity.ts), plus whatever
 * the registry says separates two points of this type.
 */
function identityOf(
  point: GoogleDataPoint,
  dataType: string,
  timing: IdentityTiming,
  discriminators?: readonly (string | number | null)[],
): ResolvedIdentity {
  // Read tolerantly, like everything else here. The schema has already decided
  // this point is readable; what travels onward is the raw record, so `name` is
  // whatever the provider put there and an empty one is no name at all.
  const provided = strAt(point, 'name');
  if (provided !== null) {
    return { externalId: provided, identitySource: 'PROVIDER' };
  }
  return {
    externalId: derivedExternalId({
      provider: GOOGLE_HEALTH_PROVIDER,
      dataType,
      timing,
      dataSource: at(point, 'dataSource'),
      discriminators,
    }),
    identitySource: 'DERIVED',
  };
}

/** One normalised scalar observation, ready for the writer. */
export interface NormalisedObservation {
  dataType: string;
  externalId: string;
  /** Whether the id above is Google's or one CUT OS minted. */
  identitySource: IdentitySource;
  externalUpdatedAt: string | null;
  /**
   * A digest of the record as it arrived, so a provider that does not version
   * its records still has a version. See contentVersion in identity.ts.
   */
  contentVersion: string;
  recordType: RecordType;
  timing: RecordTiming;
  value: number | null;
  unit: string | null;
  /** A measured zero, as distinct from an absent measurement. */
  trueZero: boolean;
  payload: unknown;
  warnings: string[];
}

function bounded(
  value: number | null,
  limit: keyof typeof LIMITS | undefined,
  label: string,
  warnings: string[],
): number | null {
  if (value === null || limit === undefined) return value;
  const { min, max } = LIMITS[limit];
  if (value < min || value > max) {
    warnings.push(
      `${label} of ${value} is outside the plausible range ${min}–${max} and was not stored.`,
    );
    return null;
  }
  return value;
}

/**
 * Normalises one data point.
 *
 * Returns null only when the point has no usable TIME - without which it has no
 * place on a timeline, no day to land on, and nothing to mint an identity from.
 * A point whose VALUE cannot be read is still returned, with a null value,
 * because the payload is still worth keeping and "this arrived and had nothing
 * in it" is a different fact from "this never arrived".
 *
 * A missing `name` is NOT a reason to refuse a point. It used to be, and that
 * was the bug: most data types do not carry one.
 */
export function mapDataPoint(
  point: GoogleDataPoint,
  spec: DataTypeSpec,
  options: { timezone: string },
): NormalisedObservation | null {
  const timing = timingOf(point, spec, options.timezone);
  if (timing === null) return null;

  const body = bodyOf(point, spec.dataType);
  const warnings: string[] = [];
  const extracted = spec.extract(body);
  const { externalId, identitySource } = identityOf(
    point, spec.dataType, timing, spec.identity?.(body),
  );

  const value = bounded(
    extracted?.value ?? null, LIMIT_FOR[spec.dataType], spec.label, warnings,
  );

  return {
    dataType: spec.dataType,
    externalId,
    identitySource,
    externalUpdatedAt: instantAt(body, 'updateTime', 'lastModified', 'updatedAt'),
    contentVersion: contentVersion(point),
    recordType: spec.record,
    timing,
    value,
    unit: extracted?.unit ?? null,
    // A true zero only survives if the value survived: a bounds failure is a
    // reading this code could not trust, not a measured nothing.
    trueZero: Boolean(extracted?.trueZero) && value !== null,
    payload: point,
    warnings,
  };
}

/* ------------------------------------------------------------------- sleep */

export type SleepStageType = 'REM' | 'DEEP' | 'LIGHT' | 'AWAKE' | 'UNKNOWN';

export interface NormalisedSleep {
  externalId: string;
  identitySource: IdentitySource;
  externalUpdatedAt: string | null;
  contentVersion: string;
  localDate: LocalDate;
  sleepStart: string | null;
  sleepEnd: string | null;
  durationMinutes: number | null;
  remMinutes: number | null;
  deepMinutes: number | null;
  lightMinutes: number | null;
  awakeMinutes: number | null;
  shortAwakenings: number | null;
  payload: unknown;
  warnings: string[];
}

function stageType(raw: unknown): SleepStageType {
  const text = typeof raw === 'string' ? raw.toUpperCase() : '';
  if (text.includes('REM')) return 'REM';
  if (text.includes('DEEP')) return 'DEEP';
  if (text.includes('LIGHT')) return 'LIGHT';
  if (text.includes('AWAKE') || text.includes('WAKE')) return 'AWAKE';
  return 'UNKNOWN';
}

/**
 * A sleep session, with its stages summed.
 *
 * SHORT AWAKENINGS ARE COUNTED, NOT SUMMED IN. The sleep guide is explicit that
 * they overlap the surrounding stages rather than partitioning the timeline
 * with them, so adding their duration to awake_minutes would count the same
 * minutes twice and make the stages exceed the night. They are kept as a count,
 * which is the fact they actually carry: how broken the sleep was.
 *
 * DURATION IS TIME ASLEEP, NOT TIME IN BED. Awake stages are excluded from the
 * total, so a nine-hour session with an hour awake reports eight. Reporting the
 * interval length would inflate every sleep figure in the app.
 *
 * A CLASSIC (non-staged) SESSION reports its interval and no stages. Its
 * duration comes from the interval, and the stage columns stay null - which
 * means "this device does not measure stages", not "you had no REM sleep".
 */
export function mapSleepSession(
  point: GoogleDataPoint,
  options: { timezone: string },
): NormalisedSleep | null {
  const body = bodyOf(point, 'sleep');
  const sleepStart = instantAt(body, 'interval.startTime', 'startTime');
  const sleepEnd = instantAt(body, 'interval.endTime', 'endTime');
  const anchor = sleepEnd ?? sleepStart;
  if (anchor === null) return null;

  const localDate = toLocalDate(new Date(anchor), options.timezone);
  const { externalId, identitySource } = identityOf(point, 'sleep', {
    observedAt: null,
    intervalStart: sleepStart,
    intervalEnd: sleepEnd,
    localDate,
  });

  const warnings: string[] = [];
  const stagesRaw = at(body, 'stages') ?? at(body, 'sleepStages');
  const stages = Array.isArray(stagesRaw) ? stagesRaw : [];

  const totals: Record<SleepStageType, number> = {
    REM: 0, DEEP: 0, LIGHT: 0, AWAKE: 0, UNKNOWN: 0,
  };
  let staged = false;
  for (const stage of stages) {
    const from = instantAt(stage, 'startTime');
    const to = instantAt(stage, 'endTime');
    if (from === null || to === null) {
      warnings.push('A sleep stage arrived without both timestamps and was skipped.');
      continue;
    }
    const minutes = (Date.parse(to) - Date.parse(from)) / 60_000;
    if (!Number.isFinite(minutes) || minutes < 0) {
      warnings.push('A sleep stage ended before it began and was skipped.');
      continue;
    }
    totals[stageType(at(stage, 'type') ?? at(stage, 'stageType'))] += minutes;
    staged = true;
  }

  const awakeningsRaw = at(body, 'shortAwakenings');
  const shortAwakenings = Array.isArray(awakeningsRaw) ? awakeningsRaw.length : null;

  const asleep = totals.REM + totals.DEEP + totals.LIGHT + totals.UNKNOWN;
  const intervalMinutes = sleepStart !== null && sleepEnd !== null
    ? (Date.parse(sleepEnd) - Date.parse(sleepStart)) / 60_000
    : null;

  const durationMinutes = staged
    ? asleep
    : (intervalMinutes !== null && intervalMinutes >= 0 ? intervalMinutes : null);

  const round = (v: number) => Math.round(v * 10) / 10;
  const capped = (v: number | null): number | null => {
    if (v === null) return null;
    if (v < LIMITS.minutes.min || v > LIMITS.minutes.max) {
      warnings.push(`A sleep duration of ${round(v)} minutes is implausible and was not stored.`);
      return null;
    }
    return round(v);
  };

  return {
    externalId,
    identitySource,
    externalUpdatedAt: instantAt(body, 'updateTime', 'updatedAt'),
    contentVersion: contentVersion(point),
    localDate,
    sleepStart,
    sleepEnd,
    durationMinutes: capped(durationMinutes),
    // Null rather than zero when the device reported no stages at all: a
    // classic sleep log does not say "you had no REM", it says nothing.
    remMinutes: staged ? capped(totals.REM) : null,
    deepMinutes: staged ? capped(totals.DEEP) : null,
    lightMinutes: staged ? capped(totals.LIGHT) : null,
    awakeMinutes: staged ? capped(totals.AWAKE) : null,
    shortAwakenings,
    payload: point,
    warnings,
  };
}

/* ---------------------------------------------------------------- exercise */

export interface NormalisedExercise {
  externalId: string;
  identitySource: IdentitySource;
  externalUpdatedAt: string | null;
  contentVersion: string;
  localDate: LocalDate;
  startTime: string;
  endTime: string | null;
  /** Elapsed, from the interval. */
  durationMinutes: number | null;
  /** True active time, excluding pauses, as the API reports it. */
  activeMinutes: number | null;
  exerciseType: string | null;
  displayName: string | null;
  sessionType: SessionTypeEnum;
  cardioType: CardioTypeEnum;
  /** Whether this looks like cardio rather than resistance training. */
  isCardio: boolean;
  caloriesKcal: number | null;
  distanceKm: number | null;
  steps: number | null;
  averageHeartRate: number | null;
  activeZoneMinutes: number | null;
  /** The provider's own zone buckets, in seconds, verbatim. */
  providerZoneSeconds: Record<string, number>;
  hasGps: boolean;
  payload: unknown;
  warnings: string[];
}

/**
 * Exercise types that are cardio in the sense CUT OS means it.
 *
 * WHY A LIST AND NOT A GUESS. An unmatched exercise session has to go
 * somewhere, and the two destinations are not interchangeable:
 * cardio_sessions feeds cardio_minutes and the Zone 2 analytics,
 * workout_sessions feeds training volume and adherence. Filing a bike ride as
 * a training session would inflate training frequency; filing a lifting
 * session as cardio would inflate cardio minutes. So the mapping is explicit,
 * and anything not on this list is treated as resistance training - the
 * conservative direction, because a strength session that turns out to have
 * been cardio is visible on the Training page, while the reverse silently
 * pads a weekly cardio target.
 */
const CARDIO_EXERCISE_TYPES = new Set([
  'WALKING', 'RUNNING', 'BIKING', 'BIKING_STATIONARY', 'TREADMILL', 'ELLIPTICAL',
  'HIKING', 'SWIMMING', 'SWIMMING_POOL', 'SWIMMING_OPEN_WATER', 'ROWING',
  'ROWING_MACHINE', 'STAIR_CLIMBING', 'STAIR_CLIMBING_MACHINE', 'AEROBIC_WORKOUT',
  'HIGH_INTENSITY_INTERVAL_TRAINING', 'SPINNING', 'JOGGING', 'SPORT', 'TENNIS',
  'FOOTBALL', 'BASKETBALL', 'SKIING', 'SNOWBOARDING', 'SKATING', 'DANCING',
  'PACED_WALKING', 'PACED_RUNNING', 'OUTDOOR_BIKE', 'CIRCUIT_TRAINING',
]);

export function mapExerciseSession(
  point: GoogleDataPoint,
  options: { timezone: string },
): NormalisedExercise | null {
  const body = bodyOf(point, 'exercise');
  const startTime = instantAt(body, 'interval.startTime', 'startTime');
  if (startTime === null) return null;
  const endTimeRaw = instantAt(body, 'interval.endTime', 'endTime');

  const localDate = toLocalDate(new Date(startTime), options.timezone);
  const { externalId, identitySource } = identityOf(point, 'exercise', {
    observedAt: null,
    intervalStart: startTime,
    // The raw end, not the validated one below: an id must not change because
    // a later reading of the same session had its end time dropped.
    intervalEnd: endTimeRaw,
    localDate,
  });

  const warnings: string[] = [];
  // An interval that ends before it starts would be refused by the
  // workout_sessions CHECK anyway. Dropping the end here keeps the session.
  let endTime = endTimeRaw;
  if (endTime !== null && Date.parse(endTime) < Date.parse(startTime)) {
    warnings.push('The session ended before it began; its end time was not stored.');
    endTime = null;
  }

  const elapsedMinutes = endTime !== null
    ? (Date.parse(endTime) - Date.parse(startTime)) / 60_000
    : null;
  const activeSeconds = durationSeconds(at(body, 'activeDuration'));

  const exerciseType = strAt(body, 'exerciseType');
  const displayName = strAt(body, 'displayName');
  const isCardio = exerciseType !== null && CARDIO_EXERCISE_TYPES.has(exerciseType);

  // Both spellings: the guide documents distanceMillimeters, the observed
  // response sends distanceMillimiters.
  const distanceMm = numAt(
    body,
    'metricsSummary.distanceMillimeters', 'metricsSummary.distanceMillimiters',
  );

  const zoneRaw = asObject(at(body, 'metricsSummary.heartRateZoneDurations')) ?? {};
  const providerZoneSeconds: Record<string, number> = {};
  for (const [key, raw] of Object.entries(zoneRaw)) {
    const seconds = durationSeconds(raw);
    if (seconds !== null) providerZoneSeconds[key] = seconds;
  }

  const round = (v: number | null, dp: number) =>
    (v === null ? null : Math.round(v * 10 ** dp) / 10 ** dp);

  /**
   * The label CUT OS files this under.
   *
   * toSessionType reads the display name for a recognised split ("Push Day"),
   * which is what a title actually tells you. An unrecognised one lands on
   * OTHER and the name is kept whole - the same bargain the paste importer
   * strikes, and the reason a title is never allowed to become a claim about
   * intensity or zone.
   */
  const sessionType = toSessionType(displayName ?? exerciseType ?? '').value;
  const cardioType = toCardioType(exerciseType ?? displayName ?? '').value;

  return {
    externalId,
    identitySource,
    externalUpdatedAt: instantAt(body, 'updateTime', 'updatedAt'),
    contentVersion: contentVersion(point),
    localDate,
    startTime,
    endTime,
    durationMinutes: elapsedMinutes !== null && elapsedMinutes >= 0
      && elapsedMinutes <= LIMITS.minutes.max
      ? round(elapsedMinutes, 1)
      : null,
    activeMinutes: activeSeconds !== null ? round(activeSeconds / 60, 1) : null,
    exerciseType,
    displayName,
    sessionType,
    cardioType,
    isCardio,
    caloriesKcal: round(numAt(body, 'metricsSummary.caloriesKcal'), 1),
    distanceKm: distanceMm !== null ? round(distanceMm / 1_000_000, 3) : null,
    steps: numAt(body, 'metricsSummary.steps'),
    averageHeartRate: bounded(
      numAt(body, 'metricsSummary.averageHeartRateBeatsPerMinute'),
      'heartRate', 'Average heart rate', warnings,
    ),
    activeZoneMinutes: numAt(body, 'metricsSummary.activeZoneMinutes'),
    providerZoneSeconds,
    hasGps: at(body, 'exerciseMetadata.hasGps') === true,
    payload: point,
    warnings,
  };
}

/* ------------------------------------------------------------ HR telemetry */

/** One heart-rate reading: an instant and a rate. Nothing else is needed. */
export interface HeartRateSample {
  at: number;
  bpm: number;
}

/**
 * Heart-rate samples, sorted, from a page of data points.
 *
 * Anything without both a timestamp and a plausible rate is skipped rather than
 * defaulted: a zero bpm is not a heart rate, and one in a series would drag an
 * average and put a minute in the wrong zone.
 */
export function mapHeartRateSamples(points: readonly GoogleDataPoint[]): HeartRateSample[] {
  const samples: HeartRateSample[] = [];
  for (const point of points) {
    const body = bodyOf(point, 'heart-rate');
    const iso = instantAt(body, 'sampleTime.physicalTime', 'sampleTime.instant', 'time');
    const bpm = numAt(body, 'beatsPerMinute', 'bpm', 'value');
    if (iso === null || bpm === null) continue;
    if (bpm < LIMITS.heartRate.min || bpm > LIMITS.heartRate.max) continue;
    samples.push({ at: Date.parse(iso), bpm });
  }
  return samples.sort((a, b) => a.at - b.at);
}
