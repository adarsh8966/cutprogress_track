'use client';

/**
 * "You set this" — and the one click that undoes it.
 *
 * A pin is invisible until it does something, and by then the user has usually
 * forgotten they made it: they typed a weight in March, and in July the watch's
 * reading for that day is quietly not the one on screen. So the pin says so
 * where the number is, and offers the way out in the same place.
 *
 * The imported observation is not hidden by any of this. It is in the raw
 * records below, with its source, exactly as it always was.
 */
import { useState, useTransition } from 'react';
import { clearCanonicalFieldPin } from '@/app/actions/corrections';

export function FieldPin({
  date,
  field,
  label,
}: {
  date: string;
  field: string;
  label: string;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (message !== null) {
    return <span className="w-full text-[11px] text-good">{message}</span>;
  }

  return (
    <>
      <span className="text-accent">· your entry</span>
      <button
        type="button"
        disabled={pending}
        aria-label={`Let imported readings resolve ${label} again`}
        onClick={() => startTransition(async () => {
          const result = await clearCanonicalFieldPin({ date, field });
          setMessage(result.message);
        })}
        className="text-ink-faint underline decoration-dotted underline-offset-2 hover:text-ink disabled:opacity-50"
      >
        {pending ? 'lifting…' : 'use imported instead'}
      </button>
    </>
  );
}
