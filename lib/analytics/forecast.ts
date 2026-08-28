/**
 * Weight forecasting (spec §22).
 *
 * "Never pretend the model knows exactly when you'll hit 180." So this returns
 * three dates, not one: a best estimate from the fitted slope, and two bounds
 * derived from the slope's own standard error. When the trend is flat or moving
 * away from target, no date is returned at all - extrapolating a target date
 * from a slope that does not reach it would be fiction.
 */
import type { DatedValue, Derived, LocalDate } from '@/lib/types';
import { derived, insufficient } from '@/lib/types';
import { addDays } from '@/lib/normalization/dates';
import { roundTo } from './series';
import { trend } from './trend';

export interface Forecast {
  currentKg: number;
  targetKg: number;
  remainingKg: number;
  ratePerWeekKg: number;
  /** Central estimate. */
  bestEstimateDate: LocalDate;
  /** Faster bound: the optimistic edge of the slope's uncertainty. */
  optimisticDate: LocalDate;
  /** Slower bound: the conservative edge. */
  conservativeDate: LocalDate;
  daysToTargetBest: number;
}

/** z for a ~68% interval. Deliberately modest: this is a range, not a promise. */
const Z = 1.0;
/** Refuse to project beyond this horizon; the extrapolation stops meaning anything. */
const MAX_HORIZON_DAYS = 730;

export function forecastTargetDate(
  weight: DatedValue[],
  targetKg: number | null,
  end: LocalDate,
  windowDays = 28,
): Derived<Forecast> {
  const weightTrend = trend(weight, end, windowDays, 'Weight trend for forecast');

  const inputs = {
    windowDays,
    endDate: end,
    targetKg,
    ratePerWeekKg: weightTrend.value ? roundTo(weightTrend.value.perWeek, 4) : null,
    slopeStandardErrorPerDay: weightTrend.value
      ? roundTo(weightTrend.value.slopeStandardError, 5)
      : null,
  };

  if (targetKg === null) {
    return insufficient<Forecast>('Target date forecast', inputs, 'No target weight is set.');
  }
  if (weightTrend.value === null) {
    return insufficient<Forecast>(
      'Target date forecast',
      inputs,
      weightTrend.notes[0] ?? 'Not enough weight data to fit a trend.',
    );
  }

  const current = weightTrend.value.fittedEnd;
  const remaining = targetKg - current;

  if (Math.abs(remaining) < 0.05) {
    return derived<Forecast>(
      {
        currentKg: roundTo(current, 3),
        targetKg,
        remainingKg: 0,
        ratePerWeekKg: roundTo(weightTrend.value.perWeek, 3),
        bestEstimateDate: end,
        optimisticDate: end,
        conservativeDate: end,
        daysToTargetBest: 0,
      },
      'Target date forecast',
      inputs,
      'HIGH',
      ['Target reached.'],
    );
  }

  const slopePerDay = weightTrend.value.perDay;
  // Moving away from target, or not moving: no honest date exists.
  if (slopePerDay === 0 || Math.sign(slopePerDay) !== Math.sign(remaining)) {
    return insufficient<Forecast>(
      'Target date forecast',
      inputs,
      slopePerDay === 0
        ? 'The weight trend is flat, so no target date can be projected.'
        : 'The current trend moves away from the target, so no target date can be projected.',
    );
  }

  const se = weightTrend.value.slopeStandardError;
  const direction = Math.sign(slopePerDay); // -1 while losing, +1 while gaining
  // One standard error either side of the fitted slope. `fast` has the larger
  // magnitude in the same direction; `slow` the smaller, and it may fall through
  // zero entirely, which is the case where no conservative date exists.
  const fastSlope = slopePerDay + direction * Z * se;
  const slowSlope = slopePerDay - direction * Z * se;

  const daysBest = remaining / slopePerDay;
  const daysFast = fastSlope !== 0 && Math.sign(fastSlope) === Math.sign(remaining)
    ? remaining / fastSlope
    : daysBest;
  const daysSlow = slowSlope !== 0 && Math.sign(slowSlope) === Math.sign(remaining)
    ? remaining / slowSlope
    : MAX_HORIZON_DAYS;

  const clamp = (d: number): number =>
    Math.min(MAX_HORIZON_DAYS, Math.max(0, Math.round(d)));

  const notes = [
    'The range comes from the standard error of the fitted slope, not from a model of ' +
      'future behaviour. It assumes the current rate continues, which it usually will not.',
  ];
  if (clamp(daysSlow) >= MAX_HORIZON_DAYS) {
    notes.push('The conservative bound exceeds two years and has been capped.');
  }

  return derived<Forecast>(
    {
      currentKg: roundTo(current, 3),
      targetKg,
      remainingKg: roundTo(remaining, 3),
      ratePerWeekKg: roundTo(weightTrend.value.perWeek, 3),
      bestEstimateDate: addDays(end, clamp(daysBest)),
      optimisticDate: addDays(end, clamp(Math.min(daysFast, daysBest))),
      conservativeDate: addDays(end, clamp(Math.max(daysSlow, daysBest))),
      daysToTargetBest: clamp(daysBest),
    },
    'Target date forecast',
    inputs,
    weightTrend.confidence === 'HIGH' ? 'MODERATE' : 'LOW',
    notes,
  );
}
