/**
 * The shapes the Hevy API returns, validated rather than trusted.
 *
 * Every boundary in this codebase parses its input (the paste importer, every
 * server action), and an HTTP response from someone else's service is the least
 * trustworthy boundary there is. A field Hevy renames must fail loudly here,
 * where the sync can report it, rather than arriving as `undefined` and being
 * written as "not recorded" - which is the same silent-data-loss failure spec
 * §33 exists to prevent, just sourced from further away.
 *
 * WHAT IS AND IS NOT DECLARED HERE. These schemas describe the documented
 * response shapes and nothing else. Where the published documentation elides an
 * enum's members - `Set.type` shows `[...]`, and the MuscleGroup and
 * EquipmentCategory enums give counts but not values - the field is typed as a
 * plain string and carried verbatim. Inventing the members would be guessing at
 * an API contract, and a wrong guess about `type` in particular would decide
 * whether a set counts towards training volume.
 *
 * Unknown keys are dropped by Zod's default, which is what we want: a field
 * Hevy ADDS must not break a sync. Nothing is lost by it either - the raw
 * response body is stored verbatim in health_imports (§17), so anything not
 * modelled here can be re-derived later without asking Hevy again.
 *
 * NOTE ON WHAT IS ABSENT. There is no body-measurement schema in this file, and
 * there is no request-body schema of any kind. Hevy's API exposes both; this
 * integration imports training and only training, and writes nothing back.
 */
import { z } from 'zod';

/**
 * A value that may be null, may be missing, and means the same thing either
 * way: not recorded. Normalised to null so nothing downstream has to ask which
 * kind of absence it is looking at.
 */
const nullish = <T extends z.ZodTypeAny>(schema: T) =>
  schema.nullish().transform((value) => value ?? null);

/**
 * An instant, as text.
 *
 * Checked for parseability rather than pattern-matched: the documentation shows
 * `2021-09-14T12:00:00Z`, and a timestamp this fails on is a genuine surprise
 * worth reporting rather than quietly reading as the epoch. Which local day a
 * workout belongs to is decided later, in the profile's timezone (§40).
 */
const instant = z.string().refine(
  (value) => !Number.isNaN(Date.parse(value)),
  'not a parseable timestamp',
);

export const hevySetSchema = z.object({
  index: z.number().int().nonnegative(),
  /** Hevy's own word for the set. Verbatim; see the header. */
  type: nullish(z.string()),
  weight_kg: nullish(z.number()),
  reps: nullish(z.number()),
  distance_meters: nullish(z.number()),
  duration_seconds: nullish(z.number()),
  rpe: nullish(z.number()),
  /** Documented as a number with no unit and no stated meaning. Not mapped. */
  custom_metric: nullish(z.number()),
});

export const hevyExerciseSchema = z.object({
  index: z.number().int().nonnegative(),
  title: z.string(),
  notes: nullish(z.string()),
  exercise_template_id: z.string().min(1),
  /** Spelled `supersets_id` in responses and `superset_id` in request bodies. */
  supersets_id: nullish(z.number()),
  sets: z.array(hevySetSchema),
});

export const hevyWorkoutSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  routine_id: nullish(z.string()),
  /** THE WORKOUT NOTE. Hevy calls it `description`; there is no `notes` field. */
  description: nullish(z.string()),
  start_time: instant,
  // Documented as present on every example, but a workout still being written
  // has no end yet, and a duration derived from a missing end is not a duration.
  end_time: nullish(instant),
  updated_at: instant,
  created_at: instant,
  exercises: z.array(hevyExerciseSchema),
});

export const hevyWorkoutEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('updated'), workout: hevyWorkoutSchema }),
  z.object({
    type: z.literal('deleted'),
    id: z.string().min(1),
    deleted_at: nullish(instant),
  }),
]);

export const hevyWorkoutEventsPageSchema = z.object({
  page: z.number().int().positive(),
  page_count: z.number().int().nonnegative(),
  events: z.array(hevyWorkoutEventSchema),
});

export const hevyWorkoutCountSchema = z.object({
  workout_count: z.number().int().nonnegative(),
});

export const hevyExerciseTemplateSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  type: nullish(z.string()),
  primary_muscle_group: nullish(z.string()),
  secondary_muscle_groups: z.array(z.string()).nullish()
    .transform((value) => value ?? []),
  equipment_category: nullish(z.string()),
  is_custom: z.boolean().nullish().transform((value) => value ?? false),
});

export const hevyExerciseTemplatesPageSchema = z.object({
  page: z.number().int().positive(),
  page_count: z.number().int().nonnegative(),
  exercise_templates: z.array(hevyExerciseTemplateSchema),
});

export const hevyUserInfoSchema = z.object({
  data: z.object({
    id: z.string().min(1),
    name: nullish(z.string()),
    url: nullish(z.string()),
  }),
});

export type HevySet = z.infer<typeof hevySetSchema>;
export type HevyExercise = z.infer<typeof hevyExerciseSchema>;
export type HevyWorkout = z.infer<typeof hevyWorkoutSchema>;
export type HevyWorkoutEvent = z.infer<typeof hevyWorkoutEventSchema>;
export type HevyWorkoutEventsPage = z.infer<typeof hevyWorkoutEventsPageSchema>;
export type HevyExerciseTemplate = z.infer<typeof hevyExerciseTemplateSchema>;
export type HevyUserInfo = z.infer<typeof hevyUserInfoSchema>['data'];

/**
 * Documented page-size ceilings. Asking for more is answered with 400 "Invalid
 * page size", so the client clamps rather than letting a caller's arithmetic
 * turn into a failed sync.
 */
export const MAX_PAGE_SIZE = {
  workoutEvents: 10,
  workouts: 10,
  exerciseTemplates: 100,
} as const;
