import 'server-only';

/**
 * Read side of the data layer.
 *
 * Turns database rows into the plain domain types lib/analytics operates on.
 * Every numeric column goes through toNumber(), which preserves null as null:
 * PostgREST returns numerics as strings in some configurations, and a naive
 * Number(null) would produce 0 - exactly the missing-data bug spec §33 warns
 * about.
 */
import type { DailyMetrics, LocalDate, UserProfile } from '@/lib/types';
import {
  rowToProfile, rowToDailyMetrics, rowsToDailyMetrics,
  joinLoggedSets, rowToTrainingSession, rowToExercise,
} from '@/lib/data/rows';
import type { LoggedSet, TrainingSession } from '@/lib/analytics/training';
import { createServerComponentClient } from '@/lib/supabase/server';
import { addDays, localToday } from '@/lib/normalization/dates';
import { toNumber } from '@/lib/normalization/numbers';
import type {
  ContextExportRow, SystemEventRow, SyncRunRow, ExerciseRow,
} from '@/lib/supabase/types';
import { toDayRecords, type DayRecord } from '@/lib/data/dayRecords';
import { apartmentGymExercises, type Exercise } from '@/lib/health/catalog';
import type { ProvenanceMap } from '@/lib/normalization/canonical';

// Defined in lib/normalization so the canonical resolver can use it too, and
// re-exported here because this is where the codebase already imports it from.
export { toNumber };
export { rowToProfile, rowToDailyMetrics, rowsToDailyMetrics } from '@/lib/data/rows';

export async function getProfile(): Promise<UserProfile | null> {
  const supabase = await createServerComponentClient();
  const { data, error } = await supabase.from('profiles').select('*').maybeSingle();
  if (error || !data) return null;
  return rowToProfile(data);
}

export async function getDailyMetrics(
  from: LocalDate,
  to: LocalDate,
): Promise<DailyMetrics[]> {
  const supabase = await createServerComponentClient();
  const { data, error } = await supabase
    .from('daily_metrics')
    .select('*')
    .gte('local_date', from)
    .lte('local_date', to)
    .order('local_date', { ascending: true });

  if (error || !data) return [];

  // The mapping itself lives in lib/data/rows.ts so that it can be tested
  // without a database - a column that is selected but never mapped is exactly
  // the kind of silent data loss this file's header warns about.
  return rowsToDailyMetrics(data);
}

/**
 * Every set performed in the window, joined to its session and exercise.
 *
 * THREE PLAIN READS, NOT ONE CLEVER ONE. This was a single PostgREST select
 * with an embedded `workout_sessions!inner(local_date)` join, which could
 * express "sets whose session falls in this window" and could NOT express
 * "...and whose session was not withdrawn". So it did not: a corrected session
 * kept contributing its sets to volume, e1RM and every muscle-group total, on
 * every page, with nothing on screen saying so.
 *
 * The filtering that matters now lives in joinLoggedSets(), which is pure and
 * driven directly by tests. Three round trips instead of one is the price, and
 * over a ninety-day window of one person's training that is not a price worth
 * paying a rule no test can reach to avoid.
 *
 * A FAILED READ IS NOT AN EMPTY WINDOW - but this function has always returned
 * [] on error, as every reader in this file does, and changing that contract
 * belongs with changing all of them rather than with this fix.
 */
export async function getLoggedSets(from: LocalDate, to: LocalDate): Promise<LoggedSet[]> {
  const supabase = await createServerComponentClient();

  const sessions = await supabase
    .from('workout_sessions')
    .select('id, local_date, superseded_at')
    .is('superseded_at', null)
    .gte('local_date', from)
    .lte('local_date', to);
  if (sessions.error || !sessions.data || sessions.data.length === 0) return [];

  const sets = await supabase
    .from('workout_sets')
    .select('*')
    .in('session_id', sessions.data.map((row) => row.id))
    .is('superseded_at', null);
  if (sets.error || !sets.data || sets.data.length === 0) return [];

  const exercises = await supabase
    .from('exercises')
    .select('exercise_id, name, primary_muscle_group')
    .in('exercise_id', [...new Set(sets.data.map((row) => row.exercise_id))]);
  if (exercises.error || !exercises.data) return [];

  return joinLoggedSets(sessions.data, sets.data, exercises.data);
}

/**
 * Training sessions as they were recorded, one object per `workout_sessions`
 * row.
 *
 * This exists because the Training page used to have no way to see a session
 * at all. Its only training query was getLoggedSets() below, which reads
 * `workout_sets` and joins UP to the session - so a session with no set
 * children produced no rows, and a summary-level import ("Pull, 58 min, avg HR
 * 142") was invisible on the one page named after it while being counted
 * everywhere else.
 *
 * The shape is deliberately the same as getCardioSessions(): a flat read of
 * the table the importer actually writes, with no join to a child table, so
 * the row's own existence is enough to make it visible. Session-level and
 * exercise-level training are two different measurements and this is the
 * session-level one; nothing here infers an exercise, a set or a volume.
 *
 * Superseded rows are excluded. A corrected import records a new row and marks
 * the old one (migration 0011), so the live row is the current truth and the
 * replaced one stays on disk for history.
 */
export async function getWorkoutSessions(
  from: LocalDate,
  to: LocalDate,
): Promise<TrainingSession[]> {
  const supabase = await createServerComponentClient();
  const { data, error } = await supabase
    .from('workout_sessions')
    .select('*')
    .is('superseded_at', null)
    .gte('local_date', from)
    .lte('local_date', to)
    .order('local_date', { ascending: false });

  if (error || !data) return [];
  return data.map(rowToTrainingSession);
}

/** One session by id, for the detail page. Null when it is not the user's. */
export async function getWorkoutSession(id: string): Promise<TrainingSession | null> {
  const supabase = await createServerComponentClient();
  const { data, error } = await supabase
    .from('workout_sessions')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error || !data) return null;
  return rowToTrainingSession(data);
}

/**
 * Every live set belonging to one session, for the detail page.
 *
 * Ordering is left to joinLoggedSets(), which sorts by exercise block and then
 * set number - the order the workout was actually performed in. Sorting by
 * set_number alone interleaved the exercises of a workout that recorded more
 * than one, because set numbers restart per exercise.
 */
export async function getSetsForSession(sessionId: string): Promise<LoggedSet[]> {
  const supabase = await createServerComponentClient();

  const session = await supabase
    .from('workout_sessions')
    .select('id, local_date, superseded_at')
    .eq('id', sessionId)
    .maybeSingle();
  if (session.error || !session.data) return [];

  const sets = await supabase
    .from('workout_sets')
    .select('*')
    .eq('session_id', sessionId)
    .is('superseded_at', null);
  if (sets.error || !sets.data || sets.data.length === 0) return [];

  const exercises = await supabase
    .from('exercises')
    .select('exercise_id, name, primary_muscle_group')
    .in('exercise_id', [...new Set(sets.data.map((row) => row.exercise_id))]);
  if (exercises.error || !exercises.data) return [];

  return joinLoggedSets([session.data], sets.data, exercises.data);
}

export async function getCardioSessions(from: LocalDate, to: LocalDate) {
  const supabase = await createServerComponentClient();
  const { data, error } = await supabase
    .from('cardio_sessions')
    .select('*')
    .is('superseded_at', null)
    .gte('local_date', from)
    .lte('local_date', to)
    .order('local_date', { ascending: false });

  if (error || !data) return [];
  // max_heart_rate and calories were selected but never mapped, so a cardio
  // session's peak HR and energy were stored by the importer and unreachable
  // by every page. They are part of the row like any other column.
  return data.map((row) => ({
    id: row.id,
    date: row.local_date,
    type: row.cardio_type as string,
    durationMinutes: toNumber(row.duration_minutes) ?? 0,
    distanceKm: toNumber(row.distance_km),
    hrZone: toNumber(row.hr_zone),
    averageHeartRate: toNumber(row.average_heart_rate),
    maxHeartRate: toNumber(row.max_heart_rate),
    calories: toNumber(row.calories),
    notes: row.notes,
    source: row.source as string,
  }));
}

export async function getRecentImports(limit = 20) {
  const supabase = await createServerComponentClient();
  const { data } = await supabase
    .from('health_imports')
    // `source` distinguishes a paste from a synced payload, so the list can say
    // where a row came from instead of previewing a JSON blob as if it were text.
    .select('id, created_at, status, target_local_date, parser_version, raw_text, source')
    .order('created_at', { ascending: false })
    .limit(limit);
  return data ?? [];
}

/**
 * The exercise library as the DATABASE holds it, not as the JSON catalog
 * describes it.
 *
 * These are not the same list any more. data/exercises/catalog.json is the SEED
 * (lib/health/catalog.ts reads it, 0009 loads it), and since 0014 an exercise
 * can also be created by a sync when it is used at the source and absent here.
 * A picker reading the JSON would offer 118 exercises while the user's own
 * history contained others - present in every chart, unfindable in the one
 * control meant for choosing them.
 */
export async function getExercises(): Promise<ExerciseRow[]> {
  const supabase = await createServerComponentClient();
  const { data, error } = await supabase
    .from('exercises')
    .select('*')
    .eq('active', true)
    .order('name', { ascending: true });
  if (error || !data) return [];
  return data;
}

/**
 * The exercises a picker should offer.
 *
 * Reads the database and falls back to the JSON catalog if that read comes back
 * empty. The fallback is not defensive noise: the catalog is the SEED of this
 * table, so it can never offer something wrong - only something incomplete -
 * and an empty picker on a page whose whole purpose is choosing an exercise is
 * a worse failure than a picker missing the handful a sync added.
 *
 * The apartment-gym filter is kept. An exercise a sync created is marked
 * performable because the user demonstrably performed it, which is an
 * observation rather than an inference - so it passes this filter honestly.
 */
export async function getExerciseLibrary(): Promise<Exercise[]> {
  const rows = await getExercises();
  const library = rows.map(rowToExercise).filter((exercise) => exercise.apartmentGym);
  return library.length > 0 ? library : apartmentGymExercises();
}

/** Synchronisation history for a provider, newest first (spec §41). */
export async function getSyncRuns(provider: string, limit = 10): Promise<SyncRunRow[]> {
  const supabase = await createServerComponentClient();
  const { data, error } = await supabase
    .from('sync_runs')
    .select('*')
    .eq('provider', provider)
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return data;
}

export async function getSystemEvents(limit = 30): Promise<SystemEventRow[]> {
  const supabase = await createServerComponentClient();
  const { data } = await supabase
    .from('system_events')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  return data ?? [];
}

export async function getContextExports(limit = 10): Promise<ContextExportRow[]> {
  const supabase = await createServerComponentClient();
  const { data } = await supabase
    .from('context_exports')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  return data ?? [];
}

/** What one day holds: the resolved row, and the observations behind it. */
export interface DayDetail {
  date: LocalDate;
  /** The canonical row, or null when the day has never been rebuilt. */
  canonical: DailyMetrics | null;
  /**
   * Which observation won each canonical field, and how many competed
   * (spec §16). Written on every rebuild since 0005 and, until the day view
   * existed, read by nothing.
   */
  provenance: ProvenanceMap;
  /** Every observation recorded against the day, superseded ones included. */
  records: DayRecord[];
  /**
   * True when a read failed. The day view must not present a partial answer as
   * a complete one - "nothing recorded" and "could not be read" are different
   * claims, and only one of them is safe to believe.
   */
  incomplete: boolean;
}

/**
 * One day, in full: what it resolves to and what it was resolved from.
 *
 * This is the only query that reads the raw layer directly rather than through
 * daily_metrics, because it is the only view whose job is correcting data.
 * daily_metrics has no ids and cannot say which of two weigh-ins it is showing.
 */
export async function getDayDetail(date: LocalDate): Promise<DayDetail> {
  const supabase = await createServerComponentClient();

  const [canonical, body, metrics, nutrition, sleep, cardio, workouts] = await Promise.all([
    supabase.from('daily_metrics').select('*').eq('local_date', date).maybeSingle(),
    supabase.from('body_measurements').select('*').eq('local_date', date),
    supabase.from('metric_observations').select('*').eq('local_date', date),
    supabase.from('nutrition_logs').select('*').eq('local_date', date),
    supabase.from('sleep_records').select('*').eq('local_date', date),
    supabase.from('cardio_sessions').select('*').eq('local_date', date),
    supabase.from('workout_sessions').select('*').eq('local_date', date),
  ]);

  const incomplete = [body, metrics, nutrition, sleep, cardio, workouts]
    .some((result) => result.error !== null);

  return {
    date,
    canonical: canonical.data ? rowToDailyMetrics(canonical.data) : null,
    provenance: (canonical.data?.provenance ?? {}) as unknown as ProvenanceMap,
    records: toDayRecords({
      body: (body.data ?? []) as never,
      metrics: (metrics.data ?? []) as never,
      nutrition: (nutrition.data ?? []) as never,
      sleep: (sleep.data ?? []) as never,
      cardio: (cardio.data ?? []) as never,
      workouts: (workouts.data ?? []) as never,
    }),
    incomplete,
  };
}

/**
 * The dates that have anything recorded against them, newest first.
 *
 * Read from daily_metrics rather than from the raw tables: a day only reaches
 * the canonical layer once something was written to it and rebuilt, which is
 * exactly the set of days worth linking to.
 */
export async function getRecordedDates(limit = 30): Promise<LocalDate[]> {
  const supabase = await createServerComponentClient();
  const { data } = await supabase
    .from('daily_metrics')
    .select('local_date')
    .order('local_date', { ascending: false })
    .limit(limit);
  return (data ?? []).map((row) => row.local_date as LocalDate);
}

/**
 * Everything the dashboard, progress and context pages need, over a window
 * ending today in the user's own timezone (spec §40).
 */
export async function getAnalyticsWindow(days = 400) {
  const profile = await getProfile();
  const timezone = profile?.timezone ?? 'UTC';
  const end = localToday(timezone);
  const start = addDays(end, -(days - 1));

  const [metrics, sets, sessions, cardio] = await Promise.all([
    getDailyMetrics(start, end),
    // Training analytics only look back 90 days; pulling 400 days of sets would
    // be a lot of rows for no gain.
    getLoggedSets(addDays(end, -89), end),
    // Sessions are read on the same window as the sets, and separately from
    // them: a session exists whether or not anything was logged inside it.
    getWorkoutSessions(addDays(end, -89), end),
    getCardioSessions(addDays(end, -89), end),
  ]);

  return { profile, end, start, metrics, sets, sessions, cardio };
}
