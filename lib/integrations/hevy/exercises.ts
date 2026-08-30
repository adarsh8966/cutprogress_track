/**
 * Deciding which CUT OS exercise a Hevy exercise IS.
 *
 * THE STAKES, BECAUSE THEY DECIDE THE RULE. Exercise identity is the foundation
 * of every progression chart, every estimated 1RM and every personal record in
 * this system. The two ways to get it wrong are not symmetrical:
 *
 *   A WRONG SPLIT costs a duplicate row. Both halves are correct, both are
 *   visible, and they can be joined later.
 *
 *   A WRONG MERGE fuses two movements' histories, permanently. Once sets are
 *   attributed to the wrong exercise there is nothing left to separate them by;
 *   the e1RM curve of a machine press and a dumbbell press become one line that
 *   was never true of either.
 *
 * So this matcher is biased all the way towards splitting, and there is NO
 * fuzzy matching anywhere in it. "Chest Press" does not adopt "Machine Chest
 * Press". "Bench Press (Barbell)" does not adopt "Barbell Bench Press". Both
 * create a new exercise, which is visible in the sync summary and fixable by
 * hand, rather than silently merging months of training.
 *
 * The order is:
 *
 *   1. stable external id     -> reuse. The steady state, and exact by nature.
 *   2. EXACT normalised name  -> adopt, once, permanently.
 *   3. otherwise              -> create.
 *
 * Step 2 exists so the first sync does not duplicate the whole seeded catalog,
 * and it is deliberately the narrowest rule that achieves that. It also refuses
 * in two more cases: an ambiguous match (two catalog rows normalising alike is
 * a coin flip on months of history) and a row already claimed by a different
 * external id.
 */
import type { Exercise } from '@/lib/health/catalog';
import type { HevyExerciseTemplate } from './types';

export const HEVY_SOURCE = 'HEVY';

/**
 * A name reduced to the form two spellings of the SAME name share.
 *
 * Case, hyphens, underscores, slashes and punctuation only. No parenthetical
 * stripping, no token reordering, no stemming, no synonyms, no edit distance -
 * every one of those would let two different movements normalise alike.
 *
 *   "Cable Pull-Through"  ->  "cable pull through"   (same movement, matches)
 *   "Bench Press (Barbell)" -> "bench press barbell" (order differs from
 *                                                     "barbell bench press",
 *                                                     so it does NOT match)
 */
export function normaliseExerciseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[-_/]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A slug for a new exercise row.
 *
 * exercise_id is the primary key workout_sets reference, and 0004 documents it
 * as "a stable human-readable slug so that re-seeding an updated catalog never
 * orphans historical workout_sets". The catalog's own schema requires
 * ^[a-z0-9-]+$, so this produces exactly that or falls back to the template id,
 * which is stable even when a title is entirely emoji.
 */
export function slugifyExerciseId(title: string, templateId: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug !== '') return slug;
  const fallback = templateId.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `hevy-exercise-${fallback || 'unnamed'}`;
}

/** A slug nothing else has taken, by numbering rather than by overwriting. */
export function uniqueExerciseId(preferred: string, taken: Set<string>): string {
  if (!taken.has(preferred)) return preferred;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${preferred}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  /* c8 ignore next */
  throw new Error(`could not find a free exercise id for "${preferred}"`);
}

export type ExerciseMatch =
  /** Already linked to this template. Nothing to write. */
  | { kind: 'LINKED'; exerciseId: string }
  /** An exactly-named row that nothing external has claimed. Link it. */
  | { kind: 'ADOPT'; exerciseId: string }
  /** No safe answer exists. Create, and say so in the summary. */
  | { kind: 'CREATE'; reason: 'NO_MATCH' | 'AMBIGUOUS' | 'ALREADY_CLAIMED' };

/**
 * A candidate row, as little of it as the decision needs.
 *
 * Deliberately not ExerciseRow: matching depends on the name and the external
 * identity and on nothing else, and a narrower input is a narrower thing to
 * get wrong.
 */
export interface ExerciseCandidate {
  exerciseId: string;
  name: string;
  externalSource: string | null;
  externalId: string | null;
}

export function matchExercise(
  template: { id: string; title: string },
  candidates: ExerciseCandidate[],
): ExerciseMatch {
  // 1. The stable id. Exact by nature, and the only rule that runs once the
  //    first sync has linked everything up.
  const linked = candidates.find(
    (c) => c.externalSource === HEVY_SOURCE && c.externalId === template.id,
  );
  if (linked) return { kind: 'LINKED', exerciseId: linked.exerciseId };

  // 2. The exact name, and only the exact name.
  const wanted = normaliseExerciseName(template.title);
  if (wanted === '') return { kind: 'CREATE', reason: 'NO_MATCH' };

  const named = candidates.filter((c) => normaliseExerciseName(c.name) === wanted);
  if (named.length === 0) return { kind: 'CREATE', reason: 'NO_MATCH' };

  // Two rows sharing a normalised name is a coin flip on months of history.
  // Refusing costs a duplicate; guessing costs the ability to tell them apart.
  if (named.length > 1) return { kind: 'CREATE', reason: 'AMBIGUOUS' };

  const only = named[0]!;
  // Already another template's exercise. Adopting it would fuse two Hevy
  // movements into one CUT OS row - the wrong merge, arrived at sideways.
  if (only.externalId !== null && only.externalId !== template.id) {
    return { kind: 'CREATE', reason: 'ALREADY_CLAIMED' };
  }

  return { kind: 'ADOPT', exerciseId: only.exerciseId };
}

/**
 * Hevy's muscle-group and equipment words in CUT OS's.
 *
 * BEST EFFORT, AND SAFE WHEN IT MISSES. The published documentation gives the
 * SIZE of the MuscleGroup (20) and EquipmentCategory (9) enums but not their
 * members, so these tables cover the values the catalog's own taxonomy already
 * has an opinion about - CUT OS files a lat pulldown under "Back" with "Lats"
 * as a subgroup, so `lats` -> `Back` follows the catalog rather than inventing
 * a scheme. Anything unmapped is title-cased and stored verbatim: both columns
 * are free text, so an unknown group becomes a visible new group rather than a
 * lost one or a wrong one.
 */
const MUSCLE_GROUP: Record<string, string> = {
  abdominals: 'Core', abs: 'Core', core: 'Core', obliques: 'Core',
  quadriceps: 'Quadriceps', quads: 'Quadriceps',
  hamstrings: 'Hamstrings',
  glutes: 'Glutes',
  calves: 'Calves',
  chest: 'Chest',
  shoulders: 'Shoulders', delts: 'Shoulders',
  biceps: 'Biceps',
  triceps: 'Triceps',
  forearms: 'Forearms',
  lats: 'Back', upper_back: 'Back', lower_back: 'Back', traps: 'Back', back: 'Back',
  cardio: 'Cardio',
};

const EQUIPMENT: Record<string, string> = {
  barbell: 'Barbell',
  dumbbell: 'Dumbbell',
  machine: 'Machine',
  cable: 'Cable',
  bodyweight: 'Bodyweight',
  none: 'Bodyweight',
  smith_machine: 'Smith Machine',
};

/** Title Case, for a word this app has no mapping for. Never dropped. */
export function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .filter((word) => word !== '')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/**
 * What to store when the template could not be read at all.
 *
 * primary_muscle_group and equipment are NOT NULL in the catalog, and the
 * workout payload carries neither - only /v1/exercise_templates does. When that
 * lookup fails, the choice is between losing the workout and storing a word
 * that says the truth. "Unspecified" is not a guessed muscle group; it is the
 * absence of one, written where the schema requires a string. A later sync
 * fills it in, and the writer never overwrites a known value with this.
 */
export const UNSPECIFIED = 'Unspecified';

/**
 * A new exercise row from a Hevy template.
 *
 * apartmentGym is TRUE, and that is evidence rather than an assumption: this
 * exercise is being created because the user performed it. A movement they
 * actually did is a movement they can do with the equipment they have, and
 * marking it false would hide it from the picker on lib/data/queries.ts's
 * apartment-gym filter - an exercise present in every chart and absent from the
 * one control for choosing it.
 *
 * nippardTier is null. The tiers are not sourced in this repository and are not
 * invented here (CLAUDE.md, lib/health/catalog.ts).
 */
export function exerciseFromTemplate(
  template: HevyExerciseTemplate | null,
  fallback: { templateId: string; title: string },
  exerciseId: string,
): Exercise {
  const muscle = template?.primary_muscle_group ?? null;
  const equipment = template?.equipment_category ?? null;

  return {
    exerciseId,
    name: template?.title?.trim() || fallback.title,
    primaryMuscleGroup: muscle === null
      ? UNSPECIFIED
      : MUSCLE_GROUP[muscle.toLowerCase()] ?? titleCase(muscle),
    equipment: equipment === null
      ? UNSPECIFIED
      : EQUIPMENT[equipment.toLowerCase()] ?? titleCase(equipment),
    nippardTier: null,
    muscleSubgroups: (template?.secondary_muscle_groups ?? []).map(
      (group) => MUSCLE_GROUP[group.toLowerCase()] ?? titleCase(group),
    ),
    demonstrationUrl: null,
    active: true,
    apartmentGym: true,
  };
}
