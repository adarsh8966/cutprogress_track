/**
 * Trend estimation (spec §18, §22).
 *
 * Ordinary least squares of value against day index, giving a slope in
 * units-per-day that is reported as units-per-week. The regression also yields
 * R² and the standard error of the slope, which is what lets the forecast quote
 * a RANGE rather than pretending to know the exact date the user hits target
 * (spec §22).
 *
 * Fitted on the raw daily points, not the smoothed series: smoothing first and
 * regressing after understates the standard error, because a moving average
 * makes neighbouring points correlated and the fit look tighter than the data
 * supports.
 */
import type { DatedValue, Derived, LocalDate } from '@/lib/types';
import { derived, insufficient } from '@/lib/types';
import { daysBetween } from '@/lib/normalization/dates';
import { coverageOf, roundTo, trailingWindow } from './series';

export interface TrendResult {
  /** Change per week, in the series' own canonical unit. */
  perWeek: number;
  /** Change per day, the raw regression slope. */
  perDay: number;
  /** Fraction of variance explained, 0..1. */
  rSquared: number;
  /** Standard error of the slope, per day. Drives the forecast band. */
  slopeStandardError: number;
  /** Fitted value at the last day of the window. */
  fittedEnd: number;
  daysWithData: number;
}

/** Fewer points than this cannot support a trend claim. */
export const MIN_POINTS_FOR_TREND = 5;

/**
 * Least-squares fit over the trailing `windowDays`.
 * x is days since the window start, so the intercept is the fitted value on day 0.
 */
export function trend(
  points: DatedValue[],
  end: LocalDate,
  windowDays: number,
  label: string,
): Derived<TrendResult> {
  const window = trailingWindow(points, end, windowDays);
  const start = window[0]?.date ?? end;

  const observations = window
    .filter((p): p is { date: LocalDate; value: number } => p.value !== null)
    .map((p) => ({ x: daysBetween(start, p.date), y: p.value }));

  const coverage = coverageOf(window.map((p) => p.value));
  const inputs = {
    windowDays,
    endDate: end,
    startDate: start,
    daysWithData: observations.length,
    coverage: roundTo(coverage.ratio, 3),
  };

  if (observations.length < MIN_POINTS_FOR_TREND) {
    return insufficient<TrendResult>(
      label,
      inputs,
      `Need at least ${MIN_POINTS_FOR_TREND} measurements in the window to fit a ` +
        `trend; found ${observations.length}.`,
      observations.length,
    );
  }

  const n = observations.length;
  const meanX = observations.reduce((a, o) => a + o.x, 0) / n;
  const meanY = observations.reduce((a, o) => a + o.y, 0) / n;

  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const { x, y } of observations) {
    sxx += (x - meanX) ** 2;
    sxy += (x - meanX) * (y - meanY);
    syy += (y - meanY) ** 2;
  }

  if (sxx === 0) {
    return insufficient<TrendResult>(
      label,
      inputs,
      'Every measurement falls on the same day; a slope is undefined.',
      observations.length,
    );
  }

  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;

  // Residual variance -> standard error of the slope.
  let residualSumSquares = 0;
  for (const { x, y } of observations) {
    residualSumSquares += (y - (intercept + slope * x)) ** 2;
  }
  const residualVariance = n > 2 ? residualSumSquares / (n - 2) : 0;
  const slopeStandardError = Math.sqrt(residualVariance / sxx);
  const rSquared = syy === 0 ? 0 : Math.max(0, 1 - residualSumSquares / syy);

  const endX = daysBetween(start, end);
  const result: TrendResult = {
    perDay: slope,
    perWeek: slope * 7,
    rSquared,
    slopeStandardError,
    fittedEnd: intercept + slope * endX,
    daysWithData: n,
  };

  // Confidence blends how much data there is with how well the line fits.
  // A tight fit over 4 days is not a trend; a loose fit over 30 days still is.
  const confidence =
    n >= 14 && coverage.ratio >= 0.7
      ? rSquared >= 0.4
        ? 'HIGH'
        : 'MODERATE'
      : n >= 8
        ? 'MODERATE'
        : 'LOW';

  const notes: string[] = [];
  if (rSquared < 0.2) {
    notes.push(
      'The fit is weak (R² < 0.2): day-to-day scatter dominates the trend over this window.',
    );
  }
  if (coverage.ratio < 0.7) {
    notes.push(`Only ${coverage.present} of ${windowDays} days carry data.`);
  }

  return derived(result, label, { ...inputs, rSquared: roundTo(rSquared, 3) }, confidence, notes);
}

/**
 * Is the rate of change itself changing? Compares the trend over the recent
 * half of the window against the earlier half, which is what answers the spec's
 * "is weight loss accelerating / slowing?" questions (§18).
 */
export type TrendDirection =
  | 'ACCELERATING'
  | 'STEADY'
  | 'SLOWING'
  | 'REVERSED'
  | 'UNKNOWN';

export function trendChange(
  points: DatedValue[],
  end: LocalDate,
  windowDays: number,
  label: string,
): Derived<{ direction: TrendDirection; recentPerWeek: number; earlierPerWeek: number }> {
  const half = Math.floor(windowDays / 2);
  const recent = trend(points, end, half, `${label} (recent half)`);
  const earlierEnd = trailingWindow(points, end, half)[0]?.date ?? end;
  const earlier = trend(points, earlierEnd, half, `${label} (earlier half)`);

  const inputs = {
    windowDays,
    halfWindowDays: half,
    recentPerWeek: recent.value ? roundTo(recent.value.perWeek, 4) : null,
    earlierPerWeek: earlier.value ? roundTo(earlier.value.perWeek, 4) : null,
  };

  if (!recent.value || !earlier.value) {
    return insufficient(
      label,
      inputs,
      'Not enough data in both halves of the window to compare rates.',
    );
  }

  const recentRate = recent.value.perWeek;
  const earlierRate = earlier.value.perWeek;

  // "Meaningfully different" is anchored to the earlier rate's own magnitude so
  // the test is scale-free, with a floor so a near-zero earlier rate does not
  // make every comparison look enormous.
  const threshold = Math.max(Math.abs(earlierRate) * 0.25, 0.05);
  const delta = recentRate - earlierRate;

  let direction: TrendDirection;
  if (Math.sign(recentRate) !== Math.sign(earlierRate) && Math.abs(delta) > threshold) {
    direction = 'REVERSED';
  } else if (Math.abs(delta) <= threshold) {
    direction = 'STEADY';
  } else if (Math.abs(recentRate) > Math.abs(earlierRate)) {
    direction = 'ACCELERATING';
  } else {
    direction = 'SLOWING';
  }

  return derived(
    { direction, recentPerWeek: recentRate, earlierPerWeek: earlierRate },
    label,
    { ...inputs, threshold: roundTo(threshold, 4) },
    recent.confidence === 'HIGH' && earlier.confidence === 'HIGH' ? 'MODERATE' : 'LOW',
    ['Comparing two half-windows is a coarse test; treat it as a prompt to look, not a conclusion.'],
  );
}
