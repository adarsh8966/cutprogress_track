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
 *
 * COLLAPSED SECTIONS ARE HIDDEN, NOT UNMOUNTED. Seven open groups is a very
 * long page on a phone, so most start closed - but a collapsed section keeps
 * its inputs in the form. Unmounting them would silently drop anything already
 * typed the moment a section was folded away, which is precisely the class of
 * data loss this screen exists to avoid. `hidden` costs nothing and cannot do
 * that.
 */
import { useEffect, useRef, useState } from 'react';
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

/**
 * Which groups start open.
 *
 * Weight and food are what gets logged most nights, so those two are open and
 * the rest are one tap away. Every group stays reachable; none is behind a
 * menu or another page.
 */
const DEFAULT_OPEN: Record<string, boolean> = {
  Body: true,
  Nutrition: true,
  'Activity and vitals': false,
  Sleep: false,
  Workout: false,
  Cardio: false,
};

const STORAGE_KEY = 'cut-os:quick-entry:open';

function Group({
  title,
  destination,
  open,
  onToggle,
  filled,
  children,
}: {
  title: string;
  destination: string;
  open: boolean;
  onToggle: () => void;
  /** True when this group holds a value, so a folded one still says so. */
  filled: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-line bg-surface">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex min-h-12 w-full items-center gap-3 px-4 py-3 text-left sm:px-5"
      >
        <span
          aria-hidden
          className={`text-ink-faint transition-transform ${open ? 'rotate-90' : ''}`}
        >
          ›
        </span>
        <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint">
          {title}
        </span>
        {/* A closed group that holds something must say so, or a value typed
            and then folded away is invisible until it is saved. */}
        {filled && (
          <span className="rounded border border-accent/40 bg-accent/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-accent">
            filled
          </span>
        )}
        <span className="ml-auto text-[11px] text-ink-faint">→ {destination}</span>
      </button>
      <div hidden={!open} className="border-t border-line px-4 py-4 sm:px-5">
        {children}
      </div>
    </section>
  );
}

export function QuickEntryForm({
  today,
  yesterday,
  initialDate,
  lastLoggedDate,
  weightUnit,
  lengthUnit,
  distanceUnit,
}: {
  /** Today in the user's own timezone. What the "Today" shortcut means. */
  today: string;
  yesterday: string;
  /**
   * The date the form opens on. Usually today, but "Add to this day" on the
   * day view arrives here with another one - and the shortcuts must still mean
   * what they say, so this is separate from `today` rather than overwriting it.
   */
  initialDate: string;
  /** The most recent day with anything recorded, when there is one. */
  lastLoggedDate: string | null;
  weightUnit: string;
  lengthUnit: string;
  distanceUnit: string;
}) {
  const [result, setResult] = useState<QuickEntryResult | null>(null);
  const [pending, setPending] = useState(false);
  const [date, setDate] = useState(initialDate);
  const [open, setOpen] = useState<Record<string, boolean>>(DEFAULT_OPEN);
  const [filled, setFilled] = useState<Record<string, boolean>>({});
  const form = useRef<HTMLFormElement>(null);
  const errors = result?.errors ?? {};

  /**
   * Which sections were open last time, on this device only.
   *
   * Read after mount rather than in a lazy initialiser, deliberately: the
   * server has no localStorage, so initialising from it would render one thing
   * on the server and another on the client. Rendering the defaults and then
   * applying the stored state is the hydration-safe order, which is the case
   * this effect is the right tool for.
   *
   * The read is wrapped because a browser can refuse storage outright, and a
   * form that throws on load is a far worse outcome than one that opens with
   * its defaults.
   */
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      return; // Keep the defaults.
    }
    if (!saved) return;
    try {
      const stored = JSON.parse(saved) as Record<string, boolean>;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot mount read, see above
      setOpen({ ...DEFAULT_OPEN, ...stored });
    } catch {
      // A corrupt value is not worth acting on, and not worth an error either.
    }
  }, []);

  function toggle(title: string) {
    setOpen((previous) => {
      const next = { ...previous, [title]: !previous[title] };
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // A remembered section is a convenience, not data. Losing it is fine.
      }
      return next;
    });
  }

  /**
   * Recomputes which groups hold a value, from the form itself rather than
   * from per-field state. One listener over the whole form is enough, and it
   * cannot fall out of step with what will actually be submitted.
   */
  function refreshFilled() {
    const element = form.current;
    if (!element) return;
    const data = new FormData(element);
    const has = (fields: string[]) =>
      fields.some((name) => String(data.get(name) ?? '').trim() !== '');
    setFilled({
      Body: has(['weight', 'waist']),
      Nutrition: has(['calories', 'protein', 'carbs', 'fat', 'fiber', 'fruitVeg']),
      'Activity and vitals': has([
        'steps', 'activeCalories', 'totalCaloriesBurned', 'restingHeartRate', 'hrv',
      ]),
      Sleep: has(['hours', 'minutes', 'score']),
      Workout: has([
        'workoutType', 'workoutDuration', 'workoutCalories',
        'workoutAverageHeartRate', 'workoutMaxHeartRate',
      ]),
      Cardio: has([
        'cardioType', 'cardioDuration', 'cardioDistance', 'cardioAverageHeartRate',
        'cardioMaxHeartRate', 'cardioCalories', 'cardioHrZone',
      ]),
    });
  }

  const shortcuts: { label: string; value: string }[] = [
    { label: 'Today', value: today },
    { label: 'Yesterday', value: yesterday },
    ...(lastLoggedDate && lastLoggedDate !== today && lastLoggedDate !== yesterday
      ? [{ label: 'Last logged', value: lastLoggedDate }]
      : []),
  ];

  return (
    <form
      ref={form}
      onChange={refreshFilled}
      action={(formData) => {
        setResult(null);
        setPending(true);
        void quickEntry(formData).then((outcome) => {
          setResult(outcome);
          setPending(false);
        });
      }}
      className="space-y-3"
    >
      <section className="rounded-lg border border-line bg-surface px-4 py-4 sm:px-5">
        <div className="max-w-xs">
          <TextField
            name="date" label="Date" type="date" required
            value={date} onChange={setDate} error={errors.date}
          />
        </div>
        {/* Shortcuts only where they earn their place: this is the one form
            where the date is routinely not today. */}
        <div className="mt-3 flex flex-wrap gap-2">
          {shortcuts.map((shortcut) => (
            <button
              key={shortcut.label}
              type="button"
              onClick={() => setDate(shortcut.value)}
              aria-pressed={date === shortcut.value}
              className={`inline-flex min-h-9 items-center rounded border px-3 text-xs transition-colors ${
                date === shortcut.value
                  ? 'border-accent text-accent'
                  : 'border-line text-ink-muted hover:border-accent'
              }`}
            >
              {shortcut.label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-ink-faint">
          Everything below is recorded against this date.
        </p>
      </section>

      <Group
        title="Body" destination="Dashboard, Progress"
        open={open.Body ?? true} onToggle={() => toggle('Body')} filled={filled.Body ?? false}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField name="weight" label="Weight" unit={weightUnit} step="0.1" />
          <NumberField name="waist" label="Waist" unit={lengthUnit} step="0.1" />
        </div>
      </Group>

      <Group
        title="Nutrition" destination="Nutrition"
        open={open.Nutrition ?? true} onToggle={() => toggle('Nutrition')}
        filled={filled.Nutrition ?? false}
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <NumberField name="calories" label="Calories" unit="kcal" step="1" />
          <NumberField name="protein" label="Protein" unit="g" step="1" />
          <NumberField name="carbs" label="Carbohydrate" unit="g" step="1" />
          <NumberField name="fat" label="Fat" unit="g" step="1" />
          <NumberField name="fiber" label="Fibre" unit="g" step="1" />
          <NumberField name="fruitVeg" label="Fruit + veg" unit="servings" step="1" />
        </div>
      </Group>

      <Group
        title="Activity and vitals" destination="Recovery, Dashboard"
        open={open['Activity and vitals'] ?? false}
        onToggle={() => toggle('Activity and vitals')}
        filled={filled['Activity and vitals'] ?? false}
      >
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

      <Group
        title="Sleep" destination="Recovery"
        open={open.Sleep ?? false} onToggle={() => toggle('Sleep')}
        filled={filled.Sleep ?? false}
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <NumberField name="hours" label="Hours" step="1" />
          <NumberField name="minutes" label="Minutes" step="1" />
          <NumberField name="score" label="Sleep score" unit="/100" step="1" />
        </div>
      </Group>

      <Group
        title="Workout" destination="Training → Session history"
        open={open.Workout ?? false} onToggle={() => toggle('Workout')}
        filled={filled.Workout ?? false}
      >
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

      <Group
        title="Cardio" destination="Recovery → Cardio"
        open={open.Cardio ?? false} onToggle={() => toggle('Cardio')}
        filled={filled.Cardio ?? false}
      >
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
            className="inline-flex min-h-11 items-center rounded border border-line-strong px-5 text-sm transition-colors hover:border-accent disabled:opacity-40"
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
            {result.ok && (
              <a href={`/day/${date}`} className="inline-block pt-1 text-accent hover:underline">
                See everything recorded for {date} →
              </a>
            )}
          </div>
        )}
      </div>
    </form>
  );
}
