'use client';

/**
 * Session and set logging (spec §11).
 *
 * Loads are entered in the user's display unit and converted at submit, exactly
 * once, matching every other input boundary in the app.
 */
import { useState, useTransition } from 'react';
import { startWorkout, logSet } from '@/app/actions/log';
import { ActionForm, NumberField, SelectField, TextField, Field } from '@/components/ui/Form';
import type { Exercise } from '@/lib/health/catalog';

const SESSION_TYPES = [
  'UPPER', 'LOWER', 'PUSH', 'PULL', 'LEGS', 'FULL_BODY', 'CARDIO', 'OTHER',
].map((value) => ({ value, label: value.replaceAll('_', ' ').toLowerCase() }));

/**
 * `existingSessionId` attaches sets to a session that already exists instead of
 * starting a new one. That is what lets an imported summary - a session row
 * with no exercises - be filled in later, rather than forcing a second session
 * row for the same workout. Manual and imported sessions are the same record
 * either way; only how they started differs.
 */
export function WorkoutLogger({
  today,
  exercises,
  weightUnit,
  existingSessionId,
  initialSetNumber = 1,
}: {
  today: string;
  exercises: Exercise[];
  /** logSet converts the load with the profile's unit; the label must match. */
  weightUnit: string;
  existingSessionId?: string;
  initialSetNumber?: number;
}) {
  const [sessionId, setSessionId] = useState<string | null>(existingSessionId ?? null);
  const [setNumber, setSetNumber] = useState(initialSetNumber);
  const [logged, setLogged] = useState<
    { exercise: string; weight: string; reps: string }[]
  >([]);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (sessionId === null) {
    return (
      <ActionForm
        action={async (formData) => {
          const result = await startWorkout(formData);
          if (result.ok && result.sessionId) setSessionId(result.sessionId);
          return result;
        }}
        submitLabel="Start session"
      >
        {(errors) => (
          <div className="grid gap-4 sm:grid-cols-3">
            <TextField
              name="date" label="Date" type="date" required
              defaultValue={today} error={errors.date}
            />
            <SelectField
              name="sessionType" label="Session" options={SESSION_TYPES}
              defaultValue="UPPER" error={errors.sessionType}
            />
            <NumberField
              name="duration" label="Duration" unit="min" error={errors.duration}
            />
          </div>
        )}
      </ActionForm>
    );
  }

  return (
    <div className="space-y-5">
      <form
        action={(formData) => {
          setMessage(null);
          formData.set('sessionId', sessionId);
          formData.set('setNumber', String(setNumber));
          startTransition(async () => {
            const result = await logSet(formData);
            setMessage(result.message);
            if (result.ok) {
              setLogged((previous) => [
                {
                  exercise:
                    exercises.find((e) => e.exerciseId === formData.get('exerciseId'))
                      ?.name ?? String(formData.get('exerciseId')),
                  weight: String(formData.get('weight') ?? ''),
                  reps: String(formData.get('reps') ?? ''),
                },
                ...previous,
              ]);
              setSetNumber((n) => n + 1);
            }
          });
        }}
        className="space-y-4"
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Exercise">
            <select
              name="exerciseId"
              required
              className="w-full min-h-11 rounded border border-line bg-ground px-3 py-2 text-base outline-none focus:border-accent sm:text-sm"
            >
              {exercises.map((exercise) => (
                <option key={exercise.exerciseId} value={exercise.exerciseId}>
                  {exercise.name} · {exercise.primaryMuscleGroup}
                </option>
              ))}
            </select>
          </Field>
          <NumberField
            name="weight" label={`Load (set ${setNumber})`} unit={weightUnit} step="0.5"
          />
          <NumberField name="reps" label="Reps" step="1" />
          <NumberField name="rir" label="RIR" step="0.5" hint="Reps in reserve" />
        </div>

        <label className="flex items-center gap-2 text-xs text-ink-muted">
          <input type="checkbox" name="warmup" className="accent-accent" />
          Warm-up set (excluded from volume and bests)
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="min-h-11 rounded border border-line-strong px-5 text-sm transition-colors hover:border-accent disabled:opacity-40"
          >
            {pending ? 'Logging…' : 'Log set'}
          </button>
          {existingSessionId === undefined && (
            <button
              type="button"
              onClick={() => {
                setSessionId(null);
                setSetNumber(1);
                setLogged([]);
              }}
              className="inline-flex min-h-11 items-center text-xs text-ink-faint hover:text-ink-muted"
            >
              End session
            </button>
          )}
          {message && <span className="text-xs text-ink-muted">{message}</span>}
        </div>
      </form>

      {logged.length > 0 && (
        <div className="border-t border-line pt-4">
          <div className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">
            This session
          </div>
          <ul className="mt-2 space-y-1 text-sm">
            {logged.map((entry, i) => (
              <li key={i} className="flex justify-between gap-3">
                <span className="text-ink-muted">{entry.exercise}</span>
                <span className="tabular">
                  {entry.weight || '—'} {weightUnit} × {entry.reps || '—'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
