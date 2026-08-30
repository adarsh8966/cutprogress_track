'use server';

/**
 * Profile and target changes (spec §4, §41, §45).
 *
 * Every target change passes through the safety review first. A BLOCK finding
 * refuses the save outright; a WARNING requires the user to tick an explicit
 * acknowledgement, and the acknowledgement itself is written to the audit log,
 * so a change is never silent (§41).
 */
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { createActionClient } from '@/lib/supabase/server';
import { getProfile } from '@/lib/data/queries';
import { reviewTargets, type SafetyFinding } from '@/lib/validation/safety';
import { canonicalWeight, feetInchesToCm } from '@/lib/normalization/units';
import { isValidTimezone } from '@/lib/normalization/dates';

export interface SettingsResult {
  ok: boolean;
  message: string;
  findings?: SafetyFinding[];
  needsAcknowledgement?: boolean;
  errors?: Record<string, string>;
}

const settingsSchema = z.object({
  heightFeet: z.coerce.number().min(3).max(8).optional().nullable(),
  heightInches: z.coerce.number().min(0).max(11.99).optional().nullable(),
  heightCm: z.coerce.number().min(100).max(250).optional().nullable(),
  sex: z.enum(['MALE', 'FEMALE', 'UNSPECIFIED']),
  dateOfBirth: z.string().optional().nullable(),
  timezone: z.string().refine(isValidTimezone, 'Choose a valid timezone.'),
  phase: z.enum(['CUT', 'MAINTENANCE', 'REVERSE_DIET', 'LEAN_GAIN']),
  startingWeight: z.coerce.number().positive().optional().nullable(),
  targetWeight: z.coerce.number().positive().optional().nullable(),
  targetCalories: z.coerce.number().int().positive().optional().nullable(),
  targetProtein: z.coerce.number().int().min(0).optional().nullable(),
  targetFiber: z.coerce.number().int().min(0).optional().nullable(),
  targetSteps: z.coerce.number().int().min(0).optional().nullable(),
  targetSessions: z.coerce.number().int().min(0).max(14).optional().nullable(),
  targetCardioMinutes: z.coerce.number().int().min(0).optional().nullable(),
  maxWeeklyLossRatePct: z.coerce.number().positive().max(2),
  weightDisplayUnit: z.enum(['LB', 'KG']),
  distanceDisplayUnit: z.enum(['MI', 'KM']),
  lengthDisplayUnit: z.enum(['IN', 'CM']),
  acknowledgeWarnings: z.coerce.boolean().optional(),
});

export async function saveSettings(formData: FormData): Promise<SettingsResult> {
  const read = (key: string): string | null => {
    const value = formData.get(key);
    const text = value === null ? null : String(value).trim();
    return text === '' ? null : text;
  };

  const parsed = settingsSchema.safeParse({
    heightFeet: read('heightFeet'),
    heightInches: read('heightInches'),
    heightCm: read('heightCm'),
    sex: read('sex') ?? 'UNSPECIFIED',
    dateOfBirth: read('dateOfBirth'),
    timezone: read('timezone') ?? 'UTC',
    phase: read('phase') ?? 'CUT',
    startingWeight: read('startingWeight'),
    targetWeight: read('targetWeight'),
    targetCalories: read('targetCalories'),
    targetProtein: read('targetProtein'),
    targetFiber: read('targetFiber'),
    targetSteps: read('targetSteps'),
    targetSessions: read('targetSessions'),
    targetCardioMinutes: read('targetCardioMinutes'),
    maxWeeklyLossRatePct: read('maxWeeklyLossRatePct') ?? '1',
    weightDisplayUnit: read('weightDisplayUnit') ?? 'LB',
    distanceDisplayUnit: read('distanceDisplayUnit') ?? 'MI',
    lengthDisplayUnit: read('lengthDisplayUnit') ?? 'IN',
    acknowledgeWarnings: formData.get('acknowledgeWarnings') === 'on',
  });

  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === 'string' && !errors[key]) errors[key] = issue.message;
    }
    return { ok: false, message: 'Check the highlighted fields.', errors };
  }

  const values = parsed.data;
  const lengthUnit = values.lengthDisplayUnit;
  const heightCm =
    lengthUnit === 'CM'
      ? (values.heightCm ?? null)
      : values.heightFeet != null
        ? feetInchesToCm(values.heightFeet, values.heightInches ?? 0)
        : null;

  const targetWeightKg =
    values.targetWeight == null
      ? null
      : canonicalWeight(values.targetWeight, values.weightDisplayUnit);
  const startingWeightKg =
    values.startingWeight == null
      ? null
      : canonicalWeight(values.startingWeight, values.weightDisplayUnit);

  // Spec §45: safety review runs before anything is written.
  const review = reviewTargets({
    calories: values.targetCalories ?? null,
    targetWeightKg,
    heightCm,
    sex: values.sex,
    maxWeeklyLossRatePct: values.maxWeeklyLossRatePct,
    // Quoted back in the unit they typed it in, not in pounds regardless.
    weightUnit: values.weightDisplayUnit,
  });

  if (review.blocked) {
    return {
      ok: false,
      message: 'These targets were not saved.',
      findings: review.findings,
    };
  }
  if (review.needsAcknowledgement && !values.acknowledgeWarnings) {
    return {
      ok: false,
      message: 'Confirm you understand the warnings below before saving.',
      findings: review.findings,
      needsAcknowledgement: true,
    };
  }

  const supabase = await createActionClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, message: 'Not signed in.' };
  const userId = auth.user.id;
  const previous = await getProfile();

  const { error } = await supabase.from('profiles').upsert({
    id: userId,
    height_cm: heightCm,
    sex: values.sex,
    date_of_birth: values.dateOfBirth ?? null,
    timezone: values.timezone,
    weight_display_unit: values.weightDisplayUnit,
    distance_display_unit: values.distanceDisplayUnit,
    length_display_unit: values.lengthDisplayUnit,
    starting_weight_kg: startingWeightKg,
    target_weight_kg: targetWeightKg,
    phase: values.phase,
    target_calories: values.targetCalories ?? null,
    target_protein_g: values.targetProtein ?? null,
    target_fiber_g: values.targetFiber ?? null,
    target_steps: values.targetSteps ?? null,
    target_training_sessions_per_week: values.targetSessions ?? null,
    target_cardio_minutes_per_week: values.targetCardioMinutes ?? null,
    max_weekly_loss_rate_pct: values.maxWeeklyLossRatePct,
    cut_start_date: read('cutStartDate'),
    updated_at: new Date().toISOString(),
  });

  if (error) return { ok: false, message: error.message };

  // Spec §41: a target change is never silent.
  if (previous && previous.targets.calories !== (values.targetCalories ?? null)) {
    await supabase.from('system_events').insert({
      user_id: userId,
      kind: 'TARGET_CHANGED',
      summary: 'Calorie target changed.',
      detail: { field: 'target_calories' },
      previous_value: String(previous.targets.calories ?? 'not set'),
      new_value: String(values.targetCalories ?? 'not set'),
      reason: 'Changed manually in Settings.',
      status: 'RECORDED',
    });
  }
  if (review.findings.length > 0 && values.acknowledgeWarnings) {
    await supabase.from('system_events').insert({
      user_id: userId,
      kind: 'SAFETY_WARNING_ACKNOWLEDGED',
      summary: 'Safety warnings were acknowledged before saving targets.',
      detail: { findings: review.findings as unknown as Record<string, unknown> },
      previous_value: null,
      new_value: null,
      reason: 'User explicitly confirmed.',
      status: 'ACKNOWLEDGED',
    });
  }

  revalidatePath('/', 'layout');
  return {
    ok: true,
    message: 'Settings saved.',
    findings: review.findings.length > 0 ? review.findings : undefined,
  };
}
