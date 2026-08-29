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
  resolveFields, type Observation, type ProvenanceMap,
} from '@/lib/normalization/canonical';
import { toNumber } from '@/lib/normalization/numbers';

type Client = SupabaseClient<Database>;

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
  recordedAt: string,
  localDate: LocalDate,
): Observation | null {
  const numeric = toNumber(value);
  if (numeric === null) return null;
  return { id, value: numeric, source, recordedAt, localDate };
}

export async function rebuildDailyMetrics(
  supabase: Client,
  userId: string,
  date: LocalDate,
): Promise<{ provenance: ProvenanceMap }> {
  const [body, metrics, nutrition, sleep, cardio, sessions] = await Promise.all([
    supabase.from('body_measurements').select('*').eq('local_date', date),
    supabase.from('metric_observations').select('*').eq('local_date', date),
    supabase.from('nutrition_logs').select('*').eq('local_date', date),
    supabase.from('sleep_records').select('*').eq('local_date', date),
    supabase.from('cardio_sessions').select('*').eq('local_date', date),
    supabase.from('workout_sessions').select('*').eq('local_date', date),
  ]);

  const fields: Record<string, Observation[]> = {
    weightKg: [], waistCm: [], steps: [], activeCalories: [],
    totalCaloriesBurned: [], restingHeartRate: [], hrvMs: [],
    sleepDurationMinutes: [], sleepScore: [], caloriesConsumed: [],
    proteinG: [], carbsG: [], fatG: [], fiberG: [], fruitVegServings: [],
  };

  const push = (key: string, obs: Observation | null) => {
    if (obs) fields[key]!.push(obs);
  };

  for (const row of body.data ?? []) {
    push('weightKg', observation(row.id, row.weight_kg, row.source, row.measured_at, date));
    push('waistCm', observation(row.id, row.waist_cm, row.source, row.measured_at, date));
  }

  const METRIC_FIELD: Record<string, string> = {
    STEPS: 'steps',
    ACTIVE_CALORIES: 'activeCalories',
    TOTAL_CALORIES_BURNED: 'totalCaloriesBurned',
    RESTING_HEART_RATE: 'restingHeartRate',
    HRV_MS: 'hrvMs',
  };
  for (const row of metrics.data ?? []) {
    const field = METRIC_FIELD[row.metric];
    if (field) push(field, observation(row.id, row.value, row.source, row.measured_at, date));
  }

  for (const row of nutrition.data ?? []) {
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

  for (const row of sleep.data ?? []) {
    push('sleepDurationMinutes',
      observation(row.id, row.duration_minutes, row.source, row.created_at, date));
    push('sleepScore', observation(row.id, row.sleep_score, row.source, row.created_at, date));
  }

  const { values, provenance } = resolveFields(fields);

  // An absent key and a null value mean the same thing here: the field was not
  // measured today. Both become null - never 0 (spec §33).
  const resolved = (field: string): number | null => values[field] ?? null;

  // Aggregates, not conflicts: cardio and training totals are SUMS of the day's
  // sessions, so they are computed rather than resolved. A day with no sessions
  // at all stays null (unknown), while a day with sessions summing to zero is 0.
  // Superseded rows are corrections' predecessors: still on disk, deliberately
  // out of the sum. Without this, re-importing a day to fix a duration would
  // add the two readings together (58 + 65 = 123) instead of replacing one.
  const cardioRows = (cardio.data ?? []).filter((r) => r.superseded_at === null);
  const sessionRows = (sessions.data ?? []).filter((r) => r.superseded_at === null);

  const minutes = (r: { duration_minutes: unknown }) => toNumber(r.duration_minutes) ?? 0;

  const cardioMinutes = cardioRows.length
    ? cardioRows.reduce((total, r) => total + minutes(r), 0)
    : null;
  const zone2Minutes = cardioRows.length
    ? cardioRows.filter((r) => r.hr_zone === 2).reduce((total, r) => total + minutes(r), 0)
    : null;
  const completed = sessionRows.filter((r) => r.completed);
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
