/**
 * Nutrition score (spec §9).
 *
 * Explicitly NOT an "AI nutrition score". It is a weighted sum of adherence to
 * the USER'S OWN targets, the weights are configurable, and the per-component
 * breakdown is always returned so the number can be taken apart.
 *
 * Spec §9's constraint, restated because it is easy to violate by accident:
 * a day at 1,980 kcal with 140 g protein must not score badly because the
 * algorithm dislikes the carb distribution. Score measures adherence to chosen
 * goals, not diet quality, and there is no hidden judgement of food choices.
 */
import type { Derived, Targets } from '@/lib/types';
import { derived, insufficient } from '@/lib/types';
import { roundTo } from './series';
import { floorAdherence, targetAdherence } from './adherence';

export const SCORER_VERSION = '0.1.0';

/** Spec §9's default weights. Every one is user-configurable. */
export interface NutritionScoreWeights {
  calorieAdherence: number;
  proteinAdherence: number;
  fiber: number;
  loggingConsistency: number;
  fruitVeg: number;
  fatCarbBalance: number;
  userDefined: number;
}

export const DEFAULT_NUTRITION_WEIGHTS: NutritionScoreWeights = {
  calorieAdherence: 30,
  proteinAdherence: 25,
  fiber: 10,
  loggingConsistency: 10,
  fruitVeg: 10,
  fatCarbBalance: 5,
  userDefined: 10,
};

export interface ScoreComponent {
  key: keyof NutritionScoreWeights;
  label: string;
  weight: number;
  /** 0..1 attainment, or null when the input for it was not logged. */
  attainment: number | null;
  points: number | null;
  note?: string;
}

export interface NutritionScoreResult {
  score: number;
  /** Points available from components that could actually be scored. */
  availablePoints: number;
  components: ScoreComponent[];
}

export interface NutritionDay {
  calories: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  fiberG: number | null;
  fruitVegServings: number | null;
  /** Whether the day was logged at all. */
  logged: boolean;
}

export function scoreNutritionDay(
  day: NutritionDay,
  targets: Targets,
  weights: NutritionScoreWeights = DEFAULT_NUTRITION_WEIGHTS,
): Derived<NutritionScoreResult> {
  const inputs = { day, targets, weights, scorerVersion: SCORER_VERSION };

  if (!day.logged) {
    return insufficient<NutritionScoreResult>(
      'Nutrition score',
      inputs,
      'Nothing was logged for this day, so there is nothing to score. This is not a zero.',
    );
  }

  const components: ScoreComponent[] = [];

  components.push({
    key: 'calorieAdherence',
    label: 'Calorie adherence',
    weight: weights.calorieAdherence,
    attainment:
      day.calories === null || targets.calories === null
        ? null
        : targetAdherence(day.calories, targets.calories),
    points: null,
    note: 'Symmetric: under-eating misses the target as much as over-eating.',
  });

  components.push({
    key: 'proteinAdherence',
    label: 'Protein adherence',
    weight: weights.proteinAdherence,
    attainment:
      day.proteinG === null || targets.proteinG === null
        ? null
        : floorAdherence(day.proteinG, targets.proteinG),
    points: null,
    note: 'A floor: exceeding the protein target is not penalised.',
  });

  components.push({
    key: 'fiber',
    label: 'Fibre',
    weight: weights.fiber,
    attainment:
      day.fiberG === null || targets.fiberG === null
        ? null
        : floorAdherence(day.fiberG, targets.fiberG),
    points: null,
  });

  components.push({
    key: 'loggingConsistency',
    label: 'Food logging',
    weight: weights.loggingConsistency,
    // Scored on completeness of the day's own entry, not on a streak.
    attainment: countLogged(day) / 4,
    points: null,
    note: 'Share of calories, protein, carbs and fat actually recorded for the day.',
  });

  components.push({
    key: 'fruitVeg',
    label: 'Fruit and vegetables',
    weight: weights.fruitVeg,
    attainment:
      day.fruitVegServings === null ? null : Math.min(1, day.fruitVegServings / 5),
    points: null,
    note: 'Against a 5-serving reference. Not scored when servings are not recorded.',
  });

  components.push({
    key: 'fatCarbBalance',
    label: 'Fat/carbohydrate balance',
    weight: weights.fatCarbBalance,
    // Deliberately permissive: anything from 20-60% of non-protein energy from
    // fat scores full marks. The spec is explicit that a day should not be
    // marked down for macro distribution alone.
    attainment: fatCarbBalance(day),
    points: null,
    note: 'Wide acceptable band. Macro split alone never makes a day "bad".',
  });

  components.push({
    key: 'userDefined',
    label: 'User-defined targets',
    weight: weights.userDefined,
    // Awarded when the user's own explicit targets were met.
    attainment: userDefinedAttainment(day, targets),
    points: null,
  });

  for (const component of components) {
    component.points =
      component.attainment === null
        ? null
        : roundTo(component.attainment * component.weight, 2);
  }

  const scorable = components.filter((c) => c.points !== null);
  const availablePoints = scorable.reduce((total, c) => total + c.weight, 0);
  const earned = scorable.reduce((total, c) => total + c.points!, 0);

  if (availablePoints === 0) {
    return insufficient<NutritionScoreResult>(
      'Nutrition score',
      inputs,
      'No component could be scored: no targets are set and nothing comparable was logged.',
    );
  }

  // Normalised over the points that were actually available, so a day missing
  // an optional input is not silently penalised for it.
  const score = roundTo((earned / availablePoints) * 100, 1);

  const skipped = components.filter((c) => c.points === null);
  const notes = [
    `Scored out of ${availablePoints} available points from ${scorable.length} components.`,
    'This measures adherence to your targets. It is not a judgement of what you ate.',
  ];
  if (skipped.length > 0) {
    notes.push(
      `Not scored (no data or no target): ${skipped.map((c) => c.label).join(', ')}.`,
    );
  }

  return derived<NutritionScoreResult>(
    { score, availablePoints, components },
    'Nutrition score',
    inputs,
    availablePoints >= 70 ? 'HIGH' : availablePoints >= 45 ? 'MODERATE' : 'LOW',
    notes,
  );
}

function countLogged(day: NutritionDay): number {
  return [day.calories, day.proteinG, day.carbsG, day.fatG].filter((v) => v !== null)
    .length;
}

function fatCarbBalance(day: NutritionDay): number | null {
  if (day.fatG === null || day.carbsG === null) return null;
  const fatKcal = day.fatG * 9;
  const carbKcal = day.carbsG * 4;
  const total = fatKcal + carbKcal;
  if (total === 0) return null;
  const fatShare = fatKcal / total;
  if (fatShare >= 0.2 && fatShare <= 0.6) return 1;
  // Outside the band, fall off gently rather than cliff-edging to zero.
  const distance = fatShare < 0.2 ? 0.2 - fatShare : fatShare - 0.6;
  return Math.max(0, 1 - distance / 0.2);
}

function userDefinedAttainment(day: NutritionDay, targets: Targets): number | null {
  const checks: boolean[] = [];
  if (targets.calories !== null && day.calories !== null) {
    checks.push(Math.abs(day.calories - targets.calories) / targets.calories <= 0.1);
  }
  if (targets.proteinG !== null && day.proteinG !== null) {
    checks.push(day.proteinG >= targets.proteinG * 0.9);
  }
  if (checks.length === 0) return null;
  return checks.filter(Boolean).length / checks.length;
}
