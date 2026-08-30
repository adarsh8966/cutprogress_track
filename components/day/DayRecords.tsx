'use client';

/**
 * The observations recorded against one day, with what can be done about them.
 *
 * NOTHING HERE DELETES. "Withdraw" marks the row superseded (migrations 0011
 * and 0012): it keeps every measurement it recorded, stops counting towards
 * the day, and can be put back. The wording on the buttons says so, because a
 * control labelled "Delete" in an append-only system is a lie about what the
 * system does.
 *
 * A superseded row stays on screen, in its own section, saying whether it was
 * replaced by a correction or withdrawn by hand. Hiding it would make a
 * correction look like the value had simply changed, and would leave a
 * withdrawal with no way back.
 */
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { withdrawObservation, restoreObservation } from '@/app/actions/corrections';
import {
  formatDayField, presentFields, type DayRecord,
} from '@/lib/data/dayRecords';
import { CardioCorrection } from '@/components/day/CardioCorrection';
import type { DisplayUnits } from '@/lib/normalization/units';

const SOURCE_LABEL: Record<string, string> = {
  MANUAL: 'entered by hand',
  IMPORT_TEXT: 'imported from a paste',
  HEALTH_CONNECT: 'Health Connect',
  GOOGLE_HEALTH: 'Google Health',
  BEVEL: 'Bevel',
  HEVY: 'Hevy',
  ESTIMATED: 'estimated',
  OTHER: 'other source',
};

function recordedAtLabel(iso: string): string {
  if (iso === '') return 'time not recorded';
  return iso.slice(0, 16).replace('T', ' ');
}

export function DayRecords({
  records,
  units,
  date,
}: {
  records: DayRecord[];
  units: DisplayUnits;
  date: string;
}) {
  const [outcome, setOutcome] = useState<{ id: string; ok: boolean; message: string } | null>(
    null,
  );
  const [pending, startTransition] = useTransition();
  const [acting, setActing] = useState<string | null>(null);

  function act(
    record: DayRecord,
    run: (input: { table: string; id: string }) => Promise<{ ok: boolean; message: string }>,
  ) {
    setOutcome(null);
    setActing(record.id);
    startTransition(async () => {
      const result = await run({ table: record.table, id: record.id });
      setOutcome({ id: record.id, ok: result.ok, message: result.message });
      setActing(null);
    });
  }

  const live = records.filter((record) => record.supersededAt === null);
  const gone = records.filter((record) => record.supersededAt !== null);

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint">
          Counting towards this day
        </h2>
        {live.length === 0 ? (
          <p className="rounded border border-line bg-surface px-4 py-3 text-sm text-ink-faint">
            Nothing is recorded for this day.
          </p>
        ) : (
          <ul className="space-y-3">
            {live.map((record) => (
              <Row
                key={record.id}
                record={record}
                units={units}
                date={date}
                busy={pending && acting === record.id}
                outcome={outcome?.id === record.id ? outcome : null}
                action={{
                  label: 'Withdraw',
                  hint: 'Keeps the record and stops it counting',
                  run: () => act(record, withdrawObservation),
                }}
              />
            ))}
          </ul>
        )}
      </section>

      {gone.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint">
            On record, not counted
          </h2>
          <p className="text-[11px] leading-relaxed text-ink-faint">
            Nothing here was deleted. A replaced record was corrected by a later one; a
            withdrawn record was taken out of the day by hand and can be put back.
          </p>
          <ul className="space-y-3">
            {gone.map((record) => (
              <Row
                key={record.id}
                record={record}
                units={units}
                date={date}
                busy={pending && acting === record.id}
                outcome={outcome?.id === record.id ? outcome : null}
                action={
                  record.replaced
                    ? null
                    : {
                      label: 'Restore',
                      hint: 'Counts towards the day again',
                      run: () => act(record, restoreObservation),
                    }
                }
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Row({
  record,
  units,
  date,
  action,
  busy,
  outcome,
}: {
  record: DayRecord;
  units: DisplayUnits;
  date: string;
  action: { label: string; hint: string; run: () => void } | null;
  busy: boolean;
  outcome: { ok: boolean; message: string } | null;
}) {
  const fields = presentFields(record);
  const superseded = record.supersededAt !== null;
  /**
   * Cardio is the one live record with a correction form rather than only a
   * withdrawal, because daily_metrics SUMS it: re-logging a corrected session
   * would give the day both readings. A training session has its own page for
   * the same job, and the resolved scalars need neither - recording the right
   * value again is the correction.
   */
  const correctable = !superseded && record.table === 'cardio_sessions';

  return (
    <li
      className={`rounded-lg border bg-surface p-4 ${
        superseded ? 'border-line/60 opacity-70' : 'border-line'
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm text-ink">
          {record.href ? (
            <Link href={record.href} className="hover:text-accent hover:underline">
              {record.title}
            </Link>
          ) : (
            record.title
          )}
        </span>
        {superseded && (
          <span className="rounded border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-faint">
            {record.replaced ? 'replaced' : 'withdrawn'}
          </span>
        )}
        <span className="ml-auto text-[11px] text-ink-faint">
          {SOURCE_LABEL[record.source] ?? record.source.toLowerCase()}
        </span>
      </div>

      {fields.length === 0 ? (
        <p className="mt-2 text-[11px] text-ink-faint">
          This observation carries no measurement.
        </p>
      ) : (
        <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
          {fields.map((field) => (
            <div key={field.label} className="flex items-baseline gap-1.5">
              <dt className="text-[11px] text-ink-faint">{field.label}</dt>
              <dd className="tabular text-sm text-ink-muted">
                {formatDayField(field, units)}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {record.notes && (
        <p className="mt-2 text-[11px] leading-snug text-ink-faint">{record.notes}</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line/60 pt-2">
        <span className="tabular text-[11px] text-ink-faint">
          recorded {recordedAtLabel(record.recordedAt)}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {correctable && (
            <CardioCorrection record={record} date={date} units={units} />
          )}
          {action && (
            <button
              type="button"
              onClick={action.run}
              disabled={busy}
              title={action.hint}
              className="inline-flex min-h-9 items-center rounded border border-line px-3 text-xs transition-colors hover:border-accent disabled:opacity-40"
            >
              {busy ? 'Saving…' : action.label}
            </button>
          )}
        </div>
        {!action && superseded && record.replaced && (
          <span className="text-[11px] text-ink-faint">
            replaced by a later correction
          </span>
        )}
      </div>

      {outcome && (
        <p
          role="status"
          className={`mt-2 text-[11px] leading-snug ${outcome.ok ? 'text-good' : 'text-bad'}`}
        >
          {outcome.message}
        </p>
      )}
    </li>
  );
}
