'use client';

import { logSleep, logCardio, logDailyMetrics } from '@/app/actions/log';
import { ActionForm, NumberField, SelectField, TextField } from '@/components/ui/Form';

const CARDIO_TYPES = [
  { value: 'INCLINE_WALKING', label: 'Incline walking' },
  { value: 'WALKING', label: 'Walking' },
  { value: 'RUNNING', label: 'Running' },
  { value: 'CYCLING', label: 'Cycling' },
  { value: 'OTHER', label: 'Other' },
];

export function LogSleepForm({ today }: { today: string }) {
  return (
    <ActionForm action={logSleep} submitLabel="Record sleep">
      {(errors) => (
        <div className="grid gap-4 sm:grid-cols-4">
          <TextField
            name="date" label="Date" type="date" required
            defaultValue={today} error={errors.date}
          />
          <NumberField name="hours" label="Hours" step="1" required error={errors.hours} />
          <NumberField name="minutes" label="Minutes" step="1" error={errors.minutes} />
          <NumberField name="score" label="Sleep score" step="1" error={errors.score} />
        </div>
      )}
    </ActionForm>
  );
}

/**
 * logCardio converts the distance with the profile's unit, so the label has to
 * be that unit. "mi" was hard-coded while the action read the setting.
 */
export function LogCardioForm({
  today, distanceUnit,
}: {
  today: string;
  distanceUnit: string;
}) {
  return (
    <ActionForm action={logCardio} submitLabel="Record cardio">
      {(errors) => (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <TextField
              name="date" label="Date" type="date" required
              defaultValue={today} error={errors.date}
            />
            <SelectField
              name="type" label="Type" options={CARDIO_TYPES}
              defaultValue="INCLINE_WALKING" error={errors.type}
            />
            <NumberField
              name="duration" label="Duration" unit="min" required error={errors.duration}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <NumberField
              name="distance" label="Distance" unit={distanceUnit} step="0.01"
              error={errors.distance}
            />
            <NumberField
              name="hrZone" label="Heart-rate zone" step="1"
              hint="1-5; zone 2 drives the zone-2 totals" error={errors.hrZone}
            />
            <NumberField
              name="averageHeartRate" label="Average HR" unit="bpm"
              error={errors.averageHeartRate}
            />
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function LogMetricsForm({ today }: { today: string }) {
  return (
    <ActionForm action={logDailyMetrics} submitLabel="Record metrics">
      {(errors) => (
        <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <TextField
            name="date" label="Date" type="date" required
            defaultValue={today} error={errors.date}
          />
          <NumberField name="steps" label="Steps" step="1" error={errors.steps} />
          <NumberField
            name="activeCalories" label="Active calories" unit="kcal"
            error={errors.activeCalories}
          />
          {/* logDailyMetrics has accepted this since TOTAL_CALORIES_BURNED got
              its writer, but only Quick Entry offered the field, so the same
              measurement could be recorded in one place and not the other. */}
          <NumberField
            name="totalCaloriesBurned" label="Total calories burned" unit="kcal"
            step="1" error={errors.totalCaloriesBurned}
          />
          <NumberField
            name="restingHeartRate" label="Resting HR" unit="bpm"
            error={errors.restingHeartRate}
          />
          <NumberField name="hrv" label="HRV" unit="ms" error={errors.hrv} />
        </div>
      )}
    </ActionForm>
  );
}
