'use client';

/**
 * Paste → Parse → Review → Confirm (spec §8, §28).
 *
 * The review step is not a convenience, it is the point. Spec §8: "NEVER
 * automatically trust parsed data." So this component:
 *
 *   - shows every field the parser found, with the exact line it read it from
 *   - makes every field editable before anything is written
 *   - flags fields the parser had to assume something about
 *   - lists the lines it could not read, rather than hiding them
 *   - refuses to import without an unambiguous date
 *   - reports a repeated paste instead of duplicating a day (§38)
 */
import { useState, useTransition } from 'react';
import { parseImport, confirmImport, type ParsePreview } from '@/app/actions/import';
import type { FieldKey } from '@/lib/health/parser';
import { kgToLb, cmToInches } from '@/lib/normalization/units';

/** Review rows, in the order they read most naturally. */
const ROWS: {
  key: FieldKey;
  formName: string;
  label: string;
  unit: string;
  /** Canonical → display, for the fields stored in metric units. */
  toDisplay?: (canonical: number) => number;
  /** Display → canonical, applied on submit. */
  toCanonical?: (display: number) => number;
  step?: string;
}[] = [
  { key: 'weightKg', formName: 'weightKg', label: 'Weight', unit: 'lb',
    toDisplay: kgToLb, toCanonical: (lb) => lb * 0.45359237, step: '0.1' },
  { key: 'waistCm', formName: 'waistCm', label: 'Waist', unit: 'in',
    toDisplay: cmToInches, toCanonical: (inches) => inches * 2.54, step: '0.1' },
  { key: 'calories', formName: 'calories', label: 'Calories', unit: 'kcal' },
  { key: 'proteinG', formName: 'proteinG', label: 'Protein', unit: 'g' },
  { key: 'carbsG', formName: 'carbsG', label: 'Carbohydrate', unit: 'g' },
  { key: 'fatG', formName: 'fatG', label: 'Fat', unit: 'g' },
  { key: 'fiberG', formName: 'fiberG', label: 'Fibre', unit: 'g' },
  { key: 'steps', formName: 'steps', label: 'Steps', unit: '' },
  { key: 'activeCalories', formName: 'activeCalories', label: 'Active calories', unit: 'kcal' },
  { key: 'sleepMinutes', formName: 'sleepMinutes', label: 'Sleep', unit: 'min' },
  { key: 'restingHeartRate', formName: 'restingHeartRate', label: 'Resting heart rate', unit: 'bpm' },
  { key: 'hrvMs', formName: 'hrvMs', label: 'HRV', unit: 'ms' },
];

const SAMPLE = `Date: 2026-08-28
Weight: 205.4 lb
Calories: 1,987
Protein: 143g
Carbs: 210g
Fat: 61g
Fiber: 28g
Steps: 10,421
Sleep: 7h 42m
Workout: Pull
Duration: 58 min`;

export function ImportWorkbench({ today }: { today: string }) {
  const [rawText, setRawText] = useState('');
  const [preview, setPreview] = useState<ParsePreview | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function handleParse() {
    setResult(null);
    startTransition(async () => {
      setPreview(await parseImport(rawText));
    });
  }

  function valueFor(key: FieldKey): string {
    const field = preview?.fields.find((f) => f.key === key);
    if (!field || typeof field.value !== 'number') return '';
    const row = ROWS.find((r) => r.key === key);
    const display = row?.toDisplay ? row.toDisplay(field.value) : field.value;
    return String(Math.round(display * 100) / 100);
  }

  function noteFor(key: FieldKey): string | null {
    const field = preview?.fields.find((f) => f.key === key);
    if (!field) return null;
    if (field.confidence === 'HIGH') return null;
    return field.note ?? 'The parser was not certain about this value.';
  }

  function rawFor(key: FieldKey): string | null {
    return preview?.fields.find((f) => f.key === key)?.rawText ?? null;
  }

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-line bg-surface p-5">
        <label className="block">
          <span className="mb-2 block text-[11px] uppercase tracking-[0.12em] text-ink-faint">
            Paste your Bevel / Health / workout summary
          </span>
          <textarea
            value={rawText}
            onChange={(event) => setRawText(event.target.value)}
            rows={12}
            spellCheck={false}
            placeholder={SAMPLE}
            className="w-full resize-y rounded border border-line bg-ground px-3 py-2 font-mono text-xs leading-relaxed outline-none focus:border-accent"
          />
        </label>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleParse}
            disabled={pending || rawText.trim() === ''}
            className="rounded border border-line-strong px-4 py-1.5 text-sm transition-colors hover:border-accent disabled:opacity-40"
          >
            {pending ? 'Parsing…' : 'Parse data'}
          </button>
          <button
            type="button"
            onClick={() => setRawText(SAMPLE)}
            className="text-xs text-ink-faint hover:text-accent"
          >
            Use a sample
          </button>
          <p className="text-[11px] text-ink-faint">
            Nothing is saved until you review and confirm.
          </p>
        </div>
      </section>

      {preview && (
        <form
          action={(formData) => {
            setResult(null);
            startTransition(async () => {
              // Convert display units back to canonical at the boundary.
              for (const row of ROWS) {
                if (!row.toCanonical) continue;
                const entered = formData.get(row.formName);
                const text = entered === null ? '' : String(entered).trim();
                if (text === '') continue;
                const parsedNumber = Number(text);
                if (Number.isFinite(parsedNumber)) {
                  formData.set(row.formName, String(row.toCanonical(parsedNumber)));
                }
              }
              formData.set('rawText', rawText);
              const outcome = await confirmImport(formData);
              setResult(outcome);
              if (outcome.ok) setPreview(null);
            });
          }}
          className="space-y-5 rounded-lg border border-line bg-surface p-5"
        >
          <header className="flex items-baseline justify-between gap-4">
            <h2 className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint">
              Review imported data
            </h2>
            <span className="text-[11px] text-ink-faint">
              parser {preview.parserVersion}
            </span>
          </header>

          {preview.alreadyImported && (
            <p className="rounded border border-warn/40 bg-warn/5 px-3 py-2 text-xs text-warn">
              This exact report has already been imported
              {preview.previousImportDate
                ? ` on ${preview.previousImportDate.slice(0, 10)}`
                : ''}
              . Importing it again will be refused rather than duplicating the day.
            </p>
          )}

          <label className="block max-w-xs">
            <span className="mb-1.5 block text-[11px] uppercase tracking-[0.12em] text-ink-faint">
              Date <span className="text-bad">*</span>
            </span>
            <input
              type="date"
              name="date"
              required
              defaultValue={preview.targetDate ?? today}
              className="w-full rounded border border-line bg-ground px-3 py-2 text-sm outline-none focus:border-accent"
            />
            {preview.targetDate === null && (
              <span className="mt-1 block text-[11px] text-warn">
                No unambiguous date was found in the text. Set it explicitly.
              </span>
            )}
          </label>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[540px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-[0.12em] text-ink-faint">
                  <th className="pb-2 font-medium">Field</th>
                  <th className="pb-2 font-medium">Value</th>
                  <th className="pb-2 font-medium">Read from</th>
                </tr>
              </thead>
              <tbody>
                {ROWS.map((row) => {
                  const source = rawFor(row.key);
                  const note = noteFor(row.key);
                  return (
                    <tr key={row.key} className="border-b border-line/60 last:border-0">
                      <td className="py-2 pr-4 align-top text-ink-muted">{row.label}</td>
                      <td className="py-2 pr-4 align-top">
                        <div className="flex items-center gap-1.5">
                          <input
                            type="number"
                            name={row.formName}
                            step={row.step ?? 'any'}
                            defaultValue={valueFor(row.key)}
                            placeholder="not logged"
                            className={`tabular w-28 rounded border bg-ground px-2 py-1 text-sm outline-none focus:border-accent ${
                              note ? 'border-warn/50' : 'border-line'
                            }`}
                          />
                          {row.unit && (
                            <span className="text-[11px] text-ink-faint">{row.unit}</span>
                          )}
                        </div>
                        {note && (
                          <span className="mt-1 block max-w-xs text-[11px] leading-snug text-warn">
                            {note}
                          </span>
                        )}
                      </td>
                      <td className="py-2 align-top">
                        <code className="text-[11px] text-ink-faint">
                          {source ?? '—'}
                        </code>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="text-[11px] leading-relaxed text-ink-faint">
            An empty field is stored as <span className="text-ink-muted">not logged</span>,
            not as zero. Leave anything you did not measure blank.
          </p>

          {preview.unrecognisedLines.length > 0 && (
            <details className="rounded border border-line bg-ground/60 p-3">
              <summary className="cursor-pointer text-[11px] text-ink-faint">
                {preview.unrecognisedLines.length} line
                {preview.unrecognisedLines.length === 1 ? '' : 's'} could not be read
              </summary>
              <ul className="mt-2 space-y-1">
                {preview.unrecognisedLines.map((line, i) => (
                  <li key={i} className="font-mono text-[11px] text-ink-muted">
                    {line}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
            <button
              type="submit"
              disabled={pending}
              className="rounded border border-line-strong px-4 py-1.5 text-sm transition-colors hover:border-accent disabled:opacity-40"
            >
              {pending ? 'Importing…' : 'Confirm import'}
            </button>
            <button
              type="button"
              onClick={() => setPreview(null)}
              className="text-xs text-ink-faint hover:text-ink-muted"
            >
              Discard
            </button>
          </div>
        </form>
      )}

      {result && (
        <p
          role="status"
          className={`rounded border px-3 py-2 text-sm ${
            result.ok
              ? 'border-good/40 bg-good/5 text-good'
              : 'border-warn/40 bg-warn/5 text-warn'
          }`}
        >
          {result.message}
        </p>
      )}
    </div>
  );
}
