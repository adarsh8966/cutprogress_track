/**
 * The Training page's markup, separated from its data fetching.
 *
 * The split is what lets the layout be rendered from fixtures - in a test or a
 * screenshot harness - without a database behind it. The route stays a thin
 * wrapper that fetches and passes; everything visual lives here.
 *
 * TWO MEASUREMENTS, KEPT APART.
 *
 * A training session and the exercises inside it are different observations,
 * and this page used to conflate them: every figure came from summariseTraining
 * (workout_sets), so a session with no sets counted as no session at all. An
 * imported "Workout: Pull, 58 min, avg HR 142" - a real, complete, session-level
 * record - read as "Sessions: 0 / Nothing logged yet", which is the one thing a
 * measurement system must never say about data it holds.
 *
 * So the page reports the two separately and says which is which. Session
 * figures are true whether or not anything was logged inside them. Exercise
 * figures are absent - explicitly, by name - when no sets exist. Nothing here
 * derives a set, a volume or an RIR from a session.
 */
import { Card, Figure, StatusDot, formatNumber, type Status } from '@/components/ui/primitives';
import { Evidence } from '@/components/ui/Evidence';
import { HorizontalBars } from '@/components/charts/HorizontalBars';
import { WorkoutLogger } from '@/components/training/WorkoutLogger';
import { SessionHistory } from '@/components/training/SessionHistory';
import { displayWeight, type WeightUnit, WEIGHT_UNIT_LABEL } from '@/lib/normalization/units';
import type { Exercise } from '@/lib/health/catalog';
import type { Derived } from '@/lib/types';
import type {
  TrainingSession, SessionSummary, TrainingSummary,
  ExercisePerformance, ProgressionResult,
} from '@/lib/analytics/training';
import type { ExerciseRecords, TrainingConsistency } from '@/lib/analytics/prs';

const PROGRESSION_STATUS: Record<string, Status> = {
  WEIGHT_INCREASED: 'good',
  REPS_INCREASED: 'good',
  VOLUME_INCREASED: 'good',
  STAGNANT: 'warn',
  DECLINING: 'bad',
  INSUFFICIENT_DATA: 'neutral',
};

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${formatNumber(minutes, 0)} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${formatNumber(minutes - hours * 60, 0)}m`;
}

export interface ExerciseRow {
  performance: Derived<ExercisePerformance>;
  progression: Derived<ProgressionResult>;
}

export function TrainingView({
  sessions,
  sessionSummary,
  summary,
  setCountBySession,
  rows,
  records,
  consistency,
  today,
  exercises,
  weightUnit,
}: {
  sessions: TrainingSession[];
  sessionSummary: Derived<SessionSummary>;
  summary: Derived<TrainingSummary>;
  setCountBySession: Map<string, number>;
  rows: ExerciseRow[];
  records: Derived<ExerciseRecords[]>;
  consistency: Derived<TrainingConsistency>;
  today: string;
  exercises: Exercise[];
  /** The user's display unit. Loads are stored in kg and read in this. */
  weightUnit: WeightUnit;
}) {
  const s = sessionSummary.value;
  const weightLabel = WEIGHT_UNIT_LABEL[weightUnit];
  const asWeight = (kg: number) => displayWeight(kg, weightUnit);
  const hasSessions = (s?.totalSessions ?? 0) > 0;
  const hasSets = (summary.value?.totalWorkingSets ?? 0) > 0;

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-xl font-light">Training</h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-muted">
          Last 90 days. Sessions and exercises are recorded separately: a session
          is what you did, sets are what you logged inside it. A session imported
          as a summary has no sets, and none are invented for it.
        </p>
      </header>

      {/* ---------------------------------------------------------------- */}
      {/* Session level: true for every recorded session, imported or not.  */}
      {/* ---------------------------------------------------------------- */}
      <section className="space-y-4">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint">
          Training sessions
        </h2>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card title="Sessions">
            <Figure value={s ? formatNumber(s.totalSessions) : null} size="sm" />
          </Card>
          <Card title="Training time">
            <Figure
              value={s?.totalMinutes == null ? null : formatDuration(s.totalMinutes)}
              size="sm"
            />
          </Card>
          <Card title="Average heart rate">
            <Figure
              value={s?.averageHeartRate == null ? null : formatNumber(s.averageHeartRate, 0)}
              unit="bpm"
              size="sm"
              sub={
                s?.maxHeartRate == null
                  ? undefined
                  : `peak ${formatNumber(s.maxHeartRate, 0)} bpm`
              }
            />
          </Card>
          <Card title="Calories burned">
            <Figure
              value={s?.totalCalories == null ? null : formatNumber(s.totalCalories, 0)}
              unit="kcal"
              size="sm"
            />
            <Evidence derived={sessionSummary} />
          </Card>
        </div>

        {s && s.byType.length > 0 && (
          <Card title="Sessions by type">
            <HorizontalBars
              rows={s.byType.map((type) => ({
                label: type.sessionType.replaceAll('_', ' ').toLowerCase(),
                value: type.sessions,
                sub: type.minutes === null ? 'duration not logged' : formatDuration(type.minutes),
              }))}
              unit="sessions"
            />
          </Card>
        )}

        <Card title="Session history">
          <SessionHistory sessions={sessions} setCountBySession={setCountBySession} />
        </Card>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Exercise level: only ever from logged sets. Absent, never faked.  */}
      {/* ---------------------------------------------------------------- */}
      <section className="space-y-4">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint">
          Exercises and sets
        </h2>

        {!hasSets && (
          <p className="rounded border border-line bg-surface px-4 py-3 text-sm leading-relaxed text-ink-muted">
            {hasSessions ? (
              <>
                No exercises or sets logged yet.{' '}
                <span className="text-ink-faint">
                  {s!.sessionsWithoutSets} of your {s!.totalSessions} recorded
                  session{s!.totalSessions === 1 ? '' : 's'} came in as a summary, which
                  records the session but not what was performed. Volume, RIR and
                  progression need set-level data — open a session to add its
                  exercises.
                </span>
              </>
            ) : (
              'No exercises or sets logged yet.'
            )}
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card title="Sessions with sets">
            <Figure value={s ? formatNumber(s.sessionsWithSets) : null} size="sm" />
          </Card>
          <Card title="Working sets">
            <Figure
              value={summary.value ? formatNumber(summary.value.totalWorkingSets) : null}
              size="sm"
            />
          </Card>
          <Card title="Volume">
            <Figure
              value={
                summary.value?.totalVolumeKg == null
                  ? null
                  : formatNumber(asWeight(summary.value.totalVolumeKg), 0)
              }
              unit={weightLabel}
              size="sm"
            />
          </Card>
          {/*
            RPE and RIR are two ways of saying the same thing and different
            sources record different ones - Hevy records RPE, hand-logging here
            records RIR. Showing whichever exists beats showing an empty card
            for the one that does not; the label says which is on screen, so
            the two are never silently conflated.
          */}
          <Card title={summary.value?.averageRpe == null ? 'Average RIR' : 'Average RPE'}>
            <Figure
              value={
                summary.value?.averageRpe != null
                  ? formatNumber(summary.value.averageRpe, 1)
                  : summary.value?.averageRir == null
                    ? null
                    : formatNumber(summary.value.averageRir, 1)
              }
              size="sm"
              sub={
                summary.value?.averageRpe != null && summary.value?.averageRir != null
                  ? `RIR ${formatNumber(summary.value.averageRir, 1)}`
                  : undefined
              }
            />
            <Evidence derived={summary} />
          </Card>
        </div>

        <Card title="Sets per muscle group">
          {(summary.value?.byMuscleGroup ?? []).length === 0 ? (
            <p className="py-6 text-sm text-ink-faint">
              No exercises or sets logged yet.
            </p>
          ) : (
            <HorizontalBars
              rows={(summary.value?.byMuscleGroup ?? []).map((group) => ({
                label: group.muscleGroup,
                value: group.sets,
                sub: `${group.sessions} session${group.sessions === 1 ? '' : 's'}`,
              }))}
              unit="sets"
            />
          )}
        </Card>

        <Card title="Exercise progression">
          {rows.length === 0 ? (
            <p className="text-sm text-ink-faint">No exercises logged yet.</p>
          ) : (
            <div>
              {/*
                A responsive grid, not a table in a horizontal scroller. Five
                columns need 560px, which is wider than any phone, so scrolling
                sideways was the only way to read the last two - on the page
                most likely to be opened in a gym. Below sm each exercise is a
                card with its figures labelled; from sm up it is the same table
                as before, from the same markup.
              */}
              <div
                role="row"
                className="hidden border-b border-line pb-2 text-[11px] uppercase tracking-[0.12em] text-ink-faint sm:grid sm:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] sm:gap-x-4"
              >
                <span>Exercise</span>
                <span>Last</span>
                <span>Best load</span>
                <span>Best e1RM</span>
                <span>Trend</span>
              </div>
              <ul className="divide-y divide-line/60">
                {rows.map(({ performance, progression }) => {
                  const p = performance.value!;
                  const last = p.lastSets
                    .map((set) =>
                      set.weightKg == null || set.reps == null
                        ? '—'
                        : `${formatNumber(asWeight(set.weightKg), 0)}×${set.reps}`,
                    )
                    .join(', ');
                  const cells: { label: string; value: React.ReactNode }[] = [
                    { label: 'Last', value: <span className="tabular">{last || '—'}</span> },
                    {
                      label: 'Best load',
                      value: (
                        <span className="tabular">
                          {p.bestWeightKg == null
                            ? '—'
                            : `${formatNumber(asWeight(p.bestWeightKg), 0)} ${weightLabel}`}
                        </span>
                      ),
                    },
                    {
                      label: 'Best e1RM',
                      value: (
                        <span className="tabular">
                          {p.bestEstimated1rmKg == null
                            ? '—'
                            : `${formatNumber(asWeight(p.bestEstimated1rmKg), 0)} ${weightLabel}`}
                        </span>
                      ),
                    },
                    {
                      label: 'Trend',
                      value: (
                        <StatusDot
                          status={
                            PROGRESSION_STATUS[progression.value?.state ?? 'INSUFFICIENT_DATA']
                            ?? 'neutral'
                          }
                          label={(progression.value?.state ?? 'INSUFFICIENT_DATA')
                            .replaceAll('_', ' ')
                            .toLowerCase()}
                        />
                      ),
                    },
                  ];
                  return (
                    <li
                      key={p.exerciseId}
                      className="py-3 sm:grid sm:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] sm:items-baseline sm:gap-x-4"
                    >
                      <span className="text-sm text-ink">{p.exerciseName}</span>
                      {cells.map((cell) => (
                        <span
                          key={cell.label}
                          className="mt-1 flex items-baseline gap-2 text-sm sm:mt-0 sm:block"
                        >
                          <span className="w-20 shrink-0 text-[11px] text-ink-faint sm:hidden">
                            {cell.label}
                          </span>
                          {cell.value}
                        </span>
                      ))}
                    </li>
                  );
                })}
              </ul>
              <p className="mt-4 text-[11px] leading-relaxed text-ink-faint">
                e1RM is estimated from working sets with the Epley formula, not from a
                tested max. Warm-up sets are recorded but excluded from volume and
                bests, so adding them never looks like progress.
              </p>
            </div>
          )}
        </Card>
      </section>

      {records.value !== null && records.value.length > 0 && (
        <Card title="Personal records">
          <p className="mb-3 text-[11px] leading-relaxed text-ink-faint">
            Derived from your own logged sets — Hevy publishes no personal-record
            data, so every figure here can show its working. A record keeps the
            date it was first reached; matching it again does not move it.
          </p>
          <ul className="divide-y divide-line/60">
            {records.value.slice(0, 12).map((record) => (
              <li
                key={record.exerciseId}
                className="py-3 sm:grid sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] sm:items-baseline sm:gap-x-4"
              >
                <span className="text-sm text-ink">
                  {record.exerciseName}
                  {record.setOnLastSession && (
                    <span className="ml-2 text-[11px] text-good">new</span>
                  )}
                </span>
                <span className="mt-1 flex flex-wrap items-baseline gap-x-4 text-sm sm:mt-0 sm:contents">
                  <span className="tabular">
                    <span className="mr-1.5 text-[11px] text-ink-faint sm:hidden">Heaviest</span>
                    {record.heaviest === null
                      ? '—'
                      : `${formatNumber(asWeight(record.heaviest.value), 0)} ${weightLabel}`}
                  </span>
                  <span className="tabular">
                    <span className="mr-1.5 text-[11px] text-ink-faint sm:hidden">Most reps</span>
                    {record.mostReps?.value ?? '—'}
                  </span>
                  <span className="tabular">
                    <span className="mr-1.5 text-[11px] text-ink-faint sm:hidden">Best e1RM</span>
                    {record.bestEstimated1rm === null
                      ? '—'
                      : `${formatNumber(asWeight(record.bestEstimated1rm.value), 0)} ${weightLabel}`}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <Evidence derived={records} />
        </Card>
      )}

      {consistency.value !== null && (
        <Card title="Training consistency">
          <div className="grid gap-4 sm:grid-cols-3">
            <Figure
              value={
                consistency.value.sessionsPerWeek === null
                  ? null
                  : formatNumber(consistency.value.sessionsPerWeek, 1)
              }
              unit="/week"
              size="sm"
              sub="sessions"
            />
            <Figure
              value={
                consistency.value.averageSessionMinutes === null
                  ? null
                  : formatNumber(consistency.value.averageSessionMinutes, 0)
              }
              unit="min"
              size="sm"
              sub="average session"
            />
            <Figure
              value={
                consistency.value.averageRpe === null
                  ? null
                  : formatNumber(consistency.value.averageRpe, 1)
              }
              size="sm"
              sub="average RPE"
            />
          </div>
          <HorizontalBars
            rows={consistency.value.weeks.map((week) => ({
              label: week.weekStart,
              value: week.sessions,
              sub: week.minutes === null
                ? 'no duration logged'
                : formatDuration(week.minutes),
            }))}
            unit="sessions"
          />
          <Evidence derived={consistency} />
        </Card>
      )}

      <Card title="Log a workout">
        <WorkoutLogger today={today} exercises={exercises} weightUnit={weightLabel} />
      </Card>
    </div>
  );
}
