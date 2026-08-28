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

  await rebuildDailyMetrics(supabase, userId, parsed.data.date);
  revalidateAll();
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
  revalidateAll();
  return { ok: true, message: 'Nutrition recorded.' };
}

const metricSchema = z.object({
  date: dateSchema,
  steps: z.coerce.number().min(0).max(200000).optional().nullable(),
  activeCalories: z.coerce.number().min(0).max(10000).optional().nullable(),
  restingHeartRate: z.coerce.number().min(25).max(250).optional().nullable(),
  hrv: z.coerce.number().min(0).max(500).optional().nullable(),
});

export async function logDailyMetrics(formData: FormData): Promise<ActionResult> {
  const parsed = metricSchema.safeParse({
    date: formData.get('date'),
    steps: emptyToNull(formData.get('steps')),
    activeCalories: emptyToNull(formData.get('activeCalories')),
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

  await rebuildDailyMetrics(supabase, userId, parsed.data.date);
  revalidateAll();
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

  await rebuildDailyMetrics(supabase, userId, parsed.data.date);
  revalidateAll();
  return { ok: true, message: 'Sleep recorded.' };
}

const cardioSchema = z.object({
  date: dateSchema,
  type: z.enum(['WALKING', 'INCLINE_WALKING', 'RUNNING', 'CYCLING', 'OTHER']),
  duration: z.coerce.number().min(0).max(1440),
  distance: z.coerce.number().min(0).max(500).optional().nullable(),
  hrZone: z.coerce.number().min(1).max(5).optional().nullable(),
  averageHeartRate: z.coerce.number().min(25).max(250).optional().nullable(),
});

export async function logCardio(formData: FormData): Promise<ActionResult> {
  const parsed = cardioSchema.safeParse({
    date: formData.get('date'),
    type: formData.get('type'),
    duration: formData.get('duration'),
    distance: emptyToNull(formData.get('distance')),
    hrZone: emptyToNull(formData.get('hrZone')),
    averageHeartRate: emptyToNull(formData.get('averageHeartRate')),
  });
  if (!parsed.success) return fieldErrors(parsed.error);

  const { supabase, userId } = await requireUser();
  const profile = await getProfile();

  const { error } = await supabase.from('cardio_sessions').insert({
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
    hr_zone: parsed.data.hrZone ?? null,
    calories: null,
    notes: null,
    source: 'MANUAL',
    import_id: null,
  });
  if (error) return { ok: false, message: error.message };

  await rebuildDailyMetrics(supabase, userId, parsed.data.date);
  revalidateAll();
  return { ok: true, message: 'Cardio session recorded.' };
}

const workoutSchema = z.object({
  date: dateSchema,
  sessionType: z.enum([
    'UPPER', 'LOWER', 'PUSH', 'PULL', 'LEGS', 'FULL_BODY', 'CARDIO', 'OTHER',
  ]),
  duration: z.coerce.number().min(0).max(1440).optional().nullable(),
  notes: z.string().max(1000).optional(),
});

export async function startWorkout(
  formData: FormData,
): Promise<ActionResult & { sessionId?: string }> {
  const parsed = workoutSchema.safeParse({
    date: formData.get('date'),
    sessionType: formData.get('sessionType'),
    duration: emptyToNull(formData.get('duration')),
    notes: formData.get('notes') ?? undefined,
  });
  if (!parsed.success) return fieldErrors(parsed.error);

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
      notes: parsed.data.notes || null,
      completed: true,
      source: 'MANUAL',
      import_id: null,
    })
    .select('id')
    .single();

  if (error || !data) return { ok: false, message: error?.message ?? 'Could not start session.' };

  await rebuildDailyMetrics(supabase, userId, parsed.data.date);
  revalidatePath('/training');
  return { ok: true, message: 'Session started.', sessionId: data.id };
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
  });
  if (error) return { ok: false, message: error.message };

  revalidatePath('/training');
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
