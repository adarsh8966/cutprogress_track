'use server';

/**
 * Quick Entry (spec §6, §8, §33, §41).
 *
 * One date, every field, one submit. It writes NOTHING itself: each group is
 * handed to the same action the dedicated form uses, so there is exactly one
 * write path per table and no second definition of what "logging weight" means.
 * If a rule changes in logNutrition, Quick Entry changes with it.
 *
 * The result names the destination of every group that was written, because a
 * form this wide is exactly where a value can be typed and then quietly go
 * nowhere. A group with no values entered is skipped rather than written as a
 * row of nulls or, worse, zeros.
 */
import { revalidatePath } from 'next/cache';
import {
  logBodyMeasurement, logNutrition, logDailyMetrics, logSleep,
  logCardio, startWorkout, type ActionResult,
} from '@/app/actions/log';

export interface QuickEntryResult extends ActionResult {
  /** One line per group actually written, naming where it landed. */
  saved: string[];
  /** Groups that failed, with the reason. Nothing is reported as saved twice. */
  failed: { group: string; message: string }[];
}

/** Copies a subset of fields into a fresh FormData for one write. */
function subset(
  source: FormData,
  fields: readonly string[],
  extra: Record<string, string> = {},
): { data: FormData; any: boolean } {
  const data = new FormData();
  let any = false;
  for (const field of fields) {
    const value = source.get(field);
    const text = value === null ? '' : String(value).trim();
    if (text !== '') any = true;
    data.set(field, text);
  }
  for (const [key, value] of Object.entries(extra)) data.set(key, value);
  return { data, any };
}

const GROUPS = [
  {
    group: 'Body measurements',
    fields: ['weight', 'waist'] as const,
    destination: 'Dashboard and Progress',
    run: logBodyMeasurement,
  },
  {
    group: 'Nutrition',
    fields: ['calories', 'protein', 'carbs', 'fat', 'fiber', 'fruitVeg'] as const,
    destination: 'Nutrition',
    run: logNutrition,
  },
  {
    group: 'Daily metrics',
    fields: ['steps', 'activeCalories', 'totalCaloriesBurned', 'restingHeartRate', 'hrv'] as const,
    destination: 'Recovery and Dashboard',
    run: logDailyMetrics,
  },
  {
    group: 'Sleep',
    fields: ['hours', 'minutes', 'score'] as const,
    destination: 'Recovery',
    run: logSleep,
  },
] as const;

export async function quickEntry(formData: FormData): Promise<QuickEntryResult> {
  const date = String(formData.get('date') ?? '').trim();
  if (date === '') {
    return {
      ok: false, message: 'A date is required.', saved: [], failed: [],
      errors: { date: 'Required' },
    };
  }

  const saved: string[] = [];
  const failed: { group: string; message: string }[] = [];

  for (const { group, fields, destination, run } of GROUPS) {
    const { data, any } = subset(formData, fields, { date });
    // Sleep needs an hours value to mean anything; a lone score is not a night.
    if (!any) continue;
    if (group === 'Sleep' && String(formData.get('hours') ?? '').trim() === '') {
      failed.push({ group, message: 'Sleep needs an hours value.' });
      continue;
    }
    const result = await run(data);
    if (result.ok) saved.push(`${group} → ${destination}`);
    else failed.push({ group, message: result.message });
  }

  // A workout needs a type to be a workout at all, and a duration to be worth
  // recording; anything else about it is optional.
  const workout = subset(
    formData,
    ['workoutDuration', 'workoutAverageHeartRate', 'workoutMaxHeartRate', 'workoutCalories'],
    { date },
  );
  const workoutType = String(formData.get('workoutType') ?? '').trim();
  if (workoutType !== '' && workout.any) {
    const data = new FormData();
    data.set('date', date);
    data.set('sessionType', workoutType);
    data.set('duration', String(formData.get('workoutDuration') ?? ''));
    data.set('averageHeartRate', String(formData.get('workoutAverageHeartRate') ?? ''));
    data.set('maxHeartRate', String(formData.get('workoutMaxHeartRate') ?? ''));
    data.set('calories', String(formData.get('workoutCalories') ?? ''));
    const result = await startWorkout(data);
    if (result.ok) saved.push('Workout → Training → Session history');
    else failed.push({ group: 'Workout', message: result.message });
  }

  const cardioType = String(formData.get('cardioType') ?? '').trim();
  const cardioDuration = String(formData.get('cardioDuration') ?? '').trim();
  if (cardioType !== '' && cardioDuration !== '') {
    const data = new FormData();
    data.set('date', date);
    data.set('type', cardioType);
    data.set('duration', cardioDuration);
    data.set('distance', String(formData.get('cardioDistance') ?? ''));
    data.set('hrZone', String(formData.get('cardioHrZone') ?? ''));
    data.set('averageHeartRate', String(formData.get('cardioAverageHeartRate') ?? ''));
    data.set('maxHeartRate', String(formData.get('cardioMaxHeartRate') ?? ''));
    data.set('calories', String(formData.get('cardioCalories') ?? ''));
    const result = await logCardio(data);
    if (result.ok) saved.push('Cardio → Recovery → Cardio');
    else failed.push({ group: 'Cardio', message: result.message });
  } else if (cardioType !== '' && cardioDuration === '') {
    // cardio_sessions.duration_minutes is NOT NULL, so this cannot be written.
    failed.push({ group: 'Cardio', message: 'Cardio needs a duration.' });
  }

  for (const path of ['/dashboard', '/progress', '/nutrition', '/training', '/recovery', '/context']) {
    revalidatePath(path);
  }

  if (saved.length === 0 && failed.length === 0) {
    return { ok: false, message: 'Nothing entered. Fill in at least one field.', saved, failed };
  }

  return {
    ok: failed.length === 0,
    message: failed.length === 0
      ? `Saved ${saved.length} group${saved.length === 1 ? '' : 's'}.`
      : `Saved ${saved.length}, ${failed.length} failed.`,
    saved,
    failed,
  };
}
