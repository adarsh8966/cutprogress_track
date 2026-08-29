'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { signUp, type SignUpResult } from '@/app/actions/auth';

const INPUT_CLASS =
  'w-full rounded border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent';

function AuthField({
  name,
  label,
  type,
  autoComplete,
  error,
  hint,
}: {
  name: string;
  label: string;
  type: string;
  autoComplete: string;
  error?: string;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] uppercase tracking-[0.12em] text-ink-faint">
        {label}
      </span>
      <input
        type={type}
        name={name}
        required
        autoComplete={autoComplete}
        aria-invalid={error ? true : undefined}
        className={INPUT_CLASS}
      />
      {hint && !error && (
        <span className="mt-1 block text-[11px] text-ink-faint">{hint}</span>
      )}
      {error && <span className="mt-1 block text-[11px] text-bad">{error}</span>}
    </label>
  );
}

export function SignUpForm() {
  const [result, setResult] = useState<SignUpResult | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  // Supabase created the account but is holding the session until the address
  // is confirmed. There is nothing to navigate to yet, so say so instead.
  if (result?.ok && result.needsEmailConfirmation) {
    return (
      <div
        role="status"
        className="rounded-lg border border-line bg-surface p-5 text-sm"
      >
        <p className="mb-3 font-medium text-good">Check your email</p>
        <p className="leading-relaxed text-ink-muted">
          Your account exists, but it is not usable until you confirm the
          address. Open the link we just sent and you will land on your
          dashboard, signed in.
        </p>
        <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
          Nothing arrived? Check spam, and confirm the address was typed
          correctly - a wrong address fails silently by design.
        </p>
      </div>
    );
  }

  const errors = result?.errors ?? {};

  return (
    <form
      action={(formData) => {
        setResult(null);
        startTransition(async () => {
          const outcome = await signUp(formData);
          setResult(outcome);
          // A session only comes back when the project does not require
          // confirmation. Then, and only then, the dashboard is reachable.
          if (outcome.ok && !outcome.needsEmailConfirmation) {
            router.push('/dashboard');
          }
        });
      }}
      className="space-y-4"
    >
      <AuthField
        name="email"
        label="Email"
        type="email"
        autoComplete="email"
        error={errors.email}
      />
      <AuthField
        name="password"
        label="Password"
        type="password"
        autoComplete="new-password"
        error={errors.password}
        hint="At least 8 characters."
      />
      <AuthField
        name="confirmPassword"
        label="Confirm password"
        type="password"
        autoComplete="new-password"
        error={errors.confirmPassword}
      />

      {result && !result.ok && !result.errors && (
        <p role="alert" className="text-xs text-bad">
          {result.message}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded border border-line-strong px-4 py-2 text-sm transition-colors hover:border-accent disabled:opacity-50"
      >
        {pending ? 'Creating account…' : 'Create account'}
      </button>
    </form>
  );
}
