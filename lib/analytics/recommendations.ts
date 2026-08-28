/**
 * Recommendation candidates (spec §23, §45, §57).
 *
 * Three constraints shape this file:
 *
 *  1. CANDIDATES, NOT COMMANDS. The app produces evidence and a proposal. The
 *     user - with ChatGPT as the reasoning layer - makes the decision. Nothing
 *     here writes a target.
 *
 *  2. CLOSED TEMPLATE SET. Every recommendation is one of a fixed enum of
 *     kinds, defined in the database and mirrored here. There is no free-text
 *     generation path, which is what structurally prevents §45's forbidden
 *     advice (starvation, extreme fasting, purging, dehydration, stimulant
 *     abuse) from ever being emitted: those templates do not exist.
 *
 *  3. EVIDENCE IS MANDATORY. Every candidate carries the numbers that produced
 *     it. The database enforces this too, with a check constraint rejecting an
 *     empty evidence object.
 */
import type { Derived, LocalDate } from '@/lib/types';
import { ANALYTICS_VERSION } from '@/lib/types';
import type { PlateauEvidence } from './plateau';
import type { AdherenceBreakdown } from './adherence';
import type { TrendResult } from './trend';
import type { DataQualityResult } from './dataQuality';
import { kgToLb } from '@/lib/normalization/units';
import { roundTo } from './series';

export type RecommendationKind =
  | 'MAINTAIN_CURRENT_INTAKE'
  | 'CONSIDER_MODEST_CALORIE_REDUCTION'
  | 'CONSIDER_MODEST_CALORIE_INCREASE'
  | 'CONSIDER_INCREASING_DAILY_STEPS'
  | 'CONSIDER_ADDING_ZONE2_CARDIO'
  | 'IMPROVE_LOGGING_CONSISTENCY'
  | 'IMPROVE_TRAINING_ADHERENCE'
  | 'PRIORITISE_SLEEP'
  | 'COLLECT_MORE_DATA_BEFORE_CHANGING'
  | 'RATE_OF_LOSS_TOO_FAST_CONSIDER_EASING';

export interface RecommendationCandidate {
  kind: RecommendationKind;
  headline: string;
  evidence: Record<string, unknown>;
  confidence: 'HIGH' | 'MODERATE' | 'LOW';
  analyticsVersion: string;
  generatedForDate: LocalDate;
}

/** Target rate band for an aggressive but sane cut, as a share of bodyweight. */
export const TARGET_WEEKLY_LOSS_PCT = { min: 0.5, max: 1.0 } as const;

export interface RecommendationInput {
  date: LocalDate;
  weightTrend: Derived<TrendResult>;
  currentWeightKg: number | null;
  plateau: Derived<PlateauEvidence>;
  adherence: AdherenceBreakdown;
  dataQuality: Derived<DataQualityResult>;
  averageSleepMinutes: number | null;
  maxWeeklyLossRatePct: number;
}

/**
 * Produces the candidate set for a day, most important first.
 *
 * The ordering is deliberate: data-quality problems come before anything that
 * depends on the data being right, and a too-fast rate of loss outranks every
 * other suggestion because it is the only safety-relevant one.
 */
export function generateRecommendations(
  input: RecommendationInput,
): RecommendationCandidate[] {
  const candidates: RecommendationCandidate[] = [];
  const base = { analyticsVersion: ANALYTICS_VERSION, generatedForDate: input.date };

  const quality = input.dataQuality.value;
  const trend = input.weightTrend.value;
  const plateau = input.plateau.value;

  // --- Safety first. Losing too fast outranks every other consideration. ---
  if (trend && input.currentWeightKg !== null && input.currentWeightKg > 0) {
    const weeklyLossPct = (-trend.perWeek / input.currentWeightKg) * 100;
    if (weeklyLossPct > input.maxWeeklyLossRatePct) {
      candidates.push({
        ...base,
        kind: 'RATE_OF_LOSS_TOO_FAST_CONSIDER_EASING',
        headline: 'Weight is coming off faster than your own ceiling allows.',
        evidence: {
          ratePerWeekKg: roundTo(trend.perWeek, 3),
          ratePerWeekLb: roundTo(kgToLb(trend.perWeek), 2),
          weeklyLossPercentOfBodyweight: roundTo(weeklyLossPct, 2),
          yourCeilingPercent: input.maxWeeklyLossRatePct,
          rSquared: roundTo(trend.rSquared, 3),
          why:
            'Sustained loss above roughly 1% of bodyweight per week tends to cost ' +
            'lean mass and training quality. This is a prompt to review, not an instruction.',
        },
        confidence: input.weightTrend.confidence === 'HIGH' ? 'HIGH' : 'MODERATE',
      });
    }
  }

  // --- Nothing downstream is trustworthy if the inputs are thin. ---
  if (quality && quality.band === 'LOW') {
    candidates.push({
      ...base,
      kind: 'IMPROVE_LOGGING_CONSISTENCY',
      headline: 'Logging is too sparse to read the trend reliably.',
      evidence: {
        dataQualityScore: quality.score,
        weakestComponents: quality.components
          .filter((c) => c.points / c.weight < 0.6)
          .map((c) => ({ label: c.label, coverage: c.coverage })),
        why: 'Every conclusion below is computed from these inputs.',
      },
      confidence: 'HIGH',
    });
  }

  if (plateau?.verdict === 'INSUFFICIENT_DATA') {
    candidates.push({
      ...base,
      kind: 'COLLECT_MORE_DATA_BEFORE_CHANGING',
      headline: 'Not enough consistent data to justify changing anything yet.',
      evidence: {
        plateauVerdict: plateau.verdict,
        loggingAdherence: plateau.loggingAdherence,
        windowDays: plateau.windowDays,
        reasons: plateau.reasons,
        why:
          'A flat weight trend on incomplete intake data is not evidence of a ' +
          'plateau. Changing calories now would be changing a variable you cannot measure.',
      },
      confidence: 'HIGH',
    });
  }

  // --- A genuine plateau, with the adherence to back the claim. ---
  if (plateau?.verdict === 'PLATEAU') {
    const stepsAdherence = input.adherence.steps.value;
    // Prefer adding activity over cutting intake when there is headroom in
    // steps: it preserves the calorie floor and is easier to sustain.
    if (stepsAdherence !== null && stepsAdherence < 0.9) {
      candidates.push({
        ...base,
        kind: 'CONSIDER_INCREASING_DAILY_STEPS',
        headline: 'Progress has stalled and there is room in daily activity.',
        evidence: {
          plateauVerdict: plateau.verdict,
          windowDays: plateau.windowDays,
          weightAverageChangeKg: plateau.weightAverageChangeKg,
          stepAdherence: stepsAdherence,
          loggingAdherence: plateau.loggingAdherence,
          why: 'Adding activity raises expenditure without lowering the calorie floor.',
        },
        confidence: 'MODERATE',
      });
    }

    candidates.push({
      ...base,
      kind: 'CONSIDER_MODEST_CALORIE_REDUCTION',
      headline: 'A real plateau, with the adherence to support that reading.',
      evidence: {
        plateauVerdict: plateau.verdict,
        windowDays: plateau.windowDays,
        weightAverageChangeKg: plateau.weightAverageChangeKg,
        caloriesStable: plateau.caloriesStable,
        activityStable: plateau.activityStable,
        loggingAdherence: plateau.loggingAdherence,
        calorieAdherence: input.adherence.calories.value,
        why:
          'Weight average, intake and activity all held steady across the window ' +
          'with high logging adherence, which is the case where an intake change is indicated.',
        caution:
          'Change one variable at a time, and give it at least two weeks before judging.',
      },
      confidence: 'MODERATE',
    });
  }

  // --- Everything is working. Say so, with the numbers. ---
  if (plateau?.verdict === 'NO_PLATEAU' && trend && input.currentWeightKg !== null) {
    const weeklyLossPct = (-trend.perWeek / input.currentWeightKg) * 100;
    const inBand =
      weeklyLossPct >= TARGET_WEEKLY_LOSS_PCT.min &&
      weeklyLossPct <= TARGET_WEEKLY_LOSS_PCT.max;
    if (inBand) {
      candidates.push({
        ...base,
        kind: 'MAINTAIN_CURRENT_INTAKE',
        headline: 'On track. No change indicated.',
        evidence: {
          ratePerWeekKg: roundTo(trend.perWeek, 3),
          ratePerWeekLb: roundTo(kgToLb(trend.perWeek), 2),
          weeklyLossPercentOfBodyweight: roundTo(weeklyLossPct, 2),
          targetBandPercent: TARGET_WEEKLY_LOSS_PCT,
          calorieAdherence: input.adherence.calories.value,
          proteinAdherence: input.adherence.protein.value,
          trainingAdherence: input.adherence.training.value,
          why: 'The rate of loss sits inside the intended band and adherence supports it.',
        },
        confidence: input.weightTrend.confidence === 'HIGH' ? 'HIGH' : 'MODERATE',
      });
    }
  }

  // --- Behaviour gaps, reported plainly. ---
  const training = input.adherence.training.value;
  if (training !== null && training < 0.7) {
    candidates.push({
      ...base,
      kind: 'IMPROVE_TRAINING_ADHERENCE',
      headline: 'Training sessions are falling short of your own target.',
      evidence: {
        trainingAdherence: training,
        inputs: input.adherence.training.inputs,
        why:
          'Resistance training is what protects lean mass during a deficit. This is ' +
          'the lever with the most to lose from being missed.',
      },
      confidence: 'HIGH',
    });
  }

  const cardio = input.adherence.cardio.value;
  if (cardio !== null && cardio < 0.6) {
    candidates.push({
      ...base,
      kind: 'CONSIDER_ADDING_ZONE2_CARDIO',
      headline: 'Cardio is well below the weekly target you set.',
      evidence: {
        cardioAdherence: cardio,
        inputs: input.adherence.cardio.inputs,
        why: 'Zone 2 work adds expenditure at low recovery cost.',
      },
      confidence: 'MODERATE',
    });
  }

  // Spec §14: recovery informs, it never gates. The wording reflects that.
  if (input.averageSleepMinutes !== null && input.averageSleepMinutes < 6.5 * 60) {
    candidates.push({
      ...base,
      kind: 'PRIORITISE_SLEEP',
      headline: 'Average sleep is running below 6.5 hours.',
      evidence: {
        averageSleepMinutes: roundTo(input.averageSleepMinutes, 0),
        averageSleepHours: roundTo(input.averageSleepMinutes / 60, 2),
        why:
          'Short sleep tends to show up as worse training performance and higher ' +
          'appetite. Consider reducing training intensity only if performance is ' +
          'also declining - poor sleep on its own is not a reason to skip the gym.',
      },
      confidence: 'MODERATE',
    });
  }

  return candidates;
}
