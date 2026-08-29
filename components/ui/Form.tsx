'use client';

/**
 * Shared form plumbing.
 *
 * NumberField's placeholder is "not logged" rather than "0", and an empty field
 * submits as absent rather than as a zero (spec §33). That behaviour is
 * centralised here so no individual form can get it wrong.
 */
import { useState, useTransition, type ReactNode } from 'react';

export interface FormOutcome {
  ok: boolean;
  message: string;
  errors?: Record<string, string>;
}

export function ActionForm({
  action,
  submitLabel,
  children,
  onSuccess,
}: {
  action: (formData: FormData) => Promise<FormOutcome>;
  submitLabel: string;
  children: (errors: Record<string, string>) => ReactNode;
  onSuccess?: () => void;
}) {
  const [outcome, setOutcome] = useState<FormOutcome | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <form
      action={(formData) => {
        setOutcome(null);
        startTransition(async () => {
          const result = await action(formData);
          setOutcome(result);
          if (result.ok) onSuccess?.();
        });
      }}
      className="space-y-4"
    >
      {children(outcome?.errors ?? {})}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="min-h-11 rounded border border-line-strong px-5 text-sm transition-colors hover:border-accent disabled:opacity-40"
        >
          {pending ? 'Saving…' : submitLabel}
        </button>
        {outcome && (
          <span
            role="status"
            className={`text-xs ${outcome.ok ? 'text-good' : 'text-warn'}`}
          >
            {outcome.message}
          </span>
        )}
      </div>
    </form>
  );
}

export function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] uppercase tracking-[0.12em] text-ink-faint">
        {label}
      </span>
      {children}
      {hint && !error && (
        <span className="mt-1 block text-[11px] text-ink-faint">{hint}</span>
      )}
      {error && <span className="mt-1 block text-[11px] text-bad">{error}</span>}
    </label>
  );
}

// min-h-11 is the comfortable touch target (44px). A 36px input is fine with a
// mouse and fiddly on a phone, and this app is used on one most nights.
// text-base on small screens also stops iOS zooming the page on focus.
const INPUT_CLASS =
  'w-full min-h-11 rounded border border-line bg-ground px-3 py-2 text-base ' +
  'outline-none focus:border-accent sm:text-sm';

export function NumberField({
  name,
  label,
  unit,
  step = 'any',
  error,
  hint,
  defaultValue,
  required,
}: {
  name: string;
  label: string;
  unit?: string;
  step?: string;
  error?: string;
  hint?: string;
  defaultValue?: string | number;
  required?: boolean;
}) {
  return (
    <Field label={unit ? `${label} (${unit})` : label} error={error} hint={hint}>
      <input
        type="number"
        name={name}
        step={step}
        required={required}
        defaultValue={defaultValue}
        // Blank means "not logged". It must never read as an implied zero.
        placeholder={required ? undefined : 'not logged'}
        className={`tabular ${INPUT_CLASS}`}
      />
    </Field>
  );
}

export function TextField({
  name, label, error, defaultValue, type = 'text', required, hint,
}: {
  name: string;
  label: string;
  error?: string;
  defaultValue?: string;
  type?: string;
  required?: boolean;
  hint?: string;
}) {
  return (
    <Field label={label} error={error} hint={hint}>
      <input
        type={type}
        name={name}
        required={required}
        defaultValue={defaultValue}
        className={INPUT_CLASS}
      />
    </Field>
  );
}

export function SelectField({
  name, label, options, defaultValue, error, hint,
}: {
  name: string;
  label: string;
  options: { value: string; label: string }[];
  defaultValue?: string;
  error?: string;
  hint?: string;
}) {
  return (
    <Field label={label} error={error} hint={hint}>
      <select name={name} defaultValue={defaultValue} className={INPUT_CLASS}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}
