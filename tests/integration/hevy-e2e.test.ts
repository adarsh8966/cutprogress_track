/**
 * Hevy -> the figures the pages actually print.
 *
 * The §20 chain, walked in one place, in the style of training-e2e.test.ts:
 *
 *   Hevy payload
 *     -> the real client, over an injected fetch
 *     -> the real mapper
 *     -> the real writer, against real PostgreSQL and real RLS
 *     -> the real rebuildDailyMetrics
 *     -> the row mappers every page's data goes through
 *     -> the real analytics
 *     -> the literal figures the Training page and the Dashboard render
 *
 * Every layer in between was individually tested and individually plausible.
 * This is the test that fails if the CHAIN breaks - a set written but not
 * joined, a session counted but not resolved, a rebuild that never ran.
 *
 * SCOPE: PGlite is real PostgreSQL. This is not proof that a hosted Supabase
 * project behaves the same; that needs a real project and a real key.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTestDb, createUser, withUser, type TestDb } from '../helpers/pglite';

vi.mock('server-only', () => ({}));

import { supabaseOverPglite } from '../helpers/supabaseOverPglite';
import { fakeHevy, hevyWorkout } from '../helpers/hevyFixtures';
import { createHevyClient } from '@/lib/integrations/hevy/client';
import { runHevySync } from '@/lib/integrations/hevy/sync';
import { joinLoggedSets, rowToTrainingSession, rowToDailyMetrics } from '@/lib/data/rows';
import {
  summariseSessions, summariseTraining, exercisePerformance, exerciseProgression,
  groupByExercise, composeTraining,
} from '@/lib/analytics/training';
import { personalRecords, trainingConsistency } from '@/lib/analytics/prs';
import { displayWeight } from '@/lib/normalization/units';
import type {
  WorkoutSessionRow, WorkoutSetRow, ExerciseRow, DailyMetricsRow,
} from '@/lib/supabase/types';

const TZ = 'America/New_York';
const DAY_ONE = '2026-08-26';
const DAY_TWO = '2026-08-29';

/** Two Push sessions a few days apart, the second heavier: real progression. */
const FIRST = hevyWorkout({
  id: 'workout-1',
  updated_at: '2026-08-26T23:10:00Z',
  start_time: '2026-08-26T22:00:00Z',
  end_time: '2026-08-26T23:00:00Z',
  description: 'Steady. Kept the incline honest.',
  exercises: [
    {
      index: 0,
      title: 'Incline Dumbbell Press',
      notes: 'Paused each rep.',
      exercise_template_id: 'TPL-INCLINE-DB',
      sets: [
        { index: 0, type: 'warmup', weight_kg: 20, reps: 12 },
        { index: 1, type: 'normal', weight_kg: 30, reps: 10, rpe: 7 },
        { index: 2, type: 'normal', weight_kg: 30, reps: 10, rpe: 8 },
        { index: 3, type: 'normal', weight_kg: 30, reps: 9, rpe: 9 },
      ],
    },
  ],
});

const SECOND = hevyWorkout({
  id: 'workout-2',
  updated_at: '2026-08-29T23:10:00Z',
  start_time: '2026-08-29T22:00:00Z',
  end_time: '2026-08-29T23:04:00Z',
  description: 'Felt really strong today. Increased incline DB press.',
  exercises: [
    {
      index: 0,
      title: 'Incline Dumbbell Press',
      notes: 'Went up 5 lb and it moved well.',
      exercise_template_id: 'TPL-INCLINE-DB',
      sets: [
        { index: 0, type: 'normal', weight_kg: 32.5, reps: 10, rpe: 7 },
        { index: 1, type: 'normal', weight_kg: 32.5, reps: 10, rpe: 8 },
        { index: 2, type: 'normal', weight_kg: 32.5, reps: 10, rpe: 9 },
      ],
    },
    {
      index: 1,
      title: 'Cable Lateral Raise',
      notes: null,
      exercise_template_id: 'TPL-CABLE-LAT-RAISE',
      sets: [
        { index: 0, type: 'normal', weight_kg: 9, reps: 15, rpe: 8 },
        { index: 1, type: 'normal', weight_kg: 9, reps: 14, rpe: 9 },
      ],
    },
  ],
});

describe('Hevy end to end, to the figures on screen', () => {
  let db: TestDb;
  let alice: string;

  beforeAll(async () => {
    db = await createTestDb();
    alice = await createUser(db, 'alice@example.com');
    await db.query(`insert into profiles (id, timezone) values ($1, $2)`, [alice, TZ]);

    await withUser(db, alice, async (tx) => {
      const api = createHevyClient({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.test',
        fetch: fakeHevy({
          events: [
            // Newest first, as the feed orders them.
            { type: 'updated', workout: SECOND },
            { type: 'updated', workout: FIRST },
          ],
        }),
        sleep: async () => {},
      });
      const result = await runHevySync(supabaseOverPglite(tx) as never, alice, {
        api, trigger: 'MANUAL',
      });
      // If the sync did not succeed, everything below asserts nothing.
      expect(result.status).toBe('SUCCEEDED');
      expect(result.workoutsCreated).toBe(2);
    });
  });

  afterAll(async () => {
    await db?.close();
  });

  /** Read exactly as lib/data/queries.ts reads them, through the same mappers. */
  async function read() {
    return withUser(db, alice, async (tx) => {
      const sessions = await tx.query<WorkoutSessionRow>(
        `select * from workout_sessions where superseded_at is null order by local_date`,
      );
      const sets = await tx.query<WorkoutSetRow>(`select * from workout_sets`);
      const exercises = await tx.query<ExerciseRow>(
        `select exercise_id, name, primary_muscle_group from exercises`,
      );
      const days = await tx.query<DailyMetricsRow>(
        `select * from daily_metrics order by local_date`,
      );
      return {
        sessions: sessions.rows.map(rowToTrainingSession),
        sets: joinLoggedSets(sessions.rows, sets.rows, exercises.rows),
        days: days.rows.map(rowToDailyMetrics),
      };
    });
  }

  /**
   * The round trip the unit tests cannot prove on their own: Hevy's instants
   * through the mapper, into a timestamptz column, back out of a real Postgres
   * driver - which returns a Date object here where PostgREST returns text -
   * and through toInstant into the domain. Both columns were written on this
   * path long before anything read them.
   */
  it('carries a synced session\'s start and end times all the way back', async () => {
    const { sessions } = await read();
    const second = sessions.find((session) => session.date === DAY_TWO)!;

    expect(second.startTime).toBe('2026-08-29T22:00:00.000Z');
    expect(second.endTime).toBe('2026-08-29T23:04:00.000Z');

    // And the day is still the user's own. 22:00 UTC is 18:00 in New York on
    // the 29th, so local_date decides the day and the instant does not move it.
    expect(second.date).toBe('2026-08-29');
  });

  it('orders two sessions on one day by when they actually started', async () => {
    const { sessions, sets } = await read();
    // A second workout the same evening, three hours after the first. Composed
    // from the same sessions the page reads, in the order the page shows them.
    const later = {
      ...sessions.find((session) => session.date === DAY_TWO)!,
      id: 'later-that-day',
      startTime: '2026-08-30T01:00:00Z',
      endTime: '2026-08-30T02:00:00Z',
    };
    const onDayTwo = composeTraining([...sessions, later], sets)
      .workouts.filter((workout) => workout.session.date === DAY_TWO);

    expect(onDayTwo.map((workout) => workout.session.id))
      .toEqual(['later-that-day', sessions.find((s) => s.date === DAY_TWO)!.id]);
  });

  it('reaches the Training page as sessions AND as sets', () => {
    return read().then(({ sessions, sets }) => {
      expect(sessions).toHaveLength(2);
      // Nine sets written, eight of them working: the warm-up is recorded and
      // excluded, so adding warm-ups can never look like progress.
      expect(sets).toHaveLength(9);
      expect(sets.filter((s) => !s.warmup)).toHaveLength(8);
    });
  });

  it('prints the session figures the Training page shows', async () => {
    const { sessions, sets } = await read();
    const summary = summariseSessions(sessions, sets).value!;

    expect(summary.totalSessions).toBe(2);
    // 60 + 64 minutes.
    expect(summary.totalMinutes).toBe(124);
    // Both have exercise detail, which is the whole point of the integration:
    // before it, every imported session was a summary with no sets at all.
    expect(summary.sessionsWithSets).toBe(2);
    expect(summary.sessionsWithoutSets).toBe(0);
    expect(summary.byType).toEqual([{ sessionType: 'PUSH', sessions: 2, minutes: 124 }]);
  });

  it('prints the exercise figures the Training page shows', async () => {
    const { sets } = await read();
    const training = summariseTraining(sets).value!;

    expect(training.totalWorkingSets).toBe(8);
    // 30x10 + 30x10 + 30x9 = 870, then 32.5x30 = 975, then 9x15 + 9x14 = 261.
    expect(training.totalVolumeKg).toBe(2106);
    // Hevy records RPE, not RIR. The page shows whichever exists.
    expect(training.averageRpe).toBe(8.13);
    expect(training.averageRir).toBeNull();
    expect(training.byMuscleGroup.map((g) => [g.muscleGroup, g.sets]))
      .toEqual([['Chest', 6], ['Shoulders', 2]]);
  });

  it('prints the progression the Training page shows', async () => {
    const { sets } = await read();
    const performance = exercisePerformance(sets, 'incline-dumbbell-press').value!;
    const progression = exerciseProgression(sets, 'incline-dumbbell-press').value!;

    expect(performance.bestWeightKg).toBe(32.5);
    // The heaviest set is the last session's, and it is what the page shows.
    expect(performance.lastPerformedOn).toBe(DAY_TWO);
    expect(performance.sessionCount).toBe(2);
    // Load went up between the first session and the last. That IS the reading.
    expect(progression.state).toBe('WEIGHT_INCREASED');
  });

  it('prints the personal records the Training page shows', async () => {
    const { sets } = await read();
    const records = personalRecords(sets).value!;
    const incline = records.find((r) => r.exerciseId === 'incline-dumbbell-press')!;

    expect(incline.heaviest).toMatchObject({ value: 32.5, date: DAY_TWO });
    // 32.5 x (1 + 10/30) = 43.3
    expect(incline.bestEstimated1rm).toMatchObject({ value: 43.3, date: DAY_TWO });
    expect(incline.bestSessionVolume).toMatchObject({ value: 975, date: DAY_TWO });
    expect(incline.setOnLastSession).toBe(true);
    // In the user's own units, which is how the page renders it.
    expect(displayWeight(incline.heaviest!.value, 'LB')).toBeCloseTo(71.65, 1);
  });

  it('prints the consistency figures the Training page shows', async () => {
    const { sessions, sets } = await read();
    const consistency = trainingConsistency(sessions, sets, DAY_TWO, 4).value!;

    expect(consistency.weeks).toHaveLength(4);
    // Both sessions fall in the week beginning Monday 24 August.
    const lastWeek = consistency.weeks.at(-1)!;
    expect(lastWeek).toMatchObject({ weekStart: '2026-08-24', sessions: 2, minutes: 124 });
    expect(lastWeek.volumeKg).toBe(2106);
    // Two sessions across four weeks, empty weeks included.
    expect(consistency.sessionsPerWeek).toBe(0.5);
    expect(consistency.emptyWeeks).toBe(3);
  });

  it('prints the workout detail the session page shows', async () => {
    const { sessions, sets } = await read();
    const second = sessions.find((s) => s.date === DAY_TWO)!;

    // The name and the note the user wrote in Hevy.
    expect(second.title).toBe('Push Day');
    expect(second.notes).toBe('Felt really strong today. Increased incline DB press.');
    expect(second.externalSource).toBe('HEVY');
    expect(second.durationMinutes).toBe(64);

    const blocks = groupByExercise(sets.filter((s) => s.sessionId === second.id));
    expect(blocks.map((b) => b.exerciseName))
      .toEqual(['Incline Dumbbell Press', 'Cable Lateral Raise']);
    // The exercise note, shown once above its sets.
    expect(blocks[0]!.notes).toBe('Went up 5 lb and it moved well.');
    // Per-set RPE, in the order performed.
    expect(blocks[0]!.sets.map((s) => [s.setNumber, s.rpe]))
      .toEqual([[1, 7], [2, 8], [3, 9]]);
  });

  it('composes the workouts the Training page now expands', async () => {
    const { sessions, sets } = await read();
    const { workouts, unattachedSets } = composeTraining(sessions, sets);

    // Most recent first, which is the order the history lists them in.
    expect(workouts.map((w) => w.session.date)).toEqual([DAY_TWO, DAY_ONE]);

    // The exercise order survives every hop: Hevy's own indices, through the
    // mapper, the writer, PostgreSQL, joinLoggedSets and the composition.
    const [second, first] = workouts;
    expect(second!.exercises.map((e) => e.exerciseName))
      .toEqual(['Incline Dumbbell Press', 'Cable Lateral Raise']);
    expect(second!.exercises[0]!.notes).toBe('Went up 5 lb and it moved well.');

    // What the collapsed row prints for each of them.
    expect(second!.setsLogged).toBe(5);
    expect(second!.workingSets).toBe(5);
    expect(second!.summary.value!.averageRpe).toBe(8.2);

    // Day one logged a warm-up: recorded, counted as logged, and excluded
    // from the average beside it.
    expect(first!.setsLogged).toBe(4);
    expect(first!.workingSets).toBe(3);
    expect(first!.summary.value!.averageRpe).toBe(8);

    // Neither workout used a superset, and none is invented for them.
    expect(second!.supersets).toEqual([]);
    expect(unattachedSets).toEqual([]);
  });

  it('reaches the canonical layer, and so the Dashboard', async () => {
    const { days } = await read();
    expect(days.map((d) => d.localDate)).toEqual([DAY_ONE, DAY_TWO]);
    expect(days.map((d) => d.trainingSessions)).toEqual([1, 1]);
    expect(days.map((d) => d.workoutMinutes)).toEqual([60, 64]);
    // Training is training. A Hevy sync never writes cardio, and never
    // resolves a weight, a step count or a sleep record.
    expect(days.every((d) => d.cardioMinutes === null)).toBe(true);
    expect(days.every((d) => d.weightKg === null)).toBe(true);
    expect(days.every((d) => d.caloriesConsumed === null)).toBe(true);
  });

  it('prints today’s training line the Dashboard shows', async () => {
    const { sessions, sets } = await read();
    // The Dashboard's own arithmetic: working sets and average RPE for the day.
    const today = sessions.filter((s) => s.date === DAY_TWO && s.completed);
    expect(today).toHaveLength(1);

    const own = sets.filter((s) => s.sessionId === today[0]!.id && !s.warmup);
    const rpe = own.map((s) => s.rpe).filter((v): v is number => v !== null);
    const averageRpe = rpe.reduce((a, b) => a + b, 0) / rpe.length;

    // "Push Day · 64 min · 5 sets · avg RPE 8.2"
    expect(today[0]!.title).toBe('Push Day');
    expect(today[0]!.durationMinutes).toBe(64);
    expect(own).toHaveLength(5);
    expect(Number(averageRpe.toFixed(1))).toBe(8.2);
  });
});
