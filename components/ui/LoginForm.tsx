'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { signIn } from '@/app/actions/auth';

export function LoginForm() {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <form
      action={(formData) => {
        setError(null);
        startTransition(async () => {
          const result = await signIn(formData);
          if (result.ok) router.push('/dashboard');
          else setError(result.message);
        });
      }}
      className="space-y-4"
    >
      <label className="block">
        <span className="mb-1.5 block text-[11px] uppercase tracking-[0.12em] text-ink-faint">
          Email
        </span>
        <input
          type="email"
          name="email"
          required
          autoComplete="email"
          className="w-full rounded border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
        />
      </label>

      <label className="block">
        <span className="mb-1.5 block text-[11px] uppercase tracking-[0.12em] text-ink-faint">
          Password
        </span>
        <input
          type="password"
          name="password"
          required
          autoComplete="current-password"
          className="w-full rounded border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
        />
      </label>

      {error && (
        <p role="alert" className="text-xs text-bad">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded border border-line-strong px-4 py-2 text-sm transition-colors hover:border-accent disabled:opacity-50"
      >
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
