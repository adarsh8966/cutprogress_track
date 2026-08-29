/**
 * Exercise catalog loading and validation (spec §10).
 *
 * The catalog in data/exercises/catalog.json is the canonical library. It is
 * validated on load rather than trusted, so a malformed hand-edit or a bad
 * third-party import fails loudly instead of seeding nonsense into the database.
 *
 * nippardTier is null throughout the shipped catalog. The tier ratings come
 * from Jeff Nippard's published catalog, which is not in this repository, and
 * spec §48 forbids fabricating data - a guessed tier would be indistinguishable
 * from a sourced one. Run scripts/import-catalog.ts against the real file to
 * fill them in; exerciseId is a stable slug, so re-seeding preserves history.
 */
import { z } from 'zod';
import catalogJson from '@/data/exercises/catalog.json';

export const exerciseSchema = z.object({
  exerciseId: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'exerciseId must be a lowercase slug'),
  name: z.string().min(1),
  primaryMuscleGroup: z.string().min(1),
  equipment: z.string().min(1),
  nippardTier: z.enum(['S', 'A', 'B', 'C']).nullable(),
  muscleSubgroups: z.array(z.string().min(1)),
  demonstrationUrl: z.string().url().nullable(),
  active: z.boolean(),
  apartmentGym: z.boolean(),
});

export type Exercise = z.infer<typeof exerciseSchema>;

export const catalogSchema = z
  .array(exerciseSchema)
  .min(1)
  .superRefine((exercises, ctx) => {
    const seen = new Set<string>();
    for (const exercise of exercises) {
      if (seen.has(exercise.exerciseId)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate exerciseId: ${exercise.exerciseId}`,
        });
      }
      seen.add(exercise.exerciseId);
    }
  });

let cached: Exercise[] | null = null;

export function loadCatalog(): Exercise[] {
  if (cached === null) cached = catalogSchema.parse(catalogJson);
  return cached;
}

export function activeExercises(): Exercise[] {
  return loadCatalog().filter((e) => e.active);
}

/** The subset performable with the user's apartment gym equipment (spec §1). */
export function apartmentGymExercises(): Exercise[] {
  return activeExercises().filter((e) => e.apartmentGym);
}

export function findExercise(exerciseId: string): Exercise | null {
  return loadCatalog().find((e) => e.exerciseId === exerciseId) ?? null;
}

export function muscleGroups(): string[] {
  return [...new Set(activeExercises().map((e) => e.primaryMuscleGroup))].sort();
}

export function equipmentTypes(): string[] {
  return [...new Set(activeExercises().map((e) => e.equipment))].sort();
}

/** Case-insensitive name search, used by the workout logger's picker. */
export function searchExercises(query: string, apartmentOnly = false): Exercise[] {
  const needle = query.trim().toLowerCase();
  const pool = apartmentOnly ? apartmentGymExercises() : activeExercises();
  if (needle === '') return pool;
  return pool.filter(
    (e) =>
      e.name.toLowerCase().includes(needle) ||
      e.primaryMuscleGroup.toLowerCase().includes(needle) ||
      e.equipment.toLowerCase().includes(needle) ||
      e.muscleSubgroups.some((m) => m.toLowerCase().includes(needle)),
  );
}
