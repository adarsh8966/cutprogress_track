/**
 * The list of training sessions actually recorded.
 *
 * This is the answer to "I imported a Pull session and Training said nothing
 * was logged". A session appears here because a workout_sessions row exists,
 * full stop - not because anything was logged inside it. What the row does not
 * know, it says it does not know: a summary import has no exercises, and the
 * row states that rather than leaving a gap the reader has to interpret.
 */
import Link from 'next/link';
import { formatNumber } from '@/components/ui/primitives';
import { formatShortDate } from '@/lib/normalization/dates';
import type { TrainingSession } from '@/lib/analytics/training';

export function SessionHistory({
  sessions,
  setCountBySession,
}: {
  sessions: TrainingSession[];
  setCountBySession: Map<string, number>;
}) {
  if (sessions.length === 0) {
    return <p className="py-6 text-sm text-ink-faint">No training sessions recorded yet.</p>;
  }

  return (
    <ul className="divide-y divide-line/60">
      {sessions.map((session) => {
        const sets = setCountBySession.get(session.id) ?? 0;
        return (
          <li key={session.id}>
            <Link
              href={`/training/${session.id}`}
              className="-mx-2 block rounded px-2 py-3 transition-colors hover:bg-raised"
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="tabular text-sm text-ink-muted">
                  {formatShortDate(session.date)}
                </span>
                <span className="text-sm text-ink">
                  {/* The name the source gave it, when it gave one. A title
                      that mapped to OTHER is still worth reading. */}
                  {session.title ?? session.sessionType.replaceAll('_', ' ').toLowerCase()}
                </span>
                {session.title !== null && (
                  <span className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">
                    {session.sessionType.replaceAll('_', ' ').toLowerCase()}
                  </span>
                )}
                <span className="tabular ml-auto text-sm">
                  {session.durationMinutes === null ? (
                    <span className="text-ink-faint">duration not logged</span>
                  ) : (
                    `${formatNumber(session.durationMinutes, 0)} min`
                  )}
                </span>
              </div>

              <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-ink-faint">
                {session.averageHeartRate !== null && (
                  <span className="tabular">
                    avg {formatNumber(session.averageHeartRate, 0)} bpm
                  </span>
                )}
                {session.maxHeartRate !== null && (
                  <span className="tabular">
                    max {formatNumber(session.maxHeartRate, 0)} bpm
                  </span>
                )}
                {session.calories !== null && (
                  <span className="tabular">
                    {formatNumber(session.calories, 0)} kcal
                  </span>
                )}
                {/* Provenance, where the user is looking at the session -
                    spec §15: an imported record says so. */}
                {session.externalSource === 'HEVY' && <span>from Hevy</span>}
                <span className="ml-auto">
                  {sets === 0 ? 'no exercises logged' : `${sets} set${sets === 1 ? '' : 's'}`}
                </span>
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
