/**
 * Weekly and monthly review (spec §51, §52).
 *
 * Both close with the context-pack link, because the review's job is to tee up
 * the coaching conversation rather than to conclude it.
 */
import Link from 'next/link';
import { getAnalyticsWindow } from '@/lib/data/queries';
import { DEFAULT_PROFILE } from '@/lib/defaults';
import { Card, Figure, StatusDot, formatNumber, type Status } from '@/components/ui/primitives';
import { Evidence } from '@/components/ui/Evidence';
import { weeklyReview, monthlyReview, type Assessment } from '@/lib/analytics/reviews';
import { kgToLb, cmToInches } from '@/lib/normalization/units';
import { addDays, formatMonth, monthKey, startOfWeek } from '@/lib/normalization/dates';

export const dynamic = 'force-dynamic';

const ASSESSMENT_STATUS: Record<Assessment, Status> = {
  ON_TRACK: 'good',
  AHEAD_OF_PLAN: 'good',
  BEHIND_PLAN: 'warn',
  LOSING_TOO_FAST: 'bad',
  INSUFFICIENT_DATA: 'neutral',
};

export default async function ReviewPage() {
  const { profile: loaded, end, metrics, sets } = await getAnalyticsWindow();
  const profile = loaded ?? DEFAULT_PROFILE;

  const thisWeek = weeklyReview(metrics, sets, profile.targets, end, profile.maxWeeklyLossRatePct);
  const lastWeek = weeklyReview(
    metrics, sets, profile.targets, addDays(startOfWeek(end), -1), profile.maxWeeklyLossRatePct,
  );
  const thisMonth = monthlyReview(metrics, sets, end);

  const w = thisWeek.value!;
  const m = thisMonth.value!;

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-xl font-light">Review</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-muted">
          Weight change is measured between 7-day averages at each end of the
          period, not between two single weigh-ins - a single morning reading can
          sit a couple of pounds from the truth on water alone.
        </p>
      </header>

      <Card title={`Week of ${w.weekStart}`}>
        <div className="mb-6">
          <StatusDot
            status={ASSESSMENT_STATUS[w.assessment]}
            label={w.assessment.replaceAll('_', ' ').toLowerCase()}
          />
        </div>

        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          <Figure
            label="Weight change"
            value={w.weightChangeKg === null ? null : formatNumber(kgToLb(w.weightChangeKg), 2)}
            unit="lb"
            size="sm"
            sub={
              w.startWeightKg !== null && w.endWeightKg !== null ? (
                <span className="tabular text-ink-faint">
                  {formatNumber(kgToLb(w.startWeightKg), 1)} →{' '}
                  {formatNumber(kgToLb(w.endWeightKg), 1)}
                </span>
              ) : null
            }
          />
          <Figure
            label="Waist change"
            value={w.waistChangeCm === null ? null : formatNumber(cmToInches(w.waistChangeCm), 2)}
            unit="in"
            size="sm"
          />
          <Figure
            label="Average calories"
            value={w.averageCalories === null ? null : formatNumber(w.averageCalories, 0)}
            unit="kcal"
            size="sm"
          />
          <Figure
            label="Average protein"
            value={w.averageProteinG === null ? null : formatNumber(w.averageProteinG, 0)}
            unit="g"
            size="sm"
          />
          <Figure
            label="Average steps"
            value={w.averageSteps === null ? null : formatNumber(w.averageSteps, 0)}
            size="sm"
          />
          <Figure
            label="Training"
            value={formatNumber(w.trainingSessions)}
            sub={
              profile.targets.trainingSessionsPerWeek !== null ? (
                <span className="text-ink-faint">
                  of {profile.targets.trainingSessionsPerWeek} planned
                </span>
              ) : null
            }
            size="sm"
          />
          <Figure
            label="Cardio"
            value={w.cardioMinutes === null ? null : formatNumber(w.cardioMinutes, 0)}
            unit="min"
            size="sm"
          />
          <Figure
            label="Adherence"
            value={
              w.overallAdherence === null ? null : formatNumber(w.overallAdherence * 100, 0)
            }
            unit="%"
            size="sm"
            sub={
              <span className="text-ink-faint">
                {w.daysLogged} of 7 days logged
              </span>
            }
          />
        </div>

        <Evidence derived={thisWeek} />
      </Card>

      {lastWeek.value && (
        <Card title={`Previous week (${lastWeek.value.weekStart})`}>
          <div className="grid gap-6 sm:grid-cols-4">
            <Figure
              label="Weight change"
              value={
                lastWeek.value.weightChangeKg === null
                  ? null
                  : formatNumber(kgToLb(lastWeek.value.weightChangeKg), 2)
              }
              unit="lb"
              size="sm"
            />
            <Figure
              label="Average calories"
              value={
                lastWeek.value.averageCalories === null
                  ? null
                  : formatNumber(lastWeek.value.averageCalories, 0)
              }
              unit="kcal"
              size="sm"
            />
            <Figure
              label="Training"
              value={formatNumber(lastWeek.value.trainingSessions)}
              size="sm"
            />
            <Figure
              label="Adherence"
              value={
                lastWeek.value.overallAdherence === null
                  ? null
                  : formatNumber(lastWeek.value.overallAdherence * 100, 0)
              }
              unit="%"
              size="sm"
            />
          </div>
        </Card>
      )}

      <Card title={formatMonth(monthKey(end))}>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          <Figure
            label="Starting weight"
            value={m.startWeightKg === null ? null : formatNumber(kgToLb(m.startWeightKg), 1)}
            unit="lb"
            size="sm"
          />
          <Figure
            label="Latest weight"
            value={m.endWeightKg === null ? null : formatNumber(kgToLb(m.endWeightKg), 1)}
            unit="lb"
            size="sm"
          />
          <Figure
            label="Total change"
            value={m.totalChangeKg === null ? null : formatNumber(kgToLb(m.totalChangeKg), 2)}
            unit="lb"
            size="sm"
          />
          <Figure
            label="Waist change"
            value={m.waistChangeCm === null ? null : formatNumber(cmToInches(m.waistChangeCm), 2)}
            unit="in"
            size="sm"
          />
          <Figure
            label="Average calories"
            value={m.averageCalories === null ? null : formatNumber(m.averageCalories, 0)}
            unit="kcal"
            size="sm"
          />
          <Figure
            label="Average steps"
            value={m.averageSteps === null ? null : formatNumber(m.averageSteps, 0)}
            size="sm"
          />
          <Figure
            label="Training sessions"
            value={formatNumber(m.trainingSessions)}
            size="sm"
          />
          <Figure
            label="Longest logging streak"
            value={formatNumber(m.longestLoggingStreak)}
            unit="days"
            size="sm"
            sub={
              <span className="text-ink-faint">
                {m.daysLogged} of {m.dayCount} days logged
              </span>
            }
          />
        </div>
        <Evidence derived={thisMonth} />
      </Card>

      <Card>
        <p className="text-sm leading-relaxed text-ink-muted">
          This review states what happened. For the interpretation - whether to
          change anything, and what -{' '}
          <Link href="/context" className="text-accent hover:underline">
            generate a context pack
          </Link>{' '}
          and hand it to ChatGPT.
        </p>
      </Card>
    </div>
  );
}
