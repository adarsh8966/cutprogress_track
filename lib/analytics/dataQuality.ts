/**
 * Data quality (spec §32).
 *
 * Every Context Pack carries this score so ChatGPT can calibrate how confident
 * to be. Half-complete data should produce hedged coaching, not confident
 * coaching about a half-imagined picture.
 *
 * The score is pure coverage - what fraction of days carry each kind of
 * measurement. It deliberately says nothing about whether the numbers are good.
 */
import type { DatedValue, Derived, LocalDate } from '@/lib/types';
import { derived } from '@/lib/types';
import { coverageOf, roundTo, trailingWindow } from './series';

export interface DataQualityComponent {
  key: string;
  label: string;
  weight: number;
  coverage: number;
  daysPresent: number;
  points: number;
}

export interface DataQualityResult {
  score: number;
  components: DataQualityComponent[];
  /** Overall confidence label the Context Pack prints. */
  band: 'HIGH' | 'MODERATE' | 'LOW';
}

/** Weights sum to 100. Weight and nutrition dominate: they drive every decision. */
export const DATA_QUALITY_WEIGHTS = {
  weight: 25,
  nutrition: 25,
  training: 15,
  steps: 15,
  sleep: 10,
  waist: 10,
} as const;

export interface DataQualityInput {
  weight: DatedValue[];
  calories: DatedValue[];
  trainingSessions: DatedValue[];
  steps: DatedValue[];
  sleepMinutes: DatedValue[];
  waist: DatedValue[];
}

export function computeDataQuality(
  data: DataQualityInput,
  end: LocalDate,
  windowDays = 28,
): Derived<DataQualityResult> {
  const specs: { key: keyof DataQualityInput; label: string; weight: number; expectedRatio: number }[] = [
    { key: 'weight', label: 'Weight logging', weight: DATA_QUALITY_WEIGHTS.weight, expectedRatio: 1 },
    { key: 'calories', label: 'Nutrition logging', weight: DATA_QUALITY_WEIGHTS.nutrition, expectedRatio: 1 },
    // Training is expected most days but not all; a rest day is not a gap.
    { key: 'trainingSessions', label: 'Training logging', weight: DATA_QUALITY_WEIGHTS.training, expectedRatio: 5 / 7 },
    { key: 'steps', label: 'Steps', weight: DATA_QUALITY_WEIGHTS.steps, expectedRatio: 1 },
    { key: 'sleepMinutes', label: 'Sleep', weight: DATA_QUALITY_WEIGHTS.sleep, expectedRatio: 1 },
    // Waist is a weekly measurement, so weekly cadence counts as complete.
    { key: 'waist', label: 'Waist', weight: DATA_QUALITY_WEIGHTS.waist, expectedRatio: 1 / 7 },
  ];

  const components: DataQualityComponent[] = specs.map((spec) => {
    const window = trailingWindow(data[spec.key], end, windowDays);
    const coverage = coverageOf(window.map((p) => p.value));
    // Coverage is measured against how often the metric is *expected*, so a
    // weekly waist measurement scores full marks at weekly cadence.
    const attainment = Math.min(1, coverage.ratio / spec.expectedRatio);
    return {
      key: spec.key,
      label: spec.label,
      weight: spec.weight,
      coverage: roundTo(coverage.ratio, 3),
      daysPresent: coverage.present,
      points: roundTo(attainment * spec.weight, 2),
    };
  });

  const score = roundTo(
    components.reduce((total, c) => total + c.points, 0),
    1,
  );
  const band = score >= 80 ? 'HIGH' : score >= 55 ? 'MODERATE' : 'LOW';

  const notes: string[] = [];
  const weakest = [...components].sort((a, b) => a.points / a.weight - b.points / b.weight)[0];
  if (weakest && weakest.points / weakest.weight < 0.5) {
    notes.push(`${weakest.label} is the weakest input at ${Math.round(weakest.coverage * 100)}% coverage.`);
  }
  if (band === 'LOW') {
    notes.push('Data is too sparse for confident conclusions. Treat every trend below as provisional.');
  }

  return derived<DataQualityResult>(
    { score, components, band },
    'Data quality score',
    { windowDays, endDate: end, weights: DATA_QUALITY_WEIGHTS },
    band === 'HIGH' ? 'HIGH' : band === 'MODERATE' ? 'MODERATE' : 'LOW',
    notes,
  );
}
