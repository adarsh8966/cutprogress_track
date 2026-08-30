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
 */
import { getAnalyticsWindow, getExerciseLibrary } from '@/lib/data/queries';
import { TrainingView } from '@/components/training/TrainingView';
import {
  summariseTraining, summariseSessions, exercisePerformance, exerciseProgression,
} from '@/lib/analytics/training';
import { personalRecords, trainingConsistency } from '@/lib/analytics/prs';
import { todayForUser } from '@/app/actions/log';
import { compareDates } from '@/lib/normalization/dates';
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

  const setCountBySession = new Map<string, number>();
  for (const set of sets) {
    setCountBySession.set(set.sessionId, (setCountBySession.get(set.sessionId) ?? 0) + 1);
  }

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
      sessions={sessions}
      sessionSummary={sessionSummary}
      summary={summary}
      setCountBySession={setCountBySession}
      rows={rows}
      records={records}
      consistency={consistency}
      today={today}
      exercises={exercises}
      weightUnit={(profile ?? DEFAULT_PROFILE).weightDisplayUnit}
    />
  );
}
