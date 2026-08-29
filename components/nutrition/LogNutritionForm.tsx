'use client';

import { logNutrition } from '@/app/actions/log';
import { ActionForm, NumberField, TextField } from '@/components/ui/Form';

export function LogNutritionForm({ today }: { today: string }) {
  return (
    <ActionForm action={logNutrition} submitLabel="Record nutrition">
      {(errors) => (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <TextField
              name="date" label="Date" type="date" required
              defaultValue={today} error={errors.date}
            />
            <NumberField name="calories" label="Calories" unit="kcal" error={errors.calories} />
            <NumberField name="protein" label="Protein" unit="g" error={errors.protein} />
          </div>
          <div className="grid gap-4 sm:grid-cols-4">
            <NumberField name="carbs" label="Carbohydrate" unit="g" error={errors.carbs} />
            <NumberField name="fat" label="Fat" unit="g" error={errors.fat} />
            <NumberField name="fiber" label="Fibre" unit="g" error={errors.fiber} />
            <NumberField
              name="fruitVeg" label="Fruit + veg" unit="servings" error={errors.fruitVeg}
            />
          </div>
          <p className="text-[11px] text-ink-faint">
            Leave anything you did not track blank. A blank field is stored as not
            logged, which is not the same as zero.
          </p>
        </>
      )}
    </ActionForm>
  );
}
