/**
 * Moving averages (spec §18).
 *
 * Weight fluctuates several pounds day to day on water alone, so every trend
 * question is asked of the smoothed series, never of raw daily readings.
 *
 * COVERAGE GATE: a "7-day average" computed from two logged days is not a
 * 7-day average. Below MIN_COVERAGE the result is null with the reason
 * recorded, rather than a confident-looking number built from a third of a
 * window (spec §33).
 */
import type { DatedValue, Derived, LocalDate } from '@/lib/types';
import { derived, insufficient } from '@/lib/types';
import {
  coverageOf,
  mean,
  presentValues,
  roundTo,
  trailingWindow,
} from './series';

/** Fraction of a window that must carry data for the average to be reported. */
export const MIN_COVERAGE = 0.5;

export type WindowSize = 7 | 14 | 30;

export function trailingAverage(
  points: DatedValue[],
  end: LocalDate,
  windowDays: number,
  options: { minCoverage?: number; label?: string } = {},
): Derived<number> {
  const minCoverage = options.minCoverage ?? MIN_COVERAGE;
  const label = options.label ?? `${windowDays}-day average`;
  const window = trailingWindow(points, end, windowDays);
  const values = presentValues(window.map((p) => p.value));
  const coverage = coverageOf(window.map((p) => p.value));

  const inputs = {
    windowDays,
    endDate: end,
    daysWithData: coverage.present,
    coverage: roundTo(coverage.ratio, 3),
    minCoverage,
  };

  // Both branches report how many days DID carry data. Without that count the
  // two nulls below are indistinguishable downstream, and a window holding four
  // real readings gets displayed as "not logged" - see isInsufficientNotAbsent.
  if (values.length === 0) {
    return insufficient<number>(
      label,
      inputs,
      `No measurements in the ${windowDays} days ending ${end}.`,
      0,
    );
  }

  if (coverage.ratio < minCoverage) {
    return insufficient<number>(
      label,
      inputs,
      `Only ${coverage.present} of ${windowDays} days carry data ` +
        `(${Math.round(coverage.ratio * 100)}%), below the ${Math.round(
          minCoverage * 100,
        )}% needed to report a ${windowDays}-day average.`,
      coverage.present,
    );
  }

  // Coverage maps to confidence: a near-complete window is trustworthy, a
  // barely-passing one is reported but flagged.
  const confidence =
    coverage.ratio >= 0.85 ? 'HIGH' : coverage.ratio >= 0.7 ? 'MODERATE' : 'LOW';

  return derived(
    roundTo(mean(values)!, 3),
    label,
    inputs,
    confidence,
    coverage.ratio < 0.85
      ? [`Based on ${coverage.present} of ${windowDays} days.`]
      : [],
    coverage.present,
  );
}

export interface MovingAverages {
  sevenDay: Derived<number>;
  fourteenDay: Derived<number>;
  thirtyDay: Derived<number>;
}

/** The 7/14/30-day set the dashboard and Context Pack both report. */
export function movingAverages(
  points: DatedValue[],
  end: LocalDate,
  metricLabel: string,
): MovingAverages {
  return {
    sevenDay: trailingAverage(points, end, 7, {
      label: `${metricLabel} 7-day average`,
    }),
    fourteenDay: trailingAverage(points, end, 14, {
      label: `${metricLabel} 14-day average`,
    }),
    thirtyDay: trailingAverage(points, end, 30, {
      label: `${metricLabel} 30-day average`,
    }),
  };
}

/**
 * A centred-free (trailing) smoothed series for charting: each day carries the
 * average of the `windowDays` ending that day. Days that cannot meet the
 * coverage gate are null, so the chart shows a gap instead of inventing a line.
 */
export function smoothedSeries(
  points: DatedValue[],
  start: LocalDate,
  end: LocalDate,
  windowDays: number,
  minCoverage = MIN_COVERAGE,
): DatedValue[] {
  const days = trailingWindow(points, end, Math.max(1, dayCount(start, end)));
  return days.map((day) => {
    const average = trailingAverage(points, day.date, windowDays, { minCoverage });
    return { date: day.date, value: average.value };
  });
}

function dayCount(start: LocalDate, end: LocalDate): number {
  const [ys, ms, ds] = start.split('-').map(Number) as [number, number, number];
  const [ye, me, de] = end.split('-').map(Number) as [number, number, number];
  const ms1 = Date.UTC(ys, ms - 1, ds, 12);
  const ms2 = Date.UTC(ye, me - 1, de, 12);
  return Math.round((ms2 - ms1) / 86_400_000) + 1;
}
