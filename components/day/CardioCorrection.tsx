'use client';

/**
 * Correcting a cardio session, in place on the day view.
 *
 * WHY CARDIO NEEDS ITS OWN FORM AND WEIGHT DOES NOT. daily_metrics RESOLVES a
 * weight - newest observation wins - so correcting one is just recording the
 * right value again. It SUMS cardio, so recording a 30-minute walk again as 35
 * minutes gives the day 65. A cardio correction has to write the new session
 * and mark the old one superseded, together, which is what
 * correctCardioSession does.
 *
 * The session's current values seed the form, so a correction is an edit of
 * what is there rather than a re-entry from memory. Clearing a field records
 * it as not logged, exactly as it does everywhere else - never as a zero.
 */
import { useState } from 'react';
import { correctCardioSession } from '@/app/actions/corrections';
import { ActionForm, NumberField, SelectField, TextField } from '@/components/ui/Form';
import { displayDistance, type DisplayUnits, DISTANCE_UNIT_LABEL } from '@/lib/normalization/units';
import type { DayRecord } from '@/lib/data/dayRecords';

const CARDIO_TYPES = [
  { value: 'INCLINE_WALKING', label: 'Incline walking' },
  { value: 'WALKING', label: 'Walking' },
  { value: 'RUNNING', label: 'Running' },
  { value: 'CYCLING', label: 'Cycling' },
  { value: 'OTHER', label: 'Other' },
];

/** The stored enum for this row, recovered from the title the mapper built. */
function typeOf(record: DayRecord): string {
  const name = record.title.replace(/^Cardio · /, '').toUpperCase().replaceAll(' ', '_');
  return CARDIO_TYPES.some((option) => option.value === name) ? name : 'OTHER';
}

function field(record: DayRecord, label: string): number | null {
  return record.fields.find((f) => f.label === label)?.value ?? null;
}

function box(value: number | null, decimals = 0): string | undefined {
  if (value === null) return undefined;
  const factor = 10 ** decimals;
  return String(Math.round(value * factor) / factor);
}

export function CardioCorrection({
  record,
  date,
  units,
}: {
  record: DayRecord;
  date: string;
  units: DisplayUnits;
}) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex min-h-9 items-center rounded border border-line px-3 text-xs transition-colors hover:border-accent"
      >
        Correct
      </button>
    );
  }

  const distanceKm = field(record, 'Distance');

  return (
    <div className="mt-3 w-full rounded border border-line bg-ground/50 p-3">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <span className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">
          Correct this session
        </span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-[11px] text-ink-faint hover:text-ink-muted"
        >
          Cancel
        </button>
      </div>

      <ActionForm
        action={async (formData) => {
          formData.set('supersedes', record.id);
          return correctCardioSession(formData);
        }}
        submitLabel="Save correction"
      >
        {(errors) => (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <TextField
                name="date" label="Date" type="date" required
                defaultValue={date} error={errors.date}
              />
              <SelectField
                name="type" label="Type" options={CARDIO_TYPES}
                defaultValue={typeOf(record)} error={errors.type}
              />
              <NumberField
                name="duration" label="Duration" unit="min" step="1" required
                defaultValue={box(field(record, 'Duration'))} error={errors.duration}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <NumberField
                name="distance" label="Distance"
                unit={DISTANCE_UNIT_LABEL[units.distance]} step="0.01"
                defaultValue={
                  distanceKm === null
                    ? undefined
                    : String(Math.round(displayDistance(distanceKm, units.distance) * 100) / 100)
                }
                error={errors.distance}
              />
              <NumberField
                name="hrZone" label="Heart-rate zone" step="1"
                defaultValue={box(field(record, 'Heart-rate zone'))}
                hint="1-5; zone 2 drives the zone-2 totals" error={errors.hrZone}
              />
              <NumberField
                name="calories" label="Calories burned" unit="kcal" step="1"
                defaultValue={box(field(record, 'Calories burned'))} error={errors.calories}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <NumberField
                name="averageHeartRate" label="Average HR" unit="bpm" step="1"
                defaultValue={box(field(record, 'Average HR'))}
                error={errors.averageHeartRate}
              />
              <NumberField
                name="maxHeartRate" label="Maximum HR" unit="bpm" step="1"
                defaultValue={box(field(record, 'Maximum HR'))} error={errors.maxHeartRate}
              />
            </div>
            <p className="text-[11px] leading-relaxed text-ink-faint">
              This writes a corrected session and keeps the original on record, no longer
              counting towards the day. Nothing is deleted, and the day totals the
              correction rather than both readings.
            </p>
          </div>
        )}
      </ActionForm>
    </div>
  );
}
