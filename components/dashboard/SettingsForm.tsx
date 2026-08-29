'use client';

/**
 * Settings form (spec §4, §39, §45).
 *
 * The safety review runs server-side before anything is written. A BLOCK
 * finding refuses the save; a WARNING requires the acknowledgement checkbox
 * that only appears once a warning has actually been raised, so it cannot be
 * pre-ticked out of habit.
 *
 * THE DISPLAY UNITS ARE LIVE, AND THAT IS A CORRECTNESS REQUIREMENT.
 *
 * saveSettings converts the weights it receives using the unit SELECTED ON
 * THIS FORM. The form used to render them through kgToLb() and label them "lb"
 * regardless, so with Kilograms chosen every save read 203.7 pounds as 203.7
 * kilograms and stored it - multiplying the user's starting and target weight
 * by 2.2, silently, on every save.
 *
 * Height was worse. saveSettings reads a `heightCm` field when the length unit
 * is CM, and this form only ever rendered feet and inches - so choosing
 * Centimetres and saving set height to null and took the BMR and TDEE priors
 * with it.
 *
 * Both are fixed the same way: the unit selects drive React state, the fields
 * are controlled, and changing a unit converts what is already typed. The
 * number on screen, its label, and the unit the action converts with are
 * always the same three things.
 */
import { useState, useTransition } from 'react';
import { saveSettings, type SettingsResult } from '@/app/actions/settings';
import { NumberField, SelectField, TextField } from '@/components/ui/Form';
import type { UserProfile } from '@/lib/types';
import {
  cmToFeetInches, feetInchesToCm,
  displayWeight, restateWeight,
  WEIGHT_UNIT_LABEL, LENGTH_UNIT_LABEL,
  type WeightUnit, type LengthUnit, type DistanceUnit,
} from '@/lib/normalization/units';

const TIMEZONES = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Phoenix', 'America/Anchorage', 'Pacific/Honolulu',
  'Europe/London', 'Europe/Dublin', 'Europe/Paris', 'Europe/Berlin',
  'Europe/Madrid', 'Europe/Rome', 'Europe/Stockholm',
  'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Asia/Shanghai',
  'Australia/Sydney', 'Australia/Perth', 'Pacific/Auckland', 'UTC',
].map((value) => ({ value, label: value.replace('_', ' ') }));

/** A number for an input: blank stays blank, never becomes a 0. */
function box(value: number | null, decimals = 1): string {
  if (value === null) return '';
  const factor = 10 ** decimals;
  return String(Math.round(value * factor) / factor);
}

function reading(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

export function SettingsForm({ profile }: { profile: UserProfile }) {
  const [result, setResult] = useState<SettingsResult | null>(null);
  const [pending, startTransition] = useTransition();

  const [weightUnit, setWeightUnit] = useState<WeightUnit>(profile.weightDisplayUnit);
  const [lengthUnit, setLengthUnit] = useState<LengthUnit>(profile.lengthDisplayUnit);
  const [distanceUnit, setDistanceUnit] =
    useState<DistanceUnit>(profile.distanceDisplayUnit);

  const initialHeight =
    profile.heightCm === null ? null : cmToFeetInches(profile.heightCm);
  const [heightFeet, setHeightFeet] = useState(box(initialHeight?.feet ?? null, 0));
  const [heightInches, setHeightInches] = useState(box(initialHeight?.inches ?? null, 1));
  const [heightCm, setHeightCm] = useState(box(profile.heightCm, 1));

  const [startingWeight, setStartingWeight] = useState(
    box(profile.startingWeightKg === null
      ? null
      : displayWeight(profile.startingWeightKg, profile.weightDisplayUnit)),
  );
  const [targetWeight, setTargetWeight] = useState(
    box(profile.targetWeightKg === null
      ? null
      : displayWeight(profile.targetWeightKg, profile.weightDisplayUnit)),
  );

  /**
   * Switching the unit must not change the weight, only how it is written.
   * Converting through canonical kg means what the user typed keeps meaning
   * the same thing, and what the action stores is what they meant.
   */
  function changeWeightUnit(next: WeightUnit) {
    if (next === weightUnit) return;
    setStartingWeight(restateWeight(startingWeight, weightUnit, next));
    setTargetWeight(restateWeight(targetWeight, weightUnit, next));
    setWeightUnit(next);
  }

  /** The same for height, which is written two different ways rather than one. */
  function changeLengthUnit(next: LengthUnit) {
    if (next === lengthUnit) return;
    if (next === 'CM') {
      const feet = reading(heightFeet);
      const inches = reading(heightInches);
      setHeightCm(
        feet === null && inches === null
          ? ''
          : box(feetInchesToCm(feet ?? 0, inches ?? 0)),
      );
    } else {
      const cm = reading(heightCm);
      if (cm === null) {
        setHeightFeet('');
        setHeightInches('');
      } else {
        const split = cmToFeetInches(cm);
        setHeightFeet(box(split.feet, 0));
        setHeightInches(box(split.inches, 1));
      }
    }
    setLengthUnit(next);
  }

  const errors = result?.errors ?? {};
  const findings = result?.findings ?? [];
  const blocking = findings.filter((f) => f.severity === 'BLOCK');
  const warnings = findings.filter((f) => f.severity === 'WARNING');

  return (
    <form
      action={(formData) => {
        setResult(null);
        startTransition(async () => setResult(await saveSettings(formData)));
      }}
      className="space-y-8"
    >
      <fieldset className="space-y-4">
        <legend className="mb-3 text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint">
          You
        </legend>
        <div className="grid gap-4 sm:grid-cols-4">
          {/* Only the fields for the SELECTED unit are rendered, so only they
              are submitted - and saveSettings reads exactly the pair it
              converts with. Rendering both would put two heights in the form
              and let the wrong one win. */}
          {lengthUnit === 'IN' ? (
            <>
              <NumberField
                name="heightFeet" label="Height" unit="ft" step="1"
                value={heightFeet} onChange={setHeightFeet} error={errors.heightFeet}
              />
              <NumberField
                name="heightInches" label="&nbsp;" unit="in" step="0.5"
                value={heightInches} onChange={setHeightInches}
                error={errors.heightInches}
              />
            </>
          ) : (
            <NumberField
              name="heightCm" label="Height" unit="cm" step="0.5"
              value={heightCm} onChange={setHeightCm} error={errors.heightCm}
            />
          )}
          <SelectField
            name="sex" label="Sex"
            options={[
              { value: 'MALE', label: 'Male' },
              { value: 'FEMALE', label: 'Female' },
              { value: 'UNSPECIFIED', label: 'Prefer not to say' },
            ]}
            defaultValue={profile.sex ?? 'UNSPECIFIED'}
            hint="Used only by the BMR formula"
          />
          <TextField
            name="dateOfBirth" label="Date of birth" type="date"
            defaultValue={profile.dateOfBirth ?? undefined}
            hint="Optional; improves the TDEE prior"
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            name="timezone" label="Timezone" options={TIMEZONES}
            defaultValue={profile.timezone} error={errors.timezone}
            hint="Every daily rollup uses this, not UTC"
          />
          <SelectField
            name="phase" label="Phase"
            options={[
              { value: 'CUT', label: 'Cut' },
              { value: 'MAINTENANCE', label: 'Maintenance' },
              { value: 'REVERSE_DIET', label: 'Reverse diet' },
              { value: 'LEAN_GAIN', label: 'Lean gain' },
            ]}
            defaultValue={profile.phase}
          />
        </div>
      </fieldset>

      <fieldset className="space-y-4 border-t border-line pt-6">
        <legend className="mb-3 text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint">
          Targets
        </legend>
        <div className="grid gap-4 sm:grid-cols-3">
          <NumberField
            name="startingWeight" label="Starting weight"
            unit={WEIGHT_UNIT_LABEL[weightUnit]} step="0.1"
            value={startingWeight} onChange={setStartingWeight}
            error={errors.startingWeight}
          />
          <NumberField
            name="targetWeight" label="Target weight"
            unit={WEIGHT_UNIT_LABEL[weightUnit]} step="0.1"
            value={targetWeight} onChange={setTargetWeight}
            error={errors.targetWeight}
          />
          <TextField
            name="cutStartDate" label="Cut start date" type="date"
            defaultValue={profile.cutStartDate ?? undefined}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <NumberField
            name="targetCalories" label="Daily calories" unit="kcal" step="10"
            defaultValue={profile.targets.calories ?? undefined}
            error={errors.targetCalories}
          />
          <NumberField
            name="targetProtein" label="Daily protein" unit="g" step="5"
            defaultValue={profile.targets.proteinG ?? undefined}
          />
          <NumberField
            name="targetFiber" label="Daily fibre" unit="g" step="1"
            defaultValue={profile.targets.fiberG ?? undefined}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <NumberField
            name="targetSteps" label="Daily steps" step="100"
            defaultValue={profile.targets.steps ?? undefined}
          />
          <NumberField
            name="targetSessions" label="Training sessions" unit="per week" step="1"
            defaultValue={profile.targets.trainingSessionsPerWeek ?? undefined}
          />
          <NumberField
            name="targetCardioMinutes" label="Cardio" unit="min per week" step="10"
            defaultValue={profile.targets.cardioMinutesPerWeek ?? undefined}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <NumberField
            name="maxWeeklyLossRatePct" label="Max loss rate" unit="% bodyweight/week"
            step="0.1" defaultValue={profile.maxWeeklyLossRatePct}
            hint="Above this, the dashboard flags the rate"
            error={errors.maxWeeklyLossRatePct}
          />
        </div>
      </fieldset>

      <fieldset className="space-y-4 border-t border-line pt-6">
        <legend className="mb-3 text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint">
          Display units
        </legend>
        <p className="mb-3 text-[11px] leading-relaxed text-ink-faint">
          Storage is always metric. This only changes what you read and type —
          changing one converts the values above rather than reinterpreting them,
          so no measurement changes because you changed a unit.
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          <SelectField
            name="weightDisplayUnit" label="Weight"
            options={[{ value: 'LB', label: 'Pounds' }, { value: 'KG', label: 'Kilograms' }]}
            value={weightUnit}
            onChange={(value) => changeWeightUnit(value as WeightUnit)}
          />
          <SelectField
            name="distanceDisplayUnit" label="Distance"
            options={[{ value: 'MI', label: 'Miles' }, { value: 'KM', label: 'Kilometres' }]}
            value={distanceUnit}
            onChange={(value) => setDistanceUnit(value as DistanceUnit)}
          />
          <SelectField
            name="lengthDisplayUnit" label={`Body measurements (${LENGTH_UNIT_LABEL[lengthUnit]})`}
            options={[{ value: 'IN', label: 'Inches' }, { value: 'CM', label: 'Centimetres' }]}
            value={lengthUnit}
            onChange={(value) => changeLengthUnit(value as LengthUnit)}
          />
        </div>
      </fieldset>

      {blocking.length > 0 && (
        <div className="rounded border border-bad/50 bg-bad/5 p-4">
          <p className="mb-2 text-sm font-medium text-bad">Not saved</p>
          <ul className="space-y-2 text-xs leading-relaxed text-ink-muted">
            {blocking.map((finding) => (
              <li key={finding.code}>{finding.message}</li>
            ))}
          </ul>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="rounded border border-warn/50 bg-warn/5 p-4">
          <p className="mb-2 text-sm font-medium text-warn">Worth a second look</p>
          <ul className="mb-4 space-y-2 text-xs leading-relaxed text-ink-muted">
            {warnings.map((finding) => (
              <li key={finding.code}>{finding.message}</li>
            ))}
          </ul>
          {result?.needsAcknowledgement && (
            <label className="flex items-start gap-2 text-xs text-ink-muted">
              <input
                type="checkbox"
                name="acknowledgeWarnings"
                className="mt-0.5 accent-accent"
              />
              I have read the warnings above and want to save these targets anyway.
            </label>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-6">
        <button
          type="submit"
          disabled={pending}
          className="rounded border border-line-strong px-4 py-2 text-sm transition-colors hover:border-accent disabled:opacity-40"
        >
          {pending ? 'Saving…' : 'Save settings'}
        </button>
        {result && (
          <span
            role="status"
            className={`text-xs ${result.ok ? 'text-good' : 'text-warn'}`}
          >
            {result.message}
          </span>
        )}
      </div>
    </form>
  );
}
