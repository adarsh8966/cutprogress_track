/**
 * Plateau detection (spec §19).
 *
 * A plateau is NOT "weight didn't move for three days". The spec is explicit
 * that calling a plateau requires four things to hold together over at least
 * fourteen days:
 *
 *   1. the weight AVERAGE has not moved meaningfully
 *   2. calorie intake has been stable
 *   3. activity has been stable
 *   4. logging adherence is high enough to believe 1-3
 *
 * The fourth is the one that matters most. If intake is only logged half the
 * time, a flat weight trend is not evidence of a metabolic plateau - it is
 * evidence of not knowing what was eaten. That case returns INSUFFICIENT_DATA,
 * never PLATEAU, because the two lead to opposite coaching decisions.
 */
import type { DatedValue, Derived, LocalDate } from '@/lib/types';
import { derived } from '@/lib/types';
import { coefficientOfVariation, coverageOf, presentValues, roundTo, trailingWindow } from './series';
import { trailingAverage } from './movingAverage';

export type PlateauVerdict = 'PLATEAU' | 'NO_PLATEAU' | 'INSUFFICIENT_DATA';

export interface PlateauEvidence {
  verdict: PlateauVerdict;
  windowDays: number;
  /** Change in the 7-day weight average across the window, kg. */
  weightAverageChangeKg: number | null;
  weightStable: boolean | null;
  caloriesStable: boolean | null;
  caloriesCoefficientOfVariation: number | null;
  activityStable: boolean | null;
  stepsCoefficientOfVariation: number | null;
  loggingAdherence: number | null;
  reasons: string[];
}

/** Spec §19: the minimum duration before the question may even be asked. */
export const MIN_PLATEAU_DAYS = 14;
/** Weight-average movement below this over the window counts as "not moving". */
export const WEIGHT_STABLE_THRESHOLD_KG = 0.45; // ~1 lb
/** Intake/activity are "stable" below this coefficient of variation. */
export const INTAKE_STABILITY_CV = 0.15;
export const ACTIVITY_STABILITY_CV = 0.25;
/** Spec §19: below this share of days logged, no plateau call is possible. */
export const MIN_LOGGING_ADHERENCE = 0.85;

export function detectPlateau(
  weight: DatedValue[],
  calories: DatedValue[],
  steps: DatedValue[],
  end: LocalDate,
  windowDays = 21,
): Derived<PlateauEvidence> {
  const window = Math.max(windowDays, MIN_PLATEAU_DAYS);
  const reasons: string[] = [];

  // 1. Has the weight AVERAGE moved? Compare the 7-day average now against the
  //    7-day average at the start of the window - never two single readings.
  const windowDates = trailingWindow(weight, end, window);
  const startDate = windowDates[0]?.date ?? end;
  const averageNow = trailingAverage(weight, end, 7);
  const averageThen = trailingAverage(weight, startDate, 7);

  const weightChange =
    averageNow.value !== null && averageThen.value !== null
      ? averageNow.value - averageThen.value
      : null;
  const weightStable =
    weightChange === null ? null : Math.abs(weightChange) < WEIGHT_STABLE_THRESHOLD_KG;

  // 2/3. Were intake and activity actually held constant over the window?
  const calorieWindow = trailingWindow(calories, end, window);
  const calorieValues = presentValues(calorieWindow.map((p) => p.value));
  const calorieCv = coefficientOfVariation(calorieValues);
  const caloriesStable = calorieCv === null ? null : calorieCv <= INTAKE_STABILITY_CV;

  const stepWindow = trailingWindow(steps, end, window);
  const stepValues = presentValues(stepWindow.map((p) => p.value));
  const stepCv = coefficientOfVariation(stepValues);
  const activityStable = stepCv === null ? null : stepCv <= ACTIVITY_STABILITY_CV;

  // 4. The gate. Adherence here is nutrition-logging coverage, because intake
  //    is the variable a plateau conclusion would cause the user to change.
  const loggingCoverage = coverageOf(calorieWindow.map((p) => p.value));
  const loggingAdherence = loggingCoverage.ratio;

  const evidence: PlateauEvidence = {
    verdict: 'INSUFFICIENT_DATA',
    windowDays: window,
    weightAverageChangeKg: weightChange === null ? null : roundTo(weightChange, 3),
    weightStable,
    caloriesStable,
    caloriesCoefficientOfVariation: calorieCv === null ? null : roundTo(calorieCv, 3),
    activityStable,
    stepsCoefficientOfVariation: stepCv === null ? null : roundTo(stepCv, 3),
    loggingAdherence: roundTo(loggingAdherence, 3),
    reasons,
  };

  const inputs = {
    windowDays: window,
    endDate: end,
    startDate,
    weightAverageNow: averageNow.value,
    weightAverageAtWindowStart: averageThen.value,
    weightStableThresholdKg: WEIGHT_STABLE_THRESHOLD_KG,
    calorieDaysLogged: loggingCoverage.present,
    minLoggingAdherence: MIN_LOGGING_ADHERENCE,
  };

  // --- The gate runs first. Poor logging cannot produce a plateau verdict. ---
  if (loggingAdherence < MIN_LOGGING_ADHERENCE) {
    reasons.push(
      `Nutrition was logged on ${loggingCoverage.present} of ${window} days ` +
        `(${Math.round(loggingAdherence * 100)}%), below the ` +
        `${Math.round(MIN_LOGGING_ADHERENCE * 100)}% needed to distinguish a real ` +
        `plateau from an unmeasured one.`,
    );
    return derived(evidence, 'Plateau detection', inputs, 'INSUFFICIENT', reasons);
  }

  if (weightChange === null) {
    reasons.push('Not enough weight measurements to compare averages across the window.');
    return derived(evidence, 'Plateau detection', inputs, 'INSUFFICIENT', reasons);
  }

  if (calorieCv === null || stepCv === null) {
    reasons.push('Not enough intake or activity data to judge whether they were held stable.');
    return derived(evidence, 'Plateau detection', inputs, 'INSUFFICIENT', reasons);
  }

  if (weightStable && caloriesStable && activityStable) {
    evidence.verdict = 'PLATEAU';
    reasons.push(
      `Weight average moved ${roundTo(Math.abs(weightChange), 2)} kg over ${window} days ` +
        `while intake and activity stayed stable, with ${Math.round(loggingAdherence * 100)}% logging.`,
    );
    return derived(evidence, 'Plateau detection', inputs, 'HIGH', reasons);
  }

  evidence.verdict = 'NO_PLATEAU';
  if (!weightStable) {
    reasons.push(
      `Weight average moved ${roundTo(weightChange, 2)} kg over ${window} days, which is real movement.`,
    );
  }
  if (!caloriesStable) {
    reasons.push(
      `Calorie intake varied too much (CV ${roundTo(calorieCv, 2)}) to attribute a flat ` +
        `weight trend to metabolism rather than to intake.`,
    );
  }
  if (!activityStable) {
    reasons.push(
      `Daily steps varied too much (CV ${roundTo(stepCv, 2)}) to treat activity as held constant.`,
    );
  }
  return derived(evidence, 'Plateau detection', inputs, 'MODERATE', reasons);
}
