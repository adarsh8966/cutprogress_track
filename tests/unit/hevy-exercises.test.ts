/**
 * Exercise matching, and the refusals that are the point of it.
 *
 * Exercise identity is the foundation of every progression chart, e1RM and PR
 * in this system, and the two failure modes are not symmetrical. A wrong SPLIT
 * costs a duplicate row: both halves correct, both visible, joinable later. A
 * wrong MERGE fuses two movements' histories permanently - once sets are
 * attributed to the wrong exercise, nothing is left to separate them by.
 *
 * So most of this file asserts what the matcher DOES NOT do.
 */
import { describe, it, expect } from 'vitest';
import {
  matchExercise, normaliseExerciseName, slugifyExerciseId, uniqueExerciseId,
  exerciseFromTemplate, titleCase, UNSPECIFIED,
  type ExerciseCandidate,
} from '@/lib/integrations/hevy/exercises';

function candidate(overrides: Partial<ExerciseCandidate> = {}): ExerciseCandidate {
  return {
    exerciseId: 'barbell-bench-press',
    name: 'Barbell Bench Press',
    externalSource: null,
    externalId: null,
    ...overrides,
  };
}

describe('normaliseExerciseName', () => {
  it('ignores case, hyphens, underscores, slashes and stray punctuation', () => {
    expect(normaliseExerciseName('Cable Pull-Through'))
      .toBe(normaliseExerciseName('cable pull through'));
    expect(normaliseExerciseName('Step-Up')).toBe(normaliseExerciseName('step up'));
    expect(normaliseExerciseName('  Cable   Row  ')).toBe('cable row');
  });

  it('does NOT reorder words, so a reordered name is a different name', () => {
    // This is the rule the whole matcher rests on.
    expect(normaliseExerciseName('Bench Press (Barbell)'))
      .not.toBe(normaliseExerciseName('Barbell Bench Press'));
  });

  it('does NOT drop words, so a qualifier makes it a different exercise', () => {
    expect(normaliseExerciseName('Chest Press'))
      .not.toBe(normaliseExerciseName('Machine Chest Press'));
  });
});

describe('matchExercise', () => {
  it('reuses the row already linked to this template', () => {
    const rows = [
      candidate({ exerciseId: 'cable-row', name: 'Cable Row' }),
      candidate({
        exerciseId: 'cable-lateral-raise',
        name: 'Cable Lateral Raise',
        externalSource: 'HEVY',
        externalId: 'TEMPLATE-1',
      }),
    ];
    expect(matchExercise({ id: 'TEMPLATE-1', title: 'Anything At All' }, rows))
      .toEqual({ kind: 'LINKED', exerciseId: 'cable-lateral-raise' });
  });

  it('survives a rename at the source, because the id is what matches', () => {
    const rows = [candidate({
      exerciseId: 'cable-row', name: 'Cable Row',
      externalSource: 'HEVY', externalId: 'TEMPLATE-1',
    })];
    // Renaming an exercise in Hevy must not fork it into a duplicate.
    expect(matchExercise({ id: 'TEMPLATE-1', title: 'Seated Cable Row v2' }, rows))
      .toEqual({ kind: 'LINKED', exerciseId: 'cable-row' });
  });

  it('adopts an exactly-named catalog row rather than duplicating it', () => {
    const rows = [candidate({ exerciseId: 'cable-row', name: 'Cable Row' })];
    expect(matchExercise({ id: 'TEMPLATE-9', title: 'cable row' }, rows))
      .toEqual({ kind: 'ADOPT', exerciseId: 'cable-row' });
  });

  // ------------------------------------------------------------------ refusals

  it('does NOT adopt on a reordered name', () => {
    // The reported example. "Bench Press (Barbell)" is not "Barbell Bench Press".
    const rows = [candidate()];
    expect(matchExercise({ id: 'T', title: 'Bench Press (Barbell)' }, rows))
      .toEqual({ kind: 'CREATE', reason: 'NO_MATCH' });
  });

  it.each([
    'Machine Chest Press',
    'Seated Chest Press',
    'Plate Loaded Chest Press',
  ])('does NOT adopt "%s" for a Hevy exercise called "Chest Press"', (name) => {
    // Deciding these are the same movement would poison the history of all of
    // them, and the e1RM curve would be a line that was never true of any.
    const rows = [candidate({ exerciseId: 'x', name })];
    expect(matchExercise({ id: 'T', title: 'Chest Press' }, rows))
      .toEqual({ kind: 'CREATE', reason: 'NO_MATCH' });
  });

  it('refuses to choose when two rows normalise to the same name', () => {
    const rows = [
      candidate({ exerciseId: 'cable-row-a', name: 'Cable Row' }),
      candidate({ exerciseId: 'cable-row-b', name: 'cable-row' }),
    ];
    // A coin flip on months of history is worse than a duplicate.
    expect(matchExercise({ id: 'T', title: 'Cable Row' }, rows))
      .toEqual({ kind: 'CREATE', reason: 'AMBIGUOUS' });
  });

  it('refuses a row another template has already claimed', () => {
    const rows = [candidate({
      exerciseId: 'cable-row', name: 'Cable Row',
      externalSource: 'HEVY', externalId: 'SOME-OTHER-TEMPLATE',
    })];
    // Adopting it would fuse two Hevy movements into one CUT OS row.
    expect(matchExercise({ id: 'TEMPLATE-1', title: 'Cable Row' }, rows))
      .toEqual({ kind: 'CREATE', reason: 'ALREADY_CLAIMED' });
  });

  it('creates when the catalog is empty', () => {
    expect(matchExercise({ id: 'T', title: 'Cable Row' }, []))
      .toEqual({ kind: 'CREATE', reason: 'NO_MATCH' });
  });

  it('creates when the title normalises to nothing at all', () => {
    expect(matchExercise({ id: 'T', title: '💪' }, [candidate()]))
      .toEqual({ kind: 'CREATE', reason: 'NO_MATCH' });
  });
});

describe('slugifyExerciseId', () => {
  it('produces the lowercase slug the catalog schema requires', () => {
    expect(slugifyExerciseId('Cable Lateral Raise', 'T')).toBe('cable-lateral-raise');
    expect(slugifyExerciseId('Bench Press (Barbell)', 'T')).toBe('bench-press-barbell');
    expect(slugifyExerciseId('Step-Up', 'T')).toBe('step-up');
    for (const title of ['Cable Lateral Raise', 'Bench Press (Barbell)', 'Step-Up']) {
      expect(slugifyExerciseId(title, 'T')).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('falls back to the stable template id when a title has no letters', () => {
    const slug = slugifyExerciseId('💪🔥', 'D04AC939');
    expect(slug).toBe('hevy-exercise-d04ac939');
    expect(slug).toMatch(/^[a-z0-9-]+$/);
  });

  it('numbers a taken slug instead of overwriting the row that has it', () => {
    const taken = new Set(['cable-row', 'cable-row-2']);
    expect(uniqueExerciseId('cable-row', taken)).toBe('cable-row-3');
    expect(uniqueExerciseId('cable-flye', taken)).toBe('cable-flye');
  });
});

describe('exerciseFromTemplate', () => {
  const template = {
    id: 'D04AC939',
    title: 'Cable Lateral Raise',
    type: 'weight_reps',
    primary_muscle_group: 'shoulders',
    secondary_muscle_groups: ['triceps'],
    equipment_category: 'cable',
    is_custom: false,
  };

  it('maps Hevy vocabulary into the catalog’s own', () => {
    const exercise = exerciseFromTemplate(
      template, { templateId: 'D04AC939', title: 'Cable Lateral Raise' },
      'cable-lateral-raise',
    );
    expect(exercise).toMatchObject({
      exerciseId: 'cable-lateral-raise',
      name: 'Cable Lateral Raise',
      primaryMuscleGroup: 'Shoulders',
      equipment: 'Cable',
      muscleSubgroups: ['Triceps'],
      active: true,
    });
  });

  it('follows the catalog’s own taxonomy where it has one', () => {
    // CUT OS files a lat pulldown under Back with Lats as a subgroup, so this
    // follows the catalog rather than inventing a second scheme.
    expect(exerciseFromTemplate(
      { ...template, primary_muscle_group: 'lats' },
      { templateId: 'T', title: 'x' }, 'x',
    ).primaryMuscleGroup).toBe('Back');
  });

  it('keeps an unmapped group verbatim instead of losing or guessing it', () => {
    // The documentation gives the size of these enums and not their members, so
    // an unknown value must become a visible new group, never a wrong one.
    expect(exerciseFromTemplate(
      { ...template, primary_muscle_group: 'abductors' },
      { templateId: 'T', title: 'x' }, 'x',
    ).primaryMuscleGroup).toBe('Abductors');
    expect(exerciseFromTemplate(
      { ...template, equipment_category: 'resistance_band' },
      { templateId: 'T', title: 'x' }, 'x',
    ).equipment).toBe('Resistance Band');
  });

  it('never guesses a tier', () => {
    expect(exerciseFromTemplate(
      template, { templateId: 'T', title: 'x' }, 'x',
    ).nippardTier).toBeNull();
  });

  it('marks it performable, because the user demonstrably performed it', () => {
    // Not an assumption: this exercise exists because it appeared in a workout
    // that was done. Marking it false would hide it from the picker.
    expect(exerciseFromTemplate(
      template, { templateId: 'T', title: 'x' }, 'x',
    ).apartmentGym).toBe(true);
  });

  it('says Unspecified when the template could not be read at all', () => {
    // Not a guessed muscle group - the absence of one, written where the schema
    // requires a string. Losing the whole workout would be the worse failure.
    const exercise = exerciseFromTemplate(
      null, { templateId: 'D04AC939', title: 'Cable Lateral Raise' },
      'cable-lateral-raise',
    );
    expect(exercise.name).toBe('Cable Lateral Raise');
    expect(exercise.primaryMuscleGroup).toBe(UNSPECIFIED);
    expect(exercise.equipment).toBe(UNSPECIFIED);
    expect(exercise.muscleSubgroups).toEqual([]);
  });

  it('title-cases a word it has no mapping for', () => {
    expect(titleCase('lower_back')).toBe('Lower Back');
    expect(titleCase('SMITH-MACHINE')).toBe('Smith Machine');
  });
});
