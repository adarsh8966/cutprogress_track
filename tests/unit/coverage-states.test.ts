/**
 * A figure that cannot be computed must say WHICH kind of nothing it is.
 *
 * `Derived.value === null` covers four different facts, and the app kept
 * rendering all of them with one sentence - "not logged" - which is a claim
 * about the database and is false in three of the four. That is how a day with
 * a session, a meal and a step count on it came to be reported as never
 * recorded on the Dashboard.
 *
 * stateOf() in lib/types.ts separates them, but only if the analytics layer
 * supplies the evidence: `observations` for a coverage refusal, `unavailable`
 * for a figure no amount of data will produce. A method that supplies neither
 * lands in UNKNOWN, and this file is what stops one shipping.
 *
 * These are the real functions on real (small) series, not stubs - the fault
 * being pinned is a call site forgetting an argument, which a stub cannot show.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stateOf, type Derived, type DatedValue, type Targets } from '@/lib/types';
import { trailingAverage } from '@/lib/analytics/movingAverage';
import { latestReading } from '@/lib/analytics/latest';
import { trend } from '@/lib/analytics/trend';
import { forecastTargetDate } from '@/lib/analytics/forecast';
import { computeAdherence } from '@/lib/analytics/adherence';
import { scoreNutritionDay } from '@/lib/analytics/scores';
import { exercisePerformance } from '@/lib/analytics/training';
import { recoverySummary } from '@/lib/analytics/recovery';
import { estimateTdee } from '@/lib/analytics/tdee';
import { computeDataQuality } from '@/lib/analytics/dataQuality';
import { DEFAULT_PROFILE } from '@/lib/defaults';

const END = '2026-08-29';

/** The Aug 29 import: one day inside a twenty-eight day window. */
const ONE_DAY: DatedValue[] = [{ date: END, value: 2050 }];
const NOTHING: DatedValue[] = [];

const NO_TARGETS: Targets = {
  calories: null, proteinG: null, fiberG: null, steps: null,
  trainingSessionsPerWeek: null, cardioMinutesPerWeek: null,
};

const TARGETS: Targets = {
  calories: 1950, proteinG: 180, fiberG: 30, steps: 10000,
  trainingSessionsPerWeek: 4, cardioMinutesPerWeek: 150,
};

describe('the four states are distinguishable', () => {
  it('calls a one-day window INSUFFICIENT, not NOT_LOGGED', () => {
    const average = trailingAverage(ONE_DAY, END, 28);
    // The gate is right and stays: 1 of 28 is not a 28-day average.
    expect(average.value).toBeNull();
    // But measurements exist, and the screen must be able to say so.
    expect(stateOf(average)).toBe('INSUFFICIENT');
    expect(average.observations).toBe(1);
  });

  it('calls an empty window NOT_LOGGED', () => {
    expect(stateOf(trailingAverage(NOTHING, END, 28))).toBe('NOT_LOGGED');
  });

  it('calls a computed average PRESENT', () => {
    const dense: DatedValue[] = Array.from({ length: 28 }, (_, i) => ({
      date: `2026-08-${String(i + 2).padStart(2, '0')}`,
      value: 2000 + i,
    }));
    expect(stateOf(trailingAverage(dense, '2026-08-29', 28))).toBe('PRESENT');
  });

  it('calls a missing target UNAVAILABLE, not NOT_LOGGED', () => {
    // THE REPORTED BUG. A day with a session on it, no weekly target set:
    // the Dashboard's Training card said "not logged".
    const sessions: DatedValue[] = [{ date: END, value: 1 }];
    const adherence = computeAdherence(
      {
        calories: ONE_DAY, protein: ONE_DAY, steps: ONE_DAY, weight: ONE_DAY,
        trainingSessions: sessions, cardioMinutes: ONE_DAY,
      },
      NO_TARGETS, END, 28,
    );
    expect(stateOf(adherence.training)).toBe('UNAVAILABLE');
    expect(stateOf(adherence.calories)).toBe('UNAVAILABLE');
    expect(stateOf(adherence.cardio)).toBe('UNAVAILABLE');
    // And the measurement it could not score is still counted, so the screen
    // can say "1 day logged, no target set" rather than implying an empty day.
    expect(adherence.training.observations).toBe(1);
  });

  it('separates "no target" from "target, but nothing logged"', () => {
    const adherence = computeAdherence(
      {
        calories: NOTHING, protein: NOTHING, steps: NOTHING, weight: NOTHING,
        trainingSessions: NOTHING, cardioMinutes: NOTHING,
      },
      TARGETS, END, 28,
    );
    expect(stateOf(adherence.calories)).toBe('NOT_LOGGED');
    expect(adherence.calories.observations).toBe(0);
  });

  it('calls a missing target weight UNAVAILABLE on the forecast', () => {
    const weight: DatedValue[] = Array.from({ length: 28 }, (_, i) => ({
      date: `2026-08-${String(i + 2).padStart(2, '0')}`,
      value: 93 - i * 0.05,
    }));
    expect(stateOf(forecastTargetDate(weight, null, '2026-08-29', 28)))
      .toBe('UNAVAILABLE');
    expect(stateOf(forecastTargetDate(NOTHING, 85, END, 28))).toBe('NOT_LOGGED');
  });

  it('calls an unlogged nutrition day NOT_LOGGED, never a zero score', () => {
    const score = scoreNutritionDay(
      {
        calories: null, proteinG: null, carbsG: null, fatG: null,
        fiberG: null, fruitVegServings: null, logged: false,
      },
      TARGETS,
    );
    expect(stateOf(score)).toBe('NOT_LOGGED');
    expect(score.value).toBeNull();
  });

  it('still scores a logged day with no targets, on what it can', () => {
    // Not every component needs a target: food-logging completeness and the
    // fat/carbohydrate balance are scored against the day itself. So a day with
    // no targets set is PRESENT with fewer available points, not absent - and
    // the components it could not score are named rather than counted as zero.
    const score = scoreNutritionDay(
      {
        calories: 2050, proteinG: null, carbsG: null, fatG: null,
        fiberG: null, fruitVegServings: null, logged: true,
      },
      NO_TARGETS,
    );
    expect(stateOf(score)).toBe('PRESENT');
    expect(score.value!.availablePoints).toBeLessThan(100);
    expect(score.notes.join(' ')).toContain('Not scored');
  });

  it('keeps latestReading answerable from a single observation', () => {
    // The complement of the gated average: "what was last true" needs one
    // reading, and a metric whose only reader is a gated average vanishes.
    const latest = latestReading(ONE_DAY, END, 28);
    expect(stateOf(latest)).toBe('PRESENT');
    expect(latest.value).toBe(2050);
  });
});

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

/**
 * Every null-valued Derived the analytics layer can produce must land in one of
 * the three honest states. UNKNOWN means a call site forgot to say which.
 */
function assertClassified(name: string, d: Derived<unknown>) {
  const state = stateOf(d);
  expect(
    state,
    `${name} produced a null value with no observations count and no ` +
      'unavailable flag, so the UI cannot tell "not logged" from "not enough ' +
      'data". Pass observations to insufficient(), or use unavailable().',
  ).not.toBe('UNKNOWN');
}

describe('no analytics function can produce an unclassified absence', () => {
  const empty = { profile: DEFAULT_PROFILE, end: END };

  it('classifies every figure on an empty dataset', () => {
    const adherence = computeAdherence(
      {
        calories: NOTHING, protein: NOTHING, steps: NOTHING, weight: NOTHING,
        trainingSessions: NOTHING, cardioMinutes: NOTHING,
      },
      NO_TARGETS, empty.end, 28,
    );
    const recovery = recoverySummary([], empty.end);

    const figures: [string, Derived<unknown>][] = [
      ['trailingAverage', trailingAverage(NOTHING, END, 28)],
      ['latestReading', latestReading(NOTHING, END, 28)],
      ['trend', trend(NOTHING, END, 28, 'Weight trend')],
      ['forecastTargetDate', forecastTargetDate(NOTHING, null, END, 28)],
      ['estimateTdee', estimateTdee(DEFAULT_PROFILE, NOTHING, NOTHING, NOTHING, END, 28)],
      ['computeDataQuality', computeDataQuality(
        {
          weight: NOTHING, calories: NOTHING, trainingSessions: NOTHING,
          steps: NOTHING, sleepMinutes: NOTHING, waist: NOTHING,
        },
        END, 28,
      )],
      ['exercisePerformance', exercisePerformance([], 'bench-press')],
      ['scoreNutritionDay', scoreNutritionDay(
        {
          calories: null, proteinG: null, carbsG: null, fatG: null,
          fiberG: null, fruitVegServings: null, logged: false,
        },
        NO_TARGETS,
      )],
      ['adherence.calories', adherence.calories],
      ['adherence.protein', adherence.protein],
      ['adherence.steps', adherence.steps],
      ['adherence.training', adherence.training],
      ['adherence.cardio', adherence.cardio],
      ['adherence.logging', adherence.logging],
      ['adherence.overall', adherence.overall],
      ['recovery.sleep7', recovery.sleep7],
      ['recovery.sleep30', recovery.sleep30],
      ['recovery.zone2Minutes', recovery.zone2Minutes],
      ['recovery.restingHeartRate.latest', recovery.restingHeartRate.latest],
      ['recovery.restingHeartRate.average30', recovery.restingHeartRate.average30],
      ['recovery.hrv.latest', recovery.hrv.latest],
      ['recovery.hrv.average30', recovery.hrv.average30],
      ['recovery.sleepScore.latest', recovery.sleepScore.latest],
      ['recovery.activeCalories.latest', recovery.activeCalories.latest],
      ['recovery.totalCaloriesBurned.latest', recovery.totalCaloriesBurned.latest],
    ];

    for (const [name, figure] of figures) assertClassified(name, figure);
  });

  it('classifies every figure on the sparse Aug 29 dataset', () => {
    const sessions: DatedValue[] = [{ date: END, value: 1 }];
    const adherence = computeAdherence(
      {
        calories: ONE_DAY, protein: ONE_DAY, steps: ONE_DAY, weight: ONE_DAY,
        trainingSessions: sessions, cardioMinutes: ONE_DAY,
      },
      TARGETS, END, 28,
    );
    const figures: [string, Derived<unknown>][] = [
      ['trailingAverage', trailingAverage(ONE_DAY, END, 28)],
      ['trend', trend(ONE_DAY, END, 28, 'Weight trend')],
      ['forecastTargetDate', forecastTargetDate(ONE_DAY, 85, END, 28)],
      ['estimateTdee', estimateTdee(DEFAULT_PROFILE, ONE_DAY, ONE_DAY, ONE_DAY, END, 28)],
      ['adherence.calories', adherence.calories],
      ['adherence.training', adherence.training],
      ['adherence.overall', adherence.overall],
    ];
    for (const [name, figure] of figures) assertClassified(name, figure);
  });

  /**
   * The static half. The list above is only as good as its coverage, so this
   * reads the source: an insufficient() call that passes no observations count
   * is the exact shape of the bug, and a new one must not slip in unnoticed.
   */
  it('leaves no insufficient() call in lib/analytics without a count', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const dir = join(root, 'lib/analytics');
    const offenders: string[] = [];

    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const source = readFileSync(join(dir, file), 'utf8');
      // Each insufficient<...>( ... ); call, arguments and all.
      for (const call of source.matchAll(/insufficient<[^>]*>\(([\s\S]*?)\n\s*\);/g)) {
        const args = call[1]!;
        // Four arguments means the count is there. Commas inside the reason
        // string and the inputs object are why this counts top-level depth.
        if (topLevelArgCount(args) < 4) {
          offenders.push(`${file}: ${args.trim().split('\n')[0]}`);
        }
      }
      // The single-line form, e.g. insufficient<number>(label, inputs, 'x').
      for (const call of source.matchAll(/insufficient<[^>]*>\(([^;\n]*)\);/g)) {
        if (topLevelArgCount(call[1]!) < 4) offenders.push(`${file}: ${call[1]!.trim()}`);
      }
    }

    expect(
      offenders,
      'insufficient() without an observations count renders as "not logged", ' +
        'which claims the measurement was never recorded. Pass the count, or ' +
        'use unavailable() if no amount of data would produce the figure.',
    ).toEqual([]);
  });
});

/** Counts arguments at bracket depth zero, ignoring commas inside strings. */
function topLevelArgCount(args: string): number {
  let depth = 0;
  let quote: string | null = null;
  let count = args.trim() === '' ? 0 : 1;

  for (let i = 0; i < args.length; i += 1) {
    const c = args[i]!;
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) depth -= 1;
    else if (c === ',' && depth === 0) count += 1;
  }
  // A trailing comma before the close paren does not introduce an argument.
  return args.trimEnd().endsWith(',') ? count - 1 : count;
}

// ---------------------------------------------------------------------------
// The display half
// ---------------------------------------------------------------------------

/**
 * The analytics layer got this right and the pages threw it away.
 *
 * `Meter` takes a bare `number | null`, so every caller writing
 * `trailingAverage(...).value` discarded the coverage, the observation count
 * and the reason - and the component then had nothing left to render but "not
 * logged". That is the whole Dashboard bug, and it lives at the call site
 * rather than in any calculation, so it is checked at the call site.
 *
 * The check is on the source text, matching tests/unit/mobile-layout.test.ts
 * and tests/unit/corrections.test.ts: the fault is a shape that is easy to
 * reach for and invisible in review.
 */
describe('no page feeds a gated average into a component that cannot explain it', () => {
  const ROOT = fileURLToPath(new URL('../../', import.meta.url));

  function pageFiles(dir: string, found: string[] = []): string[] {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) pageFiles(rel, found);
      else if (entry.name.endsWith('.tsx')) found.push(rel);
    }
    return found;
  }

  it('never passes trailingAverage(...).value straight into a value prop', () => {
    const offenders: string[] = [];
    for (const file of [...pageFiles('app'), ...pageFiles('components')]) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      // The exact shape that loses the evidence.
      if (/value=\{\s*trailingAverage\(/.test(source)) offenders.push(file);
    }
    expect(
      offenders,
      'These pass a gated average as a bare number, so a window with real ' +
        'measurements in it renders as "not logged". Use DerivedMeter or ' +
        'DerivedFigure, which take the whole Derived and can say why.',
    ).toEqual([]);
  });

  it('renders the Dashboard 28-day cards through DerivedMeter', () => {
    // The three cards named in the report: Nutrition, Activity, Training.
    const dashboard = readFileSync(join(ROOT, 'app/(app)/dashboard/page.tsx'), 'utf8');
    expect(dashboard).toContain('DerivedMeter');
    for (const metric of ['Calories', 'Protein', 'Steps', 'Cardio']) {
      expect(
        new RegExp(`label="${metric}"[\\s\\S]{0,120}reading=`).test(dashboard),
        `the ${metric} meter must be given the whole reading, not a bare value`,
      ).toBe(true);
    }
  });

  /**
   * The trap in showing a latest reading under a rate heading.
   *
   * Cardio is stored per day and displayed per week, so the AVERAGE is
   * multiplied by seven. Applying that same factor to a single logged session
   * would turn one 41-minute walk into "287 min/wk" - a week of training that
   * did not happen, printed as a measurement. Scaling belongs to the average
   * only, and the fallback carries its own unit.
   */
  it('never scales a single reading into a weekly rate', () => {
    const primitives = readFileSync(join(ROOT, 'components/ui/primitives.tsx'), 'utf8');
    expect(primitives).not.toContain('latest.value * scale');
    expect(primitives).toContain('latestUnit');

    const dashboard = readFileSync(join(ROOT, 'app/(app)/dashboard/page.tsx'), 'utf8');
    // The one meter that scales must say what a single day of it is called.
    expect(dashboard).toMatch(/scale=\{7\}/);
    expect(dashboard).toContain('latestUnit="min"');
  });

  it('keeps DerivedFigure able to render all four states', () => {
    const primitives = readFileSync(join(ROOT, 'components/ui/primitives.tsx'), 'utf8');
    for (const state of ['PRESENT', 'INSUFFICIENT', 'UNAVAILABLE', 'NOT_LOGGED']) {
      // NOT_LOGGED is the fall-through, so it appears in the comment rather
      // than as a branch; either way the file has to account for it.
      expect(primitives, `primitives must account for ${state}`).toContain(state);
    }
  });
});
