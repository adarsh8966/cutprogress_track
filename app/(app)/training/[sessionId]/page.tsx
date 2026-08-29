/**
 * One training session (spec §11, §26).
 *
 * The destination the Training page links to, and the answer to "where did my
 * imported workout go?": every field the session stores, shown with where it
 * came from, plus the two things you can do about it - correct it, or add the
 * exercises a summary import could not carry.
 *
 * A field the session does not hold reads "not logged" rather than being
 * omitted, so the page distinguishes "we have no value" from "there is no such
 * field" the same way the rest of the app does.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getWorkoutSession, getSetsForSession } from '@/lib/data/queries';
import { Card, Figure, formatNumber } from '@/components/ui/primitives';
import { SessionEditor } from '@/components/training/SessionEditor';
import { WorkoutLogger } from '@/components/training/WorkoutLogger';
import { apartmentGymExercises } from '@/lib/health/catalog';
import { kgToLb } from '@/lib/normalization/units';
import { formatShortDate } from '@/lib/normalization/dates';
import { todayForUser } from '@/app/actions/log';

export const dynamic = 'force-dynamic';

const SOURCE_LABEL: Record<string, string> = {
  MANUAL: 'entered by hand',
  IMPORT_TEXT: 'imported from a pasted summary',
  HEALTH_CONNECT: 'Health Connect',
  GOOGLE_HEALTH: 'Google Health',
  BEVEL: 'Bevel',
  ESTIMATED: 'estimated',
  OTHER: 'other',
};

export default async function SessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const session = await getWorkoutSession(sessionId);
  if (!session) notFound();

  const [sets, today] = await Promise.all([getSetsForSession(sessionId), todayForUser()]);
  const exercises = apartmentGymExercises();
  // set_number is unique per (session, exercise), so continuing past the
  // session's existing count never collides with a set already logged.
  const nextSetNumber = sets.length + 1;

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <Link href="/training" className="text-xs text-ink-faint hover:text-ink-muted">
          ← Training
        </Link>
        <h1 className="text-xl font-light">
          {session.sessionType.replaceAll('_', ' ').toLowerCase()} ·{' '}
          <span className="text-ink-muted">{formatShortDate(session.date)}</span>
        </h1>
        <p className="text-sm text-ink-muted">
          Recorded {SOURCE_LABEL[session.source] ?? session.source.toLowerCase()}
          {session.importId ? ' — the original paste is kept on Import.' : '.'}
          {sets.length === 0 && ' No exercises or sets are logged for this session.'}
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card title="Duration">
          <Figure
            value={
              session.durationMinutes === null
                ? null
                : formatNumber(session.durationMinutes, 0)
            }
            unit="min"
            size="sm"
          />
        </Card>
        <Card title="Average heart rate">
          <Figure
            value={
              session.averageHeartRate === null
                ? null
                : formatNumber(session.averageHeartRate, 0)
            }
            unit="bpm"
            size="sm"
          />
        </Card>
        <Card title="Maximum heart rate">
          <Figure
            value={
              session.maxHeartRate === null ? null : formatNumber(session.maxHeartRate, 0)
            }
            unit="bpm"
            size="sm"
          />
        </Card>
        <Card title="Calories burned">
          <Figure
            value={session.calories === null ? null : formatNumber(session.calories, 0)}
            unit="kcal"
            size="sm"
          />
        </Card>
      </div>

      <Card title="Exercises and sets">
        {sets.length === 0 ? (
          <p className="py-4 text-sm leading-relaxed text-ink-faint">
            No exercises or sets logged for this session. A summary import records
            that the session happened and how hard it was, but not what was
            performed — so none is assumed here. You can add them below; they will
            attach to this session rather than creating a second one.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[380px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-[0.12em] text-ink-faint">
                  <th className="pb-2 font-medium">Exercise</th>
                  <th className="pb-2 font-medium">Load</th>
                  <th className="pb-2 font-medium">Reps</th>
                  <th className="pb-2 font-medium">RIR</th>
                </tr>
              </thead>
              <tbody>
                {sets.map((set, i) => (
                  <tr key={`${set.exerciseId}-${i}`} className="border-b border-line/60 last:border-0">
                    <td className="py-2 pr-4 text-ink">
                      {set.exerciseName}
                      {set.warmup && (
                        <span className="ml-2 text-[11px] text-ink-faint">warm-up</span>
                      )}
                    </td>
                    <td className="tabular py-2 pr-4">
                      {set.weightKg === null
                        ? '—'
                        : `${formatNumber(kgToLb(set.weightKg), 0)} lb`}
                    </td>
                    <td className="tabular py-2 pr-4">{set.reps ?? '—'}</td>
                    <td className="tabular py-2">{set.rir ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Add exercises to this session">
        <WorkoutLogger
          today={today}
          exercises={exercises}
          existingSessionId={session.id}
          initialSetNumber={nextSetNumber}
        />
      </Card>

      <Card title="Correct this session">
        <SessionEditor
          sessionId={session.id}
          sessionType={session.sessionType}
          durationMinutes={session.durationMinutes}
          averageHeartRate={session.averageHeartRate}
          maxHeartRate={session.maxHeartRate}
          calories={session.calories}
          notes={session.notes}
        />
      </Card>
    </div>
  );
}
