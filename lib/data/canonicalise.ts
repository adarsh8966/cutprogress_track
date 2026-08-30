import 'server-only';

/**
 * Rebuilds the canonical daily_metrics row for a date from the raw layer
 * (spec §16, §17).
 *
 * This is the function that turns append-only observations into the single
 * resolved row analytics reads. It is a pure rebuild: it reads every
 * observation for the day, resolves each field by source priority, and
 * overwrites the daily_metrics row. Nothing raw is touched, so running it again
 * always produces the same answer, and a resolver bug is never data loss.
 *
 * Called after every write and after every confirmed import.
 */
import type { LocalDate } from '@/lib/types';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, DataSourceEnum } from '@/lib/supabase/types';
import {
  applyPins, resolveFields, type Observation, type ProvenanceMap,
} from '@/lib/normalization/canonical';
import { toNumber } from '@/lib/normalization/numbers';

type Client = SupabaseClient<Database>;

/**
 * A timestamp column as a string the resolver can order.
 *
 * Same reasoning as toNumber() below: what a driver hands back for a
 * `timestamptz` is not guaranteed to be a string. PostgREST serialises one to
 * ISO-8601 text, PGlite returns a Date object, and Observation.recordedAt
 * claims to be a string - so the claim is made true here rather than assumed.
 *
 * This matters more than it looks. recordedAt is what decides which of a day's
 * observations is the current one, so a Date arriving where a string was
 * expected does not degrade the ordering, it fails the whole day's rebuild.
 * An unreadable timestamp becomes the empty string, which sorts oldest: a
 * value that cannot say when it was recorded must not outrank one that can.
 */
function toIsoString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  return '';
}

/**
 * Groups the day's raw rows into per-field observation lists.
 *
 * `value` is typed unknown because that is the truth about a column read back
 * through PostgREST, which returns numerics as strings in some configurations.
 * toNumber() is what makes Observation.value: number an honest claim instead of
 * a cast that happens to survive on JavaScript's coercion rules - and it keeps
 * null as null rather than turning an unmeasured field into a zero (spec §33).
 */
function observation(
  id: string,
  value: unknown,
  source: DataSourceEnum,
  recordedAt: unknown,
  localDate: LocalDate,
): Observation | null {
  const numeric = toNumber(value);
  if (numeric === null) return null;
  return { id, value: numeric, source, recordedAt: toIsoString(recordedAt), localDate };
}

export async function rebuildDailyMetrics(
  supabase: Client,
  userId: string,
  date: LocalDate,
): Promise<{ provenance: ProvenanceMap }> {
  const [body, metrics, nutrition, sleep, cardio, sessions, pins] = await Promise.all([
    supabase.from('body_measurements').select('*').eq('local_date', date),
    supabase.from('metric_observations').select('*').eq('local_date', date),
    supabase.from('nutrition_logs').select('*').eq('local_date', date),
    supabase.from('sleep_records').select('*').eq('local_date', date),
    supabase.from('cardio_sessions').select('*').eq('local_date', date),
    supabase.from('workout_sessions').select('*').eq('local_date', date),
    // The fields the user authored by hand and an import must not move (0016).
    supabase.from('canonical_field_pins').select('*')
      .eq('local_date', date).is('cleared_at', null),
  ]);

  /**
   * A read that failed is NOT an empty day.
   *
   * These six results used to go straight to `.data ?? []`, which meant a
   * transient failure on one of them resolved that table's fields to null and
   * WROTE THAT to daily_metrics - overwriting real values with "not logged" and
   * reporting success. The observations were never at risk, but every page
   * reads the canonical row, so the day went blank on screen for as long as it
   * took someone to notice.
   *
   * A rebuild is a pure function of the raw layer. If the raw layer could not
   * be read, the function has no answer, and the honest thing is to say so:
   * rebuildRange() and rebuildCanonicalLayer() both already collect and report
   * a failed day, and the previous row stays exactly as it was until the
   * rebuild can actually run.
   */
  const reads = [
    ['body_measurements', body], ['metric_observations', metrics],
    ['nutrition_logs', nutrition], ['sleep_records', sleep],
    ['cardio_sessions', cardio], ['workout_sessions', sessions],
    ['canonical_field_pins', pins],
  ] as const;
  for (const [table, result] of reads) {
    if (result.error) {
      throw new Error(
        `Failed to rebuild daily metrics for ${date}: could not read ${table} `
        + `(${result.error.message}). Nothing was changed; the observations are safe.`,
      );
    }
  }

  const fields: Record<string, Observation[]> = {
    weightKg: [], waistCm: [], steps: [], activeCalories: [],
    totalCaloriesBurned: [], restingHeartRate: [], hrvMs: [],
    sleepDurationMinutes: [], sleepScore: [], caloriesConsumed: [],
    proteinG: [], carbsG: [], fatG: [], fiberG: [], fruitVegServings: [],
    // 0016. Every one has a source above and a reader below it; a field with
    // neither is a column that is stored, confirmed and invisible.
    bodyFatPct: [], vo2Max: [], distanceKm: [], floors: [],
    activeMinutes: [], activeZoneMinutes: [],
    respiratoryRate: [], oxygenSaturationPct: [],
    remMinutes: [], deepMinutes: [], lightMinutes: [], awakeMinutes: [],
    sleepTemperatureDeltaC: [],
  };

  const push = (key: string, obs: Observation | null) => {
    if (obs) fields[key]!.push(obs);
  };

  /**
   * Superseded observations are out of the resolution entirely (migration
   * 0012), exactly as superseded sessions are out of the sums below.
   *
   * This is what makes a withdrawal expressible at all. Resolution is
   * "newest wins", so a mistaken reading can be corrected by recording the
   * right one - but there is no value that means "I did not weigh myself that
   * day". Entering 0 would fabricate a measurement, which this system must
   * never store. Marking the row superseded removes it from the day without
   * removing it from the record.
   *
   * A ROW THAT CANNOT SAY IS LIVE. The test is `== null`, not `=== null`, and
   * the loose comparison is deliberate: it accepts `undefined` too. The type
   * says the column is always present, and against a fully migrated database it
   * is - but `select('*')` returns whatever columns the database actually has,
   * and a project still on migration 0011 hands back rows with no
   * `superseded_at` key at all. Under a strict comparison every observation for
   * the day then reads as superseded, and the whole day resolves to nulls:
   * stored, confirmed, and invisible, which is the one failure this system
   * exists to prevent. A withdrawal has to be stated to count.
   */
  const live = <T extends { superseded_at?: string | null }>(rows: T[]): T[] =>
    rows.filter((row) => row.superseded_at == null);

  for (const row of live(body.data ?? [])) {
    push('weightKg', observation(row.id, row.weight_kg, row.source, row.measured_at, date));
    push('waistCm', observation(row.id, row.waist_cm, row.source, row.measured_at, date));
  }

  /**
   * metric_key -> canonical field.
   *
   * WORKOUT_MINUTES and CARDIO_MINUTES are absent on purpose: those two are
   * SUMMED from the day's sessions below rather than resolved, so an
   * observation carrying one is stored and deliberately not read here. Every
   * other member of the enum appears, because a key with no entry is a
   * measurement that lands in the database and never reaches a page.
   */
  const METRIC_FIELD: Record<string, string> = {
    STEPS: 'steps',
    ACTIVE_CALORIES: 'activeCalories',
    TOTAL_CALORIES_BURNED: 'totalCaloriesBurned',
    RESTING_HEART_RATE: 'restingHeartRate',
    HRV_MS: 'hrvMs',
    DISTANCE_KM: 'distanceKm',
    FLOORS: 'floors',
    ACTIVE_MINUTES: 'activeMinutes',
    ACTIVE_ZONE_MINUTES: 'activeZoneMinutes',
    VO2_MAX: 'vo2Max',
    BODY_FAT_PCT: 'bodyFatPct',
    RESPIRATORY_RATE: 'respiratoryRate',
    OXYGEN_SATURATION_PCT: 'oxygenSaturationPct',
    // SEDENTARY_MINUTES has no canonical column yet. It is stored in
    // metric_observations and in external_observations, and it is named here in
    // a comment rather than left to be discovered: promoting it is a column, a
    // line above, a line here and a reader.
  };
  for (const row of live(metrics.data ?? [])) {
    const field = METRIC_FIELD[row.metric];
    if (field) push(field, observation(row.id, row.value, row.source, row.measured_at, date));
  }

  for (const row of live(nutrition.data ?? [])) {
    push('caloriesConsumed', observation(row.id, row.calories, row.source, row.logged_at, date));
    push('proteinG', observation(row.id, row.protein_g, row.source, row.logged_at, date));
    push('carbsG', observation(row.id, row.carbs_g, row.source, row.logged_at, date));
    push('fatG', observation(row.id, row.fat_g, row.source, row.logged_at, date));
    push('fiberG', observation(row.id, row.fiber_g, row.source, row.logged_at, date));
    // Stored since 0003 and weighted 10/100 by the nutrition score, but with no
    // canonical column it could never reach the page that scores it.
    push('fruitVegServings',
      observation(row.id, row.fruit_veg_servings, row.source, row.logged_at, date));
  }

  for (const row of live(sleep.data ?? [])) {
    push('sleepDurationMinutes',
      observation(row.id, row.duration_minutes, row.source, row.created_at, date));
    push('sleepScore', observation(row.id, row.sleep_score, row.source, row.created_at, date));
    // 0016. A device that does not measure a stage leaves it null, and
    // observation() drops a null rather than resolving it to zero (§33).
    push('remMinutes', observation(row.id, row.rem_minutes, row.source, row.created_at, date));
    push('deepMinutes', observation(row.id, row.deep_minutes, row.source, row.created_at, date));
    push('lightMinutes',
      observation(row.id, row.light_minutes, row.source, row.created_at, date));
    push('awakeMinutes',
      observation(row.id, row.awake_minutes, row.source, row.created_at, date));
    push('sleepTemperatureDeltaC',
      observation(row.id, row.temperature_delta_c, row.source, row.created_at, date));
    // Respiratory rate and SpO2 reach the day from two directions - a sleep
    // session's own summary and a daily metric observation. Both are pushed to
    // the same field on purpose: that is exactly the disagreement the resolver
    // exists to settle, and it records which one won.
    push('respiratoryRate',
      observation(row.id, row.respiratory_rate, row.source, row.created_at, date));
    push('oxygenSaturationPct',
      observation(row.id, row.oxygen_saturation_pct, row.source, row.created_at, date));
  }

  /**
   * A pinned field resolves among the observations the user authored.
   *
   * This is what keeps a sync from moving a number the user corrected by hand.
   * It changes which observation is canonical and nothing else: the imported
   * one is still in the raw layer, still carries its provenance, and is still
   * shown on /day/[date] as available and not applied.
   */
  const pinnedFields = new Set(
    (pins.data ?? []).map((row) => row.field),
  );
  const { values, provenance } = resolveFields(applyPins(fields, pinnedFields));

  // An absent key and a null value mean the same thing here: the field was not
  // measured today. Both become null - never 0 (spec §33).
  const resolved = (field: string): number | null => values[field] ?? null;

  // Aggregates, not conflicts: cardio and training totals are SUMS of the day's
  // sessions, so they are computed rather than resolved. A day with no sessions
  // at all stays null (unknown), while a day with sessions summing to zero is 0.
  // Superseded rows are corrections' predecessors: still on disk, deliberately
  // out of the sum. Without this, re-importing a day to fix a duration would
  // add the two readings together (58 + 65 = 123) instead of replacing one.
  const cardioRows = live(cardio.data ?? []);
  const sessionRows = live(sessions.data ?? []);

  const minutes = (r: { duration_minutes: unknown }) => toNumber(r.duration_minutes) ?? 0;

  const cardioMinutes = cardioRows.length
    ? cardioRows.reduce((total, r) => total + minutes(r), 0)
    : null;
  const completed = sessionRows.filter((r) => r.completed);

  /**
   * Zone 2 now has two sources, and it needs both.
   *
   * cardio_sessions.hr_zone is ONE zone for a whole session - the shape a
   * pasted summary reports, and all this could say until now. A lifting session
   * with a cardio finisher has no single zone, and 22 minutes of Zone 2 inside
   * a 63-minute push day was simply unrepresentable: the session is a
   * workout_session, which has no hr_zone at all, so the day showed nothing.
   *
   * session_telemetry.zone_minutes carries the per-zone breakdown computed from
   * measured heart-rate samples against the user's own definitions (0016), so a
   * session contributes the minutes it actually spent there. Summed, not
   * resolved, exactly like every other aggregate here - and a day with neither
   * kind of session stays null (unknown) rather than becoming zero.
   */
  const telemetryRows = sessionRows.length > 0
    ? await supabase.from('session_telemetry').select('*')
      .in('session_id', sessionRows.map((r) => r.id))
    : { data: [], error: null };
  if (telemetryRows.error) {
    throw new Error(
      `Failed to rebuild daily metrics for ${date}: could not read session_telemetry `
      + `(${telemetryRows.error.message}). Nothing was changed; the observations are safe.`,
    );
  }

  const sessionZone2 = (telemetryRows.data ?? []).reduce((total, row) => {
    const zones = row.zone_minutes as Record<string, unknown> | null;
    return total + (toNumber(zones?.['2']) ?? 0);
  }, 0);

  const cardioZone2 = cardioRows
    .filter((r) => r.hr_zone === 2)
    .reduce((total, r) => total + minutes(r), 0);

  const hasZone2Source = cardioRows.length > 0 || (telemetryRows.data ?? []).length > 0;
  const zone2Minutes = hasZone2Source ? cardioZone2 + sessionZone2 : null;

  // The provider's own zone accounting for the day, which is a DIFFERENT
  // measurement: its boundaries, not the user's. Summed from the sessions that
  // reported it, and left null when none did.
  const telemetryAzm = (telemetryRows.data ?? [])
    .map((row) => toNumber(row.active_zone_minutes))
    .filter((v): v is number => v !== null);
  const sessionActiveZoneMinutes = telemetryAzm.length > 0
    ? telemetryAzm.reduce((total, v) => total + v, 0)
    : null;
  const workoutMinutes = completed.length
    ? completed.reduce((total, r) => total + minutes(r), 0)
    : null;
  const trainingSessions = sessionRows.length ? completed.length : null;

  const { error } = await supabase.from('daily_metrics').upsert(
    {
      user_id: userId,
      local_date: date,
      weight_kg: resolved('weightKg'),
      waist_cm: resolved('waistCm'),
      steps: resolved('steps'),
      active_calories: resolved('activeCalories'),
      total_calories_burned: resolved('totalCaloriesBurned'),
      workout_minutes: workoutMinutes,
      cardio_minutes: cardioMinutes,
      zone2_minutes: zone2Minutes,
      resting_heart_rate: resolved('restingHeartRate'),
      hrv_ms: resolved('hrvMs'),
      sleep_duration_minutes: resolved('sleepDurationMinutes'),
      sleep_score: resolved('sleepScore'),
      // 0016. Every column is written on every rebuild, including the nulls:
      // omitting one would leave whatever was there before, and a rebuild that
      // cannot clear a stale value is not a rebuild.
      body_fat_pct: resolved('bodyFatPct'),
      vo2_max: resolved('vo2Max'),
      distance_km: resolved('distanceKm'),
      floors: resolved('floors'),
      active_minutes: resolved('activeMinutes'),
      // A daily observation of the provider's own active-zone minutes wins over
      // the per-session sum when there is one: it covers the whole day, and the
      // sessions only cover themselves.
      active_zone_minutes: resolved('activeZoneMinutes') ?? sessionActiveZoneMinutes,
      respiratory_rate: resolved('respiratoryRate'),
      oxygen_saturation_pct: resolved('oxygenSaturationPct'),
      rem_minutes: resolved('remMinutes'),
      deep_minutes: resolved('deepMinutes'),
      light_minutes: resolved('lightMinutes'),
      awake_minutes: resolved('awakeMinutes'),
      sleep_temperature_delta_c: resolved('sleepTemperatureDeltaC'),
      calories_consumed: resolved('caloriesConsumed'),
      protein_g: resolved('proteinG'),
      carbs_g: resolved('carbsG'),
      fat_g: resolved('fatG'),
      fiber_g: resolved('fiberG'),
      fruit_veg_servings: resolved('fruitVegServings'),
      training_sessions: trainingSessions,
      provenance: provenance as unknown as Record<string, unknown>,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,local_date' },
  );

  if (error) throw new Error(`Failed to rebuild daily metrics for ${date}: ${error.message}`);
  return { provenance };
}

/**
 * Rebuilds a range, used after a multi-day import.
 *
 * Each day is rebuilt independently and a failure is collected rather than
 * thrown, because these days are not related: letting the first bad one abort
 * the rest would leave later days missing from daily_metrics - and therefore
 * from the dashboard and the Context Pack - with no route back, since a repeat
 * import is refused as a duplicate and so never triggers another rebuild.
 *
 * daily_metrics is a cache of a pure function over the raw layer, so a day that
 * fails here has lost nothing; it just has not been recomputed yet.
 */
export async function rebuildRange(
  supabase: Client,
  userId: string,
  dates: LocalDate[],
): Promise<{ failed: { date: LocalDate; message: string }[] }> {
  const failed: { date: LocalDate; message: string }[] = [];
  for (const date of dates) {
    try {
      await rebuildDailyMetrics(supabase, userId, date);
    } catch (error) {
      failed.push({
        date,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { failed };
}
