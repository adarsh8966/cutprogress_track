'use client';

/**
 * The "Why?" affordance (spec §57).
 *
 * "Never let the AI hide the numbers. If it says 'You're doing well', the user
 * should be able to click Why? and see the evidence."
 *
 * Every Derived<T> in the codebase carries its method, inputs, confidence and
 * caveats, so this component works for any figure in the app without each page
 * having to build its own explanation. If a number is on screen and cannot be
 * wrapped in one of these, that number does not belong on screen.
 */
import { useState } from 'react';
import type { Derived, DerivedConfidence } from '@/lib/types';

const CONFIDENCE_LABEL: Record<DerivedConfidence, string> = {
  HIGH: 'High confidence',
  MODERATE: 'Moderate confidence',
  LOW: 'Low confidence',
  INSUFFICIENT: 'Not enough data',
};

const CONFIDENCE_CLASS: Record<DerivedConfidence, string> = {
  HIGH: 'text-good',
  MODERATE: 'text-warn',
  LOW: 'text-warn',
  INSUFFICIENT: 'text-ink-faint',
};

export function Evidence<T>({ derived }: { derived: Derived<T> }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="text-[11px] text-ink-faint hover:text-accent transition-colors"
        aria-expanded={open}
      >
        {open ? 'Hide working' : 'Why?'}
      </button>

      {open && (
        <div className="mt-2 rounded border border-line bg-ground/60 p-3 text-[11px] leading-relaxed">
          <dl className="space-y-2">
            <div>
              <dt className="text-ink-faint">Method</dt>
              <dd className="text-ink-muted">{derived.method}</dd>
            </div>
            <div>
              <dt className="text-ink-faint">Confidence</dt>
              <dd className={CONFIDENCE_CLASS[derived.confidence]}>
                {CONFIDENCE_LABEL[derived.confidence]}
              </dd>
            </div>
            <div>
              <dt className="text-ink-faint">Inputs used</dt>
              <dd>
                <ul className="mt-1 space-y-0.5">
                  {Object.entries(derived.inputs).map(([key, value]) => (
                    <li key={key} className="flex gap-2">
                      <span className="text-ink-faint">{humanise(key)}</span>
                      <span className="tabular text-ink-muted">{render(value)}</span>
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
            {derived.notes.length > 0 && (
              <div>
                <dt className="text-ink-faint">Caveats</dt>
                <dd>
                  <ul className="mt-1 list-disc space-y-1 pl-4 text-ink-muted">
                    {derived.notes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                </dd>
              </div>
            )}
          </dl>
        </div>
      )}
    </div>
  );
}

function humanise(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

function render(value: unknown): string {
  if (value === null || value === undefined) return 'not set';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '');
  }
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}
