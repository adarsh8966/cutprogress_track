'use client';

/**
 * Corrects a training session (spec §11).
 *
 * workout_sessions is an authored record rather than a closed observation, so
 * it is edited in place and daily_metrics is rebuilt from the corrected row -
 * no stale copy of the old duration survives anywhere. The date is not editable
 * here on purpose: moving a session to another day would leave the day it left
 * holding a rollup for a session that is no longer in it.
 */
import { updateWorkoutSession } from '@/app/actions/log';
import { ActionForm, NumberField, SelectField, TextField } from '@/components/ui/Form';

const SESSION_TYPES = [
  'UPPER', 'LOWER', 'PUSH', 'PULL', 'LEGS', 'FULL_BODY', 'CARDIO', 'OTHER',
].map((value) => ({ value, label: value.replaceAll('_', ' ').toLowerCase() }));

export function SessionEditor({
  sessionId,
  sessionType,
  durationMinutes,
  averageHeartRate,
  maxHeartRate,
  calories,
  notes,
}: {
  sessionId: string;
  sessionType: string;
  durationMinutes: number | null;
  averageHeartRate: number | null;
  maxHeartRate: number | null;
  calories: number | null;
  notes: string | null;
}) {
  return (
    <ActionForm
      action={async (formData) => {
        formData.set('sessionId', sessionId);
        return updateWorkoutSession(formData);
      }}
      submitLabel="Save changes"
    >
      {(errors) => (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              name="sessionType" label="Session type" options={SESSION_TYPES}
              defaultValue={sessionType} error={errors.sessionType}
            />
            <NumberField
              name="duration" label="Duration" unit="min" step="1"
              defaultValue={durationMinutes ?? undefined} error={errors.duration}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <NumberField
              name="averageHeartRate" label="Average HR" unit="bpm" step="1"
              defaultValue={averageHeartRate ?? undefined} error={errors.averageHeartRate}
            />
            <NumberField
              name="maxHeartRate" label="Maximum HR" unit="bpm" step="1"
              defaultValue={maxHeartRate ?? undefined} error={errors.maxHeartRate}
            />
            <NumberField
              name="calories" label="Calories burned" unit="kcal" step="1"
              defaultValue={calories ?? undefined} error={errors.calories}
            />
          </div>
          <TextField
            name="notes" label="Notes" defaultValue={notes ?? ''} error={errors.notes}
          />
          <p className="text-[11px] leading-relaxed text-ink-faint">
            Clearing a field records it as not logged, not as zero. Saving rebuilds
            the day&apos;s totals, so the Dashboard and Context Pack follow immediately.
          </p>
        </div>
      )}
    </ActionForm>
  );
}
