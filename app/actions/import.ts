'use server';

/**
 * Import actions (spec §8, §17, §28, §38, §41).
 *
 * Two steps, deliberately separate:
 *
 *   parseImport()    reads the text and returns what it found. Writes nothing.
 *   confirmImport()  writes what the USER confirmed, after editing.
 *
 * The separation is the point. Parsed data is never trusted (§8), so nothing
 * reaches the database until a human has seen every field. The original text is
 * stored verbatim and forever (§17), and the idempotency key makes a repeated
 * paste a no-op rather than a duplicate day (§38).
 */
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { createActionClient } from '@/lib/supabase/server';
import { rebuildDailyMetrics } from '@/lib/data/canonicalise';
import { getProfile } from '@/lib/data/queries';
import { parseText, PARSER_NAME, PARSER_VERSION, type ParseResult } from '@/lib/health/parser';
import { idempotencyKey } from '@/lib/health/idempotency';
import { isLocalDate, localToday } from '@/lib/normalization/dates';
import type { LocalDate } from '@/lib/types';

export interface ParsePreview extends ParseResult {
  targetDate: LocalDate | null;
  /** True when this exact paste has already been imported (spec §38). */
  alreadyImported: boolean;
  previousImportDate: string | null;
}

export async function parseImport(rawText: string): Promise<ParsePreview> {
  const profile = await getProfile();
  const timezone = profile?.timezone ?? 'UTC';
  const today = localToday(timezone);
  const referenceYear = Number(today.slice(0, 4));

  const result = parseText(rawText, referenceYear);
  const dateField = result.fields.find((f) => f.key === 'date');
  const targetDate =
    dateField && typeof dateField.value === 'string' && isLocalDate(dateField.value)
      ? dateField.value
      : null;

  // Check the idempotency key BEFORE the user fills anything in, so a repeat
  // paste is called out immediately rather than after they redo the review.
  const supabase = await createActionClient();
  const key = idempotencyKey(rawText, targetDate ?? today);
  const { data: existing } = await supabase
    .from('health_imports')
    .select('created_at, status')
    .eq('idempotency_key', key)
    .maybeSingle();

  return {
    ...result,
    targetDate,
    alreadyImported: Boolean(existing && existing.status === 'CONFIRMED'),
    previousImportDate: existing?.created_at ?? null,
  };
}

/** The reviewed, user-edited values. All optional; blank stays blank. */
const confirmSchema = z.object({
  rawText: z.string().min(1),
  date: z.string().refine(isLocalDate, 'A valid date is required before importing.'),
  weightKg: z.coerce.number().positive().optional().nullable(),
  waistCm: z.coerce.number().positive().optional().nullable(),
  calories: z.coerce.number().min(0).optional().nullable(),
  proteinG: z.coerce.number().min(0).optional().nullable(),
  carbsG: z.coerce.number().min(0).optional().nullable(),
  fatG: z.coerce.number().min(0).optional().nullable(),
  fiberG: z.coerce.number().min(0).optional().nullable(),
  steps: z.coerce.number().min(0).optional().nullable(),
  activeCalories: z.coerce.number().min(0).optional().nullable(),
  restingHeartRate: z.coerce.number().min(25).max(250).optional().nullable(),
  hrvMs: z.coerce.number().min(0).optional().nullable(),
  sleepMinutes: z.coerce.number().min(0).max(1440).optional().nullable(),
});

export interface ImportResult {
  ok: boolean;
  message: string;
  duplicate?: boolean;
  errors?: Record<string, string>;
}

export async function confirmImport(formData: FormData): Promise<ImportResult> {
  const raw = Object.fromEntries(
    [
      'rawText', 'date', 'weightKg', 'waistCm', 'calories', 'proteinG', 'carbsG',
      'fatG', 'fiberG', 'steps', 'activeCalories', 'restingHeartRate', 'hrvMs',
      'sleepMinutes',
    ].map((key) => {
      const value = formData.get(key);
      const text = value === null ? null : String(value).trim();
      return [key, text === '' ? null : text];
    }),
  );

  const parsed = confirmSchema.safeParse(raw);
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === 'string' && !errors[key]) errors[key] = issue.message;
    }
    return { ok: false, message: 'Check the highlighted fields.', errors };
  }

  const values = parsed.data;
  const supabase = await createActionClient();
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError || !auth.user) return { ok: false, message: 'Not signed in.' };
  const userId = auth.user.id;

  const key = idempotencyKey(values.rawText, values.date);

  // The raw text is stored first and kept regardless of what happens next, so
  // the original input survives even a failed import (spec §17).
  const { data: importRow, error: importError } = await supabase
    .from('health_imports')
    .insert({
      user_id: userId,
      raw_text: values.rawText,
      parsed: parseText(values.rawText).fields as unknown as Record<string, unknown>,
      confirmed: values as unknown as Record<string, unknown>,
      parser_name: PARSER_NAME,
      parser_version: PARSER_VERSION,
      target_local_date: values.date,
      source: 'IMPORT_TEXT',
      status: 'CONFIRMED',
      confirmed_at: new Date().toISOString(),
      idempotency_key: key,
    })
    .select('id')
    .single();

  if (importError) {
    // 23505 is unique_violation: the same paste, already imported. This is the
    // §38 guarantee, enforced by the database rather than by a check we could
    // race past.
    if (importError.code === '23505') {
      await supabase.from('system_events').insert({
        user_id: userId,
        kind: 'IMPORT_DUPLICATE_REJECTED',
        summary: 'A repeated paste was rejected before it could duplicate a day.',
        detail: { targetDate: values.date, idempotencyKey: key },
        previous_value: null,
        new_value: null,
        reason: 'Identical import already recorded.',
        status: 'RECORDED',
      });
      return {
        ok: false,
        duplicate: true,
        message:
          'This exact report has already been imported. Nothing was changed. ' +
          'Edit a value if you meant to record something different.',
      };
    }
    return { ok: false, message: importError.message };
  }

  const importId = importRow.id;
  const now = new Date().toISOString();

  // Each domain gets its own raw row, all tagged with the import that made them.
  if (values.weightKg != null || values.waistCm != null) {
    await supabase.from('body_measurements').insert({
      user_id: userId,
      measured_at: now,
      local_date: values.date,
      weight_kg: values.weightKg ?? null,
      waist_cm: values.waistCm ?? null,
      notes: null,
      source: 'IMPORT_TEXT',
      import_id: importId,
    });
  }

  const nutritionValues = [values.calories, values.proteinG, values.carbsG, values.fatG, values.fiberG];
  if (nutritionValues.some((v) => v != null)) {
    await supabase.from('nutrition_logs').insert({
      user_id: userId,
      local_date: values.date,
      calories: values.calories ?? null,
      protein_g: values.proteinG ?? null,
      carbs_g: values.carbsG ?? null,
      fat_g: values.fatG ?? null,
      fiber_g: values.fiberG ?? null,
      fruit_veg_servings: null,
      notes: null,
      source: 'IMPORT_TEXT',
      import_id: importId,
    });
  }

  const metricRows = (
    [
      ['STEPS', values.steps],
      ['ACTIVE_CALORIES', values.activeCalories],
      ['RESTING_HEART_RATE', values.restingHeartRate],
      ['HRV_MS', values.hrvMs],
    ] as const
  )
    .filter(([, value]) => value != null)
    .map(([metric, value]) => ({
      user_id: userId,
      metric,
      value: value!,
      measured_at: now,
      local_date: values.date,
      source: 'IMPORT_TEXT' as const,
      import_id: importId,
      notes: null,
    }));
  if (metricRows.length > 0) {
    await supabase.from('metric_observations').insert(metricRows);
  }

  if (values.sleepMinutes != null) {
    await supabase.from('sleep_records').insert({
      user_id: userId,
      local_date: values.date,
      sleep_start: null,
      sleep_end: null,
      duration_minutes: values.sleepMinutes,
      sleep_score: null,
      source: 'IMPORT_TEXT',
      import_id: importId,
      notes: null,
    });
  }

  const { provenance } = await rebuildDailyMetrics(supabase, userId, values.date);

  // Spec §41: the import is recorded in the audit log with what it resolved to.
  await supabase.from('system_events').insert({
    user_id: userId,
    kind: 'IMPORT_CONFIRMED',
    summary: `Imported data for ${values.date}.`,
    detail: { importId, provenance: provenance as unknown as Record<string, unknown> },
    previous_value: null,
    new_value: null,
    reason: 'User confirmed a reviewed text import.',
    status: 'RECORDED',
  });

  for (const path of ['/dashboard', '/progress', '/nutrition', '/recovery', '/import', '/context']) {
    revalidatePath(path);
  }
  return { ok: true, message: `Imported data for ${values.date}.` };
}
