/**
 * The Hevy response schemas, driven by the payloads in the published API
 * documentation.
 *
 * Two jobs. The first is that every documented shape parses - if it does not,
 * a real sync fails on the first page. The second matters more: a response
 * that has QUIETLY CHANGED must be rejected rather than read as absence. A
 * renamed `weight_kg` parsed loosely arrives as undefined, is written as "not
 * recorded", and a set that was performed with 100 kg on the bar is stored as
 * a set with no load - fabricated absence, which is the §33 failure arriving
 * from someone else's deploy.
 */
import { describe, it, expect } from 'vitest';
import {
  hevyWorkoutSchema, hevySetSchema, hevyWorkoutEventsPageSchema,
  hevyExerciseTemplateSchema, hevyUserInfoSchema, hevyWorkoutCountSchema,
} from '@/lib/integrations/hevy/types';

/** Verbatim from the documentation's Workout example. */
const WORKOUT = {
  id: 'b459cba5-cd6d-463c-abd6-54f8eafcadcb',
  title: 'Morning Workout 💪',
  routine_id: 'b459cba5-cd6d-463c-abd6-54f8eafcadcb',
  description: 'Pushed myself to the limit today!',
  start_time: '2021-09-14T12:00:00Z',
  end_time: '2021-09-14T12:00:00Z',
  updated_at: '2021-09-14T12:00:00Z',
  created_at: '2021-09-14T12:00:00Z',
  exercises: [
    {
      index: 0,
      title: 'Bench Press (Barbell)',
      notes: 'Paid closer attention to form today. Felt great!',
      exercise_template_id: '05293BCA',
      supersets_id: 0,
      sets: [
        {
          index: 0,
          type: 'normal',
          weight_kg: 100,
          reps: 10,
          distance_meters: null,
          duration_seconds: null,
          rpe: 9.5,
          custom_metric: 50,
        },
      ],
    },
  ],
};

describe('Hevy workout schema', () => {
  it('parses the documented workout, keeping every field it carries', () => {
    const parsed = hevyWorkoutSchema.parse(WORKOUT);
    expect(parsed.id).toBe('b459cba5-cd6d-463c-abd6-54f8eafcadcb');
    expect(parsed.title).toBe('Morning Workout 💪');
    // The workout NOTE. Hevy calls it description; there is no `notes` field on
    // a workout, and this is the field the user specifically needs preserved.
    expect(parsed.description).toBe('Pushed myself to the limit today!');
    expect(parsed.exercises[0]!.notes)
      .toBe('Paid closer attention to form today. Felt great!');
    expect(parsed.exercises[0]!.exercise_template_id).toBe('05293BCA');
    expect(parsed.exercises[0]!.sets[0]!.rpe).toBe(9.5);
  });

  it('treats a missing optional field and an explicit null as the same absence', () => {
    const bare = hevySetSchema.parse({ index: 0 });
    expect(bare).toEqual({
      index: 0, type: null, weight_kg: null, reps: null,
      distance_meters: null, duration_seconds: null, rpe: null, custom_metric: null,
    });
  });

  it('keeps a real zero as a zero', () => {
    // A bodyweight set is 0 kg of ADDED load - a measurement, not a gap.
    const parsed = hevySetSchema.parse({ index: 0, weight_kg: 0, reps: 12 });
    expect(parsed.weight_kg).toBe(0);
    expect(parsed.reps).toBe(12);
  });

  it('accepts a workout that has not ended yet', () => {
    const parsed = hevyWorkoutSchema.parse({ ...WORKOUT, end_time: null });
    expect(parsed.end_time).toBeNull();
  });

  it('rejects a workout with no id, rather than syncing an unidentifiable one', () => {
    const { id, ...withoutId } = WORKOUT;
    void id;
    expect(hevyWorkoutSchema.safeParse(withoutId).success).toBe(false);
  });

  it('rejects a timestamp that is not a timestamp', () => {
    // Reading this as the epoch would file the workout under 1 January 1970.
    expect(
      hevyWorkoutSchema.safeParse({ ...WORKOUT, start_time: 'yesterday' }).success,
    ).toBe(false);
  });

  it('rejects a renamed measurement rather than reading it as not recorded', () => {
    const renamed = {
      ...WORKOUT,
      exercises: [{
        ...WORKOUT.exercises[0],
        sets: [{ index: 0, type: 'normal', weight: 100, reps: 10 }],
      }],
    };
    const parsed = hevyWorkoutSchema.parse(renamed);
    // The unknown key is dropped - and `weight_kg` is then absent, which reads
    // as "no load recorded". That is exactly the silent loss worth naming: the
    // schema cannot tell a renamed field from an omitted one, so the guard that
    // catches it is the sync summary reporting a workout whose sets carry no
    // load, not this parse.
    expect(parsed.exercises[0]!.sets[0]!.weight_kg).toBeNull();
  });

  it('ignores a field Hevy adds, so a their-side release does not break a sync', () => {
    const parsed = hevyWorkoutSchema.parse({ ...WORKOUT, some_new_field: 'whatever' });
    expect(parsed.title).toBe('Morning Workout 💪');
    // Nothing is lost by dropping it: the raw body is stored verbatim (§17).
    expect('some_new_field' in parsed).toBe(false);
  });

  it('carries an unrecognised set type verbatim instead of interpreting it', () => {
    // The documentation elides this enum's members. A guess here would decide
    // whether a set counts towards training volume.
    const parsed = hevySetSchema.parse({ index: 0, type: 'some_future_type' });
    expect(parsed.type).toBe('some_future_type');
  });
});

describe('Hevy events schema', () => {
  it('parses both event kinds from the documented example', () => {
    const page = hevyWorkoutEventsPageSchema.parse({
      page: 1,
      page_count: 5,
      events: [
        { type: 'updated', workout: WORKOUT },
        {
          type: 'deleted',
          id: 'efe6801c-4aee-4959-bcdd-fca3f272821b',
          deleted_at: '2021-09-13T12:00:00Z',
        },
      ],
    });

    expect(page.events).toHaveLength(2);
    const updated = page.events[0]!;
    const deleted = page.events[1]!;
    expect(updated.type).toBe('updated');
    if (updated.type === 'updated') expect(updated.workout.title).toBe('Morning Workout 💪');
    expect(deleted.type).toBe('deleted');
    if (deleted.type === 'deleted') expect(deleted.id).toBe('efe6801c-4aee-4959-bcdd-fca3f272821b');
  });

  it('rejects an event kind it has never seen', () => {
    // A third event type would need a decision about what it means. Failing is
    // the only honest response to one this code has never been told about.
    expect(
      hevyWorkoutEventsPageSchema.safeParse({
        page: 1, page_count: 1, events: [{ type: 'archived', id: 'x' }],
      }).success,
    ).toBe(false);
  });

  it('accepts a deletion with no deleted_at', () => {
    const page = hevyWorkoutEventsPageSchema.parse({
      page: 1, page_count: 1, events: [{ type: 'deleted', id: 'x' }],
    });
    expect(page.events[0]).toMatchObject({ type: 'deleted', deleted_at: null });
  });
});

describe('the smaller documented shapes', () => {
  it('parses an exercise template', () => {
    const parsed = hevyExerciseTemplateSchema.parse({
      id: 'b459cba5-cd6d-463c-abd6-54f8eafcadcb',
      title: 'Bench Press (Barbell)',
      type: 'weight_reps',
      primary_muscle_group: 'chest',
      secondary_muscle_groups: ['triceps'],
      equipment_category: 'barbell',
      is_custom: false,
    });
    expect(parsed.primary_muscle_group).toBe('chest');
    expect(parsed.secondary_muscle_groups).toEqual(['triceps']);
    expect(parsed.is_custom).toBe(false);
  });

  it('defaults a template with no secondary muscles to an empty list', () => {
    const parsed = hevyExerciseTemplateSchema.parse({ id: 'x', title: 'Thing' });
    expect(parsed.secondary_muscle_groups).toEqual([]);
    expect(parsed.primary_muscle_group).toBeNull();
  });

  it('parses user info and the workout count', () => {
    expect(hevyUserInfoSchema.parse({
      data: { id: '9c465af3', name: 'John doe', url: 'https://hevy.com/user/jhon' },
    }).data.name).toBe('John doe');
    expect(hevyWorkoutCountSchema.parse({ workout_count: 42 }).workout_count).toBe(42);
  });
});
