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
import type { LoggedSet, TrainingSession } from '@/lib/analytics/training';
import { createServerComponentClient } from '@/lib/supabase/server';
import { addDays, localToday } from '@/lib/normalization/dates';
import type { ContextExportRow, ProfileRow, SystemEventRow } from '@/lib/supabase/types';

/** null and undefined stay null. Only a real value becomes a number. */
export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function rowToProfile(row: ProfileRow): UserProfile {
  return {
    heightCm: toNumber(row.height_cm),
    sex: row.sex,
    dateOfBirth: row.date_of_birth,
    timezone: row.timezone,
    startingWeightKg: toNumber(row.starting_weight_kg),
    targetWeightKg: toNumber(row.target_weight_kg),
    phase: row.phase,
    targets: {
      calories: toNumber(row.target_calories),
      proteinG: toNumber(row.target_protein_g),
      fiberG: toNumber(row.target_fiber_g),
      steps: toNumber(row.target_steps),
      trainingSessionsPerWeek: toNumber(row.target_training_sessions_per_week),
      cardioMinutesPerWeek: toNumber(row.target_cardio_minutes_per_week),
    },
    maxWeeklyLossRatePct: toNumber(row.max_weekly_loss_rate_pct) ?? 1,
    cutStartDate: row.cut_start_date,
    weightDisplayUnit: row.weight_display_unit,
    distanceDisplayUnit: row.distance_display_unit,
    lengthDisplayUnit: row.length_display_unit,
  };
}

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

  return data.map((row) => ({
    localDate: row.local_date,
    weightKg: toNumber(row.weight_kg),
    waistCm: toNumber(row.waist_cm),
    steps: toNumber(row.steps),
    activeCalories: toNumber(row.active_calories),
    totalCaloriesBurned: toNumber(row.total_calories_burned),
    workoutMinutes: toNumber(row.workout_minutes),
    cardioMinutes: toNumber(row.cardio_minutes),
    zone2Minutes: toNumber(row.zone2_minutes),
    restingHeartRate: toNumber(row.resting_heart_rate),
    hrvMs: toNumber(row.hrv_ms),
    sleepDurationMinutes: toNumber(row.sleep_duration_minutes),
    sleepScore: toNumber(row.sleep_score),
    caloriesConsumed: toNumber(row.calories_consumed),
    proteinG: toNumber(row.protein_g),
    carbsG: toNumber(row.carbs_g),
    fatG: toNumber(row.fat_g),
    fiberG: toNumber(row.fiber_g),
    fruitVegServings: toNumber(row.fruit_veg_servings),
    trainingSessions: toNumber(row.training_sessions),
  }));
}

export async function getLoggedSets(from: LocalDate, to: LocalDate): Promise<LoggedSet[]> {
  const supabase = await createServerComponentClient();
  const { data, error } = await supabase
    .from('workout_sets')
    .select(
      'id, set_number, weight_kg, reps, rir, rpe, warmup, session_id, exercise_id, ' +
        'workout_sessions!inner(local_date), exercises!inner(name, primary_muscle_group)',
    )
    .gte('workout_sessions.local_date', from)
    .lte('workout_sessions.local_date', to);

  if (error || !data) return [];
  return mapLoggedSets(data);
}

type JoinedSet = {
  session_id: string;
  exercise_id: string;
  weight_kg: number | null;
  reps: number | null;
  rir: number | null;
  rpe: number | null;
  warmup: boolean;
  workout_sessions: { local_date: string } | { local_date: string }[];
  exercises:
    | { name: string; primary_muscle_group: string }
    | { name: string; primary_muscle_group: string }[];
};

/** PostgREST returns an embedded row as an object or a one-element array. */
function mapLoggedSets(data: unknown): LoggedSet[] {
  return (data as JoinedSet[]).map((row) => {
    const session = Array.isArray(row.workout_sessions)
      ? row.workout_sessions[0]!
      : row.workout_sessions;
    const exercise = Array.isArray(row.exercises) ? row.exercises[0]! : row.exercises;
    return {
      date: session.local_date,
      sessionId: row.session_id,
      exerciseId: row.exercise_id,
      exerciseName: exercise.name,
      primaryMuscleGroup: exercise.primary_muscle_group,
      weightKg: toNumber(row.weight_kg),
      reps: toNumber(row.reps),
      rir: toNumber(row.rir),
      rpe: toNumber(row.rpe),
      warmup: row.warmup,
    };
  });
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
  return data.map((row) => ({
    id: row.id,
    date: row.local_date,
    sessionType: row.session_type as string,
    durationMinutes: toNumber(row.duration_minutes),
    averageHeartRate: toNumber(row.average_heart_rate),
    maxHeartRate: toNumber(row.max_heart_rate),
    calories: toNumber(row.calories),
    notes: row.notes,
    source: row.source as string,
    completed: row.completed,
    importId: row.import_id,
  }));
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
  return {
    id: data.id,
    date: data.local_date,
    sessionType: data.session_type as string,
    durationMinutes: toNumber(data.duration_minutes),
    averageHeartRate: toNumber(data.average_heart_rate),
    maxHeartRate: toNumber(data.max_heart_rate),
    calories: toNumber(data.calories),
    notes: data.notes,
    source: data.source as string,
    completed: data.completed,
    importId: data.import_id,
  };
}

/** Every set belonging to one session, for the detail page. */
export async function getSetsForSession(sessionId: string): Promise<LoggedSet[]> {
  const supabase = await createServerComponentClient();
  const { data, error } = await supabase
    .from('workout_sets')
    .select(
      'id, set_number, weight_kg, reps, rir, rpe, warmup, session_id, exercise_id, ' +
        'workout_sessions!inner(local_date), exercises!inner(name, primary_muscle_group)',
    )
    .eq('session_id', sessionId)
    .order('set_number', { ascending: true });

  if (error || !data) return [];
  return mapLoggedSets(data);
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
    .select('id, created_at, status, target_local_date, parser_version, raw_text')
    .order('created_at', { ascending: false })
    .limit(limit);
  return data ?? [];
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
