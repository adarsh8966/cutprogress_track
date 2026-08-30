/**
 * Nothing in the database may appear to the user as if it never existed.
 *
 * THE REPORT THIS PINS. A day was imported on 2026-08-29 - nutrition, steps, a
 * training session, cardio - and reached the Training, Nutrition, Recovery and
 * Review pages correctly. The Dashboard said:
 *
 *     Nutrition 28-day average: not logged
 *     Activity 28-day average:  not logged
 *     Training:                 not logged
 *
 * Every layer was right. The 28-day averages correctly refused to be computed
 * from one day of coverage, and the refusal was rendered with the words that
 * mean "you never recorded this". A coverage gate is a statement about the
 * WINDOW; "not logged" is a statement about the DATABASE, and the second does
 * not follow from the first.
 *
 * So this walks the chain the report walked, on the same day's data, and
 * asserts the DISPLAYED STATE rather than the stored value:
 *
 *   raw observations + sessions
 *     -> rebuildDailyMetrics   the REAL function, against the REAL migrations
 *     -> daily_metrics         real columns, real CHECKs, real RLS
 *     -> rowsToDailyMetrics    the mapper every page's data goes through
 *     -> readingOf / adherence what the Dashboard cards actually render
 *
 * The coverage thresholds are NOT relaxed anywhere here. Every assertion that
 * an average is null is an assertion that the gate still works.
 *
 * No figure below is invented: they are the values named in the report, or
 * arithmetic over them.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTestDb, createUser, withUser, type TestDb } from '../helpers/pglite';

vi.mock('server-only', () => ({}));

import { supabaseOverPglite } from '../helpers/supabaseOverPglite';
import { rebuildDailyMetrics } from '@/lib/data/canonicalise';
import { rowsToDailyMetrics } from '@/lib/data/rows';
import { readingOf, coverageNote } from '@/lib/analytics/reading';
import { pickMetric } from '@/lib/analytics/series';
import { computeAdherence } from '@/lib/analytics/adherence';
import { weeklyReview } from '@/lib/analytics/reviews';
import { stateOf } from '@/lib/types';
import type { DailyMetricsRow } from '@/lib/supabase/types';
import type { DailyMetrics, LocalDate, Targets } from '@/lib/types';

const END: LocalDate = '2026-08-29';
const WINDOW = 28;

/** The Aug 29 import, as reported. */
const AUG29 = {
  calories: 2050,
  proteinG: 168,
  steps: 9420,
  cardioMinutes: 41,
  cardioCalories: 305,
  cardioDistanceKm: 4.2,
  cardioAvgHr: 128,
  cardioMaxHr: 149,
  workoutMinutes: 58,
  workoutAvgHr: 142,
  workoutMaxHr: 171,
  workoutCalories: 430,
};

const TARGETS: Targets = {
  calories: 1950, proteinG: 180, fiberG: 30, steps: 10000,
  trainingSessionsPerWeek: 4, cardioMinutesPerWeek: 150,
};

describe('the Aug 29 import is visible everywhere it exists', () => {
  let db: TestDb;
  let alice: string;
  /** The canonical rows, as getDailyMetrics would hand them to a page. */
  let days: DailyMetrics[];

  beforeAll(async () => {
    db = await createTestDb();
    alice = await createUser(db, 'alice@example.com');

    await withUser(db, alice, async (tx) => {
      await tx.query(
        `insert into nutrition_logs
           (user_id, local_date, calories, protein_g, source)
         values ($1, $2, $3, $4, 'IMPORT_TEXT')`,
        [alice, END, AUG29.calories, AUG29.proteinG],
      );
      await tx.query(
        `insert into metric_observations
           (user_id, metric, value, measured_at, local_date, source)
         values ($1, 'STEPS', $2, now(), $3, 'IMPORT_TEXT')`,
        [alice, AUG29.steps, END],
      );
      await tx.query(
        `insert into cardio_sessions
           (user_id, local_date, cardio_type, duration_minutes, distance_km,
            average_heart_rate, max_heart_rate, hr_zone, calories, source)
         values ($1, $2, 'INCLINE_WALKING', $3, $4, $5, $6, 2, $7, 'IMPORT_TEXT')`,
        [alice, END, AUG29.cardioMinutes, AUG29.cardioDistanceKm,
          AUG29.cardioAvgHr, AUG29.cardioMaxHr, AUG29.cardioCalories],
      );
      await tx.query(
        `insert into workout_sessions
           (user_id, local_date, session_type, duration_minutes,
            average_heart_rate, max_heart_rate, calories, completed, source)
         values ($1, $2, 'PULL', $3, $4, $5, $6, true, 'IMPORT_TEXT')`,
        [alice, END, AUG29.workoutMinutes, AUG29.workoutAvgHr,
          AUG29.workoutMaxHr, AUG29.workoutCalories],
      );
    });

    await withUser(db, alice, async (tx) => {
      await rebuildDailyMetrics(supabaseOverPglite(tx) as never, alice, END);
    });

    const { rows } = await withUser(db, alice, (tx) =>
      tx.query<DailyMetricsRow>('select * from daily_metrics order by local_date'),
    );
    days = rowsToDailyMetrics(rows);
  });

  afterAll(async () => {
    await db?.close();
  });

  // ------------------------------------------------------- one day of data

  describe('one day of data', () => {
    it('reaches the canonical layer intact', () => {
      expect(days).toHaveLength(1);
      const day = days[0]!;
      expect(day.localDate).toBe(END);
      expect(day.caloriesConsumed).toBe(AUG29.calories);
      expect(day.proteinG).toBe(AUG29.proteinG);
      expect(day.steps).toBe(AUG29.steps);
      expect(day.cardioMinutes).toBe(AUG29.cardioMinutes);
      expect(day.zone2Minutes).toBe(AUG29.cardioMinutes);
      expect(day.workoutMinutes).toBe(AUG29.workoutMinutes);
      expect(day.trainingSessions).toBe(1);
    });

    it('still refuses to call one day a 28-day average', () => {
      // The gate is correct and is NOT relaxed. Weakening it to make a number
      // appear would be the fabrication the working agreement forbids.
      const calories = readingOf(pickMetric(days, 'caloriesConsumed'), 'Calories', END, WINDOW);
      expect(calories.average.value).toBeNull();
      expect(calories.average.confidence).toBe('INSUFFICIENT');
    });

    it('says INSUFFICIENT, not NOT_LOGGED - the reported bug', () => {
      for (const [label, key] of [
        ['Calories', 'caloriesConsumed'],
        ['Protein', 'proteinG'],
        ['Steps', 'steps'],
        ['Cardio', 'cardioMinutes'],
      ] as const) {
        const reading = readingOf(pickMetric(days, key), label, END, WINDOW);
        expect(stateOf(reading.average), `${label} average`).toBe('INSUFFICIENT');
      }
    });

    it('shows the actual logged value beside the refusal', () => {
      // This is the half that was missing. The average declines; the latest
      // reading answers from one observation, which is what the Dashboard now
      // renders instead of "not logged".
      const calories = readingOf(pickMetric(days, 'caloriesConsumed'), 'Calories', END, WINDOW);
      expect(stateOf(calories.latest)).toBe('PRESENT');
      expect(calories.latest.value).toBe(AUG29.calories);
      expect(calories.latest.inputs.observedOn).toBe(END);
    });

    it('states the coverage in the words the card prints', () => {
      const calories = readingOf(pickMetric(days, 'caloriesConsumed'), 'Calories', END, WINDOW);
      expect(coverageNote(calories.coverage)).toBe('1 of 28 days logged');
    });

    it('does not report the training session as unlogged', () => {
      // "Training: not logged" beside a recorded Pull session was the most
      // visible half of the report.
      const withTarget = computeAdherence(
        {
          calories: pickMetric(days, 'caloriesConsumed'),
          protein: pickMetric(days, 'proteinG'),
          steps: pickMetric(days, 'steps'),
          weight: pickMetric(days, 'weightKg'),
          trainingSessions: pickMetric(days, 'trainingSessions'),
          cardioMinutes: pickMetric(days, 'cardioMinutes'),
        },
        TARGETS, END, WINDOW,
      );
      // With a target, training adherence is computable from one session.
      expect(stateOf(withTarget.training)).toBe('PRESENT');
      expect(withTarget.training.inputs.completedSessions).toBe(1);
    });

    it('calls a missing target UNAVAILABLE rather than unlogged', () => {
      const noTargets = computeAdherence(
        {
          calories: pickMetric(days, 'caloriesConsumed'),
          protein: pickMetric(days, 'proteinG'),
          steps: pickMetric(days, 'steps'),
          weight: pickMetric(days, 'weightKg'),
          trainingSessions: pickMetric(days, 'trainingSessions'),
          cardioMinutes: pickMetric(days, 'cardioMinutes'),
        },
        {
          calories: null, proteinG: null, fiberG: null, steps: null,
          trainingSessionsPerWeek: null, cardioMinutesPerWeek: null,
        },
        END, WINDOW,
      );
      expect(stateOf(noTargets.training)).toBe('UNAVAILABLE');
      // And it still knows the day was logged, so the card can say so.
      expect(noTargets.training.observations).toBe(1);
    });
  });

  // ------------------------------------------------- genuinely unlogged data

  describe('genuinely unlogged values', () => {
    it('reports a metric nothing wrote as NOT_LOGGED, with zero days', () => {
      // No weight and no sleep were imported on Aug 29. This is the one case
      // "not logged" actually fits, and it has to stay distinguishable from
      // the sparse case above.
      for (const key of ['weightKg', 'sleepDurationMinutes', 'hrvMs'] as const) {
        const reading = readingOf(pickMetric(days, key), key, END, WINDOW);
        expect(stateOf(reading.average), key).toBe('NOT_LOGGED');
        expect(stateOf(reading.latest), key).toBe('NOT_LOGGED');
        expect(reading.coverage.present, key).toBe(0);
      }
    });

    it('leaves an unmeasured field null in the canonical row, never zero', () => {
      const day = days[0]!;
      expect(day.weightKg).toBeNull();
      expect(day.sleepDurationMinutes).toBeNull();
      expect(day.hrvMs).toBeNull();
      // ...while a real measured value of the same shape stays a number.
      expect(day.steps).toBe(AUG29.steps);
    });
  });

  // ------------------------------------------ the imported session's details

  /**
   * Session-level calories, duration, heart rates, distance and type are stored
   * on the session rows and summed only for minutes. If they were readable
   * nowhere, they would be the same "written and invisible" fault in a
   * different table.
   */
  describe('the imported workout and cardio detail survives', () => {
    it('keeps every cardio field on the row', async () => {
      const { rows } = await withUser(db, alice, (tx) =>
        tx.query<Record<string, string | null>>(
          `select cardio_type::text, duration_minutes::text, distance_km::text,
                  average_heart_rate::text, max_heart_rate::text,
                  hr_zone::text, calories::text
             from cardio_sessions where local_date = $1`,
          [END],
        ),
      );
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.cardio_type).toBe('INCLINE_WALKING');
      expect(Number(row.duration_minutes)).toBe(AUG29.cardioMinutes);
      expect(Number(row.distance_km)).toBeCloseTo(AUG29.cardioDistanceKm, 3);
      expect(Number(row.average_heart_rate)).toBe(AUG29.cardioAvgHr);
      expect(Number(row.max_heart_rate)).toBe(AUG29.cardioMaxHr);
      expect(Number(row.hr_zone)).toBe(2);
      expect(Number(row.calories)).toBe(AUG29.cardioCalories);
    });

    it('keeps every workout field on the row', async () => {
      const { rows } = await withUser(db, alice, (tx) =>
        tx.query<Record<string, string | null>>(
          `select session_type::text, duration_minutes::text,
                  average_heart_rate::text, max_heart_rate::text, calories::text
             from workout_sessions where local_date = $1`,
          [END],
        ),
      );
      const row = rows[0]!;
      expect(row.session_type).toBe('PULL');
      expect(Number(row.duration_minutes)).toBe(AUG29.workoutMinutes);
      expect(Number(row.average_heart_rate)).toBe(AUG29.workoutAvgHr);
      expect(Number(row.max_heart_rate)).toBe(AUG29.workoutMaxHr);
      expect(Number(row.calories)).toBe(AUG29.workoutCalories);
    });

    it('counts the session in the day, and its minutes once', () => {
      const day = days[0]!;
      expect(day.trainingSessions).toBe(1);
      expect(day.workoutMinutes).toBe(AUG29.workoutMinutes);
      expect(day.cardioMinutes).toBe(AUG29.cardioMinutes);
    });
  });

  // ----------------------------------------------- several days, and gaps

  /**
   * The rest of the state machine, on data built out from the same day.
   *
   * Fourteen of the twenty-eight days are logged, one of them deliberately
   * missing inside the run, which is the only shape that exercises the
   * boundary: below MIN_COVERAGE the average declines, at or above it the
   * average is reported WITH its coverage.
   */
  describe('several days, missing days, and enough coverage', () => {
    let denseDays: DailyMetrics[];
    let sparseDays: DailyMetrics[];
    const bob = { id: '' };

    beforeAll(async () => {
      bob.id = await createUser(db, 'bob@example.com');

      // 15 of the 28 days ending Aug 29 (53% - just over the 50% gate), with
      // 2026-08-20 deliberately skipped so a gap sits inside the run.
      const logged: LocalDate[] = [];
      for (let i = 0; i < 16; i += 1) {
        const day = 29 - i;
        const date = `2026-08-${String(day).padStart(2, '0')}` as LocalDate;
        if (date === '2026-08-20') continue;
        logged.push(date);
      }

      await withUser(db, bob.id, async (tx) => {
        for (const date of logged) {
          await tx.query(
            `insert into nutrition_logs (user_id, local_date, calories, source)
             values ($1, $2, $3, 'IMPORT_TEXT')`,
            [bob.id, date, AUG29.calories],
          );
        }
        // Steps on only three of them: enough to exist, far too few to average.
        for (const date of logged.slice(0, 3)) {
          await tx.query(
            `insert into metric_observations
               (user_id, metric, value, measured_at, local_date, source)
             values ($1, 'STEPS', $2, now(), $3, 'IMPORT_TEXT')`,
            [bob.id, AUG29.steps, date],
          );
        }
      });

      await withUser(db, bob.id, async (tx) => {
        const client = supabaseOverPglite(tx);
        for (const date of logged) {
          await rebuildDailyMetrics(client as never, bob.id, date);
        }
      });

      const { rows } = await withUser(db, bob.id, (tx) =>
        tx.query<DailyMetricsRow>('select * from daily_metrics order by local_date'),
      );
      denseDays = rowsToDailyMetrics(rows);
      sparseDays = denseDays;
    });

    it('reports the average once coverage clears the gate', () => {
      const calories = readingOf(
        pickMetric(denseDays, 'caloriesConsumed'), 'Calories', END, WINDOW,
      );
      expect(stateOf(calories.average)).toBe('PRESENT');
      expect(calories.average.value).toBe(AUG29.calories);
      expect(calories.coverage.present).toBe(15);
      expect(coverageNote(calories.coverage)).toBe('15 of 28 days logged');
    });

    it('still names the coverage on an average it DID compute', () => {
      // A reported average is not automatically a confident one. 15 of 28 is
      // below the 85% that earns HIGH, and the figure says so.
      const calories = readingOf(
        pickMetric(denseDays, 'caloriesConsumed'), 'Calories', END, WINDOW,
      );
      expect(calories.average.confidence).not.toBe('HIGH');
      expect(calories.average.notes.join(' ')).toContain('15 of 28 days');
    });

    it('keeps the missing day a gap, not a zero', () => {
      const series = pickMetric(denseDays, 'caloriesConsumed');
      expect(series.find((p) => p.date === '2026-08-20')).toBeUndefined();
      const calories = readingOf(series, 'Calories', END, WINDOW);
      // 28 window days, 15 present: the skipped day lowered coverage rather
      // than dragging the mean towards zero.
      expect(calories.coverage.window).toBe(28);
      expect(calories.average.value).toBe(AUG29.calories);
    });

    it('declines the sparse metric while reporting the dense one', () => {
      // Both live on the same days. Three step readings are not an average and
      // fifteen calorie readings are, and the page must be able to say each.
      const steps = readingOf(pickMetric(sparseDays, 'steps'), 'Steps', END, WINDOW);
      expect(stateOf(steps.average)).toBe('INSUFFICIENT');
      expect(steps.coverage.present).toBe(3);
      expect(stateOf(steps.latest)).toBe('PRESENT');
      expect(steps.latest.value).toBe(AUG29.steps);
    });

    it('gives the weekly review the coverage behind each of its averages', () => {
      const review = weeklyReview(denseDays, [], TARGETS, END, 1).value!;
      // Aug 29 2026 is a Saturday, so its week holds Mon 24 - Sun 30 and only
      // six of those days are inside the loaded window.
      expect(review.averageCalories).toBe(AUG29.calories);
      expect(review.coverage.calories).toBeGreaterThan(0);
      expect(review.coverage.days).toBeGreaterThanOrEqual(review.coverage.calories);
    });
  });

  // ---------------------------------------------------------- the one-day week

  it('does not present a single logged day as a weekly average', () => {
    // The Review page's own version of the same fault. The arithmetic is
    // unchanged; what the review now carries is how many days produced it, so
    // the label can stop calling one day an average.
    const review = weeklyReview(days, [], TARGETS, END, 1).value!;
    expect(review.averageCalories).toBe(AUG29.calories);
    expect(review.coverage.calories).toBe(1);
    expect(review.coverage.days).toBe(7);
  });
});
