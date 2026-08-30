/**
 * joinLoggedSets: which sets count, and in what order (spec §11, §12, §48).
 *
 * THE BUG THIS PINS. Withdrawing a training session marked the session row and
 * left its sets alone - correctly, because marking each set would be a second,
 * lossier record of one fact. But the only query that read sets joined UP to
 * the session for its date and never asked whether that session still counted.
 * So a session the user had withdrawn went on contributing every one of its
 * sets to volume, e1RM, muscle-group totals and progression, on every page,
 * with nothing anywhere saying so. The withdrawal appeared to work and changed
 * none of the numbers it was performed to change.
 *
 * The rule has two halves and they are not the same half:
 *
 *   a set removed at its source stops counting   (workout_sets.superseded_at)
 *   a withdrawn session takes ALL its sets       (workout_sessions.superseded_at)
 *
 * Both are asserted here, on the pure function, because that is the level at
 * which they can be asserted at all.
 */
import { describe, it, expect } from 'vitest';
import { joinLoggedSets } from '@/lib/data/rows';
import type {
  WorkoutSetRow, WorkoutSessionRow, ExerciseRow,
} from '@/lib/supabase/types';

type SessionInput = Pick<WorkoutSessionRow, 'id' | 'local_date' | 'superseded_at'>;

function session(overrides: Partial<SessionInput> = {}): SessionInput {
  return { id: 'session-1', local_date: '2026-08-29', superseded_at: null, ...overrides };
}

function set(overrides: Partial<WorkoutSetRow> = {}): WorkoutSetRow {
  return {
    id: 'set-1',
    user_id: 'alice',
    session_id: 'session-1',
    created_at: '2026-08-29T18:00:00Z',
    exercise_id: 'cable-row',
    set_number: 1,
    weight_kg: 40,
    reps: 10,
    rir: null,
    rpe: 8,
    rest_seconds: null,
    warmup: false,
    to_failure: false,
    notes: null,
    exercise_index: 0,
    exercise_notes: null,
    superset_id: null,
    set_type: 'normal',
    distance_km: null,
    duration_seconds: null,
    superseded_at: null,
    superseded_by: null,
    ...overrides,
  };
}

const CATALOG: Pick<ExerciseRow, 'exercise_id' | 'name' | 'primary_muscle_group'>[] = [
  { exercise_id: 'cable-row', name: 'Cable Row', primary_muscle_group: 'Back' },
  { exercise_id: 'incline-db-press', name: 'Incline Dumbbell Press', primary_muscle_group: 'Chest' },
];

describe('joinLoggedSets', () => {
  it('joins a live set to its session date and its exercise', () => {
    const [joined] = joinLoggedSets([session()], [set()], CATALOG);
    expect(joined).toMatchObject({
      date: '2026-08-29',
      sessionId: 'session-1',
      exerciseId: 'cable-row',
      exerciseName: 'Cable Row',
      primaryMuscleGroup: 'Back',
      weightKg: 40,
      reps: 10,
      rpe: 8,
      setNumber: 1,
      setType: 'normal',
    });
  });

  it('drops a set that was removed at the source', () => {
    const joined = joinLoggedSets(
      [session()],
      [set({ id: 'live' }), set({ id: 'gone', superseded_at: '2026-08-30T09:00:00Z' })],
      CATALOG,
    );
    expect(joined.map((s) => s.setNumber)).toHaveLength(1);
  });

  it('drops EVERY set of a withdrawn session, though no set is itself marked', () => {
    // This is the reported failure. All three sets are live rows; the session
    // they belong to is not.
    const sets = [1, 2, 3].map((n) => set({ id: `set-${n}`, set_number: n }));
    expect(joinLoggedSets([session()], sets, CATALOG)).toHaveLength(3);
    expect(
      joinLoggedSets([session({ superseded_at: '2026-08-30T09:00:00Z' })], sets, CATALOG),
    ).toEqual([]);
  });

  it('keeps the sets of a live session when another session was withdrawn', () => {
    const joined = joinLoggedSets(
      [
        session({ id: 'live-session' }),
        session({ id: 'dead-session', superseded_at: '2026-08-30T09:00:00Z' }),
      ],
      [
        set({ id: 'a', session_id: 'live-session' }),
        set({ id: 'b', session_id: 'dead-session' }),
      ],
      CATALOG,
    );
    expect(joined.map((s) => s.sessionId)).toEqual(['live-session']);
  });

  it('treats a row that cannot say as live, never as withdrawn', () => {
    // A project still on an older migration returns rows with no supersession
    // key at all. Reading that as "withdrawn" would empty the Training page of
    // data that is sitting right there - the one failure this system exists to
    // prevent. A withdrawal has to be STATED to count.
    const legacySession = { id: 'session-1', local_date: '2026-08-29' } as SessionInput;
    const legacySet = { ...set() } as Partial<WorkoutSetRow>;
    delete legacySet.superseded_at;

    expect(
      joinLoggedSets([legacySession], [legacySet as WorkoutSetRow], CATALOG),
    ).toHaveLength(1);
  });

  it('drops a set whose exercise is missing rather than naming it', () => {
    // Unreachable behind the foreign key. If it ever happens, an absent set is
    // safer than one silently attributed to the wrong movement.
    const joined = joinLoggedSets([session()], [set({ exercise_id: 'ghost' })], CATALOG);
    expect(joined).toEqual([]);
  });

  it('orders by exercise block then set number, not by set number alone', () => {
    // Set numbers restart per exercise, so ordering by set_number alone
    // interleaved the exercises of any workout that recorded more than one.
    const sets = [
      set({ id: 'b1', exercise_id: 'incline-db-press', exercise_index: 1, set_number: 1 }),
      set({ id: 'a2', exercise_id: 'cable-row', exercise_index: 0, set_number: 2 }),
      set({ id: 'b2', exercise_id: 'incline-db-press', exercise_index: 1, set_number: 2 }),
      set({ id: 'a1', exercise_id: 'cable-row', exercise_index: 0, set_number: 1 }),
    ];
    expect(joinLoggedSets([session()], sets, CATALOG).map((s) => s.exerciseId))
      .toEqual(['cable-row', 'cable-row', 'incline-db-press', 'incline-db-press']);
  });

  it('sorts a hand-logged set with no exercise block last', () => {
    const sets = [
      set({ id: 'manual', exercise_index: null, set_number: 1 }),
      set({ id: 'sourced', exercise_index: 0, set_number: 1 }),
    ];
    expect(joinLoggedSets([session()], sets, CATALOG).map((s) => s.exerciseIndex))
      .toEqual([0, null]);
  });

  it('reads numerics returned as strings, and keeps null as null', () => {
    // PostgREST and PGlite both hand back numeric columns as strings in some
    // configurations. Number(null) would be 0 - a fabricated measurement.
    const joined = joinLoggedSets(
      [session()],
      [set({
        weight_kg: '42.5' as unknown as number,
        reps: '8' as unknown as number,
        rpe: null,
        distance_km: '0.4' as unknown as number,
      })],
      CATALOG,
    );
    expect(joined[0]!.weightKg).toBe(42.5);
    expect(joined[0]!.reps).toBe(8);
    expect(joined[0]!.rpe).toBeNull();
    expect(joined[0]!.distanceKm).toBe(0.4);
  });

  it('carries the exercise note onto every set of that exercise', () => {
    const joined = joinLoggedSets(
      [session()],
      [
        set({ id: 's1', set_number: 1, exercise_notes: 'Felt strong. Went up 5 lb.' }),
        set({ id: 's2', set_number: 2, exercise_notes: 'Felt strong. Went up 5 lb.' }),
      ],
      CATALOG,
    );
    expect(joined.map((s) => s.exerciseNotes))
      .toEqual(['Felt strong. Went up 5 lb.', 'Felt strong. Went up 5 lb.']);
  });
});
