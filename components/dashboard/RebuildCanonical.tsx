'use client';

/**
 * "Rebuild daily summaries" (spec §16, §41).
 *
 * daily_metrics is a derived cache. If a rebuild is ever missed - a failed
 * write partway through an import, a bug in the resolver since fixed - the raw
 * observation is still on disk and still permanent, but no page can see it, and
 * re-pasting the same day is refused as a duplicate so it never gets another
 * chance to rebuild. This button is the way back, and it is safe to press at
 * any time: recomputing a pure function of rows that are never deleted cannot
 * lose anything.
 */
import { useState, useTransition } from 'react';
import { rebuildCanonicalLayer, type RebuildResult } from '@/app/actions/maintenance';

export function RebuildCanonical() {
  const [result, setResult] = useState<RebuildResult | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div>
      <p className="mb-4 max-w-2xl text-[11px] leading-relaxed text-ink-faint">
        Recomputes the daily summary table from your raw observations. Nothing
        recorded is changed, moved or deleted — the summary is derived from those
        rows, so rebuilding it can only bring it back into agreement with what
        you actually logged. Use it if a measurement you know you recorded is not
        showing up on a page.
      </p>

      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setResult(null);
          startTransition(async () => setResult(await rebuildCanonicalLayer()));
        }}
        className="min-h-11 rounded border border-line px-4 text-sm text-ink transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
      >
        {pending ? 'Rebuilding…' : 'Rebuild daily summaries'}
      </button>

      {result && (
        <p
          className={`mt-3 text-sm ${result.ok ? 'text-good' : 'text-warn'}`}
          role="status"
        >
          {result.message}
        </p>
      )}
    </div>
  );
}
