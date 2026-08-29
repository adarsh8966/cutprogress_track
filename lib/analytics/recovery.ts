/**
 * The Recovery view's figures, as one pure calculation (spec §14, §33).
 *
 * WHY THIS IS A MODULE AND NOT PAGE CODE. The resting-heart-rate and HRV bug
 * was invisible to the test suite because the only place those values were
 * turned into something displayable was inside a React server component, which
 * no test could call. Everything the Recovery page shows is computed here, so a
 * test can assert the DISPLAYED value rather than re-deriving its own version
 * of it and agreeing with itself.
 *
 * Every figure is a Derived<T>: it carries the method, the inputs, the
 * confidence and - crucially for this bug - how many observations it actually
 * found, so the page can tell "never logged" apart from "logged, but too sparse
 * to average".
 *
 * Spec §14: none of this is a gate on training. It reports and contextualises.
 */
import type { DailyMetrics, DatedValue, Derived, LocalDate } from '@/lib/types';
import { derived, insufficient } from '@/lib/types';
import { trailingAverage } from './movingAverage';
import { latestReading } from './latest';
import { coverageOf, pickMetric, presentValues, trailingWindow } from './series';

/**
 * How far back a "latest reading" is allowed to look.
 *
 * Matched to the 30-day averages beside it: a value older than the reporting
 * window is not a current reading of anything, and is better reported as
 * missing than shown with a stale date next to a monthly figure.
 */
export const LATEST_WINDOW_DAYS = 30;
export const ZONE2_WINDOW_DAYS = 28;

/** A metric reported both ways: what was last true, and what is typical. */
export interface RecoveryMetric {
  latest: Derived<number>;
  average30: Derived<number>;
  /** The per-day series, for charting on the correct dates. */
  series: DatedValue[];
}

export interface RecoverySummary {
  end: LocalDate;
  sleep7: Derived<number>;
  sleep30: Derived<number>;
  sleepSeries: DatedValue[];
  stepsSeries: DatedValue[];
  sleepScore: RecoveryMetric;
  restingHeartRate: RecoveryMetric;
  hrv: RecoveryMetric;
  totalCaloriesBurned: RecoveryMetric;
  zone2Minutes: Derived<number>;
  /**
   * Spec §14: true only when the last 7 days sit materially below the user's
   * own 30-day baseline. Informational, never a gate.
   */
  belowBaseline: boolean;
}

function metric(
  days: DailyMetrics[],
  key: keyof DailyMetrics,
  label: string,
  end: LocalDate,
): RecoveryMetric {
  const series = pickMetric(days, key);
  return {
    series,
    latest: latestReading(series, end, LATEST_WINDOW_DAYS, {
      label: `${label} latest reading`,
    }),
    average30: trailingAverage(series, end, 30, { label: `${label} 30-day average` }),
  };
}

/**
 * Zone 2 minutes over the last 28 days.
 *
 * A SUM, so the null rule needs stating explicitly: a window where no day
 * carries a cardio figure is unknown (null), while a window that does and sums
 * to zero is a real zero - the user did cardio and none of it was zone 2. The
 * previous inline version reported both as "not logged".
 */
function zone2Total(days: DailyMetrics[], end: LocalDate): Derived<number> {
  const window = trailingWindow(pickMetric(days, 'zone2Minutes'), end, ZONE2_WINDOW_DAYS);
  const values = presentValues(window.map((p) => p.value));
  const coverage = coverageOf(window.map((p) => p.value));
  const inputs = {
    windowDays: ZONE2_WINDOW_DAYS,
    endDate: end,
    daysWithData: coverage.present,
  };

  if (values.length === 0) {
    return insufficient<number>(
      'Zone 2 minutes, last 28 days',
      inputs,
      `No cardio recorded in the ${ZONE2_WINDOW_DAYS} days ending ${end}.`,
      0,
    );
  }

  return derived(
    values.reduce((total, v) => total + v, 0),
    'Zone 2 minutes, last 28 days',
    inputs,
    'HIGH',
    [`Summed over ${coverage.present} day(s) carrying a cardio figure.`],
    coverage.present,
  );
}

export function recoverySummary(days: DailyMetrics[], end: LocalDate): RecoverySummary {
  const sleepSeries = pickMetric(days, 'sleepDurationMinutes');
  const sleep7 = trailingAverage(sleepSeries, end, 7, { label: 'Sleep 7-day average' });
  const sleep30 = trailingAverage(sleepSeries, end, 30, { label: 'Sleep 30-day average' });

  return {
    end,
    sleep7,
    sleep30,
    sleepSeries,
    stepsSeries: pickMetric(days, 'steps'),
    sleepScore: metric(days, 'sleepScore', 'Sleep score', end),
    restingHeartRate: metric(days, 'restingHeartRate', 'Resting heart rate', end),
    hrv: metric(days, 'hrvMs', 'HRV', end),
    totalCaloriesBurned: metric(days, 'totalCaloriesBurned', 'Total calories burned', end),
    zone2Minutes: zone2Total(days, end),
    belowBaseline:
      sleep7.value !== null && sleep30.value !== null && sleep7.value < sleep30.value * 0.9,
  };
}
