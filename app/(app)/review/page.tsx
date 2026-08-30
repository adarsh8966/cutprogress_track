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
import { MIN_COVERAGE } from '@/lib/analytics/movingAverage';
import {
  displayWeight, displayLength, unitsOf, unitLabels,
} from '@/lib/normalization/units';
import { addDays, formatMonth, monthKey, startOfWeek } from '@/lib/normalization/dates';

export const dynamic = 'force-dynamic';

const ASSESSMENT_STATUS: Record<Assessment, Status> = {
  ON_TRACK: 'good',
  AHEAD_OF_PLAN: 'good',
  BEHIND_PLAN: 'warn',
  LOSING_TOO_FAST: 'bad',
  INSUFFICIENT_DATA: 'neutral',
};

/**
 * "1 of 7 days logged", printed under every averaged figure.
 *
 * The count is not decoration. A mean over one logged day and a mean over seven
 * are the same arithmetic and completely different claims, and this page showed
 * both as "Average calories" with nothing to tell them apart. Rather than
 * hiding the sparse one - the data is real and belongs on screen - it is shown
 * with what it is built from.
 */
function Coverage({ days, of }: { days: number; of: number }) {
  return (
    <span className="text-ink-faint">
      {days} of {of} day{of === 1 ? '' : 's'} logged
    </span>
  );
}

/**
 * The word "average" is earned, not assumed.
 *
 * Below the same coverage threshold the rest of the app uses, the label says
 * what the figure actually is - one day's value - instead of dressing it as a
 * period average. The threshold itself is untouched (MIN_COVERAGE).
 */
function averageLabel(metric: string, days: number, of: number): string {
  if (days === 0) return `Average ${metric.toLowerCase()}`;
  if (of > 0 && days / of >= MIN_COVERAGE) return `Average ${metric.toLowerCase()}`;
  return days === 1 ? `${metric}, 1 day logged` : `${metric}, ${days} days logged`;
}

export default async function ReviewPage() {
  const { profile: loaded, end, metrics, sets } = await getAnalyticsWindow();
  const profile = loaded ?? DEFAULT_PROFILE;

  const units = unitsOf(profile);
  const label = unitLabels(units);
  const asWeight = (kg: number) => displayWeight(kg, units.weight);
  const asLength = (cm: number) => displayLength(cm, units.length);

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
          period, not between two single weigh-ins — a single morning reading can
          sit a long way from the truth on water alone. Every figure below says
          how many days it was built from: a value from one logged day is real,
          and it is not a weekly average.
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
            value={w.weightChangeKg === null ? null : formatNumber(asWeight(w.weightChangeKg), 2)}
            unit={label.weight}
            size="sm"
            sub={
              w.startWeightKg !== null && w.endWeightKg !== null ? (
                <span className="tabular text-ink-faint">
                  {formatNumber(asWeight(w.startWeightKg), 1)} →{' '}
                  {formatNumber(asWeight(w.endWeightKg), 1)}
                </span>
              ) : null
            }
          />
          <Figure
            label="Waist change"
            value={w.waistChangeCm === null ? null : formatNumber(asLength(w.waistChangeCm), 2)}
            unit={label.length}
            size="sm"
          />
          <Figure
            label={averageLabel('Calories', w.coverage.calories, w.coverage.days)}
            value={w.averageCalories === null ? null : formatNumber(w.averageCalories, 0)}
            unit="kcal"
            size="sm"
            sub={<Coverage days={w.coverage.calories} of={w.coverage.days} />}
          />
          <Figure
            label={averageLabel('Protein', w.coverage.protein, w.coverage.days)}
            value={w.averageProteinG === null ? null : formatNumber(w.averageProteinG, 0)}
            unit="g"
            size="sm"
            sub={<Coverage days={w.coverage.protein} of={w.coverage.days} />}
          />
          <Figure
            label={averageLabel('Steps', w.coverage.steps, w.coverage.days)}
            value={w.averageSteps === null ? null : formatNumber(w.averageSteps, 0)}
            size="sm"
            sub={<Coverage days={w.coverage.steps} of={w.coverage.days} />}
          />
          <Figure
            label="Training"
            value={formatNumber(w.trainingSessions)}
            sub={
              <span className="text-ink-faint">
                {profile.targets.trainingSessionsPerWeek !== null &&
                  `of ${profile.targets.trainingSessionsPerWeek} planned · `}
                {w.workingSets === 0
                  ? 'no sets logged'
                  : `${formatNumber(w.workingSets)} working sets`}
              </span>
            }
            size="sm"
          />
          <Figure
            label="Cardio"
            value={w.cardioMinutes === null ? null : formatNumber(w.cardioMinutes, 0)}
            unit="min"
            size="sm"
            sub={<Coverage days={w.coverage.cardio} of={w.coverage.days} />}
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
                  : formatNumber(asWeight(lastWeek.value.weightChangeKg), 2)
              }
              unit={label.weight}
              size="sm"
            />
            <Figure
              label={averageLabel(
                'Calories',
                lastWeek.value.coverage.calories,
                lastWeek.value.coverage.days,
              )}
              value={
                lastWeek.value.averageCalories === null
                  ? null
                  : formatNumber(lastWeek.value.averageCalories, 0)
              }
              unit="kcal"
              size="sm"
              sub={
                <Coverage
                  days={lastWeek.value.coverage.calories}
                  of={lastWeek.value.coverage.days}
                />
              }
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
            value={m.startWeightKg === null ? null : formatNumber(asWeight(m.startWeightKg), 1)}
            unit={label.weight}
            size="sm"
          />
          <Figure
            label="Latest weight"
            value={m.endWeightKg === null ? null : formatNumber(asWeight(m.endWeightKg), 1)}
            unit={label.weight}
            size="sm"
          />
          <Figure
            label="Total change"
            value={m.totalChangeKg === null ? null : formatNumber(asWeight(m.totalChangeKg), 2)}
            unit={label.weight}
            size="sm"
          />
          <Figure
            label="Waist change"
            value={m.waistChangeCm === null ? null : formatNumber(asLength(m.waistChangeCm), 2)}
            unit={label.length}
            size="sm"
          />
          <Figure
            label={averageLabel('Calories', m.coverage.calories, m.coverage.days)}
            value={m.averageCalories === null ? null : formatNumber(m.averageCalories, 0)}
            unit="kcal"
            size="sm"
            sub={<Coverage days={m.coverage.calories} of={m.coverage.days} />}
          />
          <Figure
            label={averageLabel('Steps', m.coverage.steps, m.coverage.days)}
            value={m.averageSteps === null ? null : formatNumber(m.averageSteps, 0)}
            size="sm"
            sub={<Coverage days={m.coverage.steps} of={m.coverage.days} />}
          />
          <Figure
            label="Training sessions"
            value={formatNumber(m.trainingSessions)}
            sub={
              <span className="text-ink-faint">
                {m.workingSets === 0
                  ? 'no sets logged'
                  : `${formatNumber(m.workingSets)} working sets`}
              </span>
            }
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
