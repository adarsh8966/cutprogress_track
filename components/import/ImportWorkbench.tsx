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
 *   - lists the lines it could not read, and the values it understood but
 *     cannot store, rather than hiding either
 *   - shows, per day, exactly which rows the confirm will write
 *   - refuses to import without an unambiguous date
 *   - reports a repeated paste instead of duplicating a day (§38)
 *
 * A paste may describe several days. Each is reviewed and confirmed as its own
 * record, and the result panel reports each one separately.
 */
import { useMemo, useState, useTransition } from 'react';
import {
  parseImport, confirmImport,
  type ParsePreview, type ImportResult,
} from '@/app/actions/import';
import type { SessionFieldKey } from '@/lib/health/parser';
import {
  SESSION_TYPE_VALUES, CARDIO_TYPE_VALUES,
  SESSION_TYPE_LABEL, CARDIO_TYPE_LABEL,
} from '@/lib/health/sessionTypes';
import {
  DAY_FIELD_ORDER, SESSION_FIELD_LABEL,
  dayRow, sessionFieldRow, dayPath, sessionPath, sessionTypePath,
  editsFromPreview, buildConfirmPayload, summariseWrites,
  storableFields, unstorableFields, emptyEdits,
  type DisplayUnits, type EditState,
} from '@/lib/health/importPayload';
import type {
  WeightUnit, LengthUnit, DistanceUnit,
} from '@/lib/normalization/units';

const SAMPLE = `Date: 2026-08-28
Weight: 205.4 lb
Waist: 35.1 in
Calories: 1,987
Protein: 143g
Carbs: 210g
Fat: 61g
Fiber: 28g
Steps: 10,421
Active calories: 620
Sleep: 7h 42m
Resting HR: 58 bpm
HRV: 74 ms
Workout: Pull
Duration: 58 min
Avg HR: 128 bpm
Max HR: 161 bpm

Date: 2026-08-29
Weight: 92.4 kg
Calories: 2,140
Protein: 168 g
Steps: 8,902
Sleep: 7 hours 15 minutes
Cardio: Incline walk
Duration: 35 min
Distance: 2.6 mi
Zone: 2`;

export function ImportWorkbench({
  today, weightUnit, lengthUnit, distanceUnit,
}: {
  today: string;
  weightUnit: WeightUnit;
  lengthUnit: LengthUnit;
  distanceUnit: DistanceUnit;
}) {
  const [rawText, setRawText] = useState('');
  const [preview, setPreview] = useState<ParsePreview | null>(null);
  const [edits, setEdits] = useState<EditState>(emptyEdits);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [pending, startTransition] = useTransition();

  const units: DisplayUnits = useMemo(
    () => ({ weight: weightUnit, length: lengthUnit, distance: distanceUnit }),
    [weightUnit, lengthUnit, distanceUnit],
  );

  function handleParse() {
    setResult(null);
    startTransition(async () => {
      const next = await parseImport(rawText);
      setPreview(next);
      setEdits(editsFromPreview(next.records, units, today));
    });
  }

  function setValue(path: string, text: string) {
    setEdits((previous) => ({
      ...previous,
      values: { ...previous.values, [path]: text },
      dirty: { ...previous.dirty, [path]: true },
    }));
  }

  function setDate(index: number, date: string) {
    setEdits((previous) => ({
      ...previous,
      dates: previous.dates.map((d, i) => (i === index ? date : d)),
    }));
  }

  function setType(path: string, value: string) {
    setEdits((previous) => ({ ...previous, types: { ...previous.types, [path]: value } }));
  }

  function toggleRemoved(path: string) {
    setEdits((previous) => ({
      ...previous,
      removed: { ...previous.removed, [path]: !previous.removed[path] },
    }));
  }

  /**
   * The server keys errors by the coordinates of the payload it received, and
   * buildConfirmPayload drops removed sessions - so a removed session shifts
   * every index after it. Without this the banner says "check the highlighted
   * fields" and highlights the wrong one, or none.
   */
  function payloadSessionIndex(record: number, session: number): number {
    let index = 0;
    for (let i = 0; i < session; i += 1) {
      if (!edits.removed[sessionTypePath(record, i)]) index += 1;
    }
    return index;
  }

  /**
   * Both banners were computed server-side against the parsed date. Once the
   * reviewer moves a record to another day they describe a different day, so
   * they say which one rather than quietly going stale.
   */
  function movedFrom(record: number): boolean {
    const preview_ = preview?.records[record];
    return preview_ !== undefined && edits.dates[record] !== preview_.checkedDate;
  }

  function dayError(record: number, key: string): string | null {
    return result?.errors?.[`records.${record}.${key}`] ?? null;
  }

  function sessionError(record: number, session: number, key: string): string | null {
    if (edits.removed[sessionTypePath(record, session)]) return null;
    const index = payloadSessionIndex(record, session);
    return result?.errors?.[`records.${record}.sessions.${index}.${key}`] ?? null;
  }

  /**
   * Built from the same function the review rows read, so "will be saved" and
   * what is actually sent cannot disagree.
   */
  const payload = useMemo(
    () => buildConfirmPayload(preview?.records ?? [], edits, units, today),
    [preview, edits, units, today],
  );

  /** Reads the very payload that will be submitted, so the two cannot differ. */
  function summary(index: number): string[] {
    const record = payload.records[index];
    return record ? summariseWrites(record) : [];
  }

  function handleConfirm() {
    setResult(null);
    startTransition(async () => {
      const outcome = await confirmImport(payload);
      setResult(outcome);
      // Clear once nothing is left to act on. A skipped blank day or a refused
      // repeat needs no correction, and keeping the review open would invite a
      // second Confirm that turns the days just imported into duplicates.
      const actionable =
        outcome.records.some((record) => record.status === 'FAILED')
        || (outcome.records.length === 0 && !outcome.ok);
      if (!actionable) {
        setPreview(null);
        setEdits(emptyEdits());
        setRawText('');
      }
    });
  }

  /**
   * A paste of unreadable text still produces a record - the lines are reported
   * rather than dropped. That is not something to review, so the empty state
   * turns on whether any record holds a value, not on the record count.
   */
  const hasAnythingToReview = (preview?.records ?? []).some(
    (record) => record.fields.length > 0 || record.sessions.length > 0,
  );

  /** confirmImport refuses more than this, so say so before the review, not after. */
  const MAX_DAYS = 60;
  const tooManyDays = (preview?.records.length ?? 0) > MAX_DAYS;

  const totalSessions = preview?.records.reduce((n, r) => n + r.sessions.length, 0) ?? 0;
  const totalIgnored = preview?.records.reduce(
    (n, r) => n + r.unrecognisedLines.length, 0,
  ) ?? 0;

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
            disabled={pending}
            placeholder={SAMPLE}
            className="w-full resize-y rounded border border-line bg-ground px-3 py-2 font-mono text-xs leading-relaxed outline-none focus:border-accent disabled:opacity-60"
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
            disabled={pending}
            className="text-xs text-ink-faint hover:text-accent disabled:opacity-40"
          >
            Use a sample
          </button>
          <p className="text-[11px] text-ink-faint">
            Several days can be pasted at once. Nothing is saved until you review and confirm.
          </p>
        </div>
      </section>

      {preview && !hasAnythingToReview && (
        <p className="rounded border border-warn/40 bg-warn/5 px-3 py-2 text-sm text-warn">
          Nothing in that text could be read as health data. Check the labels — each
          line should look like <code>Weight: 205.4 lb</code>.
        </p>
      )}

      {preview && hasAnythingToReview && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-baseline justify-between gap-3 rounded-lg border border-line bg-surface px-5 py-3">
            <h2 className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint">
              Review imported data
            </h2>
            <p className="text-[11px] text-ink-faint">
              {preview.records.length} day{preview.records.length === 1 ? '' : 's'}
              {totalSessions > 0 && ` · ${totalSessions} session${totalSessions === 1 ? '' : 's'}`}
              {totalIgnored > 0 && ` · ${totalIgnored} line${totalIgnored === 1 ? '' : 's'} ignored`}
              {' · '}parser {preview.parserVersion}
            </p>
          </div>

          {preview.sessionCheckFailed && (
            <p className="rounded border border-warn/40 bg-warn/5 px-3 py-2 text-xs text-warn">
              The count of sessions already recorded on these days could not be read, so
              this screen cannot warn you if importing would add to existing ones. A day&rsquo;s
              training and cardio minutes are the total of every session on it.
            </p>
          )}

          {preview.duplicateCheckFailed && (
            <p className="rounded border border-warn/40 bg-warn/5 px-3 py-2 text-xs text-warn">
              The check for days you have already imported could not run, so this screen
              cannot tell you whether any of these are repeats. Importing is still safe —
              the database refuses a genuine repeat either way.
            </p>
          )}

          {tooManyDays && (
            <p className="rounded border border-bad/40 bg-bad/5 px-3 py-2 text-sm text-bad">
              This paste covers {preview.records.length} days. A single import can cover at
              most {MAX_DAYS}. Split it up and import the parts separately.
            </p>
          )}

          {preview.records.map((record, r) => (
            <section key={r} className="space-y-5 rounded-lg border border-line bg-surface p-5">
              {record.alreadyImported && (
                <p className="rounded border border-warn/40 bg-warn/5 px-3 py-2 text-xs text-warn">
                  This exact text was already imported for {record.checkedDate}
                  {record.previousImportDate
                    ? `, on ${record.previousImportDate.slice(0, 10)}`
                    : ''}
                  . Importing it again under that date will be refused rather than
                  duplicating the day.
                  {movedFrom(r) && (
                    <> You have since moved this record to {edits.dates[r]}, so it will
                    import as new data for that day.</>
                  )}
                </p>
              )}

              {record.existingSessions > 0 && (
                <p className="rounded border border-warn/40 bg-warn/5 px-3 py-2 text-xs text-warn">
                  {record.existingSessionsDate} already has {record.existingSessions} session
                  {record.existingSessions === 1 ? '' : 's'} recorded. Importing adds to
                  them rather than replacing them, and the day&rsquo;s training and cardio
                  minutes are the total of all of them.
                  {movedFrom(r) && (
                    <> That count is for {record.checkedDate}; this record is now dated{' '}
                    {edits.dates[r]}, which has not been checked.</>
                  )}
                </p>
              )}

              <label className="block max-w-xs">
                <span className="mb-1.5 block text-[11px] uppercase tracking-[0.12em] text-ink-faint">
                  Date <span className="text-bad">*</span>
                </span>
                <input
                  type="date"
                  value={edits.dates[r] ?? today}
                  onChange={(event) => setDate(r, event.target.value)}
                  required
                  className="w-full rounded border border-line bg-ground px-3 py-2 text-sm outline-none focus:border-accent"
                />
                {record.targetDate === null && (
                  <span className="mt-1 block text-[11px] text-warn">
                    {record.dateNote ?? 'No unambiguous date was found in the text. Set it explicitly.'}
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
                    {DAY_FIELD_ORDER.map((key) => {
                      const row = dayRow(key, units);
                      const field = record.fields.find((f) => f.key === key);
                      const note = field && field.confidence !== 'HIGH'
                        ? field.note ?? 'The parser was not certain about this value.'
                        : null;
                      const path = dayPath(r, key);
                      const fieldError = dayError(r, key);
                      return (
                        <tr key={key} className="border-b border-line/60 last:border-0">
                          <td className="py-2 pr-4 align-top text-ink-muted">{row.label}</td>
                          <td className="py-2 pr-4 align-top">
                            <div className="flex items-center gap-1.5">
                              <input
                                type="number"
                                step={row.step ?? 'any'}
                                value={edits.values[path] ?? ''}
                                onChange={(event) => setValue(path, event.target.value)}
                                placeholder="not logged"
                                aria-invalid={fieldError !== null}
                                className={`tabular w-28 rounded border bg-ground px-2 py-1 text-sm outline-none focus:border-accent ${
                                  fieldError ? 'border-bad' : note ? 'border-warn/50' : 'border-line'
                                }`}
                              />
                              {row.unit && (
                                <span className="text-[11px] text-ink-faint">{row.unit}</span>
                              )}
                            </div>
                            {fieldError && (
                              <span className="mt-1 block max-w-xs text-[11px] leading-snug text-bad">
                                {fieldError}
                              </span>
                            )}
                            {note && (
                              <span className="mt-1 block max-w-xs text-[11px] leading-snug text-warn">
                                {note}
                              </span>
                            )}
                          </td>
                          <td className="py-2 align-top">
                            <code className="text-[11px] text-ink-faint">
                              {field?.rawText ?? '—'}
                            </code>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {record.sessions.map((session, s) => {
                const isWorkout = session.kind === 'WORKOUT';
                const options = isWorkout ? SESSION_TYPE_VALUES : CARDIO_TYPE_VALUES;
                const labels: Record<string, string> = isWorkout
                  ? SESSION_TYPE_LABEL : CARDIO_TYPE_LABEL;
                const dropped = unstorableFields(session);
                const removed = edits.removed[sessionTypePath(r, s)] === true;
                return (
                  <div
                    key={s}
                    className={`rounded border border-line bg-ground/40 p-4 ${
                      removed ? 'opacity-50' : ''
                    }`}
                  >
                    <header className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">
                        {isWorkout ? 'Workout' : 'Cardio'}
                      </span>
                      <code className="text-[11px] text-ink-faint">{session.openerRawText}</code>
                      <button
                        type="button"
                        onClick={() => toggleRemoved(sessionTypePath(r, s))}
                        className="ml-auto text-[11px] text-ink-faint hover:text-accent"
                      >
                        {removed ? 'Keep this session' : 'Do not import this session'}
                      </button>
                    </header>

                    {removed && (
                      <p className="text-[11px] leading-snug text-ink-faint">
                        This session will not be saved. The paste is still stored verbatim.
                      </p>
                    )}

                    <div className={`flex flex-wrap items-end gap-4 ${removed ? 'hidden' : ''}`}>
                      <label className="block">
                        <span className="mb-1 block text-[11px] text-ink-faint">Type</span>
                        <select
                          value={edits.types[sessionTypePath(r, s)] ?? options[options.length - 1]}
                          onChange={(event) => setType(sessionTypePath(r, s), event.target.value)}
                          className={`rounded border bg-ground px-2 py-1 text-sm outline-none focus:border-accent ${
                            session.typeRecognised ? 'border-line' : 'border-warn/50'
                          }`}
                        >
                          {options.map((option) => (
                            <option key={option} value={option}>{labels[option]}</option>
                          ))}
                        </select>
                        {!session.typeRecognised && (
                          <span className="mt-1 block max-w-xs text-[11px] leading-snug text-warn">
                            &ldquo;{session.rawLabel}&rdquo; did not match a known type, so it
                            reads as Other. The text is kept in the session&rsquo;s notes either way.
                          </span>
                        )}
                      </label>

                      {storableFields(session.kind).map((key) => {
                        const row = sessionFieldRow(key, units);
                        const field = session.fields.find((f) => f.key === key);
                        const note = field && field.confidence !== 'HIGH'
                          ? field.note ?? 'The parser was not certain about this value.'
                          : null;
                        const path = sessionPath(r, s, key);
                        const fieldError = sessionError(r, s, key);
                        const required = !isWorkout && key === 'sessionMinutes';
                        return (
                          <label key={key} className="block">
                            <span className="mb-1 block text-[11px] text-ink-faint">
                              {row.label}
                              {required && <span className="text-bad"> *</span>}
                              {row.unit && <span className="text-ink-faint"> ({row.unit})</span>}
                            </span>
                            <input
                              type="number"
                              step={row.step ?? 'any'}
                              value={edits.values[path] ?? ''}
                              onChange={(event) => setValue(path, event.target.value)}
                              placeholder="not logged"
                              aria-invalid={fieldError !== null}
                              className={`tabular w-24 rounded border bg-ground px-2 py-1 text-sm outline-none focus:border-accent ${
                                fieldError ? 'border-bad' : note ? 'border-warn/50' : 'border-line'
                              }`}
                            />
                            {fieldError && (
                              <span className="mt-1 block max-w-[12rem] text-[11px] leading-snug text-bad">
                                {fieldError}
                              </span>
                            )}
                            {note && (
                              <span className="mt-1 block max-w-[12rem] text-[11px] leading-snug text-warn">
                                {note}
                              </span>
                            )}
                          </label>
                        );
                      })}
                    </div>

                    {(dropped.length > 0 || session.notStored.length > 0) && (
                      <ul className="mt-3 space-y-1 border-t border-line pt-2">
                        {dropped.map((field, i) => (
                          <li key={`d${i}`} className="text-[11px] leading-snug text-warn">
                            Not saved: {SESSION_FIELD_LABEL[field.key as SessionFieldKey]} —{' '}
                            <code>{field.rawText}</code>. A {isWorkout ? 'workout' : 'cardio'}{' '}
                            session has no column for it
                            {isWorkout ? ' — move it under a Cardio: block' : ''}.
                          </li>
                        ))}
                        {session.notStored.map((entry, i) => (
                          <li key={`n${i}`} className="text-[11px] leading-snug text-ink-faint">
                            Not saved: <code>{entry.rawText}</code> — {entry.reason}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}

              <div className="space-y-2 border-t border-line pt-4">
                <p className="text-[11px] leading-relaxed text-ink-muted">
                  <span className="uppercase tracking-[0.12em] text-ink-faint">Will be saved:</span>{' '}
                  {summary(r).length > 0
                    ? summary(r).join(' · ')
                    : 'nothing — every field on this day is blank.'}
                </p>
                <p className="text-[11px] leading-relaxed text-ink-faint">
                  An empty field is stored as <span className="text-ink-muted">not logged</span>,
                  not as zero. Leave anything you did not measure blank.
                </p>
              </div>

              {(record.unrecognisedLines.length > 0 || record.notStored.length > 0) && (
                <details className="rounded border border-line bg-ground/60 p-3">
                  <summary className="cursor-pointer text-[11px] text-ink-faint">
                    {record.unrecognisedLines.length + record.notStored.length} line
                    {record.unrecognisedLines.length + record.notStored.length === 1 ? '' : 's'}
                    {' '}will not be saved
                  </summary>
                  <ul className="mt-2 space-y-1">
                    {record.unrecognisedLines.map((line, i) => (
                      <li key={`u${i}`} className="font-mono text-[11px] text-ink-muted">
                        {line}
                      </li>
                    ))}
                    {record.notStored.map((entry, i) => (
                      <li key={`n${i}`} className="text-[11px] leading-snug text-ink-muted">
                        <code>{entry.rawText}</code> — {entry.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </section>
          ))}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleConfirm}
              disabled={pending || tooManyDays}
              className="rounded border border-line-strong px-4 py-1.5 text-sm transition-colors hover:border-accent disabled:opacity-40"
            >
              {pending
                ? 'Importing…'
                : `Confirm import (${preview.records.length} day${preview.records.length === 1 ? '' : 's'})`}
            </button>
            <button
              type="button"
              onClick={() => setPreview(null)}
              disabled={pending}
              className="text-xs text-ink-faint hover:text-ink-muted disabled:opacity-40"
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {result && (
        <div
          role="status"
          className={`space-y-2 rounded border px-3 py-2 text-sm ${
            result.ok
              ? 'border-good/40 bg-good/5 text-good'
              : 'border-warn/40 bg-warn/5 text-warn'
          }`}
        >
          <p>{result.message}</p>
          {result.records.length > 0 && (
            <ul className="space-y-1 text-[11px]">
              {result.records.map((record, i) => (
                <li key={i} className="tabular">
                  {record.date} — {record.status.toLowerCase()}: {record.message}
                </li>
              ))}
            </ul>
          )}
          {result.errors && (
            <ul className="space-y-1 text-[11px]">
              {Object.entries(result.errors).map(([path, message]) => (
                <li key={path}><code>{path}</code> — {message}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
