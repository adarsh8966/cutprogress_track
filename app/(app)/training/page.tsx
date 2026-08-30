/**
 * Training page (spec §12, §26).
 *
 * Data only. The markup lives in components/training/TrainingView.tsx so the
 * layout can be rendered from fixtures without a database.
 *
 * Sessions and sets are fetched separately and deliberately: `sessions` comes
 * from workout_sessions and exists whether or not anything was logged inside
 * it, while `sets` comes from workout_sets. Reading only the second is what
 * made an imported summary workout invisible on this page.
 *
 * They are then composed into workouts, once, here. Everything on the page
 * that needs a workout - the history, and eventually anything else that wants
 * the same tree - reads that one composition rather than each rebuilding its
 * own from the flat arrays. That is what stopped the page and the analytics
 * from disagreeing about what a workout contained.
 */
import { getAnalyticsWindow, getExerciseLibrary } from '@/lib/data/queries';
import { TrainingView } from '@/components/training/TrainingView';
import {
  composeTraining, summariseTraining, summariseSessions,
  exercisePerformance, exerciseProgression,
} from '@/lib/analytics/training';
import { personalRecords, trainingConsistency } from '@/lib/analytics/prs';
import { todayForUser } from '@/app/actions/log';
import { compareDates } from '@/lib/normalization/dates';
import { unitsOf } from '@/lib/normalization/units';
import { DEFAULT_PROFILE } from '@/lib/defaults';

export const dynamic = 'force-dynamic';

export default async function TrainingPage() {
  const { profile, sets, sessions } = await getAnalyticsWindow();
  const today = await todayForUser();
  // Read from the database, not from the JSON catalog: since 0014 an exercise
  // can also be created by a sync, and a picker reading the seed would offer
  // 118 movements while the user's own history contained others.
  const exercises = await getExerciseLibrary();

  const sessionSummary = summariseSessions(sessions, sets);
  const summary = summariseTraining(sets);
  // Both read the same 90-day window the page is titled with. Records are
  // derived here because no source publishes them (see lib/analytics/prs.ts).
  const records = personalRecords(sets);
  const consistency = trainingConsistency(sessions, sets, today, 12);

  // One workout per session, with its own exercises and sets attached. The
  // composition is pure and happens HERE rather than in the view, so the view
  // still renders from fixtures without a database. It is also a regrouping,
  // not a second read: getAnalyticsWindow already returned every set, already
  // ordered by exercise block and set number, so nothing is queried twice and
  // nothing is stored twice to draw a workout.
  const { workouts, unattachedSets } = composeTraining(sessions, sets);

  // One row per exercise actually performed, most recent first.
  const performed = [...new Set(sets.filter((s) => !s.warmup).map((s) => s.exerciseId))];
  const rows = performed
    .map((exerciseId) => ({
      performance: exercisePerformance(sets, exerciseId),
      progression: exerciseProgression(sets, exerciseId),
    }))
    .filter((row) => row.performance.value !== null)
    .sort((a, b) =>
      compareDates(
        b.performance.value!.lastPerformedOn ?? '',
        a.performance.value!.lastPerformedOn ?? '',
      ),
    );

  return (
    <TrainingView
      workouts={workouts}
      unattachedSets={unattachedSets}
      sessionSummary={sessionSummary}
      summary={summary}
      rows={rows}
      records={records}
      consistency={consistency}
      today={today}
      exercises={exercises}
      units={unitsOf(profile ?? DEFAULT_PROFILE)}
    />
  );
}
