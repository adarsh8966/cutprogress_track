/**
 * Hevy's payload -> CUT OS's terms.
 *
 * The mapper is pure, so every rule here is asserted directly rather than
 * inferred from what ended up in a database. Three groups of rule:
 *
 *   what is CARRIED  - notes, RPE, order, load, and the fields the brief named
 *   what is CONVERTED - metres to km, an interval to minutes, an instant to the
 *                       user's own calendar day
 *   what is REFUSED  - a value the schema will not accept becomes null AND a
 *                      warning, never a clamp. Clamping RPE 12 to 10 stores a
 *                      number nobody reported.
 */
import { describe, it, expect } from 'vitest';
import { mapWorkout, isWarmupSetType, durationMinutesBetween } from '@/lib/integrations/hevy/mapper';
import { hevyWorkoutSchema } from '@/lib/integrations/hevy/types';
import type { HevyWorkout } from '@/lib/integrations/hevy/types';

const TZ = 'America/New_York';

function workout(overrides: Record<string, unknown> = {}): HevyWorkout {
  return hevyWorkoutSchema.parse({
    id: 'workout-1',
    title: 'Push Day',
    routine_id: null,
    description: 'Felt really strong today. Increased incline DB press.',
    start_time: '2026-08-29T22:00:00Z',
    end_time: '2026-08-29T23:04:00Z',
    updated_at: '2026-08-29T23:05:00Z',
    created_at: '2026-08-29T22:00:00Z',
    exercises: [
      {
        index: 0,
        title: 'Incline Dumbbell Press',
        notes: 'Form was on point.',
        exercise_template_id: 'TEMPLATE-A',
        supersets_id: null,
        sets: [
          { index: 0, type: 'normal', weight_kg: 31.75, reps: 10, rpe: 7,
            distance_meters: null, duration_seconds: null, custom_metric: null },
          { index: 1, type: 'normal', weight_kg: 34, reps: 9, rpe: 8,
            distance_meters: null, duration_seconds: null, custom_metric: null },
          { index: 2, type: 'normal', weight_kg: 34, reps: 8, rpe: 9,
            distance_meters: null, duration_seconds: null, custom_metric: null },
        ],
      },
    ],
    ...overrides,
  });
}

describe('mapWorkout: what is carried', () => {
  it('keeps the workout name and the workout NOTE', () => {
    // Hevy calls the note `description`. This is the field the brief singled
    // out, and it has to survive intact.
    const { workout: mapped } = mapWorkout(workout(), { timezone: TZ });
    expect(mapped.title).toBe('Push Day');
    expect(mapped.notes).toBe('Felt really strong today. Increased incline DB press.');
  });

  it('keeps the exercise note, its position and its template id', () => {
    const { workout: mapped } = mapWorkout(workout(), { timezone: TZ });
    const [exercise] = mapped.exercises;
    expect(exercise).toMatchObject({
      templateId: 'TEMPLATE-A',
      title: 'Incline Dumbbell Press',
      index: 0,
      notes: 'Form was on point.',
    });
  });

  it('keeps every set, in order, with load, reps and RPE', () => {
    const { workout: mapped } = mapWorkout(workout(), { timezone: TZ });
    expect(mapped.exercises[0]!.sets).toEqual([
      { setNumber: 1, setType: 'normal', warmup: false, weightKg: 31.75, reps: 10, rpe: 7,
        distanceKm: null, durationSeconds: null },
      { setNumber: 2, setType: 'normal', warmup: false, weightKg: 34, reps: 9, rpe: 8,
        distanceKm: null, durationSeconds: null },
      { setNumber: 3, setType: 'normal', warmup: false, weightKg: 34, reps: 8, rpe: 9,
        distanceKm: null, durationSeconds: null },
    ]);
  });

  it('carries the external identity a re-sync needs', () => {
    const { workout: mapped } = mapWorkout(workout(), { timezone: TZ });
    expect(mapped.externalId).toBe('workout-1');
    expect(mapped.externalUpdatedAt).toBe('2026-08-29T23:05:00Z');
  });

  it('maps the title to a session type and keeps the title whole either way', () => {
    expect(mapWorkout(workout(), { timezone: TZ }).workout.sessionType).toBe('PUSH');

    const odd = mapWorkout(workout({ title: 'Arms and abs 🔥' }), { timezone: TZ });
    // Unrecognised lands on OTHER, and nothing is lost - the name is kept.
    expect(odd.workout.sessionType).toBe('OTHER');
    expect(odd.workout.title).toBe('Arms and abs 🔥');
  });

  it('reports the set-type vocabulary it actually saw', () => {
    // The documentation elides Set.type's members, so the first real sync is
    // what tells us which ones this account uses.
    const mapped = mapWorkout(workout({
      exercises: [{
        index: 0, title: 'Bench', notes: null,
        exercise_template_id: 'T', supersets_id: null,
        sets: [
          { index: 0, type: 'warmup' }, { index: 1, type: 'normal' },
          { index: 2, type: 'dropset' },
        ],
      }],
    }), { timezone: TZ });
    expect(mapped.setTypes).toEqual(['dropset', 'normal', 'warmup']);
  });
});

describe('mapWorkout: what is converted', () => {
  it('files the workout under the user’s own calendar day, never UTC’s', () => {
    // 22:00 UTC on the 29th is 18:00 in New York on the 29th.
    expect(mapWorkout(workout(), { timezone: TZ }).workout.localDate).toBe('2026-08-29');
    // The same instant is already the 30th in Tokyo. Whose day it is depends on
    // the profile's timezone and never on UTC (§40).
    expect(mapWorkout(workout(), { timezone: 'Asia/Tokyo' }).workout.localDate)
      .toBe('2026-08-30');
  });

  it('keeps a late-night session on its own day', () => {
    // 03:30 UTC is 23:30 the previous evening in New York.
    const late = workout({
      start_time: '2026-08-30T03:30:00Z', end_time: '2026-08-30T04:20:00Z',
    });
    expect(mapWorkout(late, { timezone: TZ }).workout.localDate).toBe('2026-08-29');
  });

  it('derives duration from the interval, since Hevy sends no duration', () => {
    expect(mapWorkout(workout(), { timezone: TZ }).workout.durationMinutes).toBe(64);
    expect(durationMinutesBetween('2026-08-29T22:00:00Z', '2026-08-29T23:04:30Z')).toBe(64.5);
  });

  it('converts metres to kilometres, the unit this app stores', () => {
    const mapped = mapWorkout(workout({
      exercises: [{
        index: 0, title: 'Farmer Carry', notes: null,
        exercise_template_id: 'T', supersets_id: null,
        sets: [{ index: 0, type: 'normal', distance_meters: 400, duration_seconds: 75 }],
      }],
    }), { timezone: TZ });
    expect(mapped.workout.exercises[0]!.sets[0]!.distanceKm).toBe(0.4);
    expect(mapped.workout.exercises[0]!.sets[0]!.durationSeconds).toBe(75);
  });

  it('leaves weight alone: Hevy is already metric', () => {
    const mapped = mapWorkout(workout(), { timezone: TZ });
    expect(mapped.workout.exercises[0]!.sets[0]!.weightKg).toBe(31.75);
  });
});

describe('mapWorkout: the warm-up rule', () => {
  it('treats exactly "warmup" as a warm-up, ignoring case and space', () => {
    expect(isWarmupSetType('warmup')).toBe(true);
    expect(isWarmupSetType(' WarmUp ')).toBe(true);
  });

  it('treats nothing else as a warm-up', () => {
    // Reading an unknown type as a warm-up would silently drop real sets out of
    // volume; reading it as a working set is the recoverable direction, and the
    // raw word is kept either way.
    for (const type of ['normal', 'dropset', 'failure', 'warm up', 'warm-up', null]) {
      expect(isWarmupSetType(type)).toBe(false);
    }
  });

  it('keeps an unrecognised type verbatim on the set', () => {
    const mapped = mapWorkout(workout({
      exercises: [{
        index: 0, title: 'Bench', notes: null,
        exercise_template_id: 'T', supersets_id: null,
        sets: [{ index: 0, type: 'dropset', weight_kg: 20, reps: 12 }],
      }],
    }), { timezone: TZ });
    expect(mapped.workout.exercises[0]!.sets[0]).toMatchObject({
      setType: 'dropset', warmup: false, weightKg: 20,
    });
  });
});

describe('mapWorkout: set numbering', () => {
  it('numbers sets from 1, because the column requires it', () => {
    const mapped = mapWorkout(workout(), { timezone: TZ });
    expect(mapped.workout.exercises[0]!.sets.map((s) => s.setNumber)).toEqual([1, 2, 3]);
  });

  it('continues numbering when one exercise appears twice in a workout', () => {
    // workout_sets is unique on (session, exercise, set_number). Numbering each
    // block from 1 would have the second block refused by the database.
    const mapped = mapWorkout(workout({
      exercises: [
        {
          index: 0, title: 'Bench Press', notes: null,
          exercise_template_id: 'SAME', supersets_id: null,
          sets: [{ index: 0, type: 'normal' }, { index: 1, type: 'normal' }],
        },
        {
          index: 1, title: 'Cable Row', notes: null,
          exercise_template_id: 'OTHER', supersets_id: null,
          sets: [{ index: 0, type: 'normal' }],
        },
        {
          index: 2, title: 'Bench Press', notes: null,
          exercise_template_id: 'SAME', supersets_id: null,
          sets: [{ index: 0, type: 'normal' }, { index: 1, type: 'normal' }],
        },
      ],
    }), { timezone: TZ });

    const [first, other, second] = mapped.workout.exercises;
    expect(first!.sets.map((s) => s.setNumber)).toEqual([1, 2]);
    expect(second!.sets.map((s) => s.setNumber)).toEqual([3, 4]);
    // A different exercise starts again at 1: the constraint is per exercise.
    expect(other!.sets.map((s) => s.setNumber)).toEqual([1]);
    // And the two blocks stay distinguishable by their position.
    expect([first!.index, second!.index]).toEqual([0, 2]);
  });
});

describe('mapWorkout: what is refused', () => {
  it('drops an RPE outside 1–10 rather than clamping it', () => {
    const mapped = mapWorkout(workout({
      exercises: [{
        index: 0, title: 'Bench', notes: null,
        exercise_template_id: 'T', supersets_id: null,
        sets: [{ index: 0, type: 'normal', weight_kg: 60, reps: 5, rpe: 12 }],
      }],
    }), { timezone: TZ });

    expect(mapped.workout.exercises[0]!.sets[0]!.rpe).toBeNull();
    // Clamping to 10 would store a number nobody reported.
    expect(mapped.warnings.join(' ')).toMatch(/RPE .*was 12/);
    // The rest of the set is unaffected: one bad field is not a lost set.
    expect(mapped.workout.exercises[0]!.sets[0]!.weightKg).toBe(60);
  });

  it('drops a negative load and says so', () => {
    const mapped = mapWorkout(workout({
      exercises: [{
        index: 0, title: 'Bench', notes: null,
        exercise_template_id: 'T', supersets_id: null,
        sets: [{ index: 0, type: 'normal', weight_kg: -5, reps: 5 }],
      }],
    }), { timezone: TZ });
    expect(mapped.workout.exercises[0]!.sets[0]!.weightKg).toBeNull();
    expect(mapped.warnings).toHaveLength(1);
  });

  it('drops an end time that precedes its start, with the duration', () => {
    const mapped = mapWorkout(workout({
      start_time: '2026-08-29T23:00:00Z', end_time: '2026-08-29T22:00:00Z',
    }), { timezone: TZ });
    expect(mapped.workout.endTime).toBeNull();
    expect(mapped.workout.durationMinutes).toBeNull();
    expect(mapped.warnings.join(' ')).toMatch(/ended before it started/);
    // The workout itself still lands: a bad clock is not a reason to lose it.
    expect(mapped.workout.externalId).toBe('workout-1');
  });

  it('drops a duration beyond a day, which the column refuses anyway', () => {
    const mapped = mapWorkout(workout({
      start_time: '2026-08-01T10:00:00Z', end_time: '2026-08-29T10:00:00Z',
    }), { timezone: TZ });
    expect(mapped.workout.durationMinutes).toBeNull();
    expect(mapped.warnings.join(' ')).toMatch(/outside the range/);
  });

  it('records no duration for a workout that has not ended', () => {
    const mapped = mapWorkout(workout({ end_time: null }), { timezone: TZ });
    expect(mapped.workout.durationMinutes).toBeNull();
    // Not a warning: a session still in progress is a normal state, not a fault.
    expect(mapped.warnings).toEqual([]);
  });

  it('carries a bodyweight set’s zero load as a zero', () => {
    // 0 kg of ADDED load is a measurement. Turning it into null would lose it.
    const mapped = mapWorkout(workout({
      exercises: [{
        index: 0, title: 'Pull-Up', notes: null,
        exercise_template_id: 'T', supersets_id: null,
        sets: [{ index: 0, type: 'normal', weight_kg: 0, reps: 8 }],
      }],
    }), { timezone: TZ });
    expect(mapped.workout.exercises[0]!.sets[0]!.weightKg).toBe(0);
    expect(mapped.warnings).toEqual([]);
  });

  it('maps a workout with no exercises without inventing any', () => {
    const mapped = mapWorkout(workout({ exercises: [] }), { timezone: TZ });
    expect(mapped.workout.exercises).toEqual([]);
    expect(mapped.workout.title).toBe('Push Day');
  });
});
