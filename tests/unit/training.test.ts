import { describe, it, expect } from 'vitest';
import {
  epley1rm, brzycki1rm, setVolume, workingSets, exercisePerformance,
  exerciseProgression, volumeByMuscleGroup, summariseTraining, type LoggedSet,
} from '@/lib/analytics/training';

function set(overrides: Partial<LoggedSet> = {}): LoggedSet {
  return {
    date: '2026-08-28',
    sessionId: 's1',
    exerciseId: 'cable-row',
    exerciseName: 'Cable Row',
    primaryMuscleGroup: 'Back',
    weightKg: 31.75,
    reps: 12,
    rir: 2,
    rpe: 8,
    warmup: false,
    setNumber: 1,
    exerciseIndex: null,
    exerciseNotes: null,
    setType: null,
    supersetId: null,
    distanceKm: null,
    durationSeconds: null,
    ...overrides,
  };
}

describe('estimated 1RM (spec §12)', () => {
  it('returns the load itself for a single rep', () => {
    expect(epley1rm(100, 1)).toBe(100);
    expect(brzycki1rm(100, 1)).toBe(100);
  });

  it('computes Epley as w x (1 + reps/30)', () => {
    expect(epley1rm(100, 10)).toBeCloseTo(133.33, 2);
  });

  it('diverges from Brzycki as reps climb, which is why only one is reported', () => {
    const gap = (reps: number) =>
      Math.abs(epley1rm(100, reps) - brzycki1rm(100, reps)) / epley1rm(100, reps);
    // Close enough to cross-check in the low-rep range...
    expect(gap(5)).toBeLessThan(0.05);
    // ...and far enough apart at higher reps that quoting both would be noise.
    expect(gap(15)).toBeGreaterThan(0.08);
    expect(gap(15)).toBeGreaterThan(gap(5));
  });

  it('does not blow up as Brzycki approaches its asymptote', () => {
    expect(Number.isFinite(brzycki1rm(100, 36))).toBe(true);
    expect(Number.isFinite(brzycki1rm(100, 40))).toBe(true);
  });
});

describe('volume', () => {
  it('multiplies load by reps', () => {
    expect(setVolume(set({ weightKg: 30, reps: 10 }))).toBe(300);
  });

  it('returns null when either component is unlogged', () => {
    expect(setVolume(set({ weightKg: null }))).toBeNull();
    expect(setVolume(set({ reps: null }))).toBeNull();
  });

  it('excludes warm-ups so adding them cannot look like progress', () => {
    const sets = [set({ warmup: true }), set({ warmup: false })];
    expect(workingSets(sets)).toHaveLength(1);
    const summary = summariseTraining(sets);
    expect(summary.value!.totalWorkingSets).toBe(1);
    expect(summary.inputs).toMatchObject({ warmupSetCount: 1 });
  });
});

describe('exercise performance', () => {
  const history: LoggedSet[] = [
    set({ date: '2026-08-01', sessionId: 's1', weightKg: 29.5, reps: 10 }),
    set({ date: '2026-08-01', sessionId: 's1', weightKg: 29.5, reps: 9 }),
    set({ date: '2026-08-15', sessionId: 's2', weightKg: 31.75, reps: 10 }),
    set({ date: '2026-08-28', sessionId: 's3', weightKg: 34, reps: 10 }),
    set({ date: '2026-08-28', sessionId: 's3', weightKg: 34, reps: 8 }),
  ];

  it('reports bests and the most recent session', () => {
    const result = exercisePerformance(history, 'cable-row');
    expect(result.value!.bestWeightKg).toBe(34);
    expect(result.value!.bestReps).toBe(10);
    expect(result.value!.bestEstimated1rmKg).toBeCloseTo(epley1rm(34, 10), 1);
    expect(result.value!.lastPerformedOn).toBe('2026-08-28');
    expect(result.value!.lastSets).toHaveLength(2);
    expect(result.value!.sessionCount).toBe(3);
  });

  it('reports nothing for an exercise never performed', () => {
    const result = exercisePerformance(history, 'hack-squat');
    expect(result.value).toBeNull();
    expect(result.confidence).toBe('INSUFFICIENT');
  });

  it('detects added load as the strongest form of progression', () => {
    const result = exerciseProgression(history, 'cable-row');
    expect(result.value!.state).toBe('WEIGHT_INCREASED');
  });

  it('detects added reps at the same load', () => {
    const sets = [
      set({ date: '2026-08-01', sessionId: 's1', weightKg: 30, reps: 8 }),
      set({ date: '2026-08-28', sessionId: 's2', weightKg: 30, reps: 12 }),
    ];
    expect(exerciseProgression(sets, 'cable-row').value!.state).toBe('REPS_INCREASED');
  });

  it('calls an unchanged performance stagnant, not progress', () => {
    const sets = [
      set({ date: '2026-08-01', sessionId: 's1', weightKg: 30, reps: 10 }),
      set({ date: '2026-08-28', sessionId: 's2', weightKg: 30, reps: 10 }),
    ];
    expect(exerciseProgression(sets, 'cable-row').value!.state).toBe('STAGNANT');
  });

  it('detects a decline', () => {
    const sets = [
      set({ date: '2026-08-01', sessionId: 's1', weightKg: 40, reps: 12 }),
      set({ date: '2026-08-01', sessionId: 's1', weightKg: 40, reps: 12 }),
      set({ date: '2026-08-28', sessionId: 's2', weightKg: 30, reps: 8 }),
    ];
    expect(exerciseProgression(sets, 'cable-row').value!.state).toBe('DECLINING');
  });

  it('refuses to judge progression from a single session', () => {
    const result = exerciseProgression([set()], 'cable-row');
    expect(result.value!.state).toBe('INSUFFICIENT_DATA');
    expect(result.confidence).toBe('INSUFFICIENT');
  });
});

describe('muscle group volume (spec §12)', () => {
  it('counts working sets and sessions per muscle group', () => {
    const sets = [
      set({ primaryMuscleGroup: 'Back', sessionId: 's1' }),
      set({ primaryMuscleGroup: 'Back', sessionId: 's1' }),
      set({ primaryMuscleGroup: 'Back', sessionId: 's2' }),
      set({ primaryMuscleGroup: 'Chest', sessionId: 's2' }),
      set({ primaryMuscleGroup: 'Chest', sessionId: 's2', warmup: true }),
    ];
    const volume = volumeByMuscleGroup(sets);
    expect(volume[0]).toMatchObject({ muscleGroup: 'Back', sets: 3, sessions: 2 });
    expect(volume[1]).toMatchObject({ muscleGroup: 'Chest', sets: 1, sessions: 1 });
  });

  it('averages RIR and RPE across working sets only', () => {
    const summary = summariseTraining([
      set({ rir: 2, rpe: 8 }),
      set({ rir: 0, rpe: 10 }),
      set({ rir: 5, rpe: 5, warmup: true }),
    ]);
    expect(summary.value!.averageRir).toBe(1);
    expect(summary.value!.averageRpe).toBe(9);
  });
});
