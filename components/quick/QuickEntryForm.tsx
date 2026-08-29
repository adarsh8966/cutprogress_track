'use client';

/**
 * The Quick Entry form.
 *
 * Every field names where its value lands, on the field itself, because the
 * whole point of this screen is that nothing entered here can disappear. After
 * a save it lists the destinations that were actually written - not "Saved!",
 * but which page to look at for each group.
 *
 * A blank field is "not logged" and is skipped, never written as a zero.
 */
import { useState, useTransition } from 'react';
import { quickEntry, type QuickEntryResult } from '@/app/actions/quick';
import { NumberField, SelectField, TextField } from '@/components/ui/Form';

const SESSION_TYPES = [
  { value: '', label: 'no workout' },
  ...['UPPER', 'LOWER', 'PUSH', 'PULL', 'LEGS', 'FULL_BODY', 'CARDIO', 'OTHER'].map((value) => ({
    value,
    label: value.replaceAll('_', ' ').toLowerCase(),
  })),
];

const CARDIO_TYPES = [
  { value: '', label: 'no cardio' },
  ...['WALKING', 'INCLINE_WALKING', 'RUNNING', 'CYCLING', 'OTHER'].map((value) => ({
    value,
    label: value.replaceAll('_', ' ').toLowerCase(),
  })),
];

function Group({
  title,
  destination,
  children,
}: {
  title: string;
  destination: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-line bg-surface p-4 sm:p-5">
      <header className="mb-3">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint">
          {title}
        </h2>
        <p className="mt-0.5 text-[11px] text-ink-faint">Saved → {destination}</p>
      </header>
      {children}
    </section>
  );
}

export function QuickEntryForm({
  today,
  weightUnit,
  lengthUnit,
  distanceUnit,
}: {
  today: string;
  weightUnit: string;
  lengthUnit: string;
  distanceUnit: string;
}) {
  const [result, setResult] = useState<QuickEntryResult | null>(null);
  const [pending, startTransition] = useTransition();
  const errors = result?.errors ?? {};

  return (
    <form
      action={(formData) => {
        setResult(null);
        startTransition(async () => setResult(await quickEntry(formData)));
      }}
      className="space-y-4"
    >
      <Group title="Date" destination="every record below">
        <div className="max-w-xs">
          <TextField
            name="date" label="Date" type="date" required
            defaultValue={today} error={errors.date}
          />
        </div>
      </Group>

      <Group title="Body" destination="Dashboard, Progress">
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField name="weight" label="Weight" unit={weightUnit} step="0.1" />
          <NumberField name="waist" label="Waist" unit={lengthUnit} step="0.1" />
        </div>
      </Group>

      <Group title="Nutrition" destination="Nutrition">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <NumberField name="calories" label="Calories" unit="kcal" step="1" />
          <NumberField name="protein" label="Protein" unit="g" step="1" />
          <NumberField name="carbs" label="Carbohydrate" unit="g" step="1" />
          <NumberField name="fat" label="Fat" unit="g" step="1" />
          <NumberField name="fiber" label="Fibre" unit="g" step="1" />
          <NumberField name="fruitVeg" label="Fruit + veg" unit="servings" step="1" />
        </div>
      </Group>

      <Group title="Activity and vitals" destination="Recovery, Dashboard">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <NumberField name="steps" label="Steps" step="1" />
          <NumberField name="activeCalories" label="Active calories" unit="kcal" step="1" />
          <NumberField
            name="totalCaloriesBurned" label="Total calories burned" unit="kcal" step="1"
            hint="Whole-day expenditure from a wearable"
          />
          <NumberField name="restingHeartRate" label="Resting HR" unit="bpm" step="1" />
          <NumberField name="hrv" label="HRV" unit="ms" step="1" />
        </div>
      </Group>

      <Group title="Sleep" destination="Recovery">
        <div className="grid gap-4 sm:grid-cols-3">
          <NumberField name="hours" label="Hours" step="1" />
          <NumberField name="minutes" label="Minutes" step="1" />
          <NumberField name="score" label="Sleep score" unit="/100" step="1" />
        </div>
      </Group>

      <Group title="Workout" destination="Training → Session history">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <SelectField
            name="workoutType" label="Workout" options={SESSION_TYPES} defaultValue=""
          />
          <NumberField name="workoutDuration" label="Duration" unit="min" step="1" />
          <NumberField name="workoutCalories" label="Calories burned" unit="kcal" step="1" />
          <NumberField name="workoutAverageHeartRate" label="Average HR" unit="bpm" step="1" />
          <NumberField
            name="workoutMaxHeartRate" label="Maximum HR" unit="bpm" step="1"
            error={errors.maxHeartRate}
          />
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
          This records the session, not the exercises in it. Add exercises and sets
          from the session itself on Training — nothing is assumed about what was
          performed.
        </p>
      </Group>

      <Group title="Cardio" destination="Recovery → Cardio">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <SelectField
            name="cardioType" label="Cardio" options={CARDIO_TYPES} defaultValue=""
          />
          <NumberField name="cardioDuration" label="Duration" unit="min" step="1" />
          <NumberField name="cardioDistance" label="Distance" unit={distanceUnit} step="0.01" />
          <NumberField name="cardioAverageHeartRate" label="Average HR" unit="bpm" step="1" />
          <NumberField name="cardioMaxHeartRate" label="Maximum HR" unit="bpm" step="1" />
          <NumberField name="cardioCalories" label="Calories burned" unit="kcal" step="1" />
          <NumberField
            name="cardioHrZone" label="Heart-rate zone" step="1"
            hint="1-5; zone 2 drives the zone-2 totals"
          />
        </div>
      </Group>

      <div className="sticky bottom-0 -mx-4 border-t border-line bg-ground/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-lg sm:border sm:px-5">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="min-h-11 rounded border border-line-strong px-5 text-sm transition-colors hover:border-accent disabled:opacity-40"
          >
            {pending ? 'Saving…' : 'Save entry'}
          </button>
          {result && (
            <span className={`text-sm ${result.ok ? 'text-good' : 'text-warn'}`}>
              {result.message}
            </span>
          )}
        </div>

        {result && (result.saved.length > 0 || result.failed.length > 0) && (
          <div className="mt-3 space-y-1 text-xs">
            {result.saved.map((line) => (
              <div key={line} className="text-ink-muted">✓ {line}</div>
            ))}
            {result.failed.map((failure) => (
              <div key={failure.group} className="text-bad">
                ✕ {failure.group}: {failure.message}
              </div>
            ))}
          </div>
        )}
      </div>
    </form>
  );
}
