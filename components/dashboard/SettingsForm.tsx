'use client';

/**
 * Settings form (spec §4, §45).
 *
 * The safety review runs server-side before anything is written. A BLOCK
 * finding refuses the save; a WARNING requires the acknowledgement checkbox
 * that only appears once a warning has actually been raised, so it cannot be
 * pre-ticked out of habit.
 */
import { useState, useTransition } from 'react';
import { saveSettings, type SettingsResult } from '@/app/actions/settings';
import { NumberField, SelectField, TextField } from '@/components/ui/Form';
import type { UserProfile } from '@/lib/types';
import { cmToFeetInches, kgToLb } from '@/lib/normalization/units';

const TIMEZONES = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Phoenix', 'America/Anchorage', 'Pacific/Honolulu',
  'Europe/London', 'Europe/Dublin', 'Europe/Paris', 'Europe/Berlin',
  'Europe/Madrid', 'Europe/Rome', 'Europe/Stockholm',
  'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Asia/Shanghai',
  'Australia/Sydney', 'Australia/Perth', 'Pacific/Auckland', 'UTC',
].map((value) => ({ value, label: value.replace('_', ' ') }));

export function SettingsForm({ profile }: { profile: UserProfile }) {
  const [result, setResult] = useState<SettingsResult | null>(null);
  const [pending, startTransition] = useTransition();

  const height = profile.heightCm === null ? null : cmToFeetInches(profile.heightCm);
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
          <NumberField
            name="heightFeet" label="Height" unit="ft" step="1"
            defaultValue={height?.feet} error={errors.heightFeet}
          />
          <NumberField
            name="heightInches" label="&nbsp;" unit="in" step="0.5"
            defaultValue={height ? Math.round(height.inches * 10) / 10 : undefined}
          />
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
            name="startingWeight" label="Starting weight" unit="lb" step="0.1"
            defaultValue={
              profile.startingWeightKg === null
                ? undefined
                : Math.round(kgToLb(profile.startingWeightKg) * 10) / 10
            }
          />
          <NumberField
            name="targetWeight" label="Target weight" unit="lb" step="0.1"
            defaultValue={
              profile.targetWeightKg === null
                ? undefined
                : Math.round(kgToLb(profile.targetWeightKg) * 10) / 10
            }
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
          Storage is always metric. This only changes what you read and type.
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          <SelectField
            name="weightDisplayUnit" label="Weight"
            options={[{ value: 'LB', label: 'Pounds' }, { value: 'KG', label: 'Kilograms' }]}
            defaultValue={profile.weightDisplayUnit}
          />
          <SelectField
            name="distanceDisplayUnit" label="Distance"
            options={[{ value: 'MI', label: 'Miles' }, { value: 'KM', label: 'Kilometres' }]}
            defaultValue={profile.distanceDisplayUnit}
          />
          <SelectField
            name="lengthDisplayUnit" label="Body measurements"
            options={[{ value: 'IN', label: 'Inches' }, { value: 'CM', label: 'Centimetres' }]}
            defaultValue={profile.lengthDisplayUnit}
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
