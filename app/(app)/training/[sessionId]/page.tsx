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
import {
  getProfile, getWorkoutSession, getSetsForSession, getExerciseLibrary,
} from '@/lib/data/queries';
import { DEFAULT_PROFILE } from '@/lib/defaults';
import { Card, Figure, formatNumber } from '@/components/ui/primitives';
import { SessionEditor } from '@/components/training/SessionEditor';
import { WorkoutLogger } from '@/components/training/WorkoutLogger';

import { displayWeight, WEIGHT_UNIT_LABEL } from '@/lib/normalization/units';
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

  const [sets, today, loaded, exercises] = await Promise.all([
    getSetsForSession(sessionId), todayForUser(), getProfile(), getExerciseLibrary(),
  ]);
  const profile = loaded ?? DEFAULT_PROFILE;
  const weightUnit = WEIGHT_UNIT_LABEL[profile.weightDisplayUnit];
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
          <div>
            {/* Four columns in a scroller was unreadable at 320px on the page
                most likely to be open mid-session. Below sm each set is a row
                of labelled figures; from sm up it is the same grid as before. */}
            <div className="hidden border-b border-line pb-2 text-[11px] uppercase tracking-[0.12em] text-ink-faint sm:grid sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] sm:gap-x-4">
              <span>Exercise</span>
              <span>Load</span>
              <span>Reps</span>
              <span>RIR</span>
            </div>
            <ul className="divide-y divide-line/60">
              {sets.map((set, i) => (
                <li
                  key={`${set.exerciseId}-${i}`}
                  className="py-2.5 sm:grid sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] sm:items-baseline sm:gap-x-4"
                >
                  <span className="text-sm text-ink">
                    {set.exerciseName}
                    {set.warmup && (
                      <span className="ml-2 text-[11px] text-ink-faint">warm-up</span>
                    )}
                  </span>
                  <span className="mt-1 flex items-baseline gap-4 text-sm sm:mt-0 sm:contents">
                    <span className="tabular">
                      <span className="mr-1.5 text-[11px] text-ink-faint sm:hidden">Load</span>
                      {set.weightKg === null
                        ? '—'
                        : `${formatNumber(
                          displayWeight(set.weightKg, profile.weightDisplayUnit), 0,
                        )} ${weightUnit}`}
                    </span>
                    <span className="tabular">
                      <span className="mr-1.5 text-[11px] text-ink-faint sm:hidden">Reps</span>
                      {set.reps ?? '—'}
                    </span>
                    <span className="tabular">
                      <span className="mr-1.5 text-[11px] text-ink-faint sm:hidden">RIR</span>
                      {set.rir ?? '—'}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <Card title="Add exercises to this session">
        <WorkoutLogger
          today={today}
          exercises={exercises}
          weightUnit={weightUnit}
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
