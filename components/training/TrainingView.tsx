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
 * derives a set, a volume or an RIR from a session. The two overview lines at
 * the top are that same distinction, compressed: the labels are what keep it
 * legible now that the figures no longer have a card each.
 *
 * WHAT IS OPEN, AND WHY SO LITTLE IS.
 *
 * The page opens on the question it is named after - what did I train? - and
 * nothing else. Session history is the page. Every analysis below it is real,
 * kept, and closed: progression across workouts, records, muscle-group balance
 * and week-by-week consistency answer questions worth asking, but not all at
 * once and not before being asked. Nothing was removed to achieve that; a
 * section that is closed is one click from open, and the Evidence panel behind
 * every figure comes with it.
 */
import { Figure, StatusDot, formatNumber, type Status } from '@/components/ui/primitives';
import { DisclosureSection } from '@/components/ui/Disclosure';
import { Evidence } from '@/components/ui/Evidence';
import { HorizontalBars } from '@/components/charts/HorizontalBars';
import { WorkoutLogger } from '@/components/training/WorkoutLogger';
import { SessionHistory } from '@/components/training/SessionHistory';
import {
  displayWeight, unitLabels, type DisplayUnits,
} from '@/lib/normalization/units';
import type { Exercise } from '@/lib/health/catalog';
import type { Derived } from '@/lib/types';
import type {
  Workout, LoggedSet, SessionSummary, TrainingSummary,
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

/** "5 exercises", "1 exercise". A closed section says how much is inside it. */
function count(n: number, noun: string): string {
  return `${formatNumber(n)} ${noun}${n === 1 ? '' : 's'}`;
}

export interface ExerciseRow {
  performance: Derived<ExercisePerformance>;
  progression: Derived<ProgressionResult>;
}

/**
 * One line of the overview: what this axis measures, and its figures.
 *
 * The label is not decoration. It is the only thing keeping session-level and
 * exercise-level figures from reading as one list of numbers about the same
 * thing, now that they no longer sit in separately titled cards.
 */
function OverviewLine({
  label,
  facts,
  derived,
}: {
  label: string;
  facts: string[];
  derived: Derived<unknown>;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-3">
      <span className="w-24 shrink-0 text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint">
        {label}
      </span>
      <span className="tabular text-sm text-ink">{facts.join(' · ')}</span>
      <span className="ml-auto">
        <Evidence derived={derived} />
      </span>
    </div>
  );
}

export function TrainingView({
  workouts,
  unattachedSets,
  sessionSummary,
  summary,
  rows,
  records,
  consistency,
  today,
  exercises,
  units,
}: {
  workouts: Workout[];
  /** Sets belonging to no supplied session. Should always be empty. */
  unattachedSets: LoggedSet[];
  sessionSummary: Derived<SessionSummary>;
  summary: Derived<TrainingSummary>;
  rows: ExerciseRow[];
  records: Derived<ExerciseRecords[]>;
  consistency: Derived<TrainingConsistency>;
  today: string;
  exercises: Exercise[];
  /** The user's display units. Loads are stored in kg and read in these. */
  units: DisplayUnits;
}) {
  const s = sessionSummary.value;
  const weightLabel = unitLabels(units).weight;
  const asWeight = (kg: number) => displayWeight(kg, units.weight);
  const hasSessions = (s?.totalSessions ?? 0) > 0;
  const hasSets = (summary.value?.totalWorkingSets ?? 0) > 0;

  // Session-level figures. The first two always appear, stating absence where
  // there is any; heart rate and calories appear only when a source recorded
  // them, because Hevy sends neither and a permanent "not logged" for a field
  // no source fills is noise rather than information.
  const sessionFacts: string[] = [
    `${formatNumber(s?.totalSessions ?? 0)} workout${(s?.totalSessions ?? 0) === 1 ? '' : 's'}`,
    s?.totalMinutes == null ? 'duration not logged' : formatDuration(s.totalMinutes),
  ];
  if (s?.averageHeartRate != null) {
    sessionFacts.push(`avg ${formatNumber(s.averageHeartRate, 0)} bpm`);
  }
  if (s?.maxHeartRate != null) {
    sessionFacts.push(`peak ${formatNumber(s.maxHeartRate, 0)} bpm`);
  }
  if (s?.totalCalories != null) {
    sessionFacts.push(`${formatNumber(s.totalCalories, 0)} kcal`);
  }

  // Exercise-level figures, from logged sets only.
  const exerciseFacts: string[] = [
    `${formatNumber(summary.value?.totalWorkingSets ?? 0)} working sets`,
    summary.value?.totalVolumeKg == null
      ? 'volume not logged'
      : `${formatNumber(asWeight(summary.value.totalVolumeKg), 0)} ${weightLabel}`,
  ];
  // RPE and RIR are two ways of saying the same thing and different sources
  // record different ones - Hevy records RPE, hand-logging here records RIR.
  // The label says which is on screen, so the two are never conflated.
  if (summary.value?.averageRpe != null) {
    exerciseFacts.push(`Avg RPE ${formatNumber(summary.value.averageRpe, 1)}`);
  }
  if (summary.value?.averageRir != null) {
    exerciseFacts.push(`Avg RIR ${formatNumber(summary.value.averageRir, 1)}`);
  }
  if (s) {
    exerciseFacts.push(`in ${formatNumber(s.sessionsWithSets)} of ${formatNumber(s.totalSessions)}`);
  }

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

      <section className="divide-y divide-line/60 border-y border-line/60">
        <OverviewLine label="Sessions" facts={sessionFacts} derived={sessionSummary} />
        <OverviewLine label="Exercises" facts={exerciseFacts} derived={summary} />
      </section>

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

      {/*
        A set whose session is not on this page would be data written and read
        by nothing - the failure this codebase keeps finding. It should be
        unreachable, and it says so out loud rather than being filtered away.
      */}
      {unattachedSets.length > 0 && (
        <p className="rounded border border-warn/40 bg-surface px-4 py-3 text-sm text-warn">
          {unattachedSets.length} logged set
          {unattachedSets.length === 1 ? '' : 's'} belong to a session that is not in
          this window. They are stored and are not counted above.
        </p>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* The page: what was trained, and what was done inside each of them. */}
      {/* ---------------------------------------------------------------- */}
      <section className="space-y-2">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint">
          Session history
        </h2>
        <SessionHistory workouts={workouts} units={units} />
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Analysis across workouts. Kept, and closed until asked for.       */}
      {/* ---------------------------------------------------------------- */}
      <div className="space-y-3">
        <DisclosureSection
          title="Exercise progression"
          sub={rows.length === 0 ? 'nothing logged yet' : count(rows.length, 'exercise')}
        >
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
        </DisclosureSection>

        {records.value !== null && records.value.length > 0 && (
          <DisclosureSection
            title="Personal records"
            sub={count(records.value.length, 'exercise')}
          >
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
          </DisclosureSection>
        )}

        {s && s.byType.length > 0 && (
          <DisclosureSection title="Sessions by type" sub={count(s.byType.length, 'type')}>
            <HorizontalBars
              rows={s.byType.map((type) => ({
                label: type.sessionType.replaceAll('_', ' ').toLowerCase(),
                value: type.sessions,
                sub: type.minutes === null ? 'duration not logged' : formatDuration(type.minutes),
              }))}
              unit="sessions"
            />
          </DisclosureSection>
        )}

        {(summary.value?.byMuscleGroup ?? []).length > 0 && (
          <DisclosureSection
            title="Sets per muscle group"
            sub={count((summary.value?.byMuscleGroup ?? []).length, 'group')}
          >
            <HorizontalBars
              rows={(summary.value?.byMuscleGroup ?? []).map((group) => ({
                label: group.muscleGroup,
                value: group.sets,
                sub: `${group.sessions} session${group.sessions === 1 ? '' : 's'}`,
              }))}
              unit="sets"
            />
          </DisclosureSection>
        )}

        {consistency.value !== null && (
          <DisclosureSection
            title="Training consistency"
            sub={
              consistency.value.sessionsPerWeek === null
                ? undefined
                : `${formatNumber(consistency.value.sessionsPerWeek, 1)} per week`
            }
          >
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
          </DisclosureSection>
        )}

        <DisclosureSection title="Log a workout" sub="by hand">
          <WorkoutLogger today={today} exercises={exercises} weightUnit={weightLabel} />
        </DisclosureSection>
      </div>
    </div>
  );
}
