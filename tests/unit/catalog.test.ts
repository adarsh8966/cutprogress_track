import { describe, it, expect } from 'vitest';
import {
  loadCatalog, activeExercises, apartmentGymExercises, findExercise,
  muscleGroups, equipmentTypes, searchExercises, catalogSchema,
} from '@/lib/health/catalog';

describe('exercise catalog (spec §10)', () => {
  const catalog = loadCatalog();

  it('validates against the schema', () => {
    expect(() => catalogSchema.parse(catalog)).not.toThrow();
    expect(catalog.length).toBeGreaterThan(100);
  });

  it('contains every exercise the spec names', () => {
    for (const name of [
      'Hack Squat', 'Bulgarian Split Squat', 'Smith Machine Squat',
      'Machine Chest Press', 'Cable Row', 'Neutral-Grip Pulldown', 'Pull-Up',
      'Cable Lateral Raise', 'Bayesian Cable Curl',
      'Overhead Cable Triceps Extension', 'Cable Crunch', 'Hanging Leg Raise',
    ]) {
      expect(catalog.some((e) => e.name === name), `missing: ${name}`).toBe(true);
    }
  });

  it('has unique, slug-shaped ids', () => {
    const ids = catalog.map((e) => e.exerciseId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  it('leaves the Nippard tier unsourced rather than guessed (spec §48)', () => {
    // The tier ratings are not in this repository. A guessed tier would be
    // indistinguishable from a real one, so every entry is explicitly null
    // until the real catalog is imported.
    expect(catalog.every((e) => e.nippardTier === null)).toBe(true);
  });

  it('covers the apartment gym equipment set', () => {
    const apartment = apartmentGymExercises();
    expect(apartment.length).toBeGreaterThan(80);
    const equipment = new Set(apartment.map((e) => e.equipment));
    for (const item of ['Dumbbell', 'Cable', 'Smith Machine', 'Treadmill', 'Bodyweight']) {
      expect(equipment.has(item), `no apartment exercise uses ${item}`).toBe(true);
    }
  });

  it('excludes equipment the user does not have from the apartment subset', () => {
    for (const exercise of apartmentGymExercises()) {
      expect(['Barbell', 'Machine']).not.toContain(exercise.equipment);
    }
  });

  it('gives every muscle group at least one apartment-gym option', () => {
    const covered = new Set(apartmentGymExercises().map((e) => e.primaryMuscleGroup));
    for (const group of muscleGroups()) {
      expect(covered.has(group), `${group} has no apartment gym exercise`).toBe(true);
    }
  });

  it('assigns every exercise at least one muscle subgroup', () => {
    for (const exercise of catalog) {
      expect(exercise.muscleSubgroups.length, exercise.name).toBeGreaterThan(0);
    }
  });

  it('looks exercises up by id', () => {
    expect(findExercise('cable-row')?.name).toBe('Cable Row');
    expect(findExercise('not-a-real-exercise')).toBeNull();
  });

  it('searches by name, muscle group, equipment and subgroup', () => {
    expect(searchExercises('cable row').map((e) => e.exerciseId)).toContain('cable-row');
    expect(searchExercises('Back').length).toBeGreaterThan(5);
    expect(searchExercises('Smith Machine').every((e) =>
      /smith/i.test(e.name) || e.equipment === 'Smith Machine',
    )).toBe(true);
    expect(searchExercises('lats').length).toBeGreaterThan(0);
    // An empty query returns the whole pool rather than nothing.
    expect(searchExercises('').length).toBe(activeExercises().length);
    expect(searchExercises('', true).length).toBe(apartmentGymExercises().length);
  });

  it('exposes stable vocabularies for the UI filters', () => {
    expect(muscleGroups()).toContain('Back');
    expect(equipmentTypes()).toContain('Cable');
    expect(muscleGroups()).toEqual([...muscleGroups()].sort());
  });
});
