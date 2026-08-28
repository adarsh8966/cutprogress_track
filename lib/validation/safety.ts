/**
 * Safety rails (spec §45).
 *
 * "The app is designed for aggressive but sane fat loss, not self-destruction."
 *
 * The recommendation engine cannot emit unsafe advice by construction, because
 * it can only select from a closed template set. This file covers the other
 * direction: targets the USER sets on themselves. Extreme values are not
 * silently accepted and not silently refused either - they raise a warning the
 * user must explicitly acknowledge, which is then written to the audit log.
 *
 * These floors are conservative general references, not medical advice, and the
 * app says so wherever it shows them.
 */
import type { UserProfile } from '@/lib/types';
import { kgToLb } from '@/lib/normalization/units';

export type SafetySeverity = 'WARNING' | 'BLOCK';

export interface SafetyFinding {
  code: string;
  severity: SafetySeverity;
  message: string;
  /** What the user would have to acknowledge to proceed. */
  requiresAcknowledgement: boolean;
}

/** Below this, a calorie target is not an aggressive cut, it is undereating. */
export const CALORIE_FLOOR_MALE = 1500;
export const CALORIE_FLOOR_FEMALE = 1200;
/** An absolute floor no acknowledgement can override. */
export const CALORIE_HARD_FLOOR = 1000;
/** BMI floors. 18.5 is the conventional lower bound of the healthy range. */
export const MIN_HEALTHY_BMI = 18.5;
export const HARD_MIN_BMI = 17.0;
/** Weekly loss beyond this share of bodyweight is not sustainable. */
export const MAX_SUSTAINABLE_WEEKLY_LOSS_PCT = 1.0;
export const HARD_MAX_WEEKLY_LOSS_PCT = 2.0;

export function bmi(weightKg: number, heightCm: number): number {
  const heightM = heightCm / 100;
  return weightKg / (heightM * heightM);
}

export function calorieFloorFor(sex: UserProfile['sex']): number {
  return sex === 'FEMALE' ? CALORIE_FLOOR_FEMALE : CALORIE_FLOOR_MALE;
}

export function checkCalorieTarget(
  target: number | null,
  sex: UserProfile['sex'],
): SafetyFinding[] {
  if (target === null) return [];
  const findings: SafetyFinding[] = [];

  if (target < CALORIE_HARD_FLOOR) {
    findings.push({
      code: 'CALORIE_TARGET_BELOW_HARD_FLOOR',
      severity: 'BLOCK',
      message:
        `A target of ${target} kcal is below ${CALORIE_HARD_FLOOR} kcal and will not be ` +
        `saved. Intakes this low belong under medical supervision, not in a self-directed cut.`,
      requiresAcknowledgement: false,
    });
    return findings;
  }

  const floor = calorieFloorFor(sex);
  if (target < floor) {
    findings.push({
      code: 'CALORIE_TARGET_BELOW_FLOOR',
      severity: 'WARNING',
      message:
        `${target} kcal is below the ${floor} kcal reference floor. Very low intakes ` +
        `tend to cost lean mass, training quality and adherence rather than speeding ` +
        `fat loss. Confirm explicitly if you intend to set this.`,
      requiresAcknowledgement: true,
    });
  }
  return findings;
}

export function checkTargetWeight(
  targetWeightKg: number | null,
  heightCm: number | null,
): SafetyFinding[] {
  if (targetWeightKg === null || heightCm === null) return [];
  const findings: SafetyFinding[] = [];
  const targetBmi = bmi(targetWeightKg, heightCm);

  if (targetBmi < HARD_MIN_BMI) {
    findings.push({
      code: 'TARGET_WEIGHT_BELOW_HARD_FLOOR',
      severity: 'BLOCK',
      message:
        `A target of ${kgToLb(targetWeightKg).toFixed(1)} lb is a BMI of ` +
        `${targetBmi.toFixed(1)}, below ${HARD_MIN_BMI}, and will not be saved.`,
      requiresAcknowledgement: false,
    });
    return findings;
  }

  if (targetBmi < MIN_HEALTHY_BMI) {
    findings.push({
      code: 'TARGET_WEIGHT_BELOW_HEALTHY_BMI',
      severity: 'WARNING',
      message:
        `That target is a BMI of ${targetBmi.toFixed(1)}, below the conventional ` +
        `healthy floor of ${MIN_HEALTHY_BMI}. BMI is a crude measure and says nothing ` +
        `about your body composition, but this is far enough down to be worth a ` +
        `deliberate confirmation.`,
      requiresAcknowledgement: true,
    });
  }
  return findings;
}

export function checkWeeklyLossRate(ratePct: number | null): SafetyFinding[] {
  if (ratePct === null) return [];
  const findings: SafetyFinding[] = [];

  if (ratePct > HARD_MAX_WEEKLY_LOSS_PCT) {
    findings.push({
      code: 'LOSS_RATE_ABOVE_HARD_CEILING',
      severity: 'BLOCK',
      message:
        `A ceiling of ${ratePct}% of bodyweight per week will not be saved. ` +
        `Above ${HARD_MAX_WEEKLY_LOSS_PCT}% is not a rate this app will help you plan for.`,
      requiresAcknowledgement: false,
    });
    return findings;
  }

  if (ratePct > MAX_SUSTAINABLE_WEEKLY_LOSS_PCT) {
    findings.push({
      code: 'LOSS_RATE_ABOVE_SUSTAINABLE',
      severity: 'WARNING',
      message:
        `${ratePct}% per week is above the ~${MAX_SUSTAINABLE_WEEKLY_LOSS_PCT}% that ` +
        `is generally sustainable without meaningful lean-mass loss. Confirm explicitly ` +
        `if you intend to set this.`,
      requiresAcknowledgement: true,
    });
  }
  return findings;
}

export interface ProposedTargets {
  calories: number | null;
  targetWeightKg: number | null;
  heightCm: number | null;
  sex: UserProfile['sex'];
  maxWeeklyLossRatePct: number | null;
}

export interface SafetyReview {
  findings: SafetyFinding[];
  blocked: boolean;
  needsAcknowledgement: boolean;
}

/** The single entry point Settings calls before saving anything. */
export function reviewTargets(proposed: ProposedTargets): SafetyReview {
  const findings = [
    ...checkCalorieTarget(proposed.calories, proposed.sex),
    ...checkTargetWeight(proposed.targetWeightKg, proposed.heightCm),
    ...checkWeeklyLossRate(proposed.maxWeeklyLossRatePct),
  ];

  return {
    findings,
    blocked: findings.some((f) => f.severity === 'BLOCK'),
    needsAcknowledgement: findings.some((f) => f.requiresAcknowledgement),
  };
}
