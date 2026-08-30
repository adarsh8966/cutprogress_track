import 'server-only';

/**
 * Attaching a wearable's physiology to the training sessions it was recorded
 * during.
 *
 * This is the half of the integration that makes a Hevy workout and a Fitbit
 * recording into one thing. It does three jobs in order:
 *
 *   1. Match each training session to the provider's exercise session, if there
 *      is one, by interval overlap (correlate.ts - deterministic, explainable).
 *   2. Summarise the heart rate recorded during the session's interval, whether
 *      or not step 1 found a match. A lift is frequently not recorded as an
 *      exercise at all, and the heart rate is there regardless - so the absence
 *      of an exercise session must not mean the absence of heart rate.
 *   3. Compute time in each zone against the USER'S zone definitions, falling
 *      back to the provider's own bands, and failing honestly when there is
 *      neither.
 *
 * CONSTRUCTS NO SUPABASE CLIENT; takes one, plus an explicit userId.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, HrZoneDefinitionRow } from '@/lib/supabase/types';
import type { Derived } from '@/lib/types';
import {
  zoneBreakdownFromSamples, zoneBreakdownFromProvider, zonesFromMax,
  estimatedMaxHeartRate, type ZoneBreakdown, type ZoneDefinition, type ZoneModel,
  type HeartRateSample,
} from '@/lib/analytics/zones';
import { matchSessions, explainMatch, type MatchCandidate } from './correlate';
import type { NormalisedExercise } from './mapper';
import { GOOGLE_HEALTH_PROVIDER } from './writer';

type Client = SupabaseClient<Database>;

/** A training session as the matcher needs to see it. */
export interface TrainingInterval extends MatchCandidate {
  id: string;
  startMs: number;
  endMs: number | null;
  localDate: string;
}

/**
 * The zone model for a user, and where it came from.
 *
 * PREFERENCE ORDER, and each step is a real drop in authority:
 *   1. Stored definitions the user set or accepted. Their zones, by definition.
 *   2. A measured maximum from the heart rate actually recorded. Real data, but
 *      a training maximum is usually below a true maximum, so the zones sit a
 *      little low.
 *   3. 220 − age. A population average applied to one person.
 *   4. Nothing. Reported as unavailable rather than guessed, because a zone
 *      figure computed against boundaries nobody chose is worse than no figure.
 */
export async function resolveZoneModel(
  supabase: Client,
  userId: string,
  observedMaxBpm: number | null,
): Promise<ZoneModel | null> {
  const stored = await supabase
    .from('hr_zone_definitions')
    .select('*')
    .eq('user_id', userId)
    .order('zone', { ascending: true });

  if (!stored.error && (stored.data?.length ?? 0) >= 5) {
    const rows = stored.data as HrZoneDefinitionRow[];
    const first = rows[0]!;
    return {
      definitions: rows.map((row) => ({
        zone: row.zone as ZoneDefinition['zone'],
        lowerBpm: Number(row.lower_bpm),
        upperBpm: row.upper_bpm === null ? null : Number(row.upper_bpm),
      })),
      method: first.method,
      maxHeartRate: first.max_heart_rate === null ? null : Number(first.max_heart_rate),
      derivedFrom: first.derived_from ?? 'your saved zone settings',
    };
  }

  if (observedMaxBpm !== null && observedMaxBpm >= 120) {
    return zonesFromMax(
      observedMaxBpm, 'MEASURED_MAX',
      `the highest heart rate recorded in this window (${Math.round(observedMaxBpm)} bpm)`,
    );
  }

  const profile = await supabase
    .from('profiles').select('date_of_birth').eq('id', userId).maybeSingle();
  const dob = profile.data?.date_of_birth;
  if (dob) {
    const age = Math.floor(
      (Date.now() - Date.parse(String(dob))) / (365.2425 * 24 * 3600 * 1000),
    );
    if (age > 0 && age < 120) {
      return zonesFromMax(
        estimatedMaxHeartRate(age), 'ESTIMATED_MAX', `220 − age (${age})`,
      );
    }
  }

  return null;
}

export interface TelemetryOutcome {
  sessionId: string;
  matched: boolean;
  breakdown: Derived<ZoneBreakdown> | null;
  warnings: string[];
}

/**
 * Computes and stores the telemetry for one training session.
 *
 * WRITES BOTH PLACES, AND THE DUPLICATION IS DELIBERATE. session_telemetry is
 * the full record - the match, the coverage, the per-zone breakdown, the
 * provider's own bands - and it is where anything that needs to be honest about
 * confidence reads from. workout_sessions.average_heart_rate / max_heart_rate /
 * calories are also filled because they have existed since 0010 and the
 * training analytics already read them; leaving them null would mean building
 * the data and not showing it.
 *
 * ONE INTERACTION WORTH KNOWING. The Hevy writer sets those three columns to
 * null on every write, so that an edit at the source cannot leave a stale value
 * behind. A Hevy re-sync of a workout therefore clears the heart rate until the
 * next Google Health sync refills it. That is self-correcting rather than lossy
 * - session_telemetry still holds everything - and the readers prefer telemetry
 * where it exists, so the window is invisible on screen.
 */
export async function writeSessionTelemetry(
  supabase: Client,
  userId: string,
  session: TrainingInterval,
  input: {
    samples: readonly HeartRateSample[];
    exercise: NormalisedExercise | null;
    matchConfidence: number | null;
    overlapSeconds: number | null;
    matchExplanation: string | null;
    zoneModel: ZoneModel | null;
  },
  options: { now?: () => Date } = {},
): Promise<TelemetryOutcome> {
  const now = options.now ?? (() => new Date());
  const warnings: string[] = [];

  if (session.endMs === null) {
    return {
      sessionId: session.id,
      matched: input.exercise !== null,
      breakdown: null,
      warnings: ['This session has no end time, so no heart-rate window could be read.'],
    };
  }

  const interval = { startMs: session.startMs, endMs: session.endMs };

  /**
   * Samples first, provider bands second, nothing third.
   *
   * The provider's bands are used only when there are no usable samples,
   * because they are its boundaries rather than the user's - and when neither
   * exists the result is unavailable(), never a zero.
   */
  let breakdown: Derived<ZoneBreakdown> | null = null;
  if (input.zoneModel !== null && input.samples.length >= 2) {
    breakdown = zoneBreakdownFromSamples(input.samples, input.zoneModel, interval);
  }
  if ((breakdown === null || breakdown.value === null) && input.exercise !== null) {
    const bands = input.exercise.providerZoneSeconds;
    if (Object.keys(bands).length > 0) {
      breakdown = zoneBreakdownFromProvider(bands, {
        sessionMinutes: input.exercise.activeMinutes ?? input.exercise.durationMinutes,
      });
    }
  }
  if (breakdown === null && input.zoneModel === null && input.samples.length >= 2) {
    warnings.push(
      'Heart rate was recorded for this session, but there are no heart-rate '
      + 'zone settings and no way to derive them, so no zone minutes were '
      + 'computed. Set a maximum heart rate in Settings to enable this.',
    );
  }

  const zoneMinutes = breakdown?.value?.minutes ?? {};
  const sessionMs = interval.endMs - interval.startMs;
  const inWindow = input.samples.filter(
    (s) => s.at >= interval.startMs && s.at <= interval.endMs,
  );

  const bpms = inWindow.map((s) => s.bpm);
  const measuredAverage = breakdown?.value?.averageBpm ?? null;
  const minBpm = bpms.length > 0 ? Math.min(...bpms) : null;
  const maxBpm = bpms.length > 0 ? Math.max(...bpms) : null;

  /**
   * Coverage from the samples where there are samples, and null where there are
   * none. Not zero: "we measured 0% of this session" and "we have no basis to
   * say" are different, and only the first is a measurement.
   */
  const coveragePct = breakdown?.value?.coverage !== undefined
    ? Math.round(breakdown.value.coverage * 10000) / 100
    : (inWindow.length > 0 && sessionMs > 0 ? null : null);

  /**
   * The average heart rate: measured if it was measured, otherwise the
   * provider's own summary figure. The provider's is a real measurement too -
   * it just came from a device rather than from arithmetic here - so it is used
   * rather than discarded, and hr_sample_count says which is which.
   */
  const averageHr = measuredAverage ?? input.exercise?.averageHeartRate ?? null;

  const row = {
    user_id: userId,
    session_id: session.id,
    provider: GOOGLE_HEALTH_PROVIDER,
    external_id: input.exercise?.externalId ?? null,
    match_method: input.exercise !== null
      ? ('INTERVAL_OVERLAP' as const)
      : inWindow.length > 0 ? ('INTERVAL_ONLY' as const) : ('NONE' as const),
    match_confidence: input.matchConfidence,
    overlap_seconds: input.overlapSeconds,
    hr_sample_count: inWindow.length,
    hr_coverage_pct: coveragePct,
    average_hr: averageHr,
    min_hr: minBpm,
    max_hr: maxBpm,
    zone_minutes: zoneMinutes as Record<string, unknown>,
    provider_zone_minutes: (input.exercise?.providerZoneSeconds ?? {}) as Record<string, unknown>,
    active_zone_minutes: input.exercise?.activeZoneMinutes ?? null,
    calories_kcal: input.exercise?.caloriesKcal ?? null,
    distance_km: input.exercise?.distanceKm ?? null,
    steps: input.exercise?.steps ?? null,
    updated_at: now().toISOString(),
  };

  // Re-running the correlation replaces its own conclusion rather than adding a
  // second opinion. session_telemetry is a cache of a pure function over
  // external_observations, exactly as daily_metrics is over the raw layer.
  const existing = await supabase
    .from('session_telemetry')
    .select('id')
    .eq('session_id', session.id)
    .eq('provider', GOOGLE_HEALTH_PROVIDER)
    .maybeSingle();

  const written = existing.data
    ? await supabase.from('session_telemetry').update(row).eq('id', existing.data.id)
    : await supabase.from('session_telemetry').insert(row);

  if (written.error) {
    warnings.push(`Session telemetry could not be stored: ${written.error.message}`);
  }

  /**
   * The three columns 0010 added, filled at last.
   *
   * Only written when there is something to write: an update that set them all
   * to null would erase a figure a paste importer had recorded by hand.
   */
  if (averageHr !== null || maxBpm !== null || input.exercise?.caloriesKcal != null) {
    const patch: {
      average_heart_rate?: number;
      max_heart_rate?: number;
      calories?: number;
    } = {};
    if (averageHr !== null) patch.average_heart_rate = averageHr;
    if (maxBpm !== null) patch.max_heart_rate = maxBpm;
    if (input.exercise?.caloriesKcal != null) patch.calories = input.exercise.caloriesKcal;
    const patched = await supabase
      .from('workout_sessions').update(patch)
      .eq('id', session.id).eq('user_id', userId);
    if (patched.error) {
      warnings.push(`The session's heart-rate summary could not be saved: ${patched.error.message}`);
    }
  }

  if (input.matchExplanation !== null && (input.matchConfidence ?? 1) < 0.75) {
    warnings.push(
      `A workout was matched to Google Health data with low confidence. ${input.matchExplanation}`,
    );
  }

  return {
    sessionId: session.id,
    matched: input.exercise !== null,
    breakdown,
    warnings,
  };
}

/** Matches training sessions to provider exercise sessions. Re-exported for tests. */
export { matchSessions, explainMatch };
