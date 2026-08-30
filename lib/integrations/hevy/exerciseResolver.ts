import 'server-only';

/**
 * Turning a Hevy exercise into a CUT OS exercise_id, once per run.
 *
 * WHY THIS IS AN OBJECT AND NOT A FUNCTION. Resolution needs the whole exercise
 * library to answer "is this already here?", and a workout mentions five or six
 * exercises. Reading the library per exercise would be a hundred round trips on
 * a backfill for an answer that does not change between them. So the library is
 * read once, kept, and updated in place as rows are created - which also makes
 * the slug-collision check correct WITHIN a run, not only against what was on
 * disk when it started.
 *
 * THE MATCHING RULE ITSELF IS PURE and lives in ./exercises.ts, where it is
 * tested exhaustively. This file is only the I/O around it: read the library,
 * ask, then create or adopt.
 *
 * TEMPLATES ARE FETCHED LAZILY AND ONCE. A new exercise needs a muscle group
 * and equipment, which are NOT NULL in the catalog and are carried by
 * /v1/exercise_templates rather than by the workout payload. An account whose
 * exercises are all known never makes that request at all.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/supabase/types';
import type { HevyClient } from './client';
import type { HevyExerciseTemplate } from './types';
import {
  matchExercise, slugifyExerciseId, uniqueExerciseId, exerciseFromTemplate,
  HEVY_SOURCE, UNSPECIFIED, type ExerciseCandidate,
} from './exercises';

type Client = SupabaseClient<Database>;

export type ResolveResult =
  | { ok: true; exerciseId: string; created: boolean; warnings: string[] }
  | { ok: false; message: string };

export interface ExerciseResolver {
  resolve(template: { id: string; title: string }): Promise<ResolveResult>;
  readonly created: number;
  readonly matched: number;
  /** Names of exercises this run created, so the summary can list them. */
  readonly createdNames: string[];
}

export async function createExerciseResolver(
  supabase: Client,
  api: Pick<HevyClient, 'listExerciseTemplates' | 'getExerciseTemplate'>,
): Promise<ExerciseResolver | { error: string }> {
  const library = await supabase
    .from('exercises')
    .select('exercise_id, name, external_source, external_id');
  if (library.error) return { error: library.error.message };

  const candidates: ExerciseCandidate[] = (library.data ?? []).map((row) => ({
    exerciseId: row.exercise_id,
    name: row.name,
    externalSource: row.external_source,
    externalId: row.external_id,
  }));
  const takenIds = new Set(candidates.map((c) => c.exerciseId));

  let templates: Map<string, HevyExerciseTemplate> | null = null;
  let created = 0;
  let matched = 0;
  const createdNames: string[] = [];

  /**
   * Every template on the account, read once.
   *
   * Page size is the documented ceiling for this endpoint (100), which is ten
   * times the workout endpoints', so even a large custom library is a couple of
   * requests. A failure is not fatal: templateFor() falls back to asking for
   * one template by id, and failing that the exercise is still created with its
   * name and an explicit "Unspecified" rather than being lost.
   */
  async function loadTemplates(): Promise<Map<string, HevyExerciseTemplate>> {
    if (templates !== null) return templates;
    const loaded = new Map<string, HevyExerciseTemplate>();
    try {
      let page = 1;
      let pageCount = 1;
      do {
        const result = await api.listExerciseTemplates({ page, pageSize: 100 });
        for (const template of result.templates) loaded.set(template.id, template);
        pageCount = result.pageCount;
        page += 1;
      } while (page <= pageCount && page <= 50);
    } catch {
      // Deliberately swallowed. The per-id fallback below is the next attempt,
      // and a workout must not be lost because a lookup endpoint was down.
    }
    templates = loaded;
    return loaded;
  }

  async function templateFor(id: string): Promise<HevyExerciseTemplate | null> {
    const all = await loadTemplates();
    const found = all.get(id);
    if (found) return found;
    try {
      return await api.getExerciseTemplate(id);
    } catch {
      return null;
    }
  }

  return {
    get created() { return created; },
    get matched() { return matched; },
    get createdNames() { return createdNames; },

    async resolve(template: { id: string; title: string }): Promise<ResolveResult> {
      const match = matchExercise(template, candidates);

      if (match.kind === 'LINKED') {
        matched += 1;
        return { ok: true, exerciseId: match.exerciseId, created: false, warnings: [] };
      }

      if (match.kind === 'ADOPT') {
        // Link the existing row rather than creating a second one. Only the two
        // identity columns are writable (0014's column grant), so this cannot
        // rewrite what the exercise is.
        const adopted = await supabase
          .from('exercises')
          .update({ external_source: HEVY_SOURCE, external_id: template.id })
          .eq('exercise_id', match.exerciseId);
        if (adopted.error) return { ok: false, message: adopted.error.message };

        const candidate = candidates.find((c) => c.exerciseId === match.exerciseId)!;
        candidate.externalSource = HEVY_SOURCE;
        candidate.externalId = template.id;
        matched += 1;
        return { ok: true, exerciseId: match.exerciseId, created: false, warnings: [] };
      }

      // CREATE. Splitting is the safe direction - a duplicate row is visible
      // and joinable, a wrong merge is neither - so the reason is reported
      // rather than swallowed, and the run names every exercise it created.
      const fetched = await templateFor(template.id);
      const exerciseId = uniqueExerciseId(
        slugifyExerciseId(template.title, template.id), takenIds,
      );
      const exercise = exerciseFromTemplate(
        fetched, { templateId: template.id, title: template.title }, exerciseId,
      );

      const inserted = await supabase.from('exercises').insert({
        exercise_id: exercise.exerciseId,
        name: exercise.name,
        primary_muscle_group: exercise.primaryMuscleGroup,
        equipment: exercise.equipment,
        nippard_tier: exercise.nippardTier,
        muscle_subgroups: exercise.muscleSubgroups,
        demonstration_url: exercise.demonstrationUrl,
        active: exercise.active,
        apartment_gym: exercise.apartmentGym,
        external_source: HEVY_SOURCE,
        external_id: template.id,
      });
      if (inserted.error) return { ok: false, message: inserted.error.message };

      takenIds.add(exerciseId);
      candidates.push({
        exerciseId,
        name: exercise.name,
        externalSource: HEVY_SOURCE,
        externalId: template.id,
      });
      created += 1;
      createdNames.push(exercise.name);

      const warnings: string[] = [];
      if (exercise.primaryMuscleGroup === UNSPECIFIED) {
        warnings.push(
          `Could not read Hevy's details for "${exercise.name}", so it was added `
          + 'with an unspecified muscle group and equipment. A later sync fills '
          + 'those in; the training itself was recorded in full.',
        );
      }
      if (match.reason === 'AMBIGUOUS') {
        warnings.push(
          `Added "${exercise.name}" as a new exercise: more than one existing `
          + 'exercise has that name, so which one it meant could not be established.',
        );
      }
      if (match.reason === 'ALREADY_CLAIMED') {
        warnings.push(
          `Added "${exercise.name}" as a new exercise: an exercise with that name `
          + 'is already linked to a different Hevy exercise.',
        );
      }

      return { ok: true, exerciseId, created: true, warnings };
    },
  };
}
