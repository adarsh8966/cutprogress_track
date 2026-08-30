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
import { metricReading, type MetricReading } from './reading';
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

/**
 * A metric reported both ways: what was last true, and what is typical.
 *
 * The shape this page invented is now lib/analytics/reading.ts, shared with the
 * Dashboard and Nutrition - the same reading was needed there and its absence
 * is what made a logged day read as "not logged" on the home screen.
 * `average30` is kept as a name because it is what this page's cards are
 * titled, and it is the same figure `average` holds.
 */
export interface RecoveryMetric extends MetricReading {
  average30: Derived<number>;
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
  /**
   * Active calories. Offered by Quick Entry and by the Recovery metrics form,
   * both of which name Recovery as its destination - and until this existed no
   * page read it at all. The value was written, resolved into daily_metrics,
   * mapped into DailyMetrics, and displayed nowhere: the same fault as resting
   * heart rate, with a form promising a destination that did not show it.
   */
  activeCalories: RecoveryMetric;
  zone2Minutes: Derived<number>;

  /**
   * The overnight physiology a wearable measures (migration 0016).
   *
   * These belong together and belong here: the sleep guide's own framing is
   * that stages give the structure of the night while HRV, respiratory rate and
   * blood oxygen say how the body responded to it. Read one without the others
   * and a poor night looks like bad luck rather than something with a cause.
   *
   * Every one is a RecoveryMetric - latest and average, with coverage - because
   * a single night's respiratory rate says very little and a fortnight of them
   * says a lot, and the page should be able to show both without deciding for
   * the reader which matters.
   */
  respiratoryRate: RecoveryMetric;
  oxygenSaturation: RecoveryMetric;
  remMinutes: RecoveryMetric;
  deepMinutes: RecoveryMetric;
  lightMinutes: RecoveryMetric;
  awakeMinutes: RecoveryMetric;
  /**
   * Skin temperature deviation from the user's own baseline, in Celsius.
   * SIGNED, and that is the information: a night warmer than usual is a
   * different signal from a night cooler than usual, and an absolute value
   * would erase the distinction.
   */
  sleepTemperatureDelta: RecoveryMetric;
  /** The provider's own zone accounting, kept distinct from zone2Minutes. */
  activeZoneMinutes: RecoveryMetric;
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
  const reading = metricReading(days, key, label, end, LATEST_WINDOW_DAYS);
  return { ...reading, average30: reading.average };
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
    activeCalories: metric(days, 'activeCalories', 'Active calories', end),
    zone2Minutes: zone2Total(days, end),
    respiratoryRate: metric(days, 'respiratoryRate', 'Respiratory rate', end),
    oxygenSaturation: metric(days, 'oxygenSaturationPct', 'Blood oxygen', end),
    remMinutes: metric(days, 'remMinutes', 'REM sleep', end),
    deepMinutes: metric(days, 'deepMinutes', 'Deep sleep', end),
    lightMinutes: metric(days, 'lightMinutes', 'Light sleep', end),
    awakeMinutes: metric(days, 'awakeMinutes', 'Awake during sleep', end),
    sleepTemperatureDelta: metric(
      days, 'sleepTemperatureDeltaC', 'Sleep skin temperature', end,
    ),
    activeZoneMinutes: metric(days, 'activeZoneMinutes', 'Active zone minutes', end),
    belowBaseline:
      sleep7.value !== null && sleep30.value !== null && sleep7.value < sleep30.value * 0.9,
  };
}
