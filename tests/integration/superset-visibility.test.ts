/**
 * A superset the source recorded must not disappear on the way to the screen.
 *
 * THE GAP THIS CLOSES. `workout_sets.superset_id` has been written by the Hevy
 * writer since migration 0014 - correctly, and tested at the mapper - and was
 * then read by nothing at all. Two exercises paired in the gym were stored as
 * a pair and rendered as two unrelated movements. That is the same class of
 * failure as the Aug 29 report: every layer right, and the user shown nothing.
 *
 * So this walks the whole chain on a payload that actually uses one:
 *
 *   Hevy payload with supersets_id
 *     -> the real client, over an injected fetch
 *     -> the real mapper
 *     -> the real writer, against real PostgreSQL and real RLS
 *     -> joinLoggedSets, the mapper every page's sets go through
 *     -> composeTraining, the tree the Training page renders
 *
 * The id under test is ZERO, deliberately. Hevy numbers supersets from zero,
 * so any truthiness check anywhere along that chain drops the first superset
 * of a workout and leaves every later one intact - a bug that looks like a
 * working feature.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTestDb, createUser, withUser, type TestDb } from '../helpers/pglite';

vi.mock('server-only', () => ({}));

import { supabaseOverPglite } from '../helpers/supabaseOverPglite';
import { fakeHevy, hevyWorkout } from '../helpers/hevyFixtures';
import { createHevyClient } from '@/lib/integrations/hevy/client';
import { runHevySync } from '@/lib/integrations/hevy/sync';
import { joinLoggedSets, rowToTrainingSession } from '@/lib/data/rows';
import { composeTraining } from '@/lib/analytics/training';
import type { WorkoutSessionRow, WorkoutSetRow, ExerciseRow } from '@/lib/supabase/types';

const TZ = 'America/New_York';

/**
 * A Push day where the lateral raise was supersetted with the press, and the
 * third exercise was not. Hevy pairs them by giving both the same
 * `supersets_id` - here 0, the first group of the workout.
 */
const PAIRED = hevyWorkout({
  id: 'workout-superset',
  title: 'Push Day',
  updated_at: '2026-08-29T23:10:00Z',
  start_time: '2026-08-29T22:00:00Z',
  end_time: '2026-08-29T23:05:00Z',
  exercises: [
    {
      index: 0,
      title: 'Incline Dumbbell Press',
      notes: 'Paired with the raise.',
      exercise_template_id: 'TPL-INCLINE-DB',
      supersets_id: 0,
      sets: [
        { index: 0, type: 'normal', weight_kg: 32.5, reps: 10, rpe: 8 },
        { index: 1, type: 'normal', weight_kg: 32.5, reps: 9, rpe: 9 },
      ],
    },
    {
      index: 1,
      title: 'Cable Lateral Raise',
      notes: null,
      exercise_template_id: 'TPL-CABLE-LAT-RAISE',
      supersets_id: 0,
      sets: [
        { index: 0, type: 'normal', weight_kg: 9, reps: 15, rpe: 8 },
      ],
    },
    {
      index: 2,
      title: 'Triceps Pushdown',
      notes: null,
      exercise_template_id: 'TPL-PUSHDOWN',
      supersets_id: null,
      sets: [
        { index: 0, type: 'normal', weight_kg: 30, reps: 12, rpe: 8 },
      ],
    },
  ],
});

const TEMPLATES = [
  {
    id: 'TPL-INCLINE-DB',
    title: 'Incline Dumbbell Press',
    type: 'weight_reps',
    primary_muscle_group: 'chest',
    secondary_muscle_groups: ['triceps'],
    equipment_category: 'dumbbell',
    is_custom: false,
  },
  {
    id: 'TPL-CABLE-LAT-RAISE',
    title: 'Cable Lateral Raise',
    type: 'weight_reps',
    primary_muscle_group: 'shoulders',
    secondary_muscle_groups: [],
    equipment_category: 'cable',
    is_custom: false,
  },
  {
    id: 'TPL-PUSHDOWN',
    title: 'Triceps Pushdown',
    type: 'weight_reps',
    primary_muscle_group: 'triceps',
    secondary_muscle_groups: [],
    equipment_category: 'cable',
    is_custom: false,
  },
];

describe('a superset survives the whole chain', () => {
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
          events: [{ type: 'updated', workout: PAIRED }],
          templates: TEMPLATES,
        }),
        sleep: async () => {},
      });
      const result = await runHevySync(supabaseOverPglite(tx) as never, alice, {
        api, trigger: 'MANUAL',
      });
      expect(result.status).toBe('SUCCEEDED');
      expect(result.workoutsCreated).toBe(1);
    });
  });

  afterAll(async () => {
    await db?.close();
  });

  /** Read exactly as lib/data/queries.ts reads, through the same mappers. */
  async function read() {
    return withUser(db, alice, async (tx) => {
      const sessions = await tx.query<WorkoutSessionRow>(
        `select * from workout_sessions where superseded_at is null order by local_date`,
      );
      const sets = await tx.query<WorkoutSetRow>(`select * from workout_sets`);
      const exercises = await tx.query<ExerciseRow>(
        `select exercise_id, name, primary_muscle_group from exercises`,
      );
      return {
        raw: sets.rows,
        sessions: sessions.rows.map(rowToTrainingSession),
        sets: joinLoggedSets(sessions.rows, sets.rows, exercises.rows),
      };
    });
  }

  it('stores the superset id the source sent, zero included', async () => {
    const { raw } = await read();
    const ids = raw.map((row) => row.superset_id).sort();

    // Three sets in the pair, one outside it. Zero is stored as zero, not as
    // NULL and not as a 1 someone renumbered to make it truthy.
    expect(ids.filter((id) => id === 0)).toHaveLength(3);
    expect(ids.filter((id) => id === null)).toHaveLength(1);
  });

  it('carries it through the reader onto every set of the pair', async () => {
    const { sets } = await read();
    const press = sets.filter((s) => s.exerciseName === 'Incline Dumbbell Press');
    const pushdown = sets.filter((s) => s.exerciseName === 'Triceps Pushdown');

    expect(press.every((s) => s.supersetId === 0)).toBe(true);
    expect(pushdown.every((s) => s.supersetId === null)).toBe(true);
  });

  it('reaches the Training page as one superset of two exercises', async () => {
    const { sessions, sets } = await read();
    const { workouts } = composeTraining(sessions, sets);
    const workout = workouts[0]!;

    // The order is Hevy's own, and all three exercises are present.
    expect(workout.exercises.map((e) => e.exerciseName)).toEqual([
      'Incline Dumbbell Press', 'Cable Lateral Raise', 'Triceps Pushdown',
    ]);

    expect(workout.supersets).toHaveLength(1);
    expect(workout.supersets[0]!.supersetId).toBe(0);
    expect(workout.supersets[0]!.blockKeys).toHaveLength(2);

    // And the third exercise is not swept into the pair it was not part of.
    const paired = new Set(workout.supersets[0]!.blockKeys);
    const pushdown = workout.exercises.find((e) => e.exerciseName === 'Triceps Pushdown')!;
    expect(paired.has(pushdown.key)).toBe(false);
    expect(pushdown.supersetId).toBeNull();
  });

  it('does not let the pairing change any figure it should not', async () => {
    const { sessions, sets } = await read();
    const { workouts } = composeTraining(sessions, sets);

    // A superset is how the work was arranged, not extra work. Four sets were
    // performed and four are counted.
    expect(workouts[0]!.setsLogged).toBe(4);
    expect(workouts[0]!.workingSets).toBe(4);
    expect(workouts[0]!.summary.value!.averageRpe).toBe(8.25);
  });
});
