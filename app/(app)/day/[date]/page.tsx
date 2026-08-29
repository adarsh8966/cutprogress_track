/**
 * One day, in full (spec §6, §16, §17, §41, §48).
 *
 * THE PAGE THAT ANSWERS "WHERE DID THAT GO?". Every other screen reads
 * daily_metrics - one resolved row per day, which is the right thing to
 * analyse and the wrong thing to correct. It cannot say which of two weigh-ins
 * it is showing, it has no id to act on, and it cannot show a value that lost.
 *
 * So this page shows both layers at once:
 *
 *   what the day RESOLVES TO, with the source that won each field and a
 *   warning where two sources disagreed (spec §16), and
 *
 *   the OBSERVATIONS themselves, including the ones that no longer count,
 *   each with the one action this system permits on a record - withdrawing it,
 *   which marks it superseded and never deletes it.
 *
 * The provenance behind the first half has been written on every rebuild since
 * migration 0005 and was read by nothing until this page existed.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDayDetail, getProfile } from '@/lib/data/queries';
import { DEFAULT_PROFILE } from '@/lib/defaults';
import { Card } from '@/components/ui/primitives';
import { DayRecords } from '@/components/day/DayRecords';
import {
  canonicalSummary, formatDayField, liveRecords,
} from '@/lib/data/dayRecords';
import { conflicts, corrections } from '@/lib/normalization/canonical';
import { addDays, formatShortDate, isLocalDate } from '@/lib/normalization/dates';
import { unitsOf } from '@/lib/normalization/units';
import { todayForUser } from '@/app/actions/log';
import type { LocalDate } from '@/lib/types';

export const dynamic = 'force-dynamic';

const CONFIDENCE_TONE: Record<string, string> = {
  HIGH: 'text-ink-faint',
  MODERATE: 'text-warn',
  LOW: 'text-bad',
};

export default async function DayPage({
  params,
}: {
  params: Promise<{ date: string }>;
}) {
  const { date } = await params;
  if (!isLocalDate(date)) notFound();

  const [detail, loaded, today] = await Promise.all([
    getDayDetail(date as LocalDate),
    getProfile(),
    todayForUser(),
  ]);
  const profile = loaded ?? DEFAULT_PROFILE;
  const units = unitsOf(profile);

  const disagreeing = new Set(conflicts(detail.provenance));
  const corrected = new Set(corrections(detail.provenance));
  const summary = detail.canonical === null ? [] : canonicalSummary(detail.canonical);
  const recorded = summary.filter((field) => field.value !== null);
  const live = liveRecords(detail.records);

  const previous = addDays(date as LocalDate, -1);
  const next = addDays(date as LocalDate, 1);

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <Link href="/progress" className="text-xs text-ink-faint hover:text-ink-muted">
          ← Progress
        </Link>
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
          <h1 className="text-xl font-light">
            {formatShortDate(date as LocalDate)}
            <span className="ml-2 text-sm text-ink-faint">{date}</span>
          </h1>
          <nav className="ml-auto flex items-center gap-x-4 text-xs">
            <Link href={`/day/${previous}`} className="text-ink-faint hover:text-accent">
              ← {formatShortDate(previous)}
            </Link>
            {date < today && (
              <Link href={`/day/${next}`} className="text-ink-faint hover:text-accent">
                {formatShortDate(next)} →
              </Link>
            )}
            <Link href={`/quick?date=${date}`} className="text-accent hover:underline">
              Add to this day
            </Link>
          </nav>
        </div>
        <p className="max-w-2xl text-sm leading-relaxed text-ink-muted">
          Everything recorded against this day, and what it resolves to. Records are
          never deleted here: withdrawing one keeps it on file and stops it counting,
          and it can be put back.
        </p>
      </header>

      {detail.incomplete && (
        <p className="rounded border border-warn/40 bg-warn/5 px-3 py-2 text-sm text-warn">
          Some of this day&rsquo;s records could not be read, so what is below may be
          incomplete. This is not the same as the day being empty — do not withdraw
          anything until the list loads in full.
        </p>
      )}

      <Card title="What this day resolves to">
        {detail.canonical === null ? (
          <p className="text-sm text-ink-faint">
            This day has no canonical summary yet. That happens when nothing has been
            recorded for it, or when a write landed without a rebuild — the raw records
            below are the truth either way, and rebuilding from Settings will recompute
            this.
          </p>
        ) : recorded.length === 0 ? (
          <p className="text-sm text-ink-faint">Nothing was measured on this day.</p>
        ) : (
          <>
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
              {recorded.map((field) => {
                const entry = detail.provenance[field.key];
                const isConflict = disagreeing.has(field.key);
                return (
                  <div key={field.key} className="border-b border-line/50 pb-2">
                    <dt className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">
                      {field.label}
                    </dt>
                    <dd className="tabular mt-0.5 text-sm text-ink">
                      {formatDayField(field, units)}
                    </dd>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px]">
                      {field.aggregate ? (
                        <span className="text-ink-faint">
                          total of this day&rsquo;s sessions
                        </span>
                      ) : entry ? (
                        <>
                          <span className="text-ink-faint">
                            {entry.source.replaceAll('_', ' ').toLowerCase()}
                          </span>
                          {(entry.sources ?? entry.candidates) > 1 && (
                            <span className={CONFIDENCE_TONE[entry.confidence] ?? 'text-ink-faint'}>
                              · {entry.sources ?? entry.candidates} sources,{' '}
                              {entry.confidence.toLowerCase()} agreement
                            </span>
                          )}
                          {corrected.has(field.key) && (
                            <span className="text-ink-faint">· corrected</span>
                          )}
                        </>
                      ) : (
                        <span className="text-ink-faint">source not recorded</span>
                      )}
                    </div>
                    {isConflict && (
                      <p className="mt-1 text-[11px] leading-snug text-warn">
                        Two sources disagreed about this. The value above is the most
                        recent; both readings are listed below and neither was discarded.
                      </p>
                    )}
                  </div>
                );
              })}
            </dl>
            {disagreeing.size > 0 && (
              <p className="mt-4 border-t border-line pt-3 text-[11px] leading-relaxed text-warn">
                {disagreeing.size} field{disagreeing.size === 1 ? '' : 's'} on this day had
                sources that disagree. Nothing was overwritten — withdraw whichever reading
                is wrong, or record the right one.
              </p>
            )}
          </>
        )}
      </Card>

      <DayRecords records={detail.records} units={units} date={date} />

      {live.length > 0 && (
        <p className="text-[11px] leading-relaxed text-ink-faint">
          Correcting a weight, a nutrition log, a step count or a night&rsquo;s sleep means
          recording the right value again — the most recent observation for a day is the
          one that counts. Withdraw a record only when it should not count at all.
        </p>
      )}
    </div>
  );
}
