/**
 * Personal records and training consistency.
 *
 * Hevy's API exposes no PR data of any kind, so every record CUT OS shows is
 * derived from the sets it holds. Two rules carry most of the weight:
 *
 *   a record keeps the date it was FIRST reached - matching it later does not
 *   move it, because that would tell the user something false about today;
 *
 *   an empty week still counts as a week - averaging only the weeks that
 *   happened describes a training history nobody had.
 */
import { describe, it, expect } from 'vitest';
import { personalRecords, trainingConsistency } from '@/lib/analytics/prs';
import type { LoggedSet, TrainingSession } from '@/lib/analytics/training';
import { stateOf } from '@/lib/types';

function set(overrides: Partial<LoggedSet> = {}): LoggedSet {
  return {
    date: '2026-08-03',
    sessionId: 's1',
    exerciseId: 'incline-dumbbell-press',
    exerciseName: 'Incline Dumbbell Press',
    primaryMuscleGroup: 'Chest',
    setNumber: 1,
    weightKg: 30,
    reps: 10,
    rir: null,
    rpe: 8,
    warmup: false,
    exerciseIndex: 0,
    exerciseNotes: null,
    setType: 'normal',
    supersetId: null,
    distanceKm: null,
    durationSeconds: null,
    ...overrides,
  };
}

function session(overrides: Partial<TrainingSession> = {}): TrainingSession {
  return {
    id: 's1',
    date: '2026-08-03',
    sessionType: 'PUSH',
    title: 'Push Day',
    externalSource: 'HEVY',
    durationMinutes: 60,
    averageHeartRate: null,
    maxHeartRate: null,
    calories: null,
    notes: null,
    source: 'HEVY',
    completed: true,
    importId: null,
    ...overrides,
  };
}

describe('personalRecords', () => {
  it('finds the heaviest set, the most reps, the best e1RM and the best session volume', () => {
    const result = personalRecords([
      set({ sessionId: 'a', date: '2026-08-03', weightKg: 30, reps: 10 }),
      set({ sessionId: 'a', date: '2026-08-03', weightKg: 30, reps: 9 }),
      set({ sessionId: 'b', date: '2026-08-10', weightKg: 34, reps: 8 }),
      set({ sessionId: 'b', date: '2026-08-10', weightKg: 20, reps: 20 }),
    ]);

    const [record] = result.value!;
    expect(record!.heaviest).toMatchObject({ value: 34, date: '2026-08-10' });
    expect(record!.mostReps).toMatchObject({ value: 20, date: '2026-08-10' });
    // Epley: 34 x (1 + 8/30) = 43.1, against 30 x (1 + 10/30) = 40.
    expect(record!.bestEstimated1rm).toMatchObject({ value: 43.1, date: '2026-08-10' });
    // Session b: 34x8 + 20x20 = 672, against session a's 30x10 + 30x9 = 570.
    expect(record!.bestSessionVolume).toMatchObject({ value: 672, date: '2026-08-10' });
  });

  it('keeps the date a record was FIRST set when it is matched again later', () => {
    const result = personalRecords([
      set({ sessionId: 'a', date: '2026-08-03', weightKg: 40, reps: 5 }),
      set({ sessionId: 'b', date: '2026-08-17', weightKg: 40, reps: 5 }),
    ]);
    // Matching 40 kg a fortnight later does not make it today's record.
    expect(result.value![0]!.heaviest).toMatchObject({ value: 40, date: '2026-08-03' });
  });

  it('moves the record when it is actually beaten', () => {
    const result = personalRecords([
      set({ sessionId: 'a', date: '2026-08-03', weightKg: 40, reps: 5 }),
      set({ sessionId: 'b', date: '2026-08-17', weightKg: 42.5, reps: 5 }),
    ]);
    expect(result.value![0]!.heaviest).toMatchObject({ value: 42.5, date: '2026-08-17' });
  });

  it('excludes warm-ups, so adding them never looks like progress', () => {
    const result = personalRecords([
      set({ sessionId: 'a', weightKg: 30, reps: 10 }),
      set({ sessionId: 'a', weightKg: 100, reps: 1, warmup: true }),
    ]);
    expect(result.value![0]!.heaviest!.value).toBe(30);
  });

  it('says when a record was set in the most recent session', () => {
    const beaten = personalRecords([
      set({ sessionId: 'a', date: '2026-08-03', weightKg: 40 }),
      set({ sessionId: 'b', date: '2026-08-10', weightKg: 45 }),
    ]);
    expect(beaten.value![0]!.setOnLastSession).toBe(true);

    const notBeaten = personalRecords([
      set({ sessionId: 'a', date: '2026-08-03', weightKg: 45 }),
      set({ sessionId: 'b', date: '2026-08-10', weightKg: 40 }),
    ]);
    expect(notBeaten.value![0]!.setOnLastSession).toBe(false);
  });

  it('records a rep PR for an exercise that never carries a load', () => {
    // A bodyweight movement has no heaviest set worth the name, and saying so
    // is better than reporting 0 kg as a record.
    const result = personalRecords([
      set({ exerciseId: 'pull-up', exerciseName: 'Pull-Up', weightKg: null, reps: 8 }),
      set({
        sessionId: 'b', date: '2026-08-10', exerciseId: 'pull-up',
        exerciseName: 'Pull-Up', weightKg: null, reps: 11,
      }),
    ]);
    const record = result.value![0]!;
    expect(record.heaviest).toBeNull();
    expect(record.bestEstimated1rm).toBeNull();
    expect(record.mostReps).toMatchObject({ value: 11, date: '2026-08-10' });
  });

  it('keeps each exercise’s records separate', () => {
    const result = personalRecords([
      set({ exerciseId: 'a', exerciseName: 'A', weightKg: 100 }),
      set({ exerciseId: 'b', exerciseName: 'B', weightKg: 20 }),
    ]);
    expect(result.value!.map((r) => [r.exerciseId, r.heaviest!.value]).sort())
      .toEqual([['a', 100], ['b', 20]]);
  });

  it('reports nothing rather than zero when no working set exists', () => {
    const result = personalRecords([set({ warmup: true })]);
    expect(result.value).toBeNull();
    // NOT_LOGGED, not INSUFFICIENT: no working set was ever recorded.
    expect(stateOf(result)).toBe('NOT_LOGGED');
  });

  it('treats one session as provisional', () => {
    expect(personalRecords([set()]).confidence).toBe('MODERATE');
    expect(personalRecords([
      set({ sessionId: 'a' }), set({ sessionId: 'b' }), set({ sessionId: 'c' }),
    ]).confidence).toBe('HIGH');
  });
});

describe('trainingConsistency', () => {
  // 2026-08-03 is a Monday, so these weeks start cleanly.
  const END = '2026-08-30';

  it('counts an empty week as a week', () => {
    // Two sessions in one week and nothing for three is 0.5 a week, not two.
    const result = trainingConsistency(
      [
        session({ id: 'a', date: '2026-08-24' }),
        session({ id: 'b', date: '2026-08-26' }),
      ],
      [],
      END,
      4,
    );
    expect(result.value!.sessionsPerWeek).toBe(0.5);
    expect(result.value!.emptyWeeks).toBe(3);
    expect(result.notes.join(' ')).toMatch(/3 of 4 weeks recorded no session/);
  });

  it('returns one bucket per week, oldest first, including the empty ones', () => {
    const result = trainingConsistency([session({ date: '2026-08-26' })], [], END, 4);
    const weeks = result.value!.weeks;
    expect(weeks).toHaveLength(4);
    expect(weeks.map((w) => w.weekStart))
      .toEqual(['2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24']);
    expect(weeks.map((w) => w.sessions)).toEqual([0, 0, 0, 1]);
  });

  it('reports a week with sessions but no sets as null volume, never zero', () => {
    const result = trainingConsistency([session({ date: '2026-08-26' })], [], END, 4);
    const week = result.value!.weeks.at(-1)!;
    expect(week.sessions).toBe(1);
    expect(week.minutes).toBe(60);
    // A summary-only session has no volume. 0 would claim it was measured.
    expect(week.volumeKg).toBeNull();
    expect(week.averageRpe).toBeNull();
  });

  it('totals volume and averages RPE within each week', () => {
    const result = trainingConsistency(
      [session({ id: 'a', date: '2026-08-25' })],
      [
        set({ sessionId: 'a', date: '2026-08-25', weightKg: 30, reps: 10, rpe: 7 }),
        set({ sessionId: 'a', date: '2026-08-25', weightKg: 30, reps: 10, rpe: 9 }),
      ],
      END,
      4,
    );
    const week = result.value!.weeks.at(-1)!;
    expect(week.workingSets).toBe(2);
    expect(week.volumeKg).toBe(600);
    expect(week.averageRpe).toBe(8);
    expect(result.value!.averageRpe).toBe(8);
  });

  it('ignores training outside the window', () => {
    const result = trainingConsistency(
      [session({ id: 'old', date: '2026-01-01' }), session({ id: 'new', date: '2026-08-26' })],
      [],
      END,
      4,
    );
    expect(result.value!.sessionsPerWeek).toBe(0.25);
  });

  it('does not count a planned session that was not completed', () => {
    const result = trainingConsistency(
      [session({ date: '2026-08-26', completed: false })], [], END, 4,
    );
    expect(result.value).toBeNull();
    expect(stateOf(result)).toBe('NOT_LOGGED');
  });

  it('reports no training as not logged rather than as zero per week', () => {
    const result = trainingConsistency([], [], END, 4);
    expect(result.value).toBeNull();
    expect(stateOf(result)).toBe('NOT_LOGGED');
    expect(result.notes[0]).toMatch(/No training sessions recorded/);
  });
});
