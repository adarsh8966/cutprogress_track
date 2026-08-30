/**
 * What the Hevy integration is STRUCTURALLY unable to do.
 *
 * The brief is emphatic that Hevy owns training and nothing else: not body
 * weight, body fat, waist, any body measurement, active calories, steps, heart
 * rate, HRV, sleep, nutrition or water. Hevy's API serves several of those -
 * /v1/body_measurements alone carries weight, lean mass, fat percent, waist,
 * hips and every limb - so "we simply won't import them" is a promise, and a
 * promise is not a mechanism.
 *
 * These are the mechanisms, at three independent levels:
 *
 *   1. THE CLIENT has no method for it, and no write method at all
 *      (tests/unit/hevy-client.test.ts).
 *   2. THE MAPPER'S OUTPUT TYPE has no field for it, so a body measurement
 *      read from a payload is a value with nowhere to go. Asserted here.
 *   3. NO MODULE in the integration names a health table, so nothing can reach
 *      one by writing SQL around the type. Asserted here.
 *
 * Level 3 is a source-level test, in the same spirit as
 * tests/unit/coverage-states.test.ts: a structural rule the build refuses to
 * ship a violation of, rather than one a reviewer has to notice.
 *
 * Comments are stripped before reading. This file's own subjects explain, in
 * prose, which tables they never touch - so a grep over raw text would find
 * `body_measurements` in the paragraph promising never to write it.
 */
import { describe, it, expect } from 'vitest';
import { codeOf, filesUnder } from '../helpers/source';
import { mapWorkout } from '@/lib/integrations/hevy/mapper';
import { hevyWorkoutSchema } from '@/lib/integrations/hevy/types';

/** Every table Hevy must never be a source for. */
const FORBIDDEN_TABLES = [
  'body_measurements',
  'metric_observations',
  'nutrition_logs',
  'nutrition_items',
  'sleep_records',
  'cardio_sessions',
  'daily_scores',
];

/** The measurements themselves, by the name a column or field would use. */
const FORBIDDEN_FIELDS = [
  'weight_kg', 'weightkg', 'bodyweight', 'body_weight',
  'fat_percent', 'bodyfat', 'lean_mass',
  'waist', 'hips', 'neck_cm', 'chest_cm', 'bicep', 'thigh', 'calf_cm',
  'steps', 'active_calories', 'activecalories',
  'heart_rate', 'heartrate', 'hrv', 'resting_heart',
  'sleep', 'calories_consumed', 'protein', 'carbs', 'fiber', 'water',
];

const INTEGRATION_FILES = filesUnder('lib/integrations/hevy');

describe('the Hevy integration cannot reach health data', () => {
  it('has files to check at all', () => {
    // A guard that silently checks nothing is worse than no guard.
    expect(INTEGRATION_FILES.length).toBeGreaterThan(3);
  });

  it.each(INTEGRATION_FILES)('%s names no health table', (file) => {
    const code = codeOf(file);
    for (const table of FORBIDDEN_TABLES) {
      expect(
        code,
        `${file} references ${table}. Hevy is the source for TRAINING only: `
        + 'workout_sessions, workout_sets and exercises. If this is deliberate, '
        + 'it is a change to what Hevy owns and belongs in the brief first.',
      ).not.toContain(table);
    }
  });

  it('reads /v1/body_measurements nowhere, though Hevy serves it', () => {
    for (const file of INTEGRATION_FILES) {
      expect(codeOf(file)).not.toContain('body_measurements');
    }
  });

  it('writes nothing back to Hevy from anywhere in the integration', () => {
    // One-way by construction: Hevy -> CUT OS, never the reverse. A two-way
    // sync is a loop, and CUT OS corrections must never leave for Hevy.
    for (const file of INTEGRATION_FILES) {
      const code = codeOf(file);
      for (const verb of ["method: 'POST'", "method: 'PUT'", "method: 'PATCH'", "method: 'DELETE'"]) {
        expect(code, `${file} issues a ${verb}`).not.toContain(verb);
      }
    }
  });
});

describe('the mapper’s output type has nowhere to put body data', () => {
  /**
   * A payload carrying every forbidden measurement, shaped as Hevy might if it
   * ever added them to a workout. Unknown keys are dropped by the schema, so
   * this asserts the whole chain: nothing survives parsing, and nothing the
   * mapper emits could carry it if it did.
   */
  const CONTAMINATED = {
    id: 'workout-1',
    title: 'Push Day',
    description: 'note',
    start_time: '2026-08-29T22:00:00Z',
    end_time: '2026-08-29T23:04:00Z',
    updated_at: '2026-08-29T23:05:00Z',
    created_at: '2026-08-29T22:00:00Z',
    // None of this is Hevy's documented workout shape. It is here to be ignored.
    weight_kg: 92.4,
    body_fat_percent: 18.5,
    waist_cm: 88,
    steps: 15000,
    active_calories: 640,
    resting_heart_rate: 48,
    hrv_ms: 62,
    sleep_minutes: 431,
    calories_consumed: 2001,
    exercises: [{
      index: 0, title: 'Bench', notes: null,
      exercise_template_id: 'T', supersets_id: null,
      sets: [{ index: 0, type: 'normal', weight_kg: 60, reps: 5 }],
    }],
  };

  it('drops every body field at the schema, before the mapper ever sees it', () => {
    const parsed = hevyWorkoutSchema.parse(CONTAMINATED) as Record<string, unknown>;
    for (const key of [
      'weight_kg', 'body_fat_percent', 'waist_cm', 'steps', 'active_calories',
      'resting_heart_rate', 'hrv_ms', 'sleep_minutes', 'calories_consumed',
    ]) {
      expect(key in parsed, `${key} survived parsing`).toBe(false);
    }
  });

  it('emits a workout whose every key belongs to training', () => {
    const { workout } = mapWorkout(
      hevyWorkoutSchema.parse(CONTAMINATED), { timezone: 'America/New_York' },
    );

    // Serialising the whole thing catches a forbidden value nested anywhere -
    // on the workout, an exercise or a set - not only at the top level.
    const serialised = JSON.stringify(workout).toLowerCase();

    // `weight_kg` on a SET is the load on the bar and is exactly right; the
    // mapper's own field for it is weightKg, so the snake_case column name of
    // a body measurement must not appear anywhere.
    for (const field of FORBIDDEN_FIELDS) {
      if (field === 'weightkg') continue;
      expect(serialised, `a mapped workout carries "${field}"`).not.toContain(field);
    }

    // And the top-level shape is exactly the training fields, no more.
    expect(Object.keys(workout).sort()).toEqual([
      'durationMinutes', 'endTime', 'exercises', 'externalId', 'externalUpdatedAt',
      'localDate', 'notes', 'sessionType', 'startTime', 'title',
    ]);
  });

  it('emits sets whose shape is exactly the training fields', () => {
    const { workout } = mapWorkout(
      hevyWorkoutSchema.parse(CONTAMINATED), { timezone: 'America/New_York' },
    );
    expect(Object.keys(workout.exercises[0]!.sets[0]!).sort()).toEqual([
      'distanceKm', 'durationSeconds', 'reps', 'rpe', 'setNumber', 'setType',
      'warmup', 'weightKg',
    ]);
  });
});
