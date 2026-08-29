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
import { getAnalyticsWindow } from '@/lib/data/queries';
import { TrainingView } from '@/components/training/TrainingView';
import {
  summariseTraining, summariseSessions, exercisePerformance, exerciseProgression,
} from '@/lib/analytics/training';
import { apartmentGymExercises } from '@/lib/health/catalog';
import { todayForUser } from '@/app/actions/log';
import { compareDates } from '@/lib/normalization/dates';

export const dynamic = 'force-dynamic';

export default async function TrainingPage() {
  const { sets, sessions } = await getAnalyticsWindow();
  const today = await todayForUser();
  const exercises = apartmentGymExercises();

  const sessionSummary = summariseSessions(sessions, sets);
  const summary = summariseTraining(sets);

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
      today={today}
      exercises={exercises}
    />
  );
}
