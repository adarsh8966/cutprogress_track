/**
 * A metric read the two ways a metric has to be read (spec §18, §32, §33).
 *
 * WHY THIS EXISTS. A trailing average is the right way to read a noisy daily
 * metric, and lib/analytics/movingAverage.ts refuses to compute one from a
 * window that is mostly empty. Correct - and it means a metric whose ONLY
 * reader is a gated average is invisible until half the window fills up. The
 * measurements are stored, resolved, queried and mapped, and the page reports
 * nothing.
 *
 * The Recovery page solved that by reading every metric twice: the latest
 * actual reading, which one observation can answer, beside the average, which
 * needs coverage. It was the only page that did, so the Dashboard went on
 * reporting "Nutrition 28-day average: not logged" for a day whose nutrition
 * was logged, imported and visible three screens away.
 *
 * This is that pattern, lifted out of recovery.ts so every page shares one
 * implementation rather than each rediscovering it. The coverage comes with it,
 * because the honest way to show a sparse figure is to say how sparse it is:
 *
 *     Calories
 *     2,050 kcal   measured 29 Aug
 *     1 of 28 days logged
 *     Not enough for a 28-day average
 *
 * NO THRESHOLD MOVES HERE. The average is still trailingAverage() with its
 * MIN_COVERAGE gate untouched. What changes is what happens when the gate says
 * no: the page shows the reading that does exist and names the shortfall,
 * instead of claiming nothing was recorded.
 */
import type { DailyMetrics, DatedValue, Derived, LocalDate } from '@/lib/types';
import { trailingAverage } from './movingAverage';
import { latestReading } from './latest';
import { type Coverage, coverageOf, pickMetric, trailingWindow } from './series';

/** A metric reported both ways, with the coverage behind both. */
export interface MetricReading {
  /** What is typical. Gated: null below MIN_COVERAGE. */
  average: Derived<number>;
  /**
   * What was last actually recorded, and when. Ungated - "the most recent
   * value" is answerable from a single observation, so it needs no coverage.
   */
  latest: Derived<number>;
  /** Days carrying a measurement, out of days in the window. */
  coverage: Coverage;
  /** The per-day series, for charting on the correct dates. */
  series: DatedValue[];
  /** The window both figures were read over, for the caption. */
  windowDays: number;
}

/**
 * Reads one canonical field over a trailing window.
 *
 * `label` names the metric, not the figure: the two Derived values append their
 * own descriptions, so "Calories" becomes "Calories 28-day average" and
 * "Calories latest reading".
 */
export function metricReading(
  days: DailyMetrics[],
  key: keyof DailyMetrics,
  label: string,
  end: LocalDate,
  windowDays: number,
): MetricReading {
  const series = pickMetric(days, key);
  return readingOf(series, label, end, windowDays);
}

/** The same, for a series already picked out (or converted, or summed). */
export function readingOf(
  series: DatedValue[],
  label: string,
  end: LocalDate,
  windowDays: number,
): MetricReading {
  return {
    series,
    windowDays,
    coverage: coverageOf(trailingWindow(series, end, windowDays).map((p) => p.value)),
    average: trailingAverage(series, end, windowDays, {
      label: `${label} ${windowDays}-day average`,
    }),
    // Looked for over the same window as the average, deliberately: a reading
    // older than the window the page is reporting on is not a current reading
    // of anything, and showing it under a 28-day heading would invite being
    // read as part of that period.
    latest: latestReading(series, end, windowDays, {
      label: `${label} latest reading`,
    }),
  };
}

/**
 * "1 of 28 days logged" - the sentence that turns a refusal into information.
 *
 * Always says how many days DID carry data, including when that is zero, so the
 * caption never has to be omitted and a reader never has to guess whether a
 * missing caption means none or unknown.
 */
export function coverageNote(coverage: Coverage): string {
  return `${coverage.present} of ${coverage.window} day${
    coverage.window === 1 ? '' : 's'
  } logged`;
}
