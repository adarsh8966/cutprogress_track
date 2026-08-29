import { describe, it, expect } from 'vitest';
import type { DatedValue, UserProfile } from '@/lib/types';
import { trend, trendChange, MIN_POINTS_FOR_TREND } from '@/lib/analytics/trend';
import { detectPlateau, MIN_LOGGING_ADHERENCE } from '@/lib/analytics/plateau';
import { estimateTdee, mifflinStJeorBmr, activityFactorFromSteps } from '@/lib/analytics/tdee';
import { forecastTargetDate } from '@/lib/analytics/forecast';
import { computeAdherence, targetAdherence, floorAdherence } from '@/lib/analytics/adherence';
import { computeDataQuality } from '@/lib/analytics/dataQuality';
import { scoreNutritionDay, DEFAULT_NUTRITION_WEIGHTS } from '@/lib/analytics/scores';
import { addDays, dateRange } from '@/lib/normalization/dates';
import { lbToKg } from '@/lib/normalization/units';

/** Builds a daily series from a generator over `days` ending at `end`. */
function series(
  end: string,
  days: number,
  fn: (index: number, date: string) => number | null,
): DatedValue[] {
  const start = addDays(end, -(days - 1));
  return dateRange(start, end).map((date, index) => ({ date, value: fn(index, date) }));
}

const PROFILE: UserProfile = {
  heightCm: 177.8,
  sex: 'MALE',
  dateOfBirth: '1996-01-01',
  timezone: 'America/New_York',
  startingWeightKg: lbToKg(205),
  targetWeightKg: lbToKg(180),
  phase: 'CUT',
  targets: {
    calories: 1950,
    proteinG: 145,
    fiberG: 30,
    steps: 10000,
    trainingSessionsPerWeek: 5,
    cardioMinutesPerWeek: 150,
  },
  maxWeeklyLossRatePct: 1.0,
  cutStartDate: '2026-08-28',
  weightDisplayUnit: 'LB',
  distanceDisplayUnit: 'MI',
  lengthDisplayUnit: 'IN',
};

describe('trend estimation (spec §18)', () => {
  it('recovers a known slope', () => {
    // Losing exactly 0.1 kg/day = 0.7 kg/week.
    const weight = series('2026-09-26', 30, (i) => 93 - i * 0.1);
    const result = trend(weight, '2026-09-26', 30, 'Weight');
    expect(result.value!.perDay).toBeCloseTo(-0.1, 10);
    expect(result.value!.perWeek).toBeCloseTo(-0.7, 10);
    expect(result.value!.rSquared).toBeCloseTo(1, 10);
    expect(result.confidence).toBe('HIGH');
  });

  it('refuses to fit a trend from too few points', () => {
    const weight = series('2026-09-26', 30, (i) => (i > 26 ? 93 - i * 0.1 : null));
    const result = trend(weight, '2026-09-26', 30, 'Weight');
    expect(result.value).toBeNull();
    expect(result.confidence).toBe('INSUFFICIENT');
    expect(result.notes[0]).toContain(`${MIN_POINTS_FOR_TREND}`);
  });

  it('reports a wide standard error on noisy data', () => {
    const clean = trend(series('2026-09-26', 30, (i) => 93 - i * 0.05), '2026-09-26', 30, 'clean');
    // Same slope, large alternating noise.
    const noisy = trend(
      series('2026-09-26', 30, (i) => 93 - i * 0.05 + (i % 2 === 0 ? 1.5 : -1.5)),
      '2026-09-26', 30, 'noisy',
    );
    expect(noisy.value!.slopeStandardError).toBeGreaterThan(
      clean.value!.slopeStandardError,
    );
    expect(noisy.value!.rSquared).toBeLessThan(clean.value!.rSquared);
  });

  it('detects a slowing rate of loss', () => {
    // Fast for the first half, slow for the second.
    const weight = series('2026-09-26', 28, (i) =>
      i < 14 ? 95 - i * 0.15 : 95 - 14 * 0.15 - (i - 14) * 0.02,
    );
    const change = trendChange(weight, '2026-09-26', 28, 'Weight');
    expect(change.value!.direction).toBe('SLOWING');
  });

  it('reports a steady rate as steady', () => {
    const weight = series('2026-09-26', 28, (i) => 95 - i * 0.1);
    expect(trendChange(weight, '2026-09-26', 28, 'Weight').value!.direction).toBe('STEADY');
  });
});

describe('plateau detection (spec §19)', () => {
  const END = '2026-09-26';
  const flatWeight = series(END, 30, () => 92.5 + (Math.random() > 2 ? 1 : 0));
  const steadyCalories = series(END, 30, (i) => 1950 + (i % 3) * 20);
  const steadySteps = series(END, 30, (i) => 9800 + (i % 4) * 100);

  it('calls a plateau when weight, intake and activity are all stable and logging is high', () => {
    const result = detectPlateau(flatWeight, steadyCalories, steadySteps, END, 21);
    expect(result.value!.verdict).toBe('PLATEAU');
    expect(result.confidence).toBe('HIGH');
  });

  it('returns INSUFFICIENT_DATA, never PLATEAU, when logging is poor', () => {
    // The distinction the spec calls "huge": flat weight on half-logged intake
    // is not evidence of a plateau, it is evidence of not knowing.
    const halfLogged = series(END, 30, (i) => (i % 2 === 0 ? 1950 : null));
    const result = detectPlateau(flatWeight, halfLogged, steadySteps, END, 21);
    expect(result.value!.verdict).toBe('INSUFFICIENT_DATA');
    expect(result.value!.verdict).not.toBe('PLATEAU');
    expect(result.confidence).toBe('INSUFFICIENT');
    expect(result.value!.loggingAdherence!).toBeLessThan(MIN_LOGGING_ADHERENCE);
    expect(result.notes.join(' ')).toMatch(/plateau from an unmeasured one/);
  });

  it('does not call a plateau while weight is still moving', () => {
    const falling = series(END, 30, (i) => 95 - i * 0.1);
    const result = detectPlateau(falling, steadyCalories, steadySteps, END, 21);
    expect(result.value!.verdict).toBe('NO_PLATEAU');
  });

  it('does not call a plateau when intake was not actually held stable', () => {
    const swinging = series(END, 30, (i) => (i % 2 === 0 ? 1500 : 2600));
    const result = detectPlateau(flatWeight, swinging, steadySteps, END, 21);
    expect(result.value!.verdict).toBe('NO_PLATEAU');
    expect(result.notes.join(' ')).toMatch(/varied too much/);
  });

  it('never uses a window shorter than the spec minimum', () => {
    const result = detectPlateau(flatWeight, steadyCalories, steadySteps, END, 3);
    expect(result.value!.windowDays).toBeGreaterThanOrEqual(14);
  });
});

describe('TDEE estimation (spec §20, §21)', () => {
  const END = '2026-09-26';

  it('computes Mifflin-St Jeor correctly', () => {
    // 93 kg, 177.8 cm, 30 y, male: 10(93) + 6.25(177.8) - 5(30) + 5 = 1896.25
    expect(mifflinStJeorBmr(93, 177.8, 30, 'MALE')).toBeCloseTo(1896.25, 2);
  });

  it('scales the activity factor with observed steps', () => {
    expect(activityFactorFromSteps(3000)).toBeLessThan(activityFactorFromSteps(12000));
    expect(activityFactorFromSteps(null)).toBeGreaterThan(1);
  });

  it('returns the prior only, clearly labelled, when data is too thin', () => {
    const weight = series(END, 30, (i) => 93 - i * 0.05);
    const calories = series(END, 30, (i) => (i > 24 ? 1950 : null));
    const steps = series(END, 30, () => 9800);
    const result = estimateTdee(PROFILE, weight, calories, steps, END, 28);
    expect(result.value!.observedKcal).toBeNull();
    expect(result.value!.observedWeight).toBe(0);
    expect(result.method).toContain('prior only');
    expect(result.notes.join(' ')).toMatch(/not what your data says/);
  });

  it('recovers a known TDEE from energy balance', () => {
    // Eating 2000 kcal while losing 0.5 kg/week implies expenditure of
    // 2000 + 0.5 * 7700 / 7 = 2550 kcal/day.
    const weight = series(END, 40, (i) => 93 - i * (0.5 / 7));
    const calories = series(END, 40, () => 2000);
    const steps = series(END, 40, () => 9800);
    const result = estimateTdee(PROFILE, weight, calories, steps, END, 28);
    expect(result.value!.observedKcal).toBeCloseTo(2550, 0);
    // The blend shrinks the observation toward the prior, so the reported
    // figure must lie strictly between the two, whichever is higher.
    expect(result.value!.observedWeight).toBeGreaterThan(0.5);
    const low = Math.min(result.value!.observedKcal!, result.value!.priorKcal);
    const high = Math.max(result.value!.observedKcal!, result.value!.priorKcal);
    expect(result.value!.kcal).toBeGreaterThan(low);
    expect(result.value!.kcal).toBeLessThan(high);
    // And it must sit nearer the observation, which carries the larger weight.
    expect(Math.abs(result.value!.kcal - result.value!.observedKcal!)).toBeLessThan(
      Math.abs(result.value!.kcal - result.value!.priorKcal),
    );
  });

  it('gives the observed estimate more weight as data accumulates', () => {
    const build = (days: number) => {
      const weight = series(END, days, (i) => 93 - i * (0.5 / 7));
      const calories = series(END, days, () => 2000);
      const steps = series(END, days, () => 9800);
      return estimateTdee(PROFILE, weight, calories, steps, END, days);
    };
    expect(build(42).value!.observedWeight).toBeGreaterThan(
      build(16).value!.observedWeight,
    );
  });

  it('refuses entirely without a height to compute a prior from', () => {
    const noHeight = { ...PROFILE, heightCm: null };
    const weight = series(END, 30, (i) => 93 - i * 0.05);
    const result = estimateTdee(noHeight, weight, series(END, 30, () => 2000), series(END, 30, () => 9800), END);
    expect(result.value).toBeNull();
    expect(result.confidence).toBe('INSUFFICIENT');
  });
});

describe('forecasting (spec §22)', () => {
  const END = '2026-09-26';

  it('quotes a range, not a single date', () => {
    const weight = series(END, 30, (i) => 93 - i * 0.05 + (i % 3) * 0.2);
    const result = forecastTargetDate(weight, lbToKg(180), END, 30);
    expect(result.value).not.toBeNull();
    expect(result.value!.optimisticDate <= result.value!.bestEstimateDate).toBe(true);
    expect(result.value!.conservativeDate >= result.value!.bestEstimateDate).toBe(true);
    expect(result.notes.join(' ')).toMatch(/assumes the current rate continues/);
  });

  it('refuses to project a date from a flat trend', () => {
    const weight = series(END, 30, () => 93);
    const result = forecastTargetDate(weight, lbToKg(180), END, 30);
    expect(result.value).toBeNull();
    expect(result.notes.join(' ')).toMatch(/flat/);
  });

  it('refuses to project when the trend moves away from target', () => {
    const weight = series(END, 30, (i) => 93 + i * 0.05);
    const result = forecastTargetDate(weight, lbToKg(180), END, 30);
    expect(result.value).toBeNull();
    expect(result.notes.join(' ')).toMatch(/away from the target/);
  });

  it('needs a target to forecast toward', () => {
    const weight = series(END, 30, (i) => 93 - i * 0.05);
    expect(forecastTargetDate(weight, null, END, 30).value).toBeNull();
  });
});

describe('adherence (spec §11)', () => {
  const END = '2026-09-26';

  it('treats over- and under-eating as equally off target', () => {
    expect(targetAdherence(2500, 1950)).toBeCloseTo(targetAdherence(1400, 1950), 10);
  });

  it('does not penalise exceeding a floor target', () => {
    expect(floorAdherence(200, 145)).toBe(1);
    expect(floorAdherence(120, 145)).toBeCloseTo(120 / 145, 10);
  });

  it('scores each day, so a low day and a high day do not cancel out', () => {
    const swinging = series(END, 28, (i) => (i % 2 === 0 ? 1400 : 2500));
    const result = computeAdherence(
      {
        calories: swinging,
        protein: series(END, 28, () => 145),
        steps: series(END, 28, () => 10000),
        weight: series(END, 28, () => 92),
        trainingSessions: series(END, 28, (i) => (i % 7 < 5 ? 1 : 0)),
        cardioMinutes: series(END, 28, () => 25),
      },
      PROFILE.targets,
      END,
      28,
    );
    // Mean intake is spot on 1950, but no individual day was.
    expect(result.calories.value!).toBeLessThan(0.8);
  });

  it('counts unlogged days against logging, not against calorie adherence', () => {
    const halfLogged = series(END, 28, (i) => (i % 2 === 0 ? 1950 : null));
    const result = computeAdherence(
      {
        calories: halfLogged,
        protein: series(END, 28, () => 145),
        steps: series(END, 28, () => 10000),
        weight: series(END, 28, () => 92),
        trainingSessions: series(END, 28, () => 1),
        cardioMinutes: series(END, 28, () => 25),
      },
      PROFILE.targets,
      END,
      28,
    );
    // Every logged day hit the target exactly, so calorie adherence is perfect.
    expect(result.calories.value).toBeCloseTo(1, 6);
    // The missing half shows up here instead.
    expect(result.logging.value!).toBeLessThan(0.8);
  });

  it('excludes components with no target rather than scoring them zero', () => {
    const noTargets = { ...PROFILE.targets, cardioMinutesPerWeek: null, steps: null };
    const result = computeAdherence(
      {
        calories: series(END, 28, () => 1950),
        protein: series(END, 28, () => 145),
        steps: series(END, 28, () => 10000),
        weight: series(END, 28, () => 92),
        trainingSessions: series(END, 28, (i) => (i % 7 < 5 ? 1 : 0)),
        cardioMinutes: series(END, 28, () => 25),
      },
      noTargets,
      END,
      28,
    );
    expect(result.steps.value).toBeNull();
    expect(result.cardio.value).toBeNull();
    // Excluding them keeps overall high rather than dragging it toward zero.
    expect(result.overall.value!).toBeGreaterThan(0.9);
    expect(result.overall.notes.join(' ')).toMatch(/excluded/);
  });
});

describe('data quality (spec §32)', () => {
  const END = '2026-09-26';

  it('scores complete data highly and sparse data low', () => {
    const full = computeDataQuality(
      {
        weight: series(END, 28, () => 92),
        calories: series(END, 28, () => 1950),
        trainingSessions: series(END, 28, (i) => (i % 7 < 5 ? 1 : 0)),
        steps: series(END, 28, () => 9800),
        sleepMinutes: series(END, 28, () => 440),
        waist: series(END, 28, (i) => (i % 7 === 0 ? 88 : null)),
      },
      END, 28,
    );
    expect(full.value!.score).toBeGreaterThan(90);
    expect(full.value!.band).toBe('HIGH');

    const sparse = computeDataQuality(
      {
        weight: series(END, 28, (i) => (i % 4 === 0 ? 92 : null)),
        calories: series(END, 28, () => null),
        trainingSessions: series(END, 28, () => null),
        steps: series(END, 28, () => null),
        sleepMinutes: series(END, 28, () => null),
        waist: series(END, 28, () => null),
      },
      END, 28,
    );
    expect(sparse.value!.band).toBe('LOW');
    expect(sparse.notes.join(' ')).toMatch(/provisional/);
  });

  it('gives full marks for a weekly waist measurement at weekly cadence', () => {
    const result = computeDataQuality(
      {
        weight: series(END, 28, () => 92),
        calories: series(END, 28, () => 1950),
        trainingSessions: series(END, 28, (i) => (i % 7 < 5 ? 1 : 0)),
        steps: series(END, 28, () => 9800),
        sleepMinutes: series(END, 28, () => 440),
        waist: series(END, 28, (i) => (i % 7 === 0 ? 88 : null)),
      },
      END, 28,
    );
    const waist = result.value!.components.find((c) => c.key === 'waist')!;
    expect(waist.points).toBeCloseTo(waist.weight, 5);
  });
});

describe('nutrition score (spec §9)', () => {
  it('does not mark down a well-executed day for its macro split', () => {
    // The spec's example: 1,980 kcal and 140 g protein must not score badly.
    const result = scoreNutritionDay(
      {
        calories: 1980, proteinG: 140, carbsG: 210, fatG: 61, fiberG: 28,
        fruitVegServings: 5, logged: true,
      },
      PROFILE.targets,
      DEFAULT_NUTRITION_WEIGHTS,
    );
    expect(result.value!.score).toBeGreaterThan(90);
  });

  it('scores an unlogged day as unscoreable, not as zero', () => {
    const result = scoreNutritionDay(
      {
        calories: null, proteinG: null, carbsG: null, fatG: null, fiberG: null,
        fruitVegServings: null, logged: false,
      },
      PROFILE.targets,
    );
    expect(result.value).toBeNull();
    expect(result.confidence).toBe('INSUFFICIENT');
    expect(result.notes.join(' ')).toMatch(/not a zero/);
  });

  it('normalises over available points when an optional input is missing', () => {
    const withoutServings = scoreNutritionDay(
      {
        calories: 1950, proteinG: 145, carbsG: 200, fatG: 60, fiberG: 30,
        fruitVegServings: null, logged: true,
      },
      PROFILE.targets,
    );
    // Not recording servings must not silently cost 10 points.
    expect(withoutServings.value!.score).toBeCloseTo(100, 0);
    expect(withoutServings.value!.availablePoints).toBeLessThan(100);
    expect(withoutServings.notes.join(' ')).toMatch(/Not scored/);
  });

  it('always returns the component breakdown (spec §57)', () => {
    const result = scoreNutritionDay(
      {
        calories: 1980, proteinG: 140, carbsG: 210, fatG: 61, fiberG: 28,
        fruitVegServings: 5, logged: true,
      },
      PROFILE.targets,
    );
    expect(result.value!.components.length).toBe(7);
    for (const component of result.value!.components) {
      expect(component).toHaveProperty('weight');
      expect(component).toHaveProperty('attainment');
    }
  });

  it('honours reconfigured weights', () => {
    const day = {
      calories: 1950, proteinG: 100, carbsG: 200, fatG: 60, fiberG: 30,
      fruitVegServings: 5, logged: true,
    };
    const proteinHeavy = scoreNutritionDay(day, PROFILE.targets, {
      ...DEFAULT_NUTRITION_WEIGHTS, proteinAdherence: 60, calorieAdherence: 10,
    });
    const calorieHeavy = scoreNutritionDay(day, PROFILE.targets, {
      ...DEFAULT_NUTRITION_WEIGHTS, proteinAdherence: 10, calorieAdherence: 60,
    });
    // Protein was missed, calories were hit, so weighting protein harder must
    // produce the lower score.
    expect(proteinHeavy.value!.score).toBeLessThan(calorieHeavy.value!.score);
  });
});
