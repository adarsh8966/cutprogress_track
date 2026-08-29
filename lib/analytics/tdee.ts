/**
 * Energy expenditure estimation (spec §20, §21).
 *
 * Spec §21 is the governing constraint: most of the useful intelligence here is
 * deterministic statistics, and no model is trained until enough data exists
 * (§42). So this file contains no machine learning. It contains an explicit,
 * inspectable Bayesian-flavoured shrinkage estimator, which is the right tool
 * for "what intake appears to maintain THIS user's weight?".
 *
 * PHASE 1 - the prior. Mifflin-St Jeor BMR times an activity factor. This is a
 * population formula. It is treated as a starting belief, never as truth.
 *
 * PHASE 2 - the observation. Over a window, energy balance says
 *
 *     TDEE ≈ mean intake + (weight change in kg × 7700 kcal/kg) / days
 *
 * i.e. if the user lost weight while eating X, expenditure exceeded X by the
 * energy the lost tissue represented. 7700 kcal/kg is the conventional figure
 * for mixed tissue loss; it is an approximation and is documented as one.
 *
 * COMBINING THEM. The observed estimate is noisy over short windows (water
 * weight swings dwarf the fat signal) and gets better with more days and more
 * complete logging. So the two are blended by precision weighting: the observed
 * estimate's weight grows with the number of well-logged days, and the prior
 * dominates until the data earns its place.
 *
 *     w = n_effective / (n_effective + K)
 *     TDEE = w × observed + (1 - w) × prior
 *
 * Below the minimum data thresholds nothing is returned at all - the estimate is
 * null with the reason attached, rather than a confident-looking number derived
 * from four days of half-logged intake.
 */
import type { DatedValue, Derived, LocalDate, UserProfile } from '@/lib/types';
import { derived, insufficient } from '@/lib/types';
import { KCAL_PER_KG_BODY_MASS } from '@/lib/normalization/units';
import { coverageOf, mean, presentValues, roundTo, trailingWindow } from './series';
import { trend } from './trend';
import { daysBetween } from '@/lib/normalization/dates';

/** Days of history before an observed estimate is attempted at all. */
export const MIN_DAYS_FOR_OBSERVED_TDEE = 14;
/** Share of days in the window that must have logged intake. */
export const MIN_INTAKE_COVERAGE = 0.8;
/**
 * Shrinkage constant K, in days. At n = K the observed estimate and the prior
 * carry equal weight. 21 days is roughly where the fat-loss signal starts to
 * clear typical water-weight noise.
 */
export const SHRINKAGE_DAYS = 21;

export interface TdeeEstimate {
  /** The blended estimate, kcal/day. */
  kcal: number;
  /** ± band, kcal/day. */
  standardError: number;
  priorKcal: number;
  observedKcal: number | null;
  /** Weight given to the observed estimate, 0..1. */
  observedWeight: number;
  daysUsed: number;
  intakeCoverage: number;
}

/**
 * Mifflin-St Jeor resting metabolic rate.
 * Male:   10w + 6.25h - 5a + 5
 * Female: 10w + 6.25h - 5a - 161
 * Where sex is unspecified the two are averaged, and the result is flagged.
 */
export function mifflinStJeorBmr(
  weightKg: number,
  heightCm: number,
  ageYears: number,
  sex: 'MALE' | 'FEMALE' | 'UNSPECIFIED',
): number {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * ageYears;
  if (sex === 'MALE') return base + 5;
  if (sex === 'FEMALE') return base - 161;
  return base + (5 - 161) / 2;
}

/**
 * Activity multiplier from observed steps, rather than a self-reported
 * lifestyle bucket. Anchored on the conventional 1.2 sedentary floor.
 */
export function activityFactorFromSteps(averageSteps: number | null): number {
  if (averageSteps === null) return 1.35;
  if (averageSteps < 4000) return 1.2;
  if (averageSteps < 7500) return 1.35;
  if (averageSteps < 10000) return 1.45;
  if (averageSteps < 13000) return 1.55;
  return 1.65;
}

export function ageFrom(dateOfBirth: LocalDate | null, on: LocalDate): number | null {
  if (dateOfBirth === null) return null;
  const days = daysBetween(dateOfBirth, on);
  if (days < 0) return null;
  return days / 365.2425;
}

/** Phase 1: the population prior. Never presented as measured truth. */
export function priorTdee(
  profile: UserProfile,
  currentWeightKg: number,
  averageSteps: number | null,
  on: LocalDate,
): Derived<number> {
  const age = ageFrom(profile.dateOfBirth, on);
  const inputs = {
    formula: 'Mifflin-St Jeor × step-derived activity factor',
    weightKg: roundTo(currentWeightKg, 2),
    heightCm: profile.heightCm,
    ageYears: age === null ? null : roundTo(age, 1),
    sex: profile.sex,
    averageSteps,
  };

  if (profile.heightCm === null) {
    return insufficient<number>(
      'Estimated TDEE (prior)',
      inputs,
      'Height is not set, so a BMR estimate cannot be computed.',
    );
  }

  // Age materially affects BMR but is optional in the profile; 30 is used as a
  // stand-in and the result is downgraded and flagged rather than presented as
  // equivalent to a real figure.
  const effectiveAge = age ?? 30;
  const bmr = mifflinStJeorBmr(
    currentWeightKg,
    profile.heightCm,
    effectiveAge,
    profile.sex ?? 'UNSPECIFIED',
  );
  const factor = activityFactorFromSteps(averageSteps);

  const notes = [
    'Population formula, not a measurement. Superseded by observed data as it accumulates.',
  ];
  if (age === null) notes.push('Date of birth is not set; age 30 assumed.');
  if (profile.sex === null || profile.sex === 'UNSPECIFIED') {
    notes.push('Sex is unspecified; the male and female constants were averaged.');
  }

  return derived(
    roundTo(bmr * factor, 0),
    'Estimated TDEE (prior)',
    { ...inputs, bmr: roundTo(bmr, 0), activityFactor: factor, ageAssumed: age === null },
    age === null ? 'LOW' : 'MODERATE',
    notes,
  );
}

/**
 * Phase 2: what the user's own data says maintenance is.
 * Blends the energy-balance observation with the prior by precision weighting.
 */
export function estimateTdee(
  profile: UserProfile,
  weight: DatedValue[],
  calories: DatedValue[],
  steps: DatedValue[],
  end: LocalDate,
  windowDays = 28,
): Derived<TdeeEstimate> {
  const calorieWindow = trailingWindow(calories, end, windowDays);
  const calorieValues = presentValues(calorieWindow.map((p) => p.value));
  const intakeCoverage = coverageOf(calorieWindow.map((p) => p.value));

  const stepWindow = trailingWindow(steps, end, windowDays);
  const averageSteps = mean(presentValues(stepWindow.map((p) => p.value)));

  const weightTrend = trend(weight, end, windowDays, 'Weight trend for TDEE');
  const latestWeight = weightTrend.value?.fittedEnd ?? null;

  const inputs = {
    windowDays,
    endDate: end,
    daysWithIntake: intakeCoverage.present,
    intakeCoverage: roundTo(intakeCoverage.ratio, 3),
    meanIntakeKcal: calorieValues.length ? roundTo(mean(calorieValues)!, 0) : null,
    weightTrendKgPerWeek: weightTrend.value ? roundTo(weightTrend.value.perWeek, 4) : null,
    energyDensityKcalPerKg: KCAL_PER_KG_BODY_MASS,
    minDays: MIN_DAYS_FOR_OBSERVED_TDEE,
    minIntakeCoverage: MIN_INTAKE_COVERAGE,
  };

  if (latestWeight === null) {
    return insufficient<TdeeEstimate>(
      'Observed TDEE',
      inputs,
      'No usable weight trend in the window, so energy balance cannot be evaluated.',
    );
  }

  const prior = priorTdee(profile, latestWeight, averageSteps, end);
  if (prior.value === null) {
    return insufficient<TdeeEstimate>(
      'Observed TDEE',
      { ...inputs, priorNote: prior.notes },
      `The prior could not be computed: ${prior.notes[0] ?? 'unknown reason'}`,
    );
  }

  // Not enough data to say anything observed - report the prior only, clearly
  // labelled as such, rather than inventing an observed component.
  if (
    intakeCoverage.present < MIN_DAYS_FOR_OBSERVED_TDEE ||
    intakeCoverage.ratio < MIN_INTAKE_COVERAGE ||
    weightTrend.value === null
  ) {
    return derived<TdeeEstimate>(
      {
        kcal: prior.value,
        // The prior's own uncertainty. Mifflin-St Jeor is commonly quoted at
        // roughly ±10% for an individual.
        standardError: roundTo(prior.value * 0.1, 0),
        priorKcal: prior.value,
        observedKcal: null,
        observedWeight: 0,
        daysUsed: intakeCoverage.present,
        intakeCoverage: roundTo(intakeCoverage.ratio, 3),
      },
      'Estimated TDEE (prior only)',
      inputs,
      'LOW',
      [
        `Not yet enough well-logged data for an observed estimate: need ` +
          `${MIN_DAYS_FOR_OBSERVED_TDEE} days at ${Math.round(MIN_INTAKE_COVERAGE * 100)}% ` +
          `intake logging, have ${intakeCoverage.present} days at ` +
          `${Math.round(intakeCoverage.ratio * 100)}%.`,
        'This is the population formula only. It is not what your data says.',
      ],
    );
  }

  const meanIntake = mean(calorieValues)!;
  const kgPerDay = weightTrend.value.perDay;
  // Losing weight (negative slope) means expenditure exceeded intake.
  const observed = meanIntake - kgPerDay * KCAL_PER_KG_BODY_MASS;

  const n = intakeCoverage.present;
  const observedWeight = n / (n + SHRINKAGE_DAYS);
  const blended = observedWeight * observed + (1 - observedWeight) * prior.value;

  // Uncertainty propagates from the slope's standard error through the energy
  // density, plus the residual prior uncertainty on the un-shrunk share.
  const observedSe = weightTrend.value.slopeStandardError * KCAL_PER_KG_BODY_MASS;
  const standardError = Math.sqrt(
    (observedWeight * observedSe) ** 2 + ((1 - observedWeight) * prior.value * 0.1) ** 2,
  );

  const notes = [
    `Observed component uses mean intake ${Math.round(meanIntake)} kcal against a ` +
      `${roundTo(weightTrend.value.perWeek, 2)} kg/week trend.`,
    `Blended ${Math.round(observedWeight * 100)}% observed / ` +
      `${Math.round((1 - observedWeight) * 100)}% population prior; the observed share ` +
      `grows as more well-logged days accumulate.`,
    '7700 kcal/kg is a conventional approximation for mixed tissue, not an exact constant.',
  ];

  const confidence =
    n >= 28 && weightTrend.confidence === 'HIGH'
      ? 'HIGH'
      : n >= 21
        ? 'MODERATE'
        : 'LOW';

  return derived<TdeeEstimate>(
    {
      kcal: roundTo(blended, 0),
      standardError: roundTo(standardError, 0),
      priorKcal: prior.value,
      observedKcal: roundTo(observed, 0),
      observedWeight: roundTo(observedWeight, 3),
      daysUsed: n,
      intakeCoverage: roundTo(intakeCoverage.ratio, 3),
    },
    'Observed TDEE (energy balance, shrunk toward population prior)',
    { ...inputs, shrinkageDays: SHRINKAGE_DAYS, priorKcal: prior.value },
    confidence,
    notes,
  );
}
