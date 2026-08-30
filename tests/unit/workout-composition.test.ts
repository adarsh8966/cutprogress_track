/**
 * A workout, composed: the session that happened and what was done inside it.
 *
 * WHY THIS EXISTS. Every consumer that wanted a workout used to rebuild one:
 * the session detail page grouped sets its own way, the Training page counted
 * them another way, and the two disagreed about what a workout contained. The
 * count on the list page included warm-ups; every average beside it excluded
 * them. composeTraining is the one composition all of them read, so these
 * tests are about what that composition must never do:
 *
 *  - invent an exercise for a session that has none
 *  - drop a session because nothing was logged inside it
 *  - reorder what the source recorded
 *  - re-derive an average that summariseTraining already defines
 *  - lose a set whose session it was not given
 *
 * The superset cases pin one specific bug that would ship looking healthy:
 * Hevy's supersets_id is 0-BASED, so reading it with `||` instead of `??`
 * erases the first superset of every workout and leaves the rest correct.
 */
import { describe, it, expect } from 'vitest';
import {
  composeTraining, groupByExercise, supersetGroups, summariseTraining,
  type TrainingSession, type LoggedSet,
} from '@/lib/analytics/training';

function session(overrides: Partial<TrainingSession> = {}): TrainingSession {
  return {
    id: 'session-1',
    date: '2026-08-29',
    sessionType: 'PULL',
    title: 'Pull',
    externalSource: 'HEVY',
    durationMinutes: 65,
    averageHeartRate: null,
    maxHeartRate: null,
    calories: null,
    notes: null,
    source: 'HEVY',
    completed: true,
    importId: null,
    ...overrides,
  };
}

function set(overrides: Partial<LoggedSet> = {}): LoggedSet {
  return {
    date: '2026-08-29',
    sessionId: 'session-1',
    exerciseId: 'lat-pulldown',
    exerciseName: 'Lat Pulldown',
    primaryMuscleGroup: 'Back',
    weightKg: 54.4,
    reps: 12,
    rir: null,
    rpe: 7,
    warmup: false,
    setNumber: 1,
    exerciseIndex: 0,
    exerciseNotes: null,
    setType: null,
    supersetId: null,
    distanceKm: null,
    durationSeconds: null,
    ...overrides,
  };
}

describe('composeTraining: a session with no sets is still a workout', () => {
  it('composes a summary import into a workout with no exercises', () => {
    const { workouts } = composeTraining([session({ source: 'IMPORT_TEXT' })], []);

    expect(workouts).toHaveLength(1);
    expect(workouts[0]!.exercises).toEqual([]);
    expect(workouts[0]!.setsLogged).toBe(0);
    expect(workouts[0]!.workingSets).toBe(0);
  });

  it('reports a null volume for that workout, never a zero one', () => {
    const { workouts } = composeTraining([session()], []);
    const summary = workouts[0]!.summary;

    // Nothing was logged, so nothing is known. A zero here would be a claim
    // that the user trained and moved no weight.
    expect(summary.value!.totalVolumeKg).toBeNull();
    expect(summary.value!.averageRpe).toBeNull();
    expect(summary.value!.totalWorkingSets).toBe(0);
    expect(summary.confidence).toBe('INSUFFICIENT');
  });

  it('never derives a set from a session that reported duration and heart rate', () => {
    const { workouts } = composeTraining(
      [session({ durationMinutes: 58, averageHeartRate: 142, calories: 412 })],
      [],
    );

    expect(workouts[0]!.session.durationMinutes).toBe(58);
    expect(workouts[0]!.workingSets).toBe(0);
    expect(workouts[0]!.summary.value!.totalVolumeKg).toBeNull();
  });
});

describe('composeTraining: the order is the source’s', () => {
  it('keeps exercises in the order recorded, whatever order the sets arrive in', () => {
    const sets = [
      set({ exerciseId: 'curl', exerciseName: 'Dumbbell Curl', exerciseIndex: 3 }),
      set({ exerciseId: 'lat-pulldown', exerciseName: 'Lat Pulldown', exerciseIndex: 0 }),
      set({ exerciseId: 'face-pull', exerciseName: 'Face Pull', exerciseIndex: 2 }),
      set({ exerciseId: 'cable-row', exerciseName: 'Seated Cable Row', exerciseIndex: 1 }),
    ];

    const { workouts } = composeTraining([session()], sets);

    expect(workouts[0]!.exercises.map((e) => e.exerciseName)).toEqual([
      'Lat Pulldown', 'Seated Cable Row', 'Face Pull', 'Dumbbell Curl',
    ]);
  });

  it('keeps the same movement performed twice as two blocks', () => {
    const sets = [
      set({ exerciseIndex: 0, setNumber: 1 }),
      set({ exerciseIndex: 0, setNumber: 2 }),
      set({ exerciseId: 'row', exerciseName: 'Row', exerciseIndex: 1 }),
      set({ exerciseIndex: 2, setNumber: 3 }),
    ];

    const { workouts } = composeTraining([session()], sets);

    // Three blocks, not two: the pulldown was done, then a row, then the
    // pulldown again. Merging them would report five straight sets of
    // something performed as two separate pieces of work.
    expect(workouts[0]!.exercises.map((e) => e.exerciseName)).toEqual([
      'Lat Pulldown', 'Row', 'Lat Pulldown',
    ]);
  });

  it('orders workouts most recent first', () => {
    const { workouts } = composeTraining(
      [
        session({ id: 'a', date: '2026-08-22' }),
        session({ id: 'b', date: '2026-08-29' }),
        session({ id: 'c', date: '2026-08-28' }),
      ],
      [],
    );

    expect(workouts.map((w) => w.session.id)).toEqual(['b', 'c', 'a']);
  });

  it('keeps two sessions on the same day in the order it was given them', () => {
    const { workouts } = composeTraining(
      [
        session({ id: 'morning', date: '2026-08-29' }),
        session({ id: 'evening', date: '2026-08-29' }),
      ],
      [],
    );

    // start_time is not mapped into TrainingSession, so the true order within
    // a day is not knowable here. A stable sort states that by preserving what
    // it was handed rather than inventing a sequence.
    expect(workouts.map((w) => w.session.id)).toEqual(['morning', 'evening']);
  });

  it('does not mutate the arrays it was given', () => {
    const sessions = [
      session({ id: 'a', date: '2026-08-22' }),
      session({ id: 'b', date: '2026-08-29' }),
    ];
    const sets = [set({ exerciseIndex: 1 }), set({ exerciseIndex: 0 })];
    const sessionOrder = sessions.map((s) => s.id);
    const setOrder = sets.map((s) => s.exerciseIndex);

    composeTraining(sessions, sets);

    expect(sessions.map((s) => s.id)).toEqual(sessionOrder);
    expect(sets.map((s) => s.exerciseIndex)).toEqual(setOrder);
  });
});

describe('composeTraining: counts and averages', () => {
  const sets = [
    set({ setNumber: 1, warmup: true, rpe: null }),
    set({ setNumber: 2, rpe: 7 }),
    set({ setNumber: 3, rpe: 8 }),
    set({ setNumber: 4, rpe: 9 }),
  ];

  it('counts warm-ups as logged and excludes them from working', () => {
    const { workouts } = composeTraining([session()], sets);

    // Two different questions with two different answers, and both are true:
    // four sets were recorded, three of them counted toward the work done.
    expect(workouts[0]!.setsLogged).toBe(4);
    expect(workouts[0]!.workingSets).toBe(3);
  });

  it('uses the same average as summariseTraining rather than its own', () => {
    const { workouts } = composeTraining([session()], sets);

    // If this ever fails, someone has reimplemented averaging inside the
    // composer and the per-workout figure can now disagree with the page's.
    expect(workouts[0]!.summary.value!.averageRpe)
      .toBe(summariseTraining(sets).value!.averageRpe);
    expect(workouts[0]!.summary.value!.averageRpe).toBe(8);
  });

  it('attaches only that workout’s own sets', () => {
    const { workouts } = composeTraining(
      [session({ id: 'a' }), session({ id: 'b', date: '2026-08-28' })],
      [
        set({ sessionId: 'a', setNumber: 1 }),
        set({ sessionId: 'a', setNumber: 2 }),
        set({ sessionId: 'b', setNumber: 1 }),
      ],
    );

    const byId = new Map(workouts.map((w) => [w.session.id, w]));
    expect(byId.get('a')!.setsLogged).toBe(2);
    expect(byId.get('b')!.setsLogged).toBe(1);
  });
});

describe('composeTraining: nothing stored is silently dropped', () => {
  it('surfaces a set whose session it was not given', () => {
    const orphan = set({ sessionId: 'missing' });
    const { workouts, unattachedSets } = composeTraining(
      [session({ id: 'session-1' })],
      [set({ sessionId: 'session-1' }), orphan],
    );

    expect(unattachedSets).toEqual([orphan]);
    // And it is not quietly counted against some other workout either.
    expect(workouts[0]!.setsLogged).toBe(1);
  });

  it('reports nothing unattached in the normal case', () => {
    const { unattachedSets } = composeTraining([session()], [set(), set({ setNumber: 2 })]);
    expect(unattachedSets).toEqual([]);
  });

  it('composes a session that was planned and not completed', () => {
    // summariseSessions applies the `completed` rule. A second, quieter rule
    // here could disagree with it, so the composer applies none and lets the
    // caller decide what to show.
    const { workouts } = composeTraining([session({ completed: false })], []);
    expect(workouts).toHaveLength(1);
  });
});

describe('supersetGroups', () => {
  const blocksFrom = (sets: LoggedSet[]) => groupByExercise(sets);

  it('groups consecutive exercises that share a superset id', () => {
    const groups = supersetGroups(blocksFrom([
      set({ exerciseId: 'a', exerciseIndex: 0, supersetId: 1 }),
      set({ exerciseId: 'b', exerciseIndex: 1, supersetId: 1 }),
      set({ exerciseId: 'c', exerciseIndex: 2, supersetId: null }),
    ]));

    expect(groups).toHaveLength(1);
    expect(groups[0]!.supersetId).toBe(1);
    expect(groups[0]!.blockKeys).toEqual(['0#a', '1#b']);
  });

  it('treats superset id 0 as a real group', () => {
    // Hevy numbers supersets from zero. Read with `||` rather than `??`, the
    // first superset of every workout would read as "not in one" and vanish
    // while every later one stayed correct.
    const groups = supersetGroups(blocksFrom([
      set({ exerciseId: 'a', exerciseIndex: 0, supersetId: 0 }),
      set({ exerciseId: 'b', exerciseIndex: 1, supersetId: 0 }),
    ]));

    expect(groups).toHaveLength(1);
    expect(groups[0]!.supersetId).toBe(0);
  });

  it('carries superset id 0 onto the block it belongs to', () => {
    const blocks = blocksFrom([set({ exerciseIndex: 0, supersetId: 0 })]);
    expect(blocks[0]!.supersetId).toBe(0);
  });

  it('does not call a lone exercise a superset', () => {
    const groups = supersetGroups(blocksFrom([
      set({ exerciseId: 'a', exerciseIndex: 0, supersetId: 4 }),
      set({ exerciseId: 'b', exerciseIndex: 1, supersetId: null }),
    ]));

    // The id stays on the block - nothing is lost by declining to name it.
    expect(groups).toEqual([]);
  });

  it('splits one id into two groups when another exercise sits between them', () => {
    const groups = supersetGroups(blocksFrom([
      set({ exerciseId: 'a', exerciseIndex: 0, supersetId: 2 }),
      set({ exerciseId: 'b', exerciseIndex: 1, supersetId: 2 }),
      set({ exerciseId: 'c', exerciseIndex: 2, supersetId: null }),
      set({ exerciseId: 'd', exerciseIndex: 3, supersetId: 2 }),
      set({ exerciseId: 'e', exerciseIndex: 4, supersetId: 2 }),
    ]));

    // Joining them would claim a pairing the source did not record: those two
    // pairs were performed at different points in the workout.
    expect(groups.map((g) => g.blockKeys)).toEqual([['0#a', '1#b'], ['3#d', '4#e']]);
  });

  it('finds nothing when no set carries a superset id', () => {
    const groups = supersetGroups(blocksFrom([
      set({ exerciseId: 'a', exerciseIndex: 0 }),
      set({ exerciseId: 'b', exerciseIndex: 1 }),
    ]));

    expect(groups).toEqual([]);
  });

  it('reaches the composed workout', () => {
    const { workouts } = composeTraining([session()], [
      set({ exerciseId: 'a', exerciseIndex: 0, supersetId: 0 }),
      set({ exerciseId: 'b', exerciseIndex: 1, supersetId: 0 }),
      set({ exerciseId: 'c', exerciseIndex: 2, supersetId: null }),
    ]);

    expect(workouts[0]!.supersets).toHaveLength(1);
    expect(workouts[0]!.supersets[0]!.blockKeys).toHaveLength(2);
  });
});
