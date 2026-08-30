/**
 * THE TWO TESTS THE AUDIT ASKS FOR BY NAME, end to end.
 *
 * VISIBILITY. Import a full day - weight, nutrition, steps, sleep, resting
 * heart rate, HRV, a workout, a cardio session - and prove every accepted item
 * has an observable destination. Not "the row exists": that a READER the
 * application actually uses returns the value. Every assertion below goes
 * through the same function the corresponding page calls, so a field that is
 * stored, resolved and displayed by nothing fails here.
 *
 * EDIT. Correct each of those and prove the correction is what comes back.
 * Scalars are corrected by recording the value again - resolution is
 * newest-first - and the two summed tables by superseding, because a day's
 * sessions are totalled rather than resolved.
 *
 * Both run against real PostgreSQL with the real migrations, as the
 * non-superuser `authenticated` role, and rebuild through the real
 * rebuildDailyMetrics. What is asserted is what a page would show.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTestDb, createUser, withUser, type TestDb } from '../helpers/pglite';

vi.mock('server-only', () => ({}));

import { supabaseOverPglite } from '../helpers/supabaseOverPglite';
import { rebuildDailyMetrics } from '@/lib/data/canonicalise';
import { rowsToDailyMetrics } from '@/lib/data/rows';
import { toDayRecords, canonicalSummary } from '@/lib/data/dayRecords';
import { recoverySummary } from '@/lib/analytics/recovery';
import { scoreNutritionDay } from '@/lib/analytics/scores';
import { summariseSessions } from '@/lib/analytics/training';
import { latestPresent, pickMetric } from '@/lib/analytics/series';
import { trailingAverage } from '@/lib/analytics/movingAverage';
import type { DailyMetrics, LocalDate } from '@/lib/types';
import type { DailyMetricsRow } from '@/lib/supabase/types';

const DAY: LocalDate = '2026-11-02';
const SOURCE = 'IMPORT_TEXT';

describe('a full imported day is visible, and every part of it can be corrected', () => {
  let db: TestDb;
  let alice: string;

  beforeAll(async () => {
    db = await createTestDb();
    alice = await createUser(db, 'alice@example.com');
  });

  afterAll(async () => {
    await db?.close();
  });

  /** The day as the pages read it: through rowToDailyMetrics, like queries.ts. */
  async function canonical(): Promise<DailyMetrics> {
    const { rows } = await withUser(db, alice, (tx) =>
      tx.query<DailyMetricsRow>(
        `select * from daily_metrics where local_date = $1`, [DAY],
      ),
    );
    expect(rows, 'the day has no canonical row at all').toHaveLength(1);
    return rowsToDailyMetrics(rows as never)[0]!;
  }

  async function rebuild() {
    await withUser(db, alice, async (tx) => {
      await rebuildDailyMetrics(supabaseOverPglite(tx) as never, alice, DAY);
    });
  }

  /** Every raw row for the day, as the day view maps them. */
  async function records() {
    return withUser(db, alice, async (tx) => {
      const read = async (table: string) =>
        (await tx.query<Record<string, unknown>>(
          `select * from ${table} where local_date = $1`, [DAY],
        )).rows;
      return toDayRecords({
        body: await read('body_measurements') as never,
        metrics: await read('metric_observations') as never,
        nutrition: await read('nutrition_logs') as never,
        sleep: await read('sleep_records') as never,
        cardio: await read('cardio_sessions') as never,
        workouts: await read('workout_sessions') as never,
      });
    });
  }

  // -------------------------------------------------------------- the import
  beforeAll(async () => {
    await withUser(db, alice, async (tx) => {
      await tx.query(
        `insert into health_imports
           (user_id, raw_text, parser_name, parser_version, target_local_date,
            source, status, idempotency_key)
         values ($1, 'a full day', 'text-line-parser', '2.0.0', $2, $3, 'CONFIRMED', 'k1')`,
        [alice, DAY, SOURCE],
      );
      await tx.query(
        `insert into body_measurements
           (user_id, measured_at, local_date, weight_kg, waist_cm, source)
         values ($1, now(), $2, 92.4, 89.2, $3)`,
        [alice, DAY, SOURCE],
      );
      await tx.query(
        `insert into nutrition_logs
           (user_id, local_date, calories, protein_g, carbs_g, fat_g, fiber_g, source)
         values ($1, $2, 2001, 172, 198, 67, 29, $3)`,
        [alice, DAY, SOURCE],
      );
      await tx.query(
        `insert into metric_observations
           (user_id, metric, value, measured_at, local_date, source)
         values ($1, 'STEPS', 15000, now(), $2, $3),
                ($1, 'ACTIVE_CALORIES', 640, now(), $2, $3),
                ($1, 'RESTING_HEART_RATE', 57, now(), $2, $3),
                ($1, 'HRV_MS', 68, now(), $2, $3)`,
        [alice, DAY, SOURCE],
      );
      await tx.query(
        `insert into sleep_records (user_id, local_date, duration_minutes, source)
         values ($1, $2, 450, $3)`,
        [alice, DAY, SOURCE],
      );
      await tx.query(
        `insert into workout_sessions
           (user_id, local_date, session_type, duration_minutes,
            average_heart_rate, max_heart_rate, calories, notes, source)
         values ($1, $2, 'PULL', 58, 142, 171, 412, 'Pull', $3)`,
        [alice, DAY, SOURCE],
      );
      await tx.query(
        `insert into cardio_sessions
           (user_id, local_date, cardio_type, duration_minutes, distance_km,
            average_heart_rate, hr_zone, source)
         values ($1, $2, 'INCLINE_WALKING', 30, 2.4, 118, 2, $3)`,
        [alice, DAY, SOURCE],
      );
    });
    await rebuild();
  });

  // ------------------------------------------------------------- visibility
  describe('VISIBILITY: every imported value has a reader', () => {
    it('weight and waist reach the series the Dashboard and Progress read', async () => {
      const days = [await canonical()];
      expect(latestPresent(pickMetric(days, 'weightKg'))?.value).toBeCloseTo(92.4, 3);
      expect(latestPresent(pickMetric(days, 'waistCm'))?.value).toBeCloseTo(89.2, 3);

      // The Dashboard's 7-day average correctly DECLINES on one day of data -
      // one weigh-in is not a week's average. What matters for visibility is
      // that it declines as "not enough data", having found the observation,
      // rather than as "never logged", which would be a different and false
      // claim about the same day (spec §32/§33).
      const average = trailingAverage(pickMetric(days, 'weightKg'), DAY, 7);
      expect(average.value).toBeNull();
      expect(average.confidence).toBe('INSUFFICIENT');
      expect(average.observations).toBe(1);
    });

    it('nutrition reaches the score the Nutrition page shows', async () => {
      const day = await canonical();
      const score = scoreNutritionDay(
        {
          calories: day.caloriesConsumed,
          proteinG: day.proteinG,
          carbsG: day.carbsG,
          fatG: day.fatG,
          fiberG: day.fiberG,
          fruitVegServings: day.fruitVegServings,
          logged: day.caloriesConsumed != null,
        },
        { calories: 2000, proteinG: 170, fiberG: 30, steps: null,
          trainingSessionsPerWeek: null, cardioMinutesPerWeek: null },
      );
      expect(day.caloriesConsumed).toBe(2001);
      expect(day.proteinG).toBe(172);
      expect(score.value).not.toBeNull();
    });

    it('steps, RHR, HRV, sleep and active calories reach the Recovery page', async () => {
      const recovery = recoverySummary([await canonical()], DAY);
      expect(recovery.restingHeartRate.latest.value).toBe(57);
      expect(recovery.hrv.latest.value).toBe(68);
      expect(recovery.activeCalories.latest.value).toBe(640);
      expect(latestPresent(recovery.stepsSeries)?.value).toBe(15000);
      // Sleep through the series the page charts. The 7-day average is gated
      // and declines on one night, which is correct and is asserted as such.
      expect(latestPresent(recovery.sleepSeries)?.value).toBe(450);
      expect(recovery.sleep7.confidence).toBe('INSUFFICIENT');
      expect(recovery.sleep7.observations).toBe(1);
      // Zone 2 is summed from the cardio session's own zone.
      expect(recovery.zone2Minutes.value).toBe(30);
    });

    it('the workout reaches the Training page as a session', async () => {
      const day = await canonical();
      const sessions = await withUser(db, alice, (tx) =>
        tx.query<{ id: string; duration_minutes: string }>(
          `select id, duration_minutes::text from workout_sessions
            where local_date = $1 and superseded_at is null`, [DAY],
        ),
      );
      const summary = summariseSessions(
        sessions.rows.map((row) => ({
          id: row.id, date: DAY, sessionType: 'PULL',
          title: null, externalSource: null,
          durationMinutes: Number(row.duration_minutes),
          averageHeartRate: 142, maxHeartRate: 171, calories: 412,
          notes: 'Pull', source: SOURCE, completed: true, importId: null,
        })),
        [],
      );
      expect(summary.value!.totalSessions).toBe(1);
      expect(summary.value!.totalMinutes).toBe(58);
      // And the canonical rollup agrees with it.
      expect(day.trainingSessions).toBe(1);
      expect(day.workoutMinutes).toBe(58);
    });

    it('the cardio session reaches the day it was recorded on', async () => {
      const day = await canonical();
      expect(day.cardioMinutes).toBe(30);
    });

    /**
     * The catch-all. Every field the day view lists must either hold the value
     * that was imported or be honestly absent - no field may be silently
     * missing from a day that carries it.
     */
    it('every canonical field the day view lists is populated or honestly null', async () => {
      const summary = canonicalSummary(await canonical());
      const populated = summary.filter((f) => f.value !== null).map((f) => f.key);
      expect(populated.sort()).toEqual([
        'activeCalories', 'caloriesConsumed', 'carbsG', 'cardioMinutes', 'fatG',
        'fiberG', 'hrvMs', 'proteinG', 'restingHeartRate', 'sleepDurationMinutes',
        'steps', 'trainingSessions', 'waistCm', 'weightKg', 'workoutMinutes',
        'zone2Minutes',
      ]);
      // The four that were genuinely not imported stay null, not zero.
      const absent = summary.filter((f) => f.value === null).map((f) => f.key);
      expect(absent.sort()).toEqual([
        'fruitVegServings', 'sleepScore', 'totalCaloriesBurned',
      ]);
    });

    it('lists every observation on the day view, with a source', async () => {
      const all = await records();
      // body, nutrition, four metric observations, the workout, the cardio.
      expect(all).toHaveLength(9);
      expect(all.every((r) => r.source === SOURCE)).toBe(true);
      expect(all.every((r) => r.supersededAt === null)).toBe(true);
    });
  });

  // -------------------------------------------------------------------- edit
  describe('EDIT: correcting each one is what comes back', () => {
    it('corrects a weight by recording it again', async () => {
      await withUser(db, alice, (tx) =>
        tx.query(
          `insert into body_measurements
             (user_id, measured_at, local_date, weight_kg, source)
           values ($1, now() + interval '1 hour', $2, 91.8, 'MANUAL')`,
          [alice, DAY],
        ),
      );
      await rebuild();

      const day = await canonical();
      expect(day.weightKg).toBeCloseTo(91.8, 3);
      // The waist is untouched: the correction did not carry one, and a field
      // the newer observation is silent about keeps the value that had it.
      expect(day.waistCm).toBeCloseTo(89.2, 3);
      // Both observations are on record.
      expect((await records()).filter((r) => r.table === 'body_measurements')).toHaveLength(2);
    });

    it('corrects nutrition by recording it again', async () => {
      await withUser(db, alice, (tx) =>
        tx.query(
          `insert into nutrition_logs
             (user_id, local_date, calories, protein_g, logged_at, source)
           values ($1, $2, 2140, 181, now() + interval '1 hour', 'MANUAL')`,
          [alice, DAY],
        ),
      );
      await rebuild();

      const day = await canonical();
      expect(day.caloriesConsumed).toBe(2140);
      expect(day.proteinG).toBe(181);
      // Carbs were not in the correction, so the earlier reading still stands.
      expect(day.carbsG).toBe(198);
    });

    it('corrects sleep, resting heart rate and HRV by recording them again', async () => {
      await withUser(db, alice, async (tx) => {
        await tx.query(
          `insert into sleep_records
             (user_id, local_date, duration_minutes, created_at, source)
           values ($1, $2, 415, now() + interval '1 hour', 'MANUAL')`,
          [alice, DAY],
        );
        await tx.query(
          `insert into metric_observations
             (user_id, metric, value, measured_at, local_date, source)
           values ($1, 'RESTING_HEART_RATE', 54, now() + interval '1 hour', $2, 'MANUAL'),
                  ($1, 'HRV_MS', 74, now() + interval '1 hour', $2, 'MANUAL')`,
          [alice, DAY],
        );
      });
      await rebuild();

      const recovery = recoverySummary([await canonical()], DAY);
      expect(latestPresent(recovery.sleepSeries)?.value).toBe(415);
      expect(recovery.restingHeartRate.latest.value).toBe(54);
      expect(recovery.hrv.latest.value).toBe(74);
    });

    /**
     * The audit's own worked example, on cardio rather than a workout:
     * 30 minutes corrected to 35 must read 35, never 65.
     */
    it('corrects a cardio session without doubling the day', async () => {
      const [original] = (await records()).filter(
        (r) => r.table === 'cardio_sessions' && r.supersededAt === null,
      );
      const replacement = await withUser(db, alice, async (tx) => {
        const r = await tx.query<{ id: string }>(
          `insert into cardio_sessions
             (user_id, local_date, cardio_type, duration_minutes, hr_zone, source)
           values ($1, $2, 'INCLINE_WALKING', 35, 2, 'MANUAL') returning id`,
          [alice, DAY],
        );
        return r.rows[0]!.id;
      });
      await withUser(db, alice, (tx) =>
        tx.query(
          `update cardio_sessions set superseded_at = now(), superseded_by = $2
            where id = $1`,
          [original!.id, replacement],
        ),
      );
      await rebuild();

      const day = await canonical();
      expect(day.cardioMinutes).toBe(35);
      expect(day.zone2Minutes).toBe(35);
      // Both readings survive; only one counts.
      const cardio = (await records()).filter((r) => r.table === 'cardio_sessions');
      expect(cardio).toHaveLength(2);
      expect(cardio.filter((r) => r.supersededAt === null)).toHaveLength(1);
    });

    /**
     * A workout is an authored record: 0008 grants it update, so a correction
     * is an edit in place rather than a new row. Either way the day must total
     * the correction.
     */
    it('corrects a workout in place and rebuilds the day', async () => {
      await withUser(db, alice, (tx) =>
        tx.query(
          `update workout_sessions set duration_minutes = 65
            where local_date = $1 and superseded_at is null`,
          [DAY],
        ),
      );
      await rebuild();

      const day = await canonical();
      expect(day.workoutMinutes).toBe(65);
      expect(day.trainingSessions).toBe(1);
    });

    it('leaves no ghost record: every correction is traceable', async () => {
      const all = await records();
      // Two weights, two nutrition logs, two sleep records, six metric
      // observations, one workout, two cardio sessions.
      expect(all.filter((r) => r.table === 'body_measurements')).toHaveLength(2);
      expect(all.filter((r) => r.table === 'nutrition_logs')).toHaveLength(2);
      expect(all.filter((r) => r.table === 'sleep_records')).toHaveLength(2);
      expect(all.filter((r) => r.table === 'metric_observations')).toHaveLength(6);
      expect(all.filter((r) => r.table === 'workout_sessions')).toHaveLength(1);
      expect(all.filter((r) => r.table === 'cardio_sessions')).toHaveLength(2);
      // Nothing was deleted anywhere along the way.
      const { rows } = await withUser(db, alice, (tx) =>
        tx.query<{ n: string }>(
          `select count(*)::text as n from body_measurements where local_date = $1`, [DAY],
        ),
      );
      expect(Number(rows[0]!.n)).toBe(2);
    });
  });
});
