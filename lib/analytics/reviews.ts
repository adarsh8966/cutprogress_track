/**
 * Weekly and monthly reviews (spec §51, §52).
 *
 * Both are pure summaries over a closed date range. They compute nothing new -
 * they assemble the same Derived values the rest of the app uses, so a figure in
 * the weekly review always matches the same figure on the dashboard.
 */
import type { DailyMetrics, Derived, LocalDate, Targets } from '@/lib/types';
import { derived } from '@/lib/types';
import type { LoggedSet } from './training';
import { summariseTraining } from './training';
import { computeAdherence } from './adherence';
import { trailingAverage } from './movingAverage';
import { daysBetween, endOfMonth, endOfWeek, startOfMonth, startOfWeek } from '@/lib/normalization/dates';
import { mean, presentValues, roundTo } from './series';
import type { DatedValue } from '@/lib/types';

export type Assessment =
  | 'ON_TRACK'
  | 'AHEAD_OF_PLAN'
  | 'BEHIND_PLAN'
  | 'LOSING_TOO_FAST'
  | 'INSUFFICIENT_DATA';

export interface WeeklyReview {
  weekStart: LocalDate;
  weekEnd: LocalDate;
  startWeightKg: number | null;
  endWeightKg: number | null;
  weightChangeKg: number | null;
  waistChangeCm: number | null;
  averageCalories: number | null;
  averageProteinG: number | null;
  averageSteps: number | null;
  /**
   * Sessions recorded that week, counted from daily_metrics - the same source
   * the adherence block below uses. It used to be counted from workout_sets
   * instead, so a week of imported summary sessions reported "0 sessions"
   * directly beside "training adherence 100%": two numbers about the same week
   * disagreeing because they were reading different tables.
   */
  trainingSessions: number;
  /** Sets logged inside those sessions. Zero is a real answer, not a gap. */
  workingSets: number;
  cardioMinutes: number | null;
  overallAdherence: number | null;
  assessment: Assessment;
  daysLogged: number;
}

/**
 * Sessions across a set of days, from the canonical rollup.
 *
 * daily_metrics.training_sessions is computed directly from workout_sessions
 * (lib/data/canonicalise.ts), so it counts every session that happened -
 * including one imported as a summary, which has no sets to be counted by.
 * A day with no sessions at all is null, and null does not add to the total.
 */
function sessionsIn(days: DailyMetrics[]): number {
  return days.reduce((total, day) => total + (day.trainingSessions ?? 0), 0);
}

function pick(days: DailyMetrics[], key: keyof DailyMetrics): DatedValue[] {
  return days.map((day) => {
    const value = day[key];
    return { date: day.localDate, value: typeof value === 'number' ? value : null };
  });
}

function inRange(days: DailyMetrics[], from: LocalDate, to: LocalDate): DailyMetrics[] {
  return days.filter((day) => day.localDate >= from && day.localDate <= to);
}

/**
 * Change across a week, measured between the 7-day averages at each end rather
 * than between two single readings - a single Monday weigh-in can be two pounds
 * of water away from the truth.
 */
export function weeklyReview(
  days: DailyMetrics[],
  sets: LoggedSet[],
  targets: Targets,
  anyDateInWeek: LocalDate,
  maxWeeklyLossRatePct = 1.0,
): Derived<WeeklyReview> {
  const weekStart = startOfWeek(anyDateInWeek);
  const weekEnd = endOfWeek(anyDateInWeek);
  const week = inRange(days, weekStart, weekEnd);

  const weight = pick(days, 'weightKg');
  const waist = pick(days, 'waistCm');

  const startAvg = trailingAverage(weight, weekStart, 7);
  const endAvg = trailingAverage(weight, weekEnd, 7);
  const startWaist = trailingAverage(waist, weekStart, 28, { minCoverage: 0.1 });
  const endWaist = trailingAverage(waist, weekEnd, 28, { minCoverage: 0.1 });

  const weightChange =
    startAvg.value !== null && endAvg.value !== null ? endAvg.value - startAvg.value : null;
  const waistChange =
    startWaist.value !== null && endWaist.value !== null
      ? endWaist.value - startWaist.value
      : null;

  const averageOf = (key: keyof DailyMetrics): number | null => {
    const values = presentValues(week.map((day) => day[key] as number | null));
    return values.length ? roundTo(mean(values)!, 1) : null;
  };

  const weekSets = sets.filter((s) => s.date >= weekStart && s.date <= weekEnd);
  const training = summariseTraining(weekSets);

  const adherence = computeAdherence(
    {
      calories: pick(days, 'caloriesConsumed'),
      protein: pick(days, 'proteinG'),
      steps: pick(days, 'steps'),
      weight,
      trainingSessions: pick(days, 'trainingSessions'),
      cardioMinutes: pick(days, 'cardioMinutes'),
    },
    targets,
    weekEnd,
    7,
  );

  const cardioValues = presentValues(week.map((day) => day.cardioMinutes));
  const daysLogged = week.filter((day) => day.caloriesConsumed !== null).length;

  // Assessment against the user's own intended rate band.
  let assessment: Assessment = 'INSUFFICIENT_DATA';
  if (weightChange !== null && endAvg.value !== null && endAvg.value > 0) {
    const lossPct = (-weightChange / endAvg.value) * 100;
    if (lossPct > maxWeeklyLossRatePct) assessment = 'LOSING_TOO_FAST';
    else if (lossPct >= 0.5) assessment = 'ON_TRACK';
    else if (lossPct > 0) assessment = 'BEHIND_PLAN';
    else assessment = 'BEHIND_PLAN';
    if (lossPct >= 0.5 && lossPct <= maxWeeklyLossRatePct && (adherence.overall.value ?? 0) >= 0.9) {
      assessment = 'AHEAD_OF_PLAN';
    }
  }

  const review: WeeklyReview = {
    weekStart,
    weekEnd,
    startWeightKg: startAvg.value,
    endWeightKg: endAvg.value,
    weightChangeKg: weightChange === null ? null : roundTo(weightChange, 3),
    waistChangeCm: waistChange === null ? null : roundTo(waistChange, 2),
    averageCalories: averageOf('caloriesConsumed'),
    averageProteinG: averageOf('proteinG'),
    averageSteps: averageOf('steps'),
    trainingSessions: sessionsIn(week),
    workingSets: training.value?.totalWorkingSets ?? 0,
    cardioMinutes: cardioValues.length ? roundTo(cardioValues.reduce((a, b) => a + b, 0), 0) : null,
    overallAdherence: adherence.overall.value,
    assessment,
    daysLogged,
  };

  return derived(
    review,
    'Weekly review',
    {
      weekStart,
      weekEnd,
      daysInWeek: week.length,
      daysLogged,
      note: 'Weight change is measured between 7-day averages, not single weigh-ins.',
    },
    assessment === 'INSUFFICIENT_DATA' ? 'INSUFFICIENT' : daysLogged >= 5 ? 'HIGH' : 'LOW',
    daysLogged < 5
      ? [`Only ${daysLogged} of ${week.length} days were logged; treat this week as provisional.`]
      : [],
  );
}

export interface MonthlyReview {
  monthStart: LocalDate;
  monthEnd: LocalDate;
  startWeightKg: number | null;
  endWeightKg: number | null;
  totalChangeKg: number | null;
  waistChangeCm: number | null;
  averageCalories: number | null;
  averageSteps: number | null;
  /** Counted from daily_metrics, so imported sessions are included. */
  trainingSessions: number;
  workingSets: number;
  longestLoggingStreak: number;
  daysLogged: number;
  dayCount: number;
}

export function monthlyReview(
  days: DailyMetrics[],
  sets: LoggedSet[],
  anyDateInMonth: LocalDate,
): Derived<MonthlyReview> {
  const monthStart = startOfMonth(anyDateInMonth);
  const monthEnd = endOfMonth(anyDateInMonth);
  const month = inRange(days, monthStart, monthEnd);

  const weights = presentValues(month.map((day) => day.weightKg));
  const waists = presentValues(month.map((day) => day.waistCm));
  const calories = presentValues(month.map((day) => day.caloriesConsumed));
  const steps = presentValues(month.map((day) => day.steps));

  const monthSets = sets.filter((s) => s.date >= monthStart && s.date <= monthEnd);
  const training = summariseTraining(monthSets);

  // Longest run of consecutive days with nutrition logged.
  let streak = 0;
  let best = 0;
  for (const day of month) {
    if (day.caloriesConsumed !== null) {
      streak += 1;
      best = Math.max(best, streak);
    } else {
      streak = 0;
    }
  }

  const first = weights[0] ?? null;
  const last = weights[weights.length - 1] ?? null;

  const review: MonthlyReview = {
    monthStart,
    monthEnd,
    startWeightKg: first,
    endWeightKg: last,
    totalChangeKg: first !== null && last !== null ? roundTo(last - first, 3) : null,
    waistChangeCm:
      waists.length > 1 ? roundTo(waists[waists.length - 1]! - waists[0]!, 2) : null,
    averageCalories: calories.length ? roundTo(mean(calories)!, 0) : null,
    averageSteps: steps.length ? roundTo(mean(steps)!, 0) : null,
    trainingSessions: sessionsIn(month),
    workingSets: training.value?.totalWorkingSets ?? 0,
    longestLoggingStreak: best,
    daysLogged: month.filter((day) => day.caloriesConsumed !== null).length,
    dayCount: month.length,
  };

  return derived(
    review,
    'Monthly review',
    { monthStart, monthEnd, daysInMonth: daysBetween(monthStart, monthEnd) + 1 },
    month.length === 0 ? 'INSUFFICIENT' : review.daysLogged >= 20 ? 'HIGH' : 'MODERATE',
    [],
  );
}
