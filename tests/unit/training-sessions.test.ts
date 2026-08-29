/**
 * Session-level training (spec §11, §12).
 *
 * The bug these guard against: a workout imported as a summary - a real
 * workout_sessions row with a duration, heart rates and calories, but no
 * exercises - was invisible on the Training page, which reported "Sessions: 0"
 * and "Nothing logged yet" for data it was holding.
 *
 * The fix must not overcorrect. A session-level record says a session happened
 * and how hard it was; it cannot say what was performed. So these also pin the
 * other half: no set, volume, RIR or progression may ever be conjured from a
 * session that has none.
 */
import { describe, it, expect } from 'vitest';
import {
  summariseSessions, summariseTraining, exerciseProgression, volumeByMuscleGroup,
  type TrainingSession, type LoggedSet,
} from '@/lib/analytics/training';

function session(overrides: Partial<TrainingSession> = {}): TrainingSession {
  return {
    id: 'session-1',
    date: '2026-08-28',
    sessionType: 'PULL',
    durationMinutes: 58,
    averageHeartRate: 142,
    maxHeartRate: 171,
    calories: 412,
    notes: 'Pull',
    source: 'IMPORT_TEXT',
    completed: true,
    importId: 'import-1',
    ...overrides,
  };
}

function set(overrides: Partial<LoggedSet> = {}): LoggedSet {
  return {
    date: '2026-08-28',
    sessionId: 'session-1',
    exerciseId: 'cable-row',
    exerciseName: 'Cable Row',
    primaryMuscleGroup: 'Back',
    weightKg: 40,
    reps: 10,
    rir: 2,
    rpe: 8,
    warmup: false,
    ...overrides,
  };
}

/** The two days from the production report, exactly as they were imported. */
const AUG_27 = session({
  id: 'aug27', date: '2026-08-27', sessionType: 'LOWER',
  durationMinutes: 64, averageHeartRate: 138, maxHeartRate: 169, calories: 395,
  notes: 'Lower',
});
const AUG_28 = session({
  id: 'aug28', date: '2026-08-28', sessionType: 'PULL',
  durationMinutes: 58, averageHeartRate: 142, maxHeartRate: 171, calories: 412,
  notes: 'Pull',
});

describe('summariseSessions: imported sessions are visible', () => {
  it('counts a session that has no sets at all', () => {
    const result = summariseSessions([AUG_27, AUG_28], []);
    expect(result.value!.totalSessions).toBe(2);
  });

  it('includes each session duration in the total', () => {
    const result = summariseSessions([AUG_27, AUG_28], []);
    expect(result.value!.totalMinutes).toBe(122);
  });

  it('reports heart rate and calories when the session carries them', () => {
    const result = summariseSessions([AUG_27, AUG_28], []);
    // Duration-weighted: (138*64 + 142*58) / 122.
    expect(result.value!.averageHeartRate).toBeCloseTo(139.9, 1);
    expect(result.value!.maxHeartRate).toBe(171);
    expect(result.value!.totalCalories).toBe(807);
  });

  it('breaks the sessions down by type', () => {
    const result = summariseSessions([AUG_27, AUG_28], []);
    expect(result.value!.byType).toEqual([
      { sessionType: 'LOWER', sessions: 1, minutes: 64 },
      { sessionType: 'PULL', sessions: 1, minutes: 58 },
    ]);
  });

  it('says how many sessions carry no exercise detail', () => {
    const result = summariseSessions([AUG_27, AUG_28], []);
    expect(result.value!.sessionsWithSets).toBe(0);
    expect(result.value!.sessionsWithoutSets).toBe(2);
    expect(result.notes.join(' ')).toMatch(/no exercise or set detail/i);
  });
});

describe('summariseSessions: nothing is fabricated', () => {
  it('invents no working sets, volume or RIR for a summary import', () => {
    const training = summariseTraining([]);
    expect(training.value!.totalWorkingSets).toBe(0);
    expect(training.value!.totalVolumeKg).toBeNull();
    expect(training.value!.averageRir).toBeNull();
    expect(training.value!.averageRpe).toBeNull();
  });

  it('leaves muscle-group volume empty when no exercises were imported', () => {
    expect(volumeByMuscleGroup([])).toEqual([]);
    expect(summariseTraining([]).value!.byMuscleGroup).toEqual([]);
  });

  it('leaves exercise progression at INSUFFICIENT_DATA with no sets', () => {
    const progression = exerciseProgression([], 'cable-row');
    expect(progression.value!.state).toBe('INSUFFICIENT_DATA');
    expect(progression.value!.firstSessionVolumeKg).toBeNull();
    expect(progression.value!.lastSessionVolumeKg).toBeNull();
  });

  it('exposes no set-level field on the session summary at all', () => {
    const result = summariseSessions([AUG_27, AUG_28], []);
    for (const key of ['totalVolumeKg', 'averageRir', 'totalWorkingSets', 'byMuscleGroup']) {
      expect(result.value).not.toHaveProperty(key);
    }
  });
});

describe('summariseSessions: missing values stay missing', () => {
  it('counts a session with no duration but does not add it to the minutes', () => {
    const result = summariseSessions(
      [session({ id: 'a', durationMinutes: null }), session({ id: 'b', durationMinutes: 30 })],
      [],
    );
    expect(result.value!.totalSessions).toBe(2);
    expect(result.value!.totalMinutes).toBe(30);
  });

  it('reports null, not zero, when nothing carried a heart rate', () => {
    const result = summariseSessions(
      [session({ averageHeartRate: null, maxHeartRate: null, calories: null })],
      [],
    );
    expect(result.value!.averageHeartRate).toBeNull();
    expect(result.value!.maxHeartRate).toBeNull();
    expect(result.value!.totalCalories).toBeNull();
  });

  it('averages heart rate only over the sessions that reported one', () => {
    const result = summariseSessions(
      [
        session({ id: 'a', durationMinutes: 60, averageHeartRate: 140 }),
        session({ id: 'b', durationMinutes: 60, averageHeartRate: null }),
      ],
      [],
    );
    expect(result.value!.averageHeartRate).toBe(140);
    expect(result.notes.join(' ')).toMatch(/covers 1 of 2 sessions/);
  });

  it('is INSUFFICIENT with no sessions, and says so rather than showing zero', () => {
    const result = summariseSessions([], []);
    expect(result.value!.totalSessions).toBe(0);
    expect(result.value!.totalMinutes).toBeNull();
    expect(result.confidence).toBe('INSUFFICIENT');
    expect(result.notes.join(' ')).toMatch(/No training sessions recorded/);
  });

  it('excludes a planned-but-not-completed session from the totals', () => {
    const result = summariseSessions(
      [AUG_28, session({ id: 'skipped', completed: false, durationMinutes: 45 })],
      [],
    );
    expect(result.value!.totalSessions).toBe(1);
    expect(result.value!.totalMinutes).toBe(58);
    expect(result.notes.join(' ')).toMatch(/were not completed/);
  });
});

describe('manually logged sessions keep behaving exactly as before', () => {
  const manual = session({ id: 'manual', source: 'MANUAL', importId: null });
  const sets = [set({ sessionId: 'manual' }), set({ sessionId: 'manual', reps: 8 })];

  it('still derives every exercise figure from the sets alone', () => {
    const training = summariseTraining(sets);
    expect(training.value!.totalSessions).toBe(1);
    expect(training.value!.totalWorkingSets).toBe(2);
    expect(training.value!.totalVolumeKg).toBe(720);
    expect(training.value!.averageRir).toBe(2);
  });

  it('marks a session with sets as having exercise detail', () => {
    const result = summariseSessions([manual], sets);
    expect(result.value!.sessionsWithSets).toBe(1);
    expect(result.value!.sessionsWithoutSets).toBe(0);
    expect(result.notes.join(' ')).not.toMatch(/no exercise or set detail/i);
  });

  it('counts a mixed period correctly on both axes at once', () => {
    const sessions = summariseSessions([manual, AUG_27, AUG_28], sets);
    const training = summariseTraining(sets);
    // Three sessions happened; one of them was logged set-by-set.
    expect(sessions.value!.totalSessions).toBe(3);
    expect(sessions.value!.sessionsWithSets).toBe(1);
    expect(sessions.value!.sessionsWithoutSets).toBe(2);
    // The set-level figures describe only that one session.
    expect(training.value!.totalSessions).toBe(1);
    expect(training.value!.totalWorkingSets).toBe(2);
  });

  it('does not let warm-up-only sets claim exercise detail they do not have', () => {
    const warmupOnly = [set({ sessionId: 'manual', warmup: true })];
    expect(summariseTraining(warmupOnly).value!.totalWorkingSets).toBe(0);
    // The session still happened, and is still counted as a session.
    expect(summariseSessions([manual], warmupOnly).value!.totalSessions).toBe(1);
  });
});

describe('multi-day imports', () => {
  it('keeps each day separate and totals them all', () => {
    const days = ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28'];
    const sessions = days.map((date, i) =>
      session({ id: `s-${date}`, date, durationMinutes: 30 + i, calories: 100 + i }),
    );
    const result = summariseSessions(sessions, []);
    expect(result.value!.totalSessions).toBe(5);
    expect(result.value!.totalMinutes).toBe(30 + 31 + 32 + 33 + 34);
    expect(result.value!.totalCalories).toBe(100 + 101 + 102 + 103 + 104);
  });
});
