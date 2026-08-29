'use client';

/**
 * logBodyMeasurement converts what it receives using the PROFILE's display
 * units, so the labels here have to name those same units. Hard-coded "lb" and
 * "in" meant a user reading "Weight (lb)" with Kilograms configured had their
 * pounds stored as kilograms.
 */
import { logBodyMeasurement } from '@/app/actions/log';
import { ActionForm, NumberField, TextField } from '@/components/ui/Form';

export function LogMeasurementForm({
  today, weightUnit, lengthUnit,
}: {
  today: string;
  weightUnit: string;
  lengthUnit: string;
}) {
  return (
    <ActionForm action={logBodyMeasurement} submitLabel="Record measurement">
      {(errors) => (
        <div className="grid gap-4 sm:grid-cols-3">
          <TextField
            name="date"
            label="Date"
            type="date"
            required
            defaultValue={today}
            error={errors.date}
          />
          <NumberField
            name="weight"
            label="Weight"
            unit={weightUnit}
            step="0.1"
            error={errors.weight}
          />
          <NumberField
            name="waist"
            label="Waist"
            unit={lengthUnit}
            step="0.1"
            error={errors.waist}
          />
        </div>
      )}
    </ActionForm>
  );
}
