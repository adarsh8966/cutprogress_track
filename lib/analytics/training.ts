/**
 * Training analytics (spec §12).
 *
 * Estimated 1RM uses EPLEY: e1RM = w × (1 + reps/30).
 * Brzycki (w × 36/(37 - reps)) is provided alongside for cross-checking, since
 * the two diverge above roughly 10 reps and neither is authoritative. Epley is
 * the reported figure because it degrades more gracefully at high rep counts.
 * Both are estimates from a single set, not tested maxes, and are labelled so.
 *
 * Only WORKING sets count toward volume and bests. Warm-ups are recorded but
 * excluded, otherwise adding warm-up sets would look like progress.
 */
import type { Derived, LocalDate } from '@/lib/types';
import { derived, insufficient } from '@/lib/types';
import { compareDates, daysBetween } from '@/lib/normalization/dates';
import { mean, roundTo } from './series';

export interface LoggedSet {
  date: LocalDate;
  sessionId: string;
  exerciseId: string;
  exerciseName: string;
  primaryMuscleGroup: string;
  weightKg: number | null;
  reps: number | null;
  rir: number | null;
  rpe: number | null;
  warmup: boolean;
}

/**
 * A training session as it was recorded: the fact that it happened, and the
 * intensity figures a summary carries. NOT what was done inside it.
 *
 * This is the second of the two training measurements, and it is deliberately
 * separate from LoggedSet. A pasted summary - "Workout: Pull, 58 min, avg HR
 * 142, max HR 171, 412 kcal" - says a Pull session happened and how hard it
 * was. It says nothing about which exercises were performed or for how many
 * sets, and no amount of processing can recover that. So this type has no
 * exercise, no reps, no weight and no RIR: the fields do not exist rather than
 * being null, because a session-level record cannot answer those questions
 * even in principle.
 */
export interface TrainingSession {
  id: string;
  date: LocalDate;
  sessionType: string;
  durationMinutes: number | null;
  averageHeartRate: number | null;
  maxHeartRate: number | null;
  calories: number | null;
  notes: string | null;
  source: string;
  completed: boolean;
  importId: string | null;
}

export interface SessionTypeCount {
  sessionType: string;
  sessions: number;
  minutes: number | null;
}

export interface SessionSummary {
  totalSessions: number;
  totalMinutes: number | null;
  byType: SessionTypeCount[];
  /** Duration-weighted, across the sessions that reported an average. */
  averageHeartRate: number | null;
  maxHeartRate: number | null;
  totalCalories: number | null;
  /** How many of these sessions have exercise-level detail attached. */
  sessionsWithSets: number;
  sessionsWithoutSets: number;
}

/**
 * Counts and totals the sessions themselves (spec §11, §12).
 *
 * Every figure here is either measured or absent. A session that did not report
 * a duration contributes to the count and not to the minutes; a day of sessions
 * that all lack heart rates reports a null average rather than a number derived
 * from the ones that happen to have it. The coverage behind each figure is put
 * in `inputs` so the Evidence panel can show what the average was actually
 * taken over.
 *
 * `sets` is read ONLY to say which sessions have exercise detail. No set is
 * ever invented for a session that has none, and no session-level figure is
 * ever derived from a set.
 */
export function summariseSessions(
  sessions: TrainingSession[],
  sets: LoggedSet[] = [],
): Derived<SessionSummary> {
  const completed = sessions.filter((s) => s.completed);
  const sessionIdsWithSets = new Set(sets.map((s) => s.sessionId));

  const withDuration = completed.filter((s) => s.durationMinutes !== null);
  const totalMinutes = withDuration.length
    ? roundTo(withDuration.reduce((total, s) => total + s.durationMinutes!, 0), 1)
    : null;

  // A mean of session averages would weight a 10-minute session the same as a
  // 90-minute one. Weighting by duration is the honest aggregate; sessions
  // with an HR but no duration fall back to an unweighted contribution rather
  // than being dropped.
  const withHr = completed.filter((s) => s.averageHeartRate !== null);
  const hrWeight = (s: TrainingSession) => s.durationMinutes ?? 1;
  const hrWeightTotal = withHr.reduce((total, s) => total + hrWeight(s), 0);
  const averageHeartRate =
    withHr.length && hrWeightTotal > 0
      ? roundTo(
          withHr.reduce((total, s) => total + s.averageHeartRate! * hrWeight(s), 0) /
            hrWeightTotal,
          1,
        )
      : null;

  const maxima = completed.map((s) => s.maxHeartRate).filter((v): v is number => v !== null);
  const calories = completed.map((s) => s.calories).filter((v): v is number => v !== null);

  const byTypeMap = new Map<string, { sessions: number; minutes: number[] }>();
  for (const session of completed) {
    const entry = byTypeMap.get(session.sessionType) ?? { sessions: 0, minutes: [] };
    entry.sessions += 1;
    if (session.durationMinutes !== null) entry.minutes.push(session.durationMinutes);
    byTypeMap.set(session.sessionType, entry);
  }
  const byType: SessionTypeCount[] = [...byTypeMap.entries()]
    .map(([sessionType, entry]) => ({
      sessionType,
      sessions: entry.sessions,
      minutes: entry.minutes.length
        ? roundTo(entry.minutes.reduce((a, b) => a + b, 0), 1)
        : null,
    }))
    .sort((a, b) => b.sessions - a.sessions || a.sessionType.localeCompare(b.sessionType));

  const withSets = completed.filter((s) => sessionIdsWithSets.has(s.id)).length;

  const summary: SessionSummary = {
    totalSessions: completed.length,
    totalMinutes,
    byType,
    averageHeartRate,
    maxHeartRate: maxima.length ? Math.max(...maxima) : null,
    totalCalories: calories.length ? roundTo(calories.reduce((a, b) => a + b, 0), 1) : null,
    sessionsWithSets: withSets,
    sessionsWithoutSets: completed.length - withSets,
  };

  const notes: string[] = [];
  if (summary.sessionsWithoutSets > 0) {
    notes.push(
      `${summary.sessionsWithoutSets} of ${completed.length} session` +
        `${completed.length === 1 ? '' : 's'} ${summary.sessionsWithoutSets === 1 ? 'has' : 'have'}` +
        ' no exercise or set detail. Volume, RIR and progression are not computed for those.',
    );
  }
  if (withHr.length > 0 && withHr.length < completed.length) {
    notes.push(`Average heart rate covers ${withHr.length} of ${completed.length} sessions.`);
  }
  if (completed.length < sessions.length) {
    notes.push(`${sessions.length - completed.length} planned session(s) were not completed.`);
  }

  return derived(
    summary,
    'Training sessions',
    {
      sessionCount: completed.length,
      plannedNotCompleted: sessions.length - completed.length,
      sessionsReportingDuration: withDuration.length,
      sessionsReportingAverageHr: withHr.length,
      sessionsReportingCalories: calories.length,
      sessionsWithExerciseDetail: withSets,
    },
    completed.length > 0 ? 'HIGH' : 'INSUFFICIENT',
    completed.length === 0 ? ['No training sessions recorded in this period.'] : notes,
  );
}

export function epley1rm(weightKg: number, reps: number): number {
  if (reps <= 0) return 0;
  if (reps === 1) return weightKg;
  return weightKg * (1 + reps / 30);
}

export function brzycki1rm(weightKg: number, reps: number): number {
  if (reps <= 0) return 0;
  if (reps === 1) return weightKg;
  // Brzycki breaks down as reps approach 37; clamp before the asymptote.
  if (reps >= 36) return weightKg * 36;
  return weightKg * (36 / (37 - reps));
}

/** Volume load for a set: weight × reps. Bodyweight sets contribute 0 load. */
export function setVolume(set: LoggedSet): number | null {
  if (set.weightKg === null || set.reps === null) return null;
  return set.weightKg * set.reps;
}

export function workingSets(sets: LoggedSet[]): LoggedSet[] {
  return sets.filter((s) => !s.warmup);
}

export interface ExercisePerformance {
  exerciseId: string;
  exerciseName: string;
  bestWeightKg: number | null;
  bestReps: number | null;
  bestEstimated1rmKg: number | null;
  bestSessionVolumeKg: number | null;
  lastPerformedOn: LocalDate | null;
  lastSets: { weightKg: number | null; reps: number | null; rir: number | null }[];
  sessionCount: number;
}

export function exercisePerformance(
  sets: LoggedSet[],
  exerciseId: string,
): Derived<ExercisePerformance> {
  const relevant = workingSets(sets).filter((s) => s.exerciseId === exerciseId);
  const inputs = { exerciseId, workingSetCount: relevant.length };

  if (relevant.length === 0) {
    return insufficient<ExercisePerformance>(
      'Exercise performance',
      inputs,
      'No working sets logged for this exercise.',
      0,
    );
  }

  const name = relevant[0]!.exerciseName;
  const bySession = new Map<string, LoggedSet[]>();
  for (const set of relevant) {
    const bucket = bySession.get(set.sessionId) ?? [];
    bucket.push(set);
    bySession.set(set.sessionId, bucket);
  }

  let bestWeight: number | null = null;
  let bestReps: number | null = null;
  let best1rm: number | null = null;
  for (const set of relevant) {
    if (set.weightKg !== null) {
      bestWeight = bestWeight === null ? set.weightKg : Math.max(bestWeight, set.weightKg);
    }
    if (set.reps !== null) {
      bestReps = bestReps === null ? set.reps : Math.max(bestReps, set.reps);
    }
    if (set.weightKg !== null && set.reps !== null) {
      const estimate = epley1rm(set.weightKg, set.reps);
      best1rm = best1rm === null ? estimate : Math.max(best1rm, estimate);
    }
  }

  let bestSessionVolume: number | null = null;
  for (const bucket of bySession.values()) {
    const volumes = bucket.map(setVolume).filter((v): v is number => v !== null);
    if (volumes.length === 0) continue;
    const total = volumes.reduce((a, b) => a + b, 0);
    bestSessionVolume = bestSessionVolume === null ? total : Math.max(bestSessionVolume, total);
  }

  const sorted = [...relevant].sort((a, b) => compareDates(a.date, b.date));
  const lastDate = sorted[sorted.length - 1]!.date;
  const lastSets = sorted
    .filter((s) => s.date === lastDate)
    .map((s) => ({ weightKg: s.weightKg, reps: s.reps, rir: s.rir }));

  return derived<ExercisePerformance>(
    {
      exerciseId,
      exerciseName: name,
      bestWeightKg: bestWeight === null ? null : roundTo(bestWeight, 2),
      bestReps,
      bestEstimated1rmKg: best1rm === null ? null : roundTo(best1rm, 1),
      bestSessionVolumeKg: bestSessionVolume === null ? null : roundTo(bestSessionVolume, 1),
      lastPerformedOn: lastDate,
      lastSets,
      sessionCount: bySession.size,
    },
    'Exercise performance (Epley e1RM)',
    inputs,
    bySession.size >= 3 ? 'HIGH' : 'MODERATE',
    ['e1RM is estimated from working sets, not from a tested max.'],
  );
}

export type ProgressionState =
  | 'WEIGHT_INCREASED'
  | 'REPS_INCREASED'
  | 'VOLUME_INCREASED'
  | 'STAGNANT'
  | 'DECLINING'
  | 'INSUFFICIENT_DATA';

export interface ProgressionResult {
  state: ProgressionState;
  firstSessionVolumeKg: number | null;
  lastSessionVolumeKg: number | null;
  firstBest1rmKg: number | null;
  lastBest1rmKg: number | null;
}

/** Compares the earliest and most recent sessions for an exercise (spec §12). */
export function exerciseProgression(
  sets: LoggedSet[],
  exerciseId: string,
): Derived<ProgressionResult> {
  const relevant = workingSets(sets)
    .filter((s) => s.exerciseId === exerciseId)
    .sort((a, b) => compareDates(a.date, b.date));

  const dates = [...new Set(relevant.map((s) => s.date))];
  const inputs = { exerciseId, sessionCount: dates.length };

  const empty: ProgressionResult = {
    state: 'INSUFFICIENT_DATA',
    firstSessionVolumeKg: null,
    lastSessionVolumeKg: null,
    firstBest1rmKg: null,
    lastBest1rmKg: null,
  };

  if (dates.length < 2) {
    return derived(
      empty,
      'Exercise progression',
      inputs,
      'INSUFFICIENT',
      ['At least two sessions are needed to say anything about progression.'],
    );
  }

  const firstDate = dates[0]!;
  const lastDate = dates[dates.length - 1]!;
  const first = relevant.filter((s) => s.date === firstDate);
  const last = relevant.filter((s) => s.date === lastDate);

  const volumeOf = (group: LoggedSet[]): number | null => {
    const volumes = group.map(setVolume).filter((v): v is number => v !== null);
    return volumes.length ? volumes.reduce((a, b) => a + b, 0) : null;
  };
  const best1rmOf = (group: LoggedSet[]): number | null => {
    const estimates = group
      .filter((s) => s.weightKg !== null && s.reps !== null)
      .map((s) => epley1rm(s.weightKg!, s.reps!));
    return estimates.length ? Math.max(...estimates) : null;
  };
  const topWeightOf = (group: LoggedSet[]): number | null => {
    const weights = group.map((s) => s.weightKg).filter((w): w is number => w !== null);
    return weights.length ? Math.max(...weights) : null;
  };
  const topRepsOf = (group: LoggedSet[]): number | null => {
    const reps = group.map((s) => s.reps).filter((r): r is number => r !== null);
    return reps.length ? Math.max(...reps) : null;
  };

  const firstVolume = volumeOf(first);
  const lastVolume = volumeOf(last);
  const first1rm = best1rmOf(first);
  const last1rm = best1rmOf(last);

  const result: ProgressionResult = {
    state: 'STAGNANT',
    firstSessionVolumeKg: firstVolume === null ? null : roundTo(firstVolume, 1),
    lastSessionVolumeKg: lastVolume === null ? null : roundTo(lastVolume, 1),
    firstBest1rmKg: first1rm === null ? null : roundTo(first1rm, 1),
    lastBest1rmKg: last1rm === null ? null : roundTo(last1rm, 1),
  };

  const firstWeight = topWeightOf(first);
  const lastWeight = topWeightOf(last);
  const firstReps = topRepsOf(first);
  const lastReps = topRepsOf(last);

  // Ordered most-to-least meaningful: added load beats added reps beats added
  // total volume. A 2% band keeps rounding noise from reading as progress.
  const grew = (a: number | null, b: number | null): boolean =>
    a !== null && b !== null && b > a * 1.02;
  const shrank = (a: number | null, b: number | null): boolean =>
    a !== null && b !== null && b < a * 0.98;

  if (grew(firstWeight, lastWeight)) result.state = 'WEIGHT_INCREASED';
  else if (grew(firstReps, lastReps)) result.state = 'REPS_INCREASED';
  else if (grew(firstVolume, lastVolume)) result.state = 'VOLUME_INCREASED';
  else if (shrank(first1rm, last1rm) && shrank(firstVolume, lastVolume))
    result.state = 'DECLINING';
  else result.state = 'STAGNANT';

  return derived(
    result,
    'Exercise progression',
    {
      ...inputs,
      firstDate,
      lastDate,
      spanDays: daysBetween(firstDate, lastDate),
    },
    dates.length >= 4 ? 'HIGH' : 'MODERATE',
    dates.length < 4
      ? ['Based on only a few sessions; treat the direction as provisional.']
      : [],
  );
}

export interface MuscleGroupVolume {
  muscleGroup: string;
  sets: number;
  volumeKg: number | null;
  sessions: number;
}

/** Weekly hard-set counts per muscle group - the standard volume currency. */
export function volumeByMuscleGroup(sets: LoggedSet[]): MuscleGroupVolume[] {
  const groups = new Map<string, { sets: LoggedSet[]; sessions: Set<string> }>();
  for (const set of workingSets(sets)) {
    const entry = groups.get(set.primaryMuscleGroup) ?? { sets: [], sessions: new Set() };
    entry.sets.push(set);
    entry.sessions.add(set.sessionId);
    groups.set(set.primaryMuscleGroup, entry);
  }

  return [...groups.entries()]
    .map(([muscleGroup, entry]) => {
      const volumes = entry.sets.map(setVolume).filter((v): v is number => v !== null);
      return {
        muscleGroup,
        sets: entry.sets.length,
        volumeKg: volumes.length ? roundTo(volumes.reduce((a, b) => a + b, 0), 1) : null,
        sessions: entry.sessions.size,
      };
    })
    .sort((a, b) => b.sets - a.sets);
}

export interface TrainingSummary {
  totalSessions: number;
  totalWorkingSets: number;
  totalVolumeKg: number | null;
  averageRir: number | null;
  averageRpe: number | null;
  byMuscleGroup: MuscleGroupVolume[];
}

export function summariseTraining(sets: LoggedSet[]): Derived<TrainingSummary> {
  const working = workingSets(sets);
  const sessions = new Set(working.map((s) => s.sessionId));
  const volumes = working.map(setVolume).filter((v): v is number => v !== null);
  const rirValues = working.map((s) => s.rir).filter((v): v is number => v !== null);
  const rpeValues = working.map((s) => s.rpe).filter((v): v is number => v !== null);

  const summary: TrainingSummary = {
    totalSessions: sessions.size,
    totalWorkingSets: working.length,
    totalVolumeKg: volumes.length ? roundTo(volumes.reduce((a, b) => a + b, 0), 1) : null,
    averageRir: rirValues.length ? roundTo(mean(rirValues)!, 2) : null,
    averageRpe: rpeValues.length ? roundTo(mean(rpeValues)!, 2) : null,
    byMuscleGroup: volumeByMuscleGroup(sets),
  };

  return derived(
    summary,
    'Training summary',
    {
      workingSetCount: working.length,
      warmupSetCount: sets.length - working.length,
      note: 'Warm-up sets are excluded from volume and set counts.',
    },
    working.length > 0 ? 'HIGH' : 'INSUFFICIENT',
    working.length === 0 ? ['No working sets logged in this period.'] : [],
  );
}
