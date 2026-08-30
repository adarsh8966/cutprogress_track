/**
 * Heart-rate zones, and whether a session contained Zone 2 work (spec §13).
 *
 * PURE. No I/O, no clock, no provider. It takes samples, boundaries and an
 * interval, and returns Derived<T> like every other calculation here - so the
 * number on screen arrives with the method that produced it, the inputs it used
 * and the caveats that apply.
 *
 * WHY THIS EXISTS AT ALL. "Did I do Zone 2 today?" was previously answerable
 * only from cardio_sessions.hr_zone, a single zone for a whole session, set by
 * hand or parsed from a paste. A lifting session with twenty minutes of cardio
 * in the middle of it had no way to say so - workout_sessions has no zone
 * column - and a session that genuinely varied had to be labelled as though it
 * had not.
 *
 * TWO METHODS, AND THE DIFFERENCE IS ALWAYS REPORTED:
 *
 *   FROM SAMPLES   Integrate the time between consecutive heart-rate readings
 *                  against the user's own boundaries. This is the real answer,
 *                  and it is the only one that can say "22 minutes", because a
 *                  minute is only in a zone if a measurement puts it there.
 *
 *   FROM PROVIDER  Fitbit's own three-band accounting - Fat Burn, Cardio, Peak
 *                  - against Fitbit's boundaries, mapped onto zones 2, 3 and 4.
 *                  Coarser, and not the user's definitions, so it is used only
 *                  when there are no samples and it never claims better than
 *                  MODERATE confidence.
 *
 * AND A THIRD OUTCOME THAT IS NOT A METHOD: no samples and no provider bands
 * means unavailable(). Not zero. A workout with no heart-rate data did not
 * contain zero minutes of Zone 2 - nobody knows what it contained, and saying
 * "0" would be a fabricated measurement of exactly the kind this system exists
 * not to store.
 *
 * A TITLE IS NEVER EVIDENCE. Nothing in this file reads a workout's name. "Zone
 * 2 Ride" in a title is a label somebody typed; it is not a measurement, and a
 * session called "Upper Body" can contain more Zone 2 than one called "Cardio".
 */
import { derived, unavailable, type Derived } from '@/lib/types';

export type ZoneNumber = 1 | 2 | 3 | 4 | 5;

export const ZONES: readonly ZoneNumber[] = [1, 2, 3, 4, 5];

export interface ZoneDefinition {
  zone: ZoneNumber;
  lowerBpm: number;
  /** Null on the top zone, which has no ceiling. */
  upperBpm: number | null;
}

export type ZoneMethod = 'MEASURED_MAX' | 'ESTIMATED_MAX' | 'MANUAL' | 'PROVIDER';

export interface ZoneModel {
  definitions: ZoneDefinition[];
  method: ZoneMethod;
  maxHeartRate: number | null;
  /** Names the evidence, e.g. "220 − age (37)". Shown with any zone figure. */
  derivedFrom: string;
}

/**
 * Percentage-of-maximum boundaries for the classic five-zone model.
 *
 * These are the conventional bands, and they are stated here as data rather
 * than buried in arithmetic so that changing them is one edit and reading them
 * needs no algebra. Zone 2 - 60% to 70% of maximum - is the aerobic base zone
 * the training literature means by the phrase, which is what makes it worth
 * measuring separately at all.
 */
export const ZONE_BOUNDS: Record<ZoneNumber, { from: number; to: number | null }> = {
  1: { from: 0.50, to: 0.60 },
  2: { from: 0.60, to: 0.70 },
  3: { from: 0.70, to: 0.80 },
  4: { from: 0.80, to: 0.90 },
  5: { from: 0.90, to: null },
};

/** Builds the five zones from a maximum heart rate. */
export function zonesFromMax(
  maxHeartRate: number,
  method: ZoneMethod,
  derivedFrom: string,
): ZoneModel {
  const round = (v: number) => Math.round(v * 10) / 10;
  return {
    maxHeartRate,
    method,
    derivedFrom,
    definitions: ZONES.map((zone) => ({
      zone,
      lowerBpm: round(maxHeartRate * ZONE_BOUNDS[zone].from),
      upperBpm: ZONE_BOUNDS[zone].to === null
        ? null
        : round(maxHeartRate * ZONE_BOUNDS[zone].to!),
    })),
  };
}

/**
 * An age-predicted maximum heart rate.
 *
 * 220 − age is the familiar formula and it is a POPULATION AVERAGE with a
 * standard deviation around 10–12 bpm. For one person it can be out by twenty.
 * It is offered because a zone model built on it is far better than none, and
 * it is labelled ESTIMATED_MAX everywhere it is used so that no figure derived
 * from it can be mistaken for a measurement. A measured maximum - the highest
 * heart rate actually recorded - always wins where one exists.
 */
export function estimatedMaxHeartRate(ageYears: number): number {
  return 220 - ageYears;
}

/** Which zone a rate falls in, or null if it is below zone 1. */
export function zoneOf(bpm: number, definitions: readonly ZoneDefinition[]): ZoneNumber | null {
  // Highest first, so a rate on a boundary lands in the higher zone rather than
  // depending on the order the definitions happen to be in.
  const ordered = [...definitions].sort((a, b) => b.lowerBpm - a.lowerBpm);
  for (const definition of ordered) {
    if (bpm >= definition.lowerBpm) return definition.zone;
  }
  return null;
}

export interface HeartRateSample {
  /** Epoch milliseconds. */
  at: number;
  bpm: number;
}

export interface ZoneBreakdown {
  /** Minutes per zone. A zone with no time is 0 here - it was measured. */
  minutes: Record<ZoneNumber, number>;
  zone2Minutes: number;
  totalMinutes: number;
  /** Share of the covered time spent in Zone 2, 0..1. */
  zone2Share: number;
  averageBpm: number | null;
  minBpm: number | null;
  maxBpm: number | null;
  sampleCount: number;
  /** Share of the session heart rate actually covers, 0..1. */
  coverage: number;
  method: ZoneMethod;
}

/**
 * The largest gap between two samples that is still treated as continuous.
 *
 * Heart-rate sampling is not evenly spaced, and a device that goes off-wrist
 * leaves a hole. Integrating straight across a forty-minute hole would credit
 * forty minutes to whatever zone the last reading before it happened to be in -
 * which is how a workout ends up reporting more Zone 2 than it was long. Beyond
 * this ceiling the gap is counted as uncovered rather than attributed, and
 * `coverage` reports how much of the session that left.
 */
export const MAX_SAMPLE_GAP_MS = 3 * 60_000;

/** Minutes counted below Zone 2 before the result is worth calling Zone 2 work. */
export const MEANINGFUL_ZONE2_MINUTES = 10;

/**
 * Minutes per zone, integrated from samples.
 *
 * Each sample owns the interval between it and the next, capped at the gap
 * ceiling. The final sample owns nothing - there is no next reading to bound
 * it, and inventing one would be inventing data - which is why a session with
 * one sample reports zero covered minutes rather than a zone.
 */
export function zoneBreakdownFromSamples(
  samples: readonly HeartRateSample[],
  model: ZoneModel,
  interval: { startMs: number; endMs: number },
  options: { maxGapMs?: number } = {},
): Derived<ZoneBreakdown> {
  const maxGapMs = options.maxGapMs ?? MAX_SAMPLE_GAP_MS;
  const sessionMs = Math.max(0, interval.endMs - interval.startMs);
  const inputs = {
    samples: samples.length,
    sessionMinutes: Math.round((sessionMs / 60_000) * 10) / 10,
    zoneMethod: model.method,
    maxHeartRate: model.maxHeartRate,
    zoneBoundaries: model.definitions.map((d) => `${d.zone}: ${d.lowerBpm}+`),
  };

  const inWindow = samples
    .filter((s) => s.at >= interval.startMs && s.at <= interval.endMs)
    .sort((a, b) => a.at - b.at);

  if (inWindow.length < 2) {
    return unavailable<ZoneBreakdown>(
      'zone-breakdown-from-samples',
      inputs,
      inWindow.length === 0
        ? 'No heart-rate data was recorded during this session.'
        : 'Only one heart-rate reading falls in this session, which is not enough '
          + 'to attribute any time to a zone.',
      inWindow.length,
    );
  }

  const minutes: Record<ZoneNumber, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let coveredMs = 0;
  let weightedBpm = 0;
  let minBpm = Number.POSITIVE_INFINITY;
  let maxBpm = Number.NEGATIVE_INFINITY;
  let gapsSkipped = 0;

  for (let i = 0; i < inWindow.length; i += 1) {
    const sample = inWindow[i]!;
    minBpm = Math.min(minBpm, sample.bpm);
    maxBpm = Math.max(maxBpm, sample.bpm);

    const next = inWindow[i + 1];
    if (next === undefined) break;

    const spanMs = next.at - sample.at;
    if (spanMs > maxGapMs) {
      gapsSkipped += 1;
      continue;
    }

    coveredMs += spanMs;
    weightedBpm += sample.bpm * spanMs;
    const zone = zoneOf(sample.bpm, model.definitions);
    if (zone !== null) minutes[zone] += spanMs / 60_000;
  }

  if (coveredMs === 0) {
    return unavailable<ZoneBreakdown>(
      'zone-breakdown-from-samples',
      { ...inputs, gapsSkipped },
      'The heart-rate readings for this session are too far apart to attribute '
      + 'time to a zone.',
      inWindow.length,
    );
  }

  const round = (v: number) => Math.round(v * 10) / 10;
  const totalMinutes = coveredMs / 60_000;
  const coverage = sessionMs > 0 ? Math.min(1, coveredMs / sessionMs) : 0;

  const notes: string[] = [];
  if (gapsSkipped > 0) {
    notes.push(
      `${gapsSkipped} gap${gapsSkipped === 1 ? '' : 's'} longer than `
      + `${maxGapMs / 60_000} minutes were left uncounted rather than attributed `
      + 'to the zone either side of them.',
    );
  }
  if (coverage < 0.8) {
    notes.push(
      `Heart rate covers ${Math.round(coverage * 100)}% of this session, so these `
      + 'minutes are a floor rather than a total.',
    );
  }
  if (model.method === 'ESTIMATED_MAX') {
    notes.push(
      `Zone boundaries come from an estimated maximum heart rate (${model.derivedFrom}), `
      + 'not a measured one. An estimate can be out by around 10–20 bpm for one person.',
    );
  }

  /**
   * Confidence is about how much of the session was actually measured, not
   * about how much Zone 2 there was. A tightly-covered session with no Zone 2
   * is a HIGH-confidence zero.
   */
  const confidence = coverage >= 0.8 && model.method !== 'ESTIMATED_MAX'
    ? 'HIGH'
    : coverage >= 0.5
      ? 'MODERATE'
      : 'LOW';

  return derived<ZoneBreakdown>(
    {
      minutes: {
        1: round(minutes[1]), 2: round(minutes[2]), 3: round(minutes[3]),
        4: round(minutes[4]), 5: round(minutes[5]),
      },
      zone2Minutes: round(minutes[2]),
      totalMinutes: round(totalMinutes),
      zone2Share: totalMinutes > 0 ? minutes[2] / totalMinutes : 0,
      averageBpm: Math.round((weightedBpm / coveredMs) * 10) / 10,
      minBpm: Number.isFinite(minBpm) ? minBpm : null,
      maxBpm: Number.isFinite(maxBpm) ? maxBpm : null,
      sampleCount: inWindow.length,
      coverage,
      method: model.method,
    },
    'zone-breakdown-from-samples',
    { ...inputs, coveredMinutes: round(totalMinutes), gapsSkipped },
    confidence,
    notes,
    inWindow.length,
  );
}

/**
 * Fitbit's band names, mapped onto the five-zone model.
 *
 * Fitbit accounts for time in three bands above rest - Fat Burn, Cardio and
 * Peak - plus Out of Range below them. That is a coarser model than five zones
 * and the boundaries are Fitbit's, not the user's, so the mapping is
 * approximate and is labelled as such wherever it is used.
 *
 * Fat Burn is the band that corresponds to Zone 2: both are defined as the
 * aerobic range beginning around 60% of maximum. It is the closest thing the
 * provider offers, and it is better than reporting nothing - but it is not the
 * same measurement, which is why the result never claims HIGH confidence.
 */
export const PROVIDER_BAND_TO_ZONE: Record<string, ZoneNumber> = {
  outofrangetime: 1,
  lighttime: 1,
  light: 1,
  fatburntime: 2,
  fatburn: 2,
  cardiotime: 3,
  cardio: 3,
  peaktime: 4,
  peak: 4,
};

/**
 * A breakdown from the provider's own band durations, in seconds.
 *
 * Used only when there are no samples. `coverage` is reported as 1 because the
 * provider's summary covers the session it describes - what is uncertain here
 * is the boundaries, not the coverage, and that is what the note and the
 * confidence say.
 */
export function zoneBreakdownFromProvider(
  bandSeconds: Readonly<Record<string, number>>,
  options: { sessionMinutes?: number | null } = {},
): Derived<ZoneBreakdown> {
  const minutes: Record<ZoneNumber, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let recognised = 0;
  const unrecognised: string[] = [];

  for (const [band, seconds] of Object.entries(bandSeconds)) {
    const zone = PROVIDER_BAND_TO_ZONE[band.toLowerCase()];
    if (zone === undefined) {
      unrecognised.push(band);
      continue;
    }
    minutes[zone] += seconds / 60;
    recognised += 1;
  }

  const inputs = { bands: bandSeconds, unrecognisedBands: unrecognised };

  if (recognised === 0) {
    return unavailable<ZoneBreakdown>(
      'zone-breakdown-from-provider',
      inputs,
      unrecognised.length > 0
        ? `Google Health reported heart-rate zones this app does not recognise: `
          + `${unrecognised.join(', ')}. They were stored but not counted.`
        : 'No heart-rate zone information was recorded for this session.',
      0,
    );
  }

  const round = (v: number) => Math.round(v * 10) / 10;
  const totalMinutes = ZONES.reduce((sum, z) => sum + minutes[z], 0);

  return derived<ZoneBreakdown>(
    {
      minutes: {
        1: round(minutes[1]), 2: round(minutes[2]), 3: round(minutes[3]),
        4: round(minutes[4]), 5: round(minutes[5]),
      },
      zone2Minutes: round(minutes[2]),
      totalMinutes: round(totalMinutes),
      zone2Share: totalMinutes > 0 ? minutes[2] / totalMinutes : 0,
      // A band summary carries no individual readings, so there is no average,
      // minimum or maximum to report. Null, not a number derived from nothing.
      averageBpm: null,
      minBpm: null,
      maxBpm: null,
      sampleCount: 0,
      coverage: 1,
      method: 'PROVIDER',
    },
    'zone-breakdown-from-provider',
    { ...inputs, sessionMinutes: options.sessionMinutes ?? null },
    // Never HIGH: these are the provider's boundaries and its three-band model,
    // not the user's five zones.
    'MODERATE',
    [
      'These minutes come from Google Health’s own heart-rate zones, not from '
      + 'your zone settings. Fat Burn is counted as Zone 2, which is the closest '
      + 'equivalent, and the boundaries are Google’s.',
      ...(unrecognised.length > 0
        ? [`Unrecognised zone names were kept but not counted: ${unrecognised.join(', ')}.`]
        : []),
    ],
    0,
  );
}

/**
 * Whether a session contained meaningful Zone 2 work.
 *
 * A threshold rather than "any Zone 2 at all", because passing through Zone 2
 * on the way to Zone 4 is not Zone 2 training and calling it that would make
 * the flag useless. Ten minutes is the floor; the actual minutes are reported
 * alongside so the judgement can be disagreed with.
 */
export function hadMeaningfulZone2(
  breakdown: Derived<ZoneBreakdown>,
  thresholdMinutes: number = MEANINGFUL_ZONE2_MINUTES,
): Derived<boolean> {
  if (breakdown.value === null) {
    return unavailable<boolean>(
      'meaningful-zone2',
      { threshold: thresholdMinutes },
      breakdown.notes[0] ?? 'No heart-rate data for this session.',
      breakdown.observations ?? 0,
    );
  }
  const { zone2Minutes } = breakdown.value;
  return derived<boolean>(
    zone2Minutes >= thresholdMinutes,
    'meaningful-zone2',
    {
      zone2Minutes,
      threshold: thresholdMinutes,
      zoneMethod: breakdown.value.method,
      coverage: breakdown.value.coverage,
    },
    breakdown.confidence,
    breakdown.notes,
    breakdown.observations ?? breakdown.value.sampleCount,
  );
}
