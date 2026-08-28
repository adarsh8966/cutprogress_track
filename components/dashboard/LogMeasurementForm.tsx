'use client';

import { logBodyMeasurement } from '@/app/actions/log';
import { ActionForm, NumberField, TextField } from '@/components/ui/Form';

export function LogMeasurementForm({ today }: { today: string }) {
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
            unit="lb"
            step="0.1"
            error={errors.weight}
          />
          <NumberField
            name="waist"
            label="Waist"
            unit="in"
            step="0.1"
            error={errors.waist}
          />
        </div>
      )}
    </ActionForm>
  );
}
