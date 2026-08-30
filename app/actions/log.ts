'use server';

/**
 * Write actions (spec §6, §8, §38, §41).
 *
 * Every write follows the same shape:
 *   1. validate the input with Zod at the boundary
 *   2. append a raw observation - never update or delete an existing one
 *   3. rebuild the canonical daily_metrics row for the affected date
 *   4. revalidate the pages that read it
 *
 * Values arrive in the user's DISPLAY units and are converted to canonical
 * units here, at the boundary, exactly once.
 */
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { createActionClient } from '@/lib/supabase/server';
import { rebuildDailyMetrics } from '@/lib/data/canonicalise';
import { pinManualFields, type PinnableField } from '@/lib/data/pins';
import { getProfile } from '@/lib/data/queries';
import { canonicalWeight, canonicalLength, canonicalDistance } from '@/lib/normalization/units';
import { isLocalDate, localToday, toLocalDate } from '@/lib/normalization/dates';
import type { LocalDate } from '@/lib/types';

export interface ActionResult {
  ok: boolean;
  message: string;
  /** Field-level errors keyed by form field name. */
  errors?: Record<string, string>;
}

const dateSchema = z.string().refine(isLocalDate, 'Enter a valid date');

async function requireUser() {
  const supabase = await createActionClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new Error('Not signed in.');
  return { supabase, userId: data.user.id };
}

function revalidateAll() {
  for (const path of ['/dashboard', '/progress', '/nutrition', '/training', '/recovery', '/context']) {
    revalidatePath(path);
  }
}

/**
 * The day a write landed on, as well as the pages that summarise it. /day/[date]
 * lists the raw observations themselves, so it goes stale on exactly the writes
 * the summary pages do.
 */
function revalidateDay(date: LocalDate) {
  revalidateAll();
  revalidatePath(`/day/${date}`);
}

const bodyMeasurementSchema = z
  .object({
    date: dateSchema,
    weight: z.coerce.number().positive().optional().nullable(),
    waist: z.coerce.number().positive().optional().nullable(),
    notes: z.string().max(500).optional(),
  })
  .refine(
    (v) => v.weight != null || v.waist != null,
    { message: 'Enter a weight, a waist measurement, or both.', path: ['weight'] },
  );

/** Spec §6: appends a new observation. It never overwrites an earlier one. */
export async function logBodyMeasurement(formData: FormData): Promise<ActionResult> {
  const parsed = bodyMeasurementSchema.safeParse({
    date: formData.get('date'),
    weight: emptyToNull(formData.get('weight')),
    waist: emptyToNull(formData.get('waist')),
    notes: formData.get('notes') ?? undefined,
  });
  if (!parsed.success) return fieldErrors(parsed.error);

  const { supabase, userId } = await requireUser();
  const profile = await getProfile();
  const timezone = profile?.timezone ?? 'UTC';

  const { error } = await supabase.from('body_measurements').insert({
    user_id: userId,
    measured_at: new Date().toISOString(),
    local_date: parsed.data.date,
    weight_kg:
      parsed.data.weight == null
        ? null
        : canonicalWeight(parsed.data.weight, profile?.weightDisplayUnit ?? 'LB'),
    waist_cm:
      parsed.data.waist == null
        ? null
        : canonicalLength(parsed.data.waist, profile?.lengthDisplayUnit ?? 'IN'),
    notes: parsed.data.notes || null,
    source: 'MANUAL',
    import_id: null,
  });
  if (error) return { ok: false, message: error.message };

  /**
   * A value entered by hand is the user's answer for that day, and an import
   * arriving later must not quietly replace it. Only the fields actually filled
   * in are pinned - leaving waist blank is not a statement about waist.
   */
  await pinManualFields(supabase, userId, parsed.data.date, [
    ...(parsed.data.weight == null ? [] : (['weightKg'] as const)),
    ...(parsed.data.waist == null ? [] : (['waistCm'] as const)),
  ]);

  await rebuildDailyMetrics(supabase, userId, parsed.data.date);
  revalidateDay(parsed.data.date);
  void timezone;
  return { ok: true, message: 'Measurement recorded.' };
}

const nutritionSchema = z.object({
  date: dateSchema,
  calories: z.coerce.number().min(0).max(20000).optional().nullable(),
  protein: z.coerce.number().min(0).max(2000).optional().nullable(),
  carbs: z.coerce.number().min(0).max(3000).optional().nullable(),
  fat: z.coerce.number().min(0).max(2000).optional().nullable(),
  fiber: z.coerce.number().min(0).max(500).optional().nullable(),
  fruitVeg: z.coerce.number().min(0).max(50).optional().nullable(),
  notes: z.string().max(500).optional(),
});

export async function logNutrition(formData: FormData): Promise<ActionResult> {
  const parsed = nutritionSchema.safeParse({
    date: formData.get('date'),
    calories: emptyToNull(formData.get('calories')),
    protein: emptyToNull(formData.get('protein')),
    carbs: emptyToNull(formData.get('carbs')),
    fat: emptyToNull(formData.get('fat')),
    fiber: emptyToNull(formData.get('fiber')),
    fruitVeg: emptyToNull(formData.get('fruitVeg')),
    notes: formData.get('notes') ?? undefined,
  });
  if (!parsed.success) return fieldErrors(parsed.error);

  const values = parsed.data;
  const anyValue = [values.calories, values.protein, values.carbs, values.fat, values.fiber]
    .some((v) => v != null);
  if (!anyValue) {
    return { ok: false, message: 'Enter at least one value.', errors: { calories: 'Required' } };
  }

  const { supabase, userId } = await requireUser();
  // A blank field stays null. It is not logged as zero (spec §33).
  const { error } = await supabase.from('nutrition_logs').insert({
    user_id: userId,
    local_date: values.date,
    calories: values.calories ?? null,
    protein_g: values.protein ?? null,
    carbs_g: values.carbs ?? null,
    fat_g: values.fat ?? null,
    fiber_g: values.fiber ?? null,
    fruit_veg_servings: values.fruitVeg ?? null,
    notes: values.notes || null,
    source: 'MANUAL',
    import_id: null,
  });
  if (error) return { ok: false, message: error.message };

  await rebuildDailyMetrics(supabase, userId, values.date);
  revalidateDay(values.date);
  return { ok: true, message: 'Nutrition recorded.' };
}

const metricSchema = z.object({
  date: dateSchema,
  steps: z.coerce.number().min(0).max(200000).optional().nullable(),
  activeCalories: z.coerce.number().min(0).max(10000).optional().nullable(),
  // daily_metrics.total_calories_burned has existed since 0005 and resolves
  // from this metric, which nothing wrote - so the column could never hold a
  // value. This is its writer.
  totalCaloriesBurned: z.coerce.number().min(0).max(20000).optional().nullable(),
  restingHeartRate: z.coerce.number().min(25).max(250).optional().nullable(),
  hrv: z.coerce.number().min(0).max(500).optional().nullable(),
});

export async function logDailyMetrics(formData: FormData): Promise<ActionResult> {
  const parsed = metricSchema.safeParse({
    date: formData.get('date'),
    steps: emptyToNull(formData.get('steps')),
    activeCalories: emptyToNull(formData.get('activeCalories')),
    totalCaloriesBurned: emptyToNull(formData.get('totalCaloriesBurned')),
    restingHeartRate: emptyToNull(formData.get('restingHeartRate')),
    hrv: emptyToNull(formData.get('hrv')),
  });
  if (!parsed.success) return fieldErrors(parsed.error);

  const { supabase, userId } = await requireUser();
  const now = new Date().toISOString();
  const rows = (
    [
      ['STEPS', parsed.data.steps],
      ['ACTIVE_CALORIES', parsed.data.activeCalories],
      ['TOTAL_CALORIES_BURNED', parsed.data.totalCaloriesBurned],
      ['RESTING_HEART_RATE', parsed.data.restingHeartRate],
      ['HRV_MS', parsed.data.hrv],
    ] as const
  )
    .filter(([, value]) => value != null)
    .map(([metric, value]) => ({
      user_id: userId,
      metric,
      value: value!,
      measured_at: now,
      local_date: parsed.data.date,
      source: 'MANUAL' as const,
      import_id: null,
      notes: null,
    }));

  if (rows.length === 0) return { ok: false, message: 'Enter at least one value.' };

  const { error } = await supabase.from('metric_observations').insert(rows);
  if (error) return { ok: false, message: error.message };

  const PIN_FOR_METRIC: Record<string, PinnableField> = {
    STEPS: 'steps',
    ACTIVE_CALORIES: 'activeCalories',
    TOTAL_CALORIES_BURNED: 'totalCaloriesBurned',
    RESTING_HEART_RATE: 'restingHeartRate',
    HRV_MS: 'hrvMs',
  };
  await pinManualFields(
    supabase, userId, parsed.data.date,
    rows.map((row) => PIN_FOR_METRIC[row.metric]).filter((f): f is PinnableField => !!f),
  );

  await rebuildDailyMetrics(supabase, userId, parsed.data.date);
  revalidateDay(parsed.data.date);
  return { ok: true, message: 'Metrics recorded.' };
}

const sleepSchema = z.object({
  date: dateSchema,
  hours: z.coerce.number().min(0).max(24),
  minutes: z.coerce.number().min(0).max(59).optional().nullable(),
  score: z.coerce.number().min(0).max(100).optional().nullable(),
});

export async function logSleep(formData: FormData): Promise<ActionResult> {
  const parsed = sleepSchema.safeParse({
    date: formData.get('date'),
    hours: formData.get('hours'),
    minutes: emptyToNull(formData.get('minutes')),
    score: emptyToNull(formData.get('score')),
  });
  if (!parsed.success) return fieldErrors(parsed.error);

  const { supabase, userId } = await requireUser();
  const { error } = await supabase.from('sleep_records').insert({
    user_id: userId,
    local_date: parsed.data.date,
    sleep_start: null,
    sleep_end: null,
    duration_minutes: parsed.data.hours * 60 + (parsed.data.minutes ?? 0),
    sleep_score: parsed.data.score ?? null,
    source: 'MANUAL',
    import_id: null,
    notes: null,
  });
  if (error) return { ok: false, message: error.message };

  await pinManualFields(supabase, userId, parsed.data.date, [
    'sleepDurationMinutes',
    ...(parsed.data.score == null ? [] : (['sleepScore'] as const)),
  ]);

  await rebuildDailyMetrics(supabase, userId, parsed.data.date);
  revalidateDay(parsed.data.date);
  return { ok: true, message: 'Sleep recorded.' };
}

const cardioSchema = z.object({
  date: dateSchema,
  type: z.enum(['WALKING', 'INCLINE_WALKING', 'RUNNING', 'CYCLING', 'OTHER']),
  duration: z.coerce.number().min(0).max(1440),
  distance: z.coerce.number().min(0).max(500).optional().nullable(),
  hrZone: z.coerce.number().min(1).max(5).optional().nullable(),
  averageHeartRate: z.coerce.number().min(25).max(250).optional().nullable(),
  // The importer has stored both of these since 0010. Logging by hand could
  // not, so the same session recorded two ways kept different amounts of data.
  maxHeartRate: z.coerce.number().min(25).max(250).optional().nullable(),
  calories: z.coerce.number().min(0).max(20000).optional().nullable(),
  // Carries the label a corrected session should keep, and the free text the
  // importer already writes here from the paste's own opener line.
  notes: z.string().max(500).optional(),
});

/**
 * Records a cardio session (spec §13).
 *
 * Returns the id of the row it wrote, because cardio_sessions is SUMMED rather
 * than resolved: correcting a session means writing the corrected one and
 * marking the old one superseded, and the correction has to be able to name
 * the row that replaced it. See correctCardioSession in app/actions/corrections.ts.
 */
export async function logCardio(
  formData: FormData,
): Promise<ActionResult & { sessionId?: string }> {
  const parsed = cardioSchema.safeParse({
    date: formData.get('date'),
    type: formData.get('type'),
    duration: formData.get('duration'),
    distance: emptyToNull(formData.get('distance')),
    hrZone: emptyToNull(formData.get('hrZone')),
    averageHeartRate: emptyToNull(formData.get('averageHeartRate')),
    maxHeartRate: emptyToNull(formData.get('maxHeartRate')),
    calories: emptyToNull(formData.get('calories')),
    notes: formData.get('notes') ?? undefined,
  });
  if (!parsed.success) return fieldErrors(parsed.error);

  const hrError = heartRateOrder(parsed.data.averageHeartRate, parsed.data.maxHeartRate);
  if (hrError) return hrError;

  const { supabase, userId } = await requireUser();
  const profile = await getProfile();

  const { data, error } = await supabase
    .from('cardio_sessions')
    .insert({
      user_id: userId,
      local_date: parsed.data.date,
      started_at: null,
      cardio_type: parsed.data.type,
      duration_minutes: parsed.data.duration,
      distance_km:
        parsed.data.distance == null
          ? null
          : canonicalDistance(parsed.data.distance, profile?.distanceDisplayUnit ?? 'MI'),
      average_heart_rate: parsed.data.averageHeartRate ?? null,
      max_heart_rate: parsed.data.maxHeartRate ?? null,
      hr_zone: parsed.data.hrZone ?? null,
      calories: parsed.data.calories ?? null,
      notes: parsed.data.notes || null,
      source: 'MANUAL',
      import_id: null,
    })
    .select('id')
    .single();
  if (error || !data) {
    return { ok: false, message: error?.message ?? 'Could not record the session.' };
  }

  await rebuildDailyMetrics(supabase, userId, parsed.data.date);
  revalidateAll();
  revalidatePath(`/day/${parsed.data.date}`);
  return { ok: true, message: 'Cardio session recorded.', sessionId: data.id };
}

const workoutSchema = z.object({
  date: dateSchema,
  sessionType: z.enum([
    'UPPER', 'LOWER', 'PUSH', 'PULL', 'LEGS', 'FULL_BODY', 'CARDIO', 'OTHER',
  ]),
  duration: z.coerce.number().min(0).max(1440).optional().nullable(),
  averageHeartRate: z.coerce.number().min(25).max(250).optional().nullable(),
  maxHeartRate: z.coerce.number().min(25).max(250).optional().nullable(),
  calories: z.coerce.number().min(0).max(20000).optional().nullable(),
  notes: z.string().max(1000).optional(),
});

/** Mirrors the *_hr_ordered CHECKs, as a field error rather than a DB message. */
function heartRateOrder(
  average: number | null | undefined,
  max: number | null | undefined,
): ActionResult | null {
  if (average == null || max == null || max >= average) return null;
  return {
    ok: false,
    message: 'Maximum heart rate cannot be below the average.',
    errors: { maxHeartRate: 'Must be at least the average' },
  };
}

export async function startWorkout(
  formData: FormData,
): Promise<ActionResult & { sessionId?: string }> {
  const parsed = workoutSchema.safeParse({
    date: formData.get('date'),
    sessionType: formData.get('sessionType'),
    duration: emptyToNull(formData.get('duration')),
    averageHeartRate: emptyToNull(formData.get('averageHeartRate')),
    maxHeartRate: emptyToNull(formData.get('maxHeartRate')),
    calories: emptyToNull(formData.get('calories')),
    notes: formData.get('notes') ?? undefined,
  });
  if (!parsed.success) return fieldErrors(parsed.error);

  const hrError = heartRateOrder(parsed.data.averageHeartRate, parsed.data.maxHeartRate);
  if (hrError) return hrError;

  const { supabase, userId } = await requireUser();
  const { data, error } = await supabase
    .from('workout_sessions')
    .insert({
      user_id: userId,
      local_date: parsed.data.date,
      start_time: new Date().toISOString(),
      end_time: null,
      duration_minutes: parsed.data.duration ?? null,
      session_type: parsed.data.sessionType,
      average_heart_rate: parsed.data.averageHeartRate ?? null,
      max_heart_rate: parsed.data.maxHeartRate ?? null,
      calories: parsed.data.calories ?? null,
      notes: parsed.data.notes || null,
      completed: true,
      source: 'MANUAL',
      import_id: null,
      // A session logged here has no name of its own and comes from no external
      // system. Stated rather than omitted: Insertable makes every column an
      // explicit decision, so a new column cannot be silently forgotten.
      title: null,
      external_source: null,
      external_id: null,
      external_updated_at: null,
    })
    .select('id')
    .single();

  if (error || !data) return { ok: false, message: error?.message ?? 'Could not start session.' };

  await rebuildDailyMetrics(supabase, userId, parsed.data.date);
  revalidateDay(parsed.data.date);
  revalidatePath('/training');
  return { ok: true, message: 'Session started.', sessionId: data.id };
}

const updateSessionSchema = z.object({
  sessionId: z.string().uuid(),
  sessionType: z.enum([
    'UPPER', 'LOWER', 'PUSH', 'PULL', 'LEGS', 'FULL_BODY', 'CARDIO', 'OTHER',
  ]),
  duration: z.coerce.number().min(0).max(1440).optional().nullable(),
  averageHeartRate: z.coerce.number().min(25).max(250).optional().nullable(),
  maxHeartRate: z.coerce.number().min(25).max(250).optional().nullable(),
  calories: z.coerce.number().min(0).max(20000).optional().nullable(),
  notes: z.string().max(1000).optional(),
});

/**
 * Corrects a training session in place (spec §11).
 *
 * workout_sessions is an authored record, not an immutable observation - it is
 * written over the course of a session and a figure gets corrected while it is
 * still being logged - so 0008_rls.sql grants it update, and this is the write
 * that uses it. Cardio has no equivalent: it is a closed observation, and a
 * correction there is a new row that supersedes the old one.
 *
 * The date is deliberately not editable here. Moving a session to another day
 * would leave the day it left behind holding a stale rollup, and the honest way
 * to record the wrong day is a new session, not a silent move.
 */
export async function updateWorkoutSession(formData: FormData): Promise<ActionResult> {
  const parsed = updateSessionSchema.safeParse({
    sessionId: formData.get('sessionId'),
    sessionType: formData.get('sessionType'),
    duration: emptyToNull(formData.get('duration')),
    averageHeartRate: emptyToNull(formData.get('averageHeartRate')),
    maxHeartRate: emptyToNull(formData.get('maxHeartRate')),
    calories: emptyToNull(formData.get('calories')),
    notes: formData.get('notes') ?? undefined,
  });
  if (!parsed.success) return fieldErrors(parsed.error);

  const values = parsed.data;
  // Mirrors the workout_sessions_hr_ordered CHECK, so the user gets a field
  // error rather than a database message.
  if (
    values.averageHeartRate != null &&
    values.maxHeartRate != null &&
    values.maxHeartRate < values.averageHeartRate
  ) {
    return {
      ok: false,
      message: 'Maximum heart rate cannot be below the average.',
      errors: { maxHeartRate: 'Must be at least the average' },
    };
  }

  const { supabase, userId } = await requireUser();

  const { data: existing, error: readError } = await supabase
    .from('workout_sessions')
    .select('local_date, superseded_at')
    .eq('id', values.sessionId)
    .maybeSingle();
  if (readError) return { ok: false, message: readError.message };
  if (!existing) return { ok: false, message: 'That session no longer exists.' };
  // A superseded session is history: a later observation replaced it and the
  // day's totals already exclude it (migration 0011). Editing it would appear
  // to work, change no total anywhere, and quietly rewrite a record kept
  // precisely so the correction stays traceable.
  if (existing.superseded_at !== null) {
    return {
      ok: false,
      message:
        'This session was replaced by a later correction, so it no longer counts '
        + "towards the day's totals and is kept only as history. Edit the session "
        + 'that replaced it instead.',
    };
  }

  const { error } = await supabase
    .from('workout_sessions')
    .update({
      session_type: values.sessionType,
      duration_minutes: values.duration ?? null,
      average_heart_rate: values.averageHeartRate ?? null,
      max_heart_rate: values.maxHeartRate ?? null,
      calories: values.calories ?? null,
      notes: values.notes || null,
    })
    .eq('id', values.sessionId);
  if (error) return { ok: false, message: error.message };

  // The day's rollup is a pure function of the raw layer, so it has to be
  // recomputed or the dashboard keeps showing the duration that was replaced.
  await rebuildDailyMetrics(supabase, userId, existing.local_date as LocalDate);
  revalidateDay(existing.local_date as LocalDate);
  revalidatePath(`/training/${values.sessionId}`);
  return { ok: true, message: 'Session updated.' };
}

const setSchema = z.object({
  sessionId: z.string().uuid(),
  exerciseId: z.string().min(1),
  setNumber: z.coerce.number().int().min(1).max(50),
  weight: z.coerce.number().min(0).max(1000).optional().nullable(),
  reps: z.coerce.number().int().min(0).max(200).optional().nullable(),
  rir: z.coerce.number().min(0).max(10).optional().nullable(),
  rpe: z.coerce.number().min(1).max(10).optional().nullable(),
  warmup: z.coerce.boolean().optional(),
});

export async function logSet(formData: FormData): Promise<ActionResult> {
  const parsed = setSchema.safeParse({
    sessionId: formData.get('sessionId'),
    exerciseId: formData.get('exerciseId'),
    setNumber: formData.get('setNumber'),
    weight: emptyToNull(formData.get('weight')),
    reps: emptyToNull(formData.get('reps')),
    rir: emptyToNull(formData.get('rir')),
    rpe: emptyToNull(formData.get('rpe')),
    warmup: formData.get('warmup') === 'on',
  });
  if (!parsed.success) return fieldErrors(parsed.error);

  const { supabase, userId } = await requireUser();
  const profile = await getProfile();

  const { error } = await supabase.from('workout_sets').insert({
    user_id: userId,
    session_id: parsed.data.sessionId,
    exercise_id: parsed.data.exerciseId,
    set_number: parsed.data.setNumber,
    weight_kg:
      parsed.data.weight == null
        ? null
        : canonicalWeight(parsed.data.weight, profile?.weightDisplayUnit ?? 'LB'),
    reps: parsed.data.reps ?? null,
    rir: parsed.data.rir ?? null,
    rpe: parsed.data.rpe ?? null,
    rest_seconds: null,
    warmup: parsed.data.warmup ?? false,
    to_failure: false,
    notes: null,
    // The exercise-block fields belong to a source that records a workout as a
    // whole. Logging a set by hand fills none of them, and NULL says so.
    exercise_index: null,
    exercise_notes: null,
    superset_id: null,
    set_type: null,
    distance_km: null,
    duration_seconds: null,
  });
  if (error) return { ok: false, message: error.message };

  revalidatePath('/training');
  revalidatePath(`/training/${parsed.data.sessionId}`);
  return { ok: true, message: 'Set logged.' };
}

/** An empty form field means "not logged", so it must become null, not 0. */
function emptyToNull(value: FormDataEntryValue | null): string | null {
  if (value === null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function fieldErrors(error: z.ZodError): ActionResult {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === 'string' && !errors[key]) errors[key] = issue.message;
  }
  return { ok: false, message: 'Check the highlighted fields.', errors };
}

/** Today in the signed-in user's timezone, for form defaults (spec §40). */
export async function todayForUser(): Promise<LocalDate> {
  const profile = await getProfile();
  return localToday(profile?.timezone ?? 'UTC');
}

export async function localDateForInstant(iso: string): Promise<LocalDate> {
  const profile = await getProfile();
  return toLocalDate(new Date(iso), profile?.timezone ?? 'UTC');
}
