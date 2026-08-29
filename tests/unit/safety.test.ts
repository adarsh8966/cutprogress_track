import { describe, it, expect } from 'vitest';
import {
  reviewTargets, checkCalorieTarget, checkTargetWeight, checkWeeklyLossRate,
  bmi, CALORIE_HARD_FLOOR, MIN_HEALTHY_BMI,
} from '@/lib/validation/safety';
import { lbToKg, feetInchesToCm } from '@/lib/normalization/units';

const HEIGHT = feetInchesToCm(5, 10);

describe('safety rails (spec §45)', () => {
  it('accepts the user\'s own stated plan without complaint', () => {
    // 205 lb -> 180 lb at 1950 kcal is aggressive but sane, and must not nag.
    const review = reviewTargets({
      calories: 1950,
      targetWeightKg: lbToKg(180),
      heightCm: HEIGHT,
      sex: 'MALE',
      maxWeeklyLossRatePct: 1.0,
    });
    expect(review.findings).toHaveLength(0);
    expect(review.blocked).toBe(false);
    expect(review.needsAcknowledgement).toBe(false);
  });

  it('warns but allows a low calorie target with explicit confirmation', () => {
    const findings = checkCalorieTarget(1300, 'MALE');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('WARNING');
    expect(findings[0]!.requiresAcknowledgement).toBe(true);
  });

  it('refuses outright below the hard calorie floor', () => {
    const findings = checkCalorieTarget(CALORIE_HARD_FLOOR - 1, 'MALE');
    expect(findings[0]!.severity).toBe('BLOCK');
    expect(findings[0]!.requiresAcknowledgement).toBe(false);
    expect(reviewTargets({
      calories: 800, targetWeightKg: null, heightCm: HEIGHT,
      sex: 'MALE', maxWeeklyLossRatePct: 1,
    }).blocked).toBe(true);
  });

  it('uses a lower floor for female profiles', () => {
    expect(checkCalorieTarget(1300, 'FEMALE')).toHaveLength(0);
    expect(checkCalorieTarget(1300, 'MALE')).toHaveLength(1);
  });

  it('warns on a target weight below the healthy BMI floor', () => {
    const veryLow = lbToKg(125); // BMI ~17.9 at 5'10"
    expect(bmi(veryLow, HEIGHT)).toBeLessThan(MIN_HEALTHY_BMI);
    const findings = checkTargetWeight(veryLow, HEIGHT);
    expect(findings[0]!.severity).toBe('WARNING');
    expect(findings[0]!.message).toMatch(/crude measure/);
  });

  it('blocks a target weight below the hard BMI floor', () => {
    const findings = checkTargetWeight(lbToKg(110), HEIGHT);
    expect(findings[0]!.severity).toBe('BLOCK');
  });

  it('warns above a sustainable loss rate and blocks above the hard ceiling', () => {
    expect(checkWeeklyLossRate(1.0)).toHaveLength(0);
    expect(checkWeeklyLossRate(1.5)[0]!.severity).toBe('WARNING');
    expect(checkWeeklyLossRate(2.5)[0]!.severity).toBe('BLOCK');
  });

  it('says nothing about targets that are not set', () => {
    expect(checkCalorieTarget(null, 'MALE')).toHaveLength(0);
    expect(checkTargetWeight(null, HEIGHT)).toHaveLength(0);
    expect(checkTargetWeight(lbToKg(180), null)).toHaveLength(0);
  });
});
