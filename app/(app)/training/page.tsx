/**
 * Training page (spec §12, §26).
 */
import { getAnalyticsWindow } from '@/lib/data/queries';
import { Card, Figure, StatusDot, formatNumber, type Status } from '@/components/ui/primitives';
import { Evidence } from '@/components/ui/Evidence';
import { HorizontalBars } from '@/components/charts/HorizontalBars';
import { WorkoutLogger } from '@/components/training/WorkoutLogger';
import {
  summariseTraining, exercisePerformance, exerciseProgression,
} from '@/lib/analytics/training';
import { kgToLb } from '@/lib/normalization/units';
import { apartmentGymExercises } from '@/lib/health/catalog';
import { todayForUser } from '@/app/actions/log';
import { compareDates } from '@/lib/normalization/dates';

export const dynamic = 'force-dynamic';

const PROGRESSION_STATUS: Record<string, Status> = {
  WEIGHT_INCREASED: 'good',
  REPS_INCREASED: 'good',
  VOLUME_INCREASED: 'good',
  STAGNANT: 'warn',
  DECLINING: 'bad',
  INSUFFICIENT_DATA: 'neutral',
};

export default async function TrainingPage() {
  const { sets } = await getAnalyticsWindow();
  const today = await todayForUser();
  const exercises = apartmentGymExercises();
  const summary = summariseTraining(sets);

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
    <div className="space-y-8">
      <header>
        <h1 className="text-xl font-light">Training</h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-muted">
          Last 90 days. Warm-up sets are recorded but excluded from volume and
          bests, so adding them never looks like progress.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card title="Sessions">
          <Figure
            value={
              summary.value ? formatNumber(summary.value.totalSessions) : null
            }
            size="sm"
          />
        </Card>
        <Card title="Working sets">
          <Figure
            value={
              summary.value ? formatNumber(summary.value.totalWorkingSets) : null
            }
            size="sm"
          />
        </Card>
        <Card title="Volume">
          <Figure
            value={
              summary.value?.totalVolumeKg == null
                ? null
                : formatNumber(kgToLb(summary.value.totalVolumeKg), 0)
            }
            unit="lb"
            size="sm"
          />
        </Card>
        <Card title="Average RIR">
          <Figure
            value={
              summary.value?.averageRir == null
                ? null
                : formatNumber(summary.value.averageRir, 1)
            }
            size="sm"
          />
          <Evidence derived={summary} />
        </Card>
      </div>

      <Card title="Sets per muscle group">
        <HorizontalBars
          rows={(summary.value?.byMuscleGroup ?? []).map((group) => ({
            label: group.muscleGroup,
            value: group.sets,
            sub: `${group.sessions} session${group.sessions === 1 ? '' : 's'}`,
          }))}
          unit="sets"
        />
      </Card>

      <Card title="Exercise progression">
        {rows.length === 0 ? (
          <p className="text-sm text-ink-faint">No exercises logged yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-[0.12em] text-ink-faint">
                  <th className="pb-2 font-medium">Exercise</th>
                  <th className="pb-2 font-medium">Last</th>
                  <th className="pb-2 font-medium">Best load</th>
                  <th className="pb-2 font-medium">Best e1RM</th>
                  <th className="pb-2 font-medium">Trend</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ performance, progression }) => {
                  const p = performance.value!;
                  return (
                    <tr key={p.exerciseId} className="border-b border-line/60 last:border-0">
                      <td className="py-2.5 pr-4 text-ink">{p.exerciseName}</td>
                      <td className="tabular py-2.5 pr-4 text-ink-muted">
                        {p.lastSets
                          .map((s) =>
                            s.weightKg == null || s.reps == null
                              ? '—'
                              : `${formatNumber(kgToLb(s.weightKg), 0)}×${s.reps}`,
                          )
                          .join(', ')}
                      </td>
                      <td className="tabular py-2.5 pr-4">
                        {p.bestWeightKg == null
                          ? '—'
                          : `${formatNumber(kgToLb(p.bestWeightKg), 0)} lb`}
                      </td>
                      <td className="tabular py-2.5 pr-4">
                        {p.bestEstimated1rmKg == null
                          ? '—'
                          : `${formatNumber(kgToLb(p.bestEstimated1rmKg), 0)} lb`}
                      </td>
                      <td className="py-2.5">
                        <StatusDot
                          status={
                            PROGRESSION_STATUS[progression.value?.state ?? 'INSUFFICIENT_DATA'] ??
                            'neutral'
                          }
                          label={(progression.value?.state ?? 'INSUFFICIENT_DATA')
                            .replaceAll('_', ' ')
                            .toLowerCase()}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-4 text-[11px] leading-relaxed text-ink-faint">
              e1RM is estimated from working sets with the Epley formula, not from a
              tested max.
            </p>
          </div>
        )}
      </Card>

      <Card title="Log a workout">
        <WorkoutLogger today={today} exercises={exercises} />
      </Card>
    </div>
  );
}
