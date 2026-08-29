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
import type { DayFieldKey, SessionFieldKey } from '@/lib/health/parser';
import {
  SESSION_TYPE_VALUES, CARDIO_TYPE_VALUES,
  SESSION_TYPE_LABEL, CARDIO_TYPE_LABEL,
} from '@/lib/health/sessionTypes';
import {
  DAY_FIELD_ORDER, SESSION_FIELD_LABEL,
  dayRow, sessionFieldRow, dayPath, sessionPath, sessionTypePath,
  editsFromPreview, buildConfirmPayload, summariseWrites, summariseImport,
  storableFields, unstorableFields, emptyEdits,
  type SessionDisposition,
  type DisplayUnits, type EditState,
} from '@/lib/health/importPayload';
import {
  dayFieldVerdict, sessionVerdict, blocksImport,
  type ValueStatus, type FieldVerdict,
} from '@/lib/health/importStatus';
import type {
  WeightUnit, LengthUnit, DistanceUnit,
} from '@/lib/normalization/units';

/**
 * What each verdict looks like. The wording is the promise: NEW and UPDATED
 * mean the value WILL be stored, IGNORED and INVALID mean it will not, and the
 * two groups are coloured apart so the difference is legible before confirming
 * rather than discoverable after.
 */
const STATUS_STYLE: Record<ValueStatus, string> = {
  NEW: 'border-good/40 bg-good/5 text-good',
  UPDATED: 'border-accent/40 bg-accent/5 text-accent',
  REPLACE: 'border-accent/40 bg-accent/5 text-accent',
  DUPLICATE: 'border-line-strong bg-raised text-ink-muted',
  CONFLICT: 'border-warn/50 bg-warn/5 text-warn',
  IGNORED: 'border-line bg-ground text-ink-faint',
  INVALID: 'border-bad/50 bg-bad/5 text-bad',
};

function StatusChip({ status }: { status: ValueStatus }) {
  return (
    <span
      className={`inline-block whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_STYLE[status]}`}
    >
      {status.toLowerCase()}
    </span>
  );
}

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

  /**
   * What to do about a session already recorded on the target day.
   *
   * The screen used to warn that importing adds to what is already there and
   * leave it at that, so the only way to correct a session was to import a
   * second one and have the day total both. The choice is now explicit, and
   * the "will be saved" line below reports whichever one is picked.
   */
  function setDisposition(path: string, value: SessionDisposition, supersedes: string | null) {
    setEdits((previous) => ({
      ...previous,
      dispositions: { ...previous.dispositions, [path]: value },
      supersedes: supersedes === null
        ? Object.fromEntries(Object.entries(previous.supersedes).filter(([k]) => k !== path))
        : { ...previous.supersedes, [path]: supersedes },
    }));
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

  /**
   * What confirming will do to one day-level value.
   *
   * Read from the SAME payload the confirm submits, so the verdict on screen
   * and the value sent cannot describe different numbers - the property this
   * whole screen exists to hold.
   */
  function dayVerdict(record: number, key: DayFieldKey): FieldVerdict {
    const day = preview?.records[record]?.existingDay ?? { values: {}, sources: {}, known: false };
    const proposed = payload.records[record]?.[key] ?? null;
    return dayFieldVerdict(key, proposed, day);
  }

  /** An existing canonical value, written in the unit the field is shown in. */
  function forExisting(verdict: FieldVerdict, key: DayFieldKey): string {
    if (verdict.existing === null) return '—';
    const row = dayRow(key, units);
    const shown = row.toDisplay ? row.toDisplay(verdict.existing) : verdict.existing;
    const rounded = Math.round(shown * 100) / 100;
    return row.unit ? `${rounded} ${row.unit}` : String(rounded);
  }

  /**
   * What confirming will do with one session. Sessions are SUMMED into the day
   * rather than resolved, so an accidental second copy is not a harmless
   * duplicate observation - it permanently doubles the day's minutes.
   */
  function verdictForSession(record: number, index: number) {
    const preview_ = preview?.records[record];
    const session = preview_?.sessions[index];
    if (!preview_ || !session) {
      return { status: 'IGNORED' as ValueStatus, match: null, reason: '' };
    }
    const typePath = sessionTypePath(record, index);
    const chosen = edits.types[typePath]
      ?? (session.kind === 'WORKOUT' ? session.sessionType : session.cardioType);
    const disposition = edits.dispositions[typePath] ?? 'ADD';
    const payloadIndex = payloadSessionIndex(record, index);
    const written = payload.records[record]?.sessions[payloadIndex] ?? null;
    const minutes = written?.sessionMinutes ?? null;

    // The two rails confirmImport enforces, checked here so the review says
    // "will not be saved" before the confirm rather than after it.
    let invalidReason: string | null = null;
    if (session.kind === 'CARDIO' && minutes === null) {
      invalidReason = 'A cardio session needs a duration before it can be saved.';
    } else if (
      written
      && written.averageHeartRate != null
      && written.maxHeartRate != null
      && written.maxHeartRate < written.averageHeartRate
    ) {
      invalidReason =
        `A maximum heart rate of ${written.maxHeartRate} bpm is below the average of `
        + `${written.averageHeartRate} bpm.`;
    }

    return sessionVerdict({
      kind: session.kind,
      type: chosen,
      minutes,
      disposition,
      supersedes: edits.supersedes[typePath] ?? null,
      removed: edits.removed[typePath] === true,
      existing: preview_.existingSessionRows,
      invalidReason,
      known: !preview.sessionCheckFailed,
    });
  }

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

  /**
   * Values that cannot be written. confirmImport refuses the whole payload
   * over any one of them, so the button is disabled and says which - rather
   * than letting the user press Confirm and receive a wall of field errors.
   */
  const blocked = useMemo(() => {
    const problems: string[] = [];
    (preview?.records ?? []).forEach((record, r) => {
      for (const key of DAY_FIELD_ORDER) {
        const verdict = dayVerdict(r, key);
        if (blocksImport(verdict.status)) {
          problems.push(`${edits.dates[r] ?? today}: ${dayRow(key, units).label}`);
        }
      }
      record.sessions.forEach((_, i) => {
        if (blocksImport(verdictForSession(r, i).status)) {
          problems.push(`${edits.dates[r] ?? today}: session ${i + 1}`);
        }
      });
    });
    return problems;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, edits, payload, units, today]);

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

          {preview.dayCheckFailed && (
            <p className="rounded border border-warn/40 bg-warn/5 px-3 py-2 text-xs text-warn">
              What these days already hold could not be read, so each value below reads as
              new. Some may in fact replace a value already recorded. Importing is still
              safe — nothing is overwritten, and the day resolves to the most recent
              observation either way.
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
                  {record.existingSessions === 1 ? '' : 's'} recorded. Each session below
                  chooses whether to add to them, replace one of them, or leave the day
                  as it is — a day&rsquo;s minutes are the total of the sessions on it, so
                  re-importing a corrected session as a new one would count it twice.
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

              {/*
                A list, not a table. Every value gets a verdict saying what
                confirming will DO to it - which is the difference between "we
                will write 2,001 kcal" and "the day currently says 1,950 and
                will say 2,001". A three-column table could not carry that at
                any width, and could not be read on a phone at all.
              */}
              <ul className="divide-y divide-line/60">
                {DAY_FIELD_ORDER.map((key) => {
                  const row = dayRow(key, units);
                  const field = record.fields.find((f) => f.key === key);
                  const note = field && field.confidence !== 'HIGH'
                    ? field.note ?? 'The parser was not certain about this value.'
                    : null;
                  const path = dayPath(r, key);
                  const fieldError = dayError(r, key);
                  const verdict = dayVerdict(r, key);
                  return (
                    <li key={key} className="py-3">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                        <span className="min-w-[7.5rem] text-sm text-ink-muted">
                          {row.label}
                        </span>
                        <div className="flex items-center gap-1.5">
                          <input
                            type="number"
                            step={row.step ?? 'any'}
                            value={edits.values[path] ?? ''}
                            onChange={(event) => setValue(path, event.target.value)}
                            placeholder="not logged"
                            aria-invalid={fieldError !== null}
                            aria-label={row.label}
                            className={`tabular w-28 rounded border bg-ground px-2 py-1.5 text-base outline-none focus:border-accent sm:text-sm ${
                              fieldError ? 'border-bad' : note ? 'border-warn/50' : 'border-line'
                            }`}
                          />
                          {row.unit && (
                            <span className="text-[11px] text-ink-faint">{row.unit}</span>
                          )}
                        </div>
                        <StatusChip status={verdict.status} />
                        {verdict.existing !== null && verdict.status !== 'IGNORED' && (
                          <span className="tabular text-[11px] text-ink-faint">
                            existing {forExisting(verdict, key)}
                          </span>
                        )}
                        <code className="ml-auto text-[11px] text-ink-faint">
                          {field?.rawText ?? '—'}
                        </code>
                      </div>

                      <p className="mt-1.5 max-w-2xl text-[11px] leading-snug text-ink-faint">
                        {verdict.reason}
                      </p>
                      {fieldError && (
                        <p className="mt-1 max-w-2xl text-[11px] leading-snug text-bad">
                          {fieldError}
                        </p>
                      )}
                      {note && (
                        <p className="mt-1 max-w-2xl text-[11px] leading-snug text-warn">
                          {note}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>

              {record.sessions.map((session, s) => {
                const isWorkout = session.kind === 'WORKOUT';
                const options = isWorkout ? SESSION_TYPE_VALUES : CARDIO_TYPE_VALUES;
                const labels: Record<string, string> = isWorkout
                  ? SESSION_TYPE_LABEL : CARDIO_TYPE_LABEL;
                const dropped = unstorableFields(session);
                const removed = edits.removed[sessionTypePath(r, s)] === true;
                const outcome = verdictForSession(r, s);
                return (
                  <div
                    key={s}
                    className={`rounded border border-line bg-ground/40 p-4 ${
                      removed ? 'opacity-60' : ''
                    }`}
                  >
                    <header className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                      <span className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">
                        {isWorkout ? 'Workout' : 'Cardio'}
                      </span>
                      <StatusChip status={outcome.status} />
                      <code className="text-[11px] text-ink-faint">{session.openerRawText}</code>
                      <button
                        type="button"
                        onClick={() => toggleRemoved(sessionTypePath(r, s))}
                        className="ml-auto inline-flex min-h-9 items-center text-[11px] text-ink-faint hover:text-accent"
                      >
                        {removed ? 'Keep this session' : 'Do not import this session'}
                      </button>
                    </header>

                    {/* The verdict in words, above the fields it describes. A
                        DUPLICATE here means the day would total both sessions,
                        which is worth reading before confirming rather than
                        discovering in the training minutes afterwards. */}
                    <p
                      className={`mb-3 max-w-2xl text-[11px] leading-snug ${
                        outcome.status === 'INVALID'
                          ? 'text-bad'
                          : outcome.status === 'DUPLICATE' || outcome.status === 'CONFLICT'
                            ? 'text-warn'
                            : 'text-ink-faint'
                      }`}
                    >
                      {outcome.reason}
                    </p>

                    {(() => {
                      const path = sessionTypePath(r, s);
                      const candidates = record.existingSessionRows.filter(
                        (existing) => existing.kind === session.kind,
                      );
                      if (removed || candidates.length === 0) return null;
                      const disposition = edits.dispositions[path] ?? 'ADD';
                      const chosen = edits.supersedes[path] ?? '';
                      return (
                        <div className="mb-3 rounded border border-line bg-ground px-3 py-2">
                          <span className="mb-1.5 block text-[11px] uppercase tracking-[0.12em] text-ink-faint">
                            This day already has {candidates.length}{' '}
                            {session.kind === 'WORKOUT' ? 'workout' : 'cardio session'}
                            {candidates.length === 1 ? '' : 's'}
                          </span>
                          <div className="flex flex-wrap gap-x-4 gap-y-2">
                            {(['ADD', 'REPLACE', 'KEEP'] as const).map((mode) => (
                              <label key={mode} className="flex items-center gap-1.5 text-xs">
                                <input
                                  type="radio"
                                  name={`disposition-${path}`}
                                  checked={disposition === mode}
                                  onChange={() =>
                                    setDisposition(
                                      path,
                                      mode,
                                      mode === 'REPLACE'
                                        ? chosen || candidates[0]!.id
                                        : null,
                                    )
                                  }
                                  className="accent-accent"
                                />
                                <span className={disposition === mode ? 'text-ink' : 'text-ink-muted'}>
                                  {mode === 'ADD' && 'Add as another session'}
                                  {mode === 'REPLACE' && 'Replace an existing one'}
                                  {mode === 'KEEP' && 'Keep what is there, import nothing'}
                                </span>
                              </label>
                            ))}
                          </div>

                          {disposition === 'REPLACE' && (
                            <label className="mt-2 block">
                              <span className="mb-1 block text-[11px] text-ink-faint">
                                Replaces
                              </span>
                              <select
                                value={chosen || candidates[0]!.id}
                                onChange={(event) =>
                                  setDisposition(path, 'REPLACE', event.target.value)
                                }
                                className="rounded border border-line bg-ground px-2 py-1 text-sm outline-none focus:border-accent"
                              >
                                {candidates.map((existing) => (
                                  <option key={existing.id} value={existing.id}>
                                    {existing.label.replaceAll('_', ' ').toLowerCase()}
                                    {existing.durationMinutes === null
                                      ? ' · duration not logged'
                                      : ` · ${existing.durationMinutes} min`}
                                  </option>
                                ))}
                              </select>
                              <span className="mt-1 block max-w-md text-[11px] leading-snug text-ink-faint">
                                The replaced session is kept on record and stops counting
                                towards the day&rsquo;s totals. Nothing is deleted.
                              </span>
                            </label>
                          )}

                          {disposition === 'KEEP' && (
                            <span className="mt-2 block text-[11px] leading-snug text-ink-faint">
                              This session will not be saved. The paste is still stored verbatim.
                            </span>
                          )}
                        </div>
                      );
                    })()}

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
              disabled={pending || tooManyDays || blocked.length > 0}
              className="inline-flex min-h-11 items-center rounded border border-line-strong px-4 text-sm transition-colors hover:border-accent disabled:opacity-40"
            >
              {pending
                ? 'Importing…'
                : `Confirm import (${preview.records.length} day${preview.records.length === 1 ? '' : 's'})`}
            </button>
            <button
              type="button"
              onClick={() => setPreview(null)}
              disabled={pending}
              className="inline-flex min-h-11 items-center text-xs text-ink-faint hover:text-ink-muted disabled:opacity-40"
            >
              Discard
            </button>
          </div>

          {blocked.length > 0 && (
            <p className="rounded border border-bad/40 bg-bad/5 px-3 py-2 text-sm leading-relaxed text-bad">
              {blocked.length} value{blocked.length === 1 ? '' : 's'} cannot be stored, so
              nothing can be imported yet: {blocked.slice(0, 5).join(', ')}
              {blocked.length > 5 && `, and ${blocked.length - 5} more`}. Correct each one
              marked <span className="uppercase">invalid</span> above, or clear it — a
              cleared field is recorded as not logged.
            </p>
          )}
        </div>
      )}

      {result && <ImportReport result={result} />}
    </div>
  );
}

/**
 * What the import actually did, from what it actually wrote.
 *
 * "Imported 9 rows." was true and useless: it could not be checked against the
 * paste, and it could not distinguish a day that wrote a nutrition log from
 * one that wrote nothing at all. Every figure here comes from the outcomes the
 * server returned - the tables it wrote and how many rows - rather than from
 * categories assumed in advance, so a destination that received nothing simply
 * does not appear.
 */
function ImportReport({ result }: { result: ImportResult }) {
  const summary = summariseImport(result.records);

  return (
    <div
      role="status"
      className={`space-y-4 rounded-lg border p-4 text-sm ${
        result.ok
          ? 'border-good/40 bg-good/5'
          : 'border-warn/40 bg-warn/5'
      }`}
    >
      <p className={result.ok ? 'text-good' : 'text-warn'}>{result.message}</p>

      {summary.groups.length > 0 && (
        <div>
          <h3 className="mb-2 text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint">
            What was written, and where to see it
          </h3>
          <ul className="divide-y divide-line/60">
            {summary.groups.map((group) => (
              <li
                key={group.group}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5"
              >
                <span className="text-ink">{group.group}</span>
                <span className="tabular text-ink-muted">
                  {group.rows} record{group.rows === 1 ? '' : 's'}
                </span>
                <span className="ml-auto text-[11px] text-ink-faint">{group.where}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-line/60 pt-3 text-[11px] text-ink-muted">
        <span className="tabular">
          {summary.imported} day{summary.imported === 1 ? '' : 's'} imported
        </span>
        <span className="tabular">{summary.totalRows} records written</span>
        {summary.duplicates > 0 && (
          <span className="tabular">{summary.duplicates} already imported</span>
        )}
        {summary.skipped > 0 && (
          <span className="tabular">{summary.skipped} had nothing to import</span>
        )}
        {summary.noChange > 0 && (
          <span className="tabular">{summary.noChange} wrote nothing new</span>
        )}
        <span className={`tabular ${summary.failed > 0 ? 'text-bad' : ''}`}>
          {summary.failed} failed
        </span>
      </div>

      {result.records.length > 0 && (
        <details className="border-t border-line/60 pt-3">
          <summary className="cursor-pointer text-[11px] text-ink-faint">
            Day by day
          </summary>
          <ul className="mt-2 space-y-1.5 text-[11px]">
            {result.records.map((record, i) => (
              <li key={i} className="flex flex-wrap gap-x-2">
                <span className="tabular text-ink-muted">{record.date}</span>
                <span
                  className={`uppercase tracking-wide ${
                    record.status === 'FAILED' ? 'text-bad' : 'text-ink-faint'
                  }`}
                >
                  {record.status.toLowerCase()}
                </span>
                <span className="text-ink-muted">{record.message}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {result.errors && (
        <ul className="space-y-1 border-t border-line/60 pt-3 text-[11px] text-bad">
          {Object.entries(result.errors).map(([path, message]) => (
            <li key={path}><code>{path}</code> — {message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
