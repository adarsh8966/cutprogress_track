/**
 * Adherence (spec §11 behaviour block).
 *
 * Adherence answers "did the user do what they set out to do?" and nothing
 * else. It is not a judgement of the plan and not a health score.
 *
 * Two distinctions the maths depends on:
 *  - A day with no logged intake is NOT a 0% adherence day. It is an unmeasured
 *    day, and it lowers LOGGING adherence rather than calorie adherence.
 *  - Calorie adherence is symmetric around the target: eating 1,400 against a
 *    1,950 target is as far off plan as eating 2,500, not twice as good.
 */
import type { DatedValue, Derived, LocalDate, Targets } from '@/lib/types';
import { derived, insufficient } from '@/lib/types';
import { coverageOf, mean, presentValues, roundTo, trailingWindow } from './series';

export interface AdherenceBreakdown {
  calories: Derived<number>;
  protein: Derived<number>;
  steps: Derived<number>;
  training: Derived<number>;
  cardio: Derived<number>;
  logging: Derived<number>;
  overall: Derived<number>;
}

/**
 * Symmetric adherence to a target: 1 when on target, falling linearly with
 * relative deviation in either direction, floored at 0.
 */
export function targetAdherence(actual: number, target: number): number {
  if (target <= 0) return 0;
  const relativeMiss = Math.abs(actual - target) / target;
  return Math.max(0, 1 - relativeMiss);
}

/**
 * One-sided adherence for targets that are floors rather than points: hitting
 * more steps than the goal is not a miss.
 */
export function floorAdherence(actual: number, target: number): number {
  if (target <= 0) return 1;
  return Math.min(1, actual / target);
}

function windowAdherence(
  points: DatedValue[],
  end: LocalDate,
  windowDays: number,
  target: number | null,
  label: string,
  mode: 'SYMMETRIC' | 'FLOOR',
): Derived<number> {
  const window = trailingWindow(points, end, windowDays);
  const values = presentValues(window.map((p) => p.value));
  const coverage = coverageOf(window.map((p) => p.value));

  const inputs = {
    windowDays,
    endDate: end,
    target,
    daysWithData: coverage.present,
    mode,
    averageActual: values.length ? roundTo(mean(values)!, 1) : null,
  };

  if (target === null) {
    return insufficient<number>(label, inputs, 'No target is set for this metric.');
  }
  if (values.length === 0) {
    return insufficient<number>(
      label,
      inputs,
      `Nothing logged in the ${windowDays} days ending ${end}.`,
    );
  }

  // Scored per day and then averaged, not scored on the average. Averaging
  // first would let a 1,400 day and a 2,500 day cancel into a perfect score.
  const daily = values.map((v) =>
    mode === 'SYMMETRIC' ? targetAdherence(v, target) : floorAdherence(v, target),
  );
  const score = mean(daily)!;

  return derived(
    roundTo(score, 3),
    label,
    inputs,
    coverage.ratio >= 0.85 ? 'HIGH' : coverage.ratio >= 0.6 ? 'MODERATE' : 'LOW',
    coverage.ratio < 0.85
      ? [
          `Measured over the ${coverage.present} days that were logged, not all ` +
            `${windowDays}. Unlogged days are counted in logging adherence instead.`,
        ]
      : [],
  );
}

/** How much of the window was logged at all (spec §11, §19's gate). */
export function loggingAdherence(
  calories: DatedValue[],
  weight: DatedValue[],
  end: LocalDate,
  windowDays: number,
): Derived<number> {
  const calorieCoverage = coverageOf(
    trailingWindow(calories, end, windowDays).map((p) => p.value),
  );
  const weightCoverage = coverageOf(
    trailingWindow(weight, end, windowDays).map((p) => p.value),
  );
  const score = (calorieCoverage.ratio + weightCoverage.ratio) / 2;

  return derived(
    roundTo(score, 3),
    'Logging adherence',
    {
      windowDays,
      endDate: end,
      nutritionDaysLogged: calorieCoverage.present,
      weightDaysLogged: weightCoverage.present,
      totalDays: windowDays,
    },
    score >= 0.85 ? 'HIGH' : 'MODERATE',
    [],
  );
}

/** Sessions actually completed against the weekly target, over the window. */
export function trainingAdherence(
  sessionsPerDay: DatedValue[],
  end: LocalDate,
  windowDays: number,
  sessionsPerWeekTarget: number | null,
): Derived<number> {
  const window = trailingWindow(sessionsPerDay, end, windowDays);
  const completed = presentValues(window.map((p) => p.value)).reduce((a, b) => a + b, 0);
  const expected =
    sessionsPerWeekTarget === null ? null : (sessionsPerWeekTarget * windowDays) / 7;

  const inputs = {
    windowDays,
    endDate: end,
    completedSessions: completed,
    sessionsPerWeekTarget,
    expectedSessions: expected === null ? null : roundTo(expected, 1),
  };

  if (expected === null || expected <= 0) {
    return insufficient<number>(
      'Training adherence',
      inputs,
      'No training frequency target is set.',
    );
  }

  return derived(
    roundTo(Math.min(1, completed / expected), 3),
    'Training adherence',
    inputs,
    'HIGH',
    [],
  );
}

export function cardioAdherence(
  cardioMinutes: DatedValue[],
  end: LocalDate,
  windowDays: number,
  minutesPerWeekTarget: number | null,
): Derived<number> {
  const window = trailingWindow(cardioMinutes, end, windowDays);
  const total = presentValues(window.map((p) => p.value)).reduce((a, b) => a + b, 0);
  const expected =
    minutesPerWeekTarget === null ? null : (minutesPerWeekTarget * windowDays) / 7;

  const inputs = {
    windowDays,
    endDate: end,
    totalMinutes: roundTo(total, 1),
    minutesPerWeekTarget,
    expectedMinutes: expected === null ? null : roundTo(expected, 1),
  };

  if (expected === null || expected <= 0) {
    return insufficient<number>('Cardio adherence', inputs, 'No cardio target is set.');
  }

  return derived(
    roundTo(Math.min(1, total / expected), 3),
    'Cardio adherence',
    inputs,
    'HIGH',
    [],
  );
}

export interface AdherenceInput {
  calories: DatedValue[];
  protein: DatedValue[];
  steps: DatedValue[];
  weight: DatedValue[];
  trainingSessions: DatedValue[];
  cardioMinutes: DatedValue[];
}

export function computeAdherence(
  data: AdherenceInput,
  targets: Targets,
  end: LocalDate,
  windowDays = 28,
): AdherenceBreakdown {
  const calories = windowAdherence(
    data.calories, end, windowDays, targets.calories, 'Calorie adherence', 'SYMMETRIC',
  );
  const protein = windowAdherence(
    data.protein, end, windowDays, targets.proteinG, 'Protein adherence', 'FLOOR',
  );
  const steps = windowAdherence(
    data.steps, end, windowDays, targets.steps, 'Step adherence', 'FLOOR',
  );
  const training = trainingAdherence(
    data.trainingSessions, end, windowDays, targets.trainingSessionsPerWeek,
  );
  const cardio = cardioAdherence(
    data.cardioMinutes, end, windowDays, targets.cardioMinutesPerWeek,
  );
  const logging = loggingAdherence(data.calories, data.weight, end, windowDays);

  // Overall is the mean of whichever components were computable. A component
  // with no target set is excluded rather than scored as zero.
  const components = [calories, protein, steps, training, cardio, logging];
  const scored = components.filter((c) => c.value !== null).map((c) => c.value!);
  const overall =
    scored.length === 0
      ? insufficient<number>(
          'Overall adherence',
          { componentCount: 0 },
          'No adherence component could be computed; set targets in Settings.',
        )
      : derived(
          roundTo(mean(scored)!, 3),
          'Overall adherence',
          {
            components: {
              calories: calories.value,
              protein: protein.value,
              steps: steps.value,
              training: training.value,
              cardio: cardio.value,
              logging: logging.value,
            },
            note: 'Mean of the components that had a target set and data to score.',
          },
          scored.length >= 4 ? 'HIGH' : 'MODERATE',
          scored.length < components.length
            ? [`${components.length - scored.length} component(s) had no target or no data and were excluded.`]
            : [],
        );

  return { calories, protein, steps, training, cardio, logging, overall };
}
