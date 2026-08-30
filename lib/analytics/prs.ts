/**
 * Personal records and training consistency (spec §12).
 *
 * DERIVED HERE, BECAUSE NOBODY HANDS THEM TO US. Hevy's published API exposes
 * no personal-record endpoint and no PR field on any response, so a PR in CUT
 * OS is computed from the sets it holds - which is the honest arrangement
 * anyway: a record this app displays should be one it can show the working for.
 *
 * A PR IS DATED, AND THE DATE IS THE FIRST TIME IT WAS ACHIEVED. Matching a
 * best later does not move the record. That is what a record means, and it also
 * keeps the figure stable: a bar that reads "best: 100 kg, set today" every
 * time you match it is telling you something false about today.
 *
 * ONLY WORKING SETS COUNT, as everywhere else in this file's neighbourhood.
 * Warm-ups are recorded and excluded, so adding them can never look like
 * progress.
 *
 * Estimated 1RM uses Epley, the same formula and the same caveat as
 * lib/analytics/training.ts: an estimate from one set, never a tested max.
 */
import type { Derived, LocalDate } from '@/lib/types';
import { derived, insufficient } from '@/lib/types';
import { compareDates, startOfWeek, addDays } from '@/lib/normalization/dates';
import { epley1rm, setVolume, workingSets, type LoggedSet, type TrainingSession } from './training';
import { mean, roundTo } from './series';

/** One record: the figure, when it was first reached, and what reached it. */
export interface Record1 {
  value: number;
  date: LocalDate;
  weightKg: number | null;
  reps: number | null;
}

export interface ExerciseRecords {
  exerciseId: string;
  exerciseName: string;
  /** Heaviest working set, whatever the reps. */
  heaviest: Record1 | null;
  /** Most reps in a working set, whatever the load. */
  mostReps: Record1 | null;
  /** Best Epley estimate from a single set. */
  bestEstimated1rm: Record1 | null;
  /** Most volume (weight x reps, summed) in one session. */
  bestSessionVolume: Record1 | null;
  lastPerformedOn: LocalDate;
  /** True when any of the above was first set on the most recent session. */
  setOnLastSession: boolean;
}

/**
 * Keeps the FIRST occurrence of a best.
 *
 * `>` rather than `>=` is the whole rule: a later set that merely matches does
 * not take the record, so the date keeps meaning "when this was first done".
 */
function better(current: Record1 | null, candidate: Record1): Record1 {
  if (current === null) return candidate;
  if (candidate.value > current.value) return candidate;
  return current;
}

export function personalRecords(sets: LoggedSet[]): Derived<ExerciseRecords[]> {
  const working = workingSets(sets);
  const inputs = {
    workingSetCount: working.length,
    warmupSetCount: sets.length - working.length,
    note: 'A record keeps the date it was FIRST set; matching it later does not move it.',
  };

  if (working.length === 0) {
    return insufficient<ExerciseRecords[]>(
      'Personal records (Epley e1RM)',
      inputs,
      'No working sets logged, so there is nothing to take a record from.',
      0,
    );
  }

  const byExercise = new Map<string, LoggedSet[]>();
  for (const set of working) {
    const bucket = byExercise.get(set.exerciseId) ?? [];
    bucket.push(set);
    byExercise.set(set.exerciseId, bucket);
  }

  const records: ExerciseRecords[] = [];

  for (const [exerciseId, exerciseSets] of byExercise) {
    // Oldest first, so the first set to reach a figure is the one seen first.
    const ordered = [...exerciseSets].sort((a, b) => compareDates(a.date, b.date));

    let heaviest: Record1 | null = null;
    let mostReps: Record1 | null = null;
    let bestE1rm: Record1 | null = null;

    for (const set of ordered) {
      if (set.weightKg !== null) {
        heaviest = better(heaviest, {
          value: set.weightKg, date: set.date, weightKg: set.weightKg, reps: set.reps,
        });
      }
      if (set.reps !== null) {
        mostReps = better(mostReps, {
          value: set.reps, date: set.date, weightKg: set.weightKg, reps: set.reps,
        });
      }
      if (set.weightKg !== null && set.reps !== null) {
        bestE1rm = better(bestE1rm, {
          value: roundTo(epley1rm(set.weightKg, set.reps), 1),
          date: set.date,
          weightKg: set.weightKg,
          reps: set.reps,
        });
      }
    }

    // Volume is a property of a SESSION, not of a set: one hard triple and ten
    // easy sets are different training, and only the total says which happened.
    const bySession = new Map<string, { date: LocalDate; volume: number; any: boolean }>();
    for (const set of ordered) {
      const entry = bySession.get(set.sessionId)
        ?? { date: set.date, volume: 0, any: false };
      const volume = setVolume(set);
      if (volume !== null) {
        entry.volume += volume;
        entry.any = true;
      }
      bySession.set(set.sessionId, entry);
    }

    let bestSessionVolume: Record1 | null = null;
    const sessionsOldestFirst = [...bySession.values()]
      .filter((entry) => entry.any)
      .sort((a, b) => compareDates(a.date, b.date));
    for (const entry of sessionsOldestFirst) {
      bestSessionVolume = better(bestSessionVolume, {
        value: roundTo(entry.volume, 1), date: entry.date, weightKg: null, reps: null,
      });
    }

    const lastPerformedOn = ordered[ordered.length - 1]!.date;
    const setOnLastSession = [heaviest, mostReps, bestE1rm, bestSessionVolume]
      .some((record) => record !== null && record.date === lastPerformedOn);

    records.push({
      exerciseId,
      exerciseName: ordered[0]!.exerciseName,
      heaviest,
      mostReps,
      bestEstimated1rm: bestE1rm,
      bestSessionVolume,
      lastPerformedOn,
      setOnLastSession,
    });
  }

  records.sort((a, b) =>
    compareDates(b.lastPerformedOn, a.lastPerformedOn)
    || a.exerciseName.localeCompare(b.exerciseName));

  return derived(
    records,
    'Personal records (Epley e1RM)',
    { ...inputs, exercises: records.length },
    // One session is a reading, not a record worth calling one.
    new Set(working.map((s) => s.sessionId)).size >= 3 ? 'HIGH' : 'MODERATE',
    ['e1RM is estimated from a working set, not from a tested max.'],
    working.length,
  );
}

export interface TrainingWeek {
  /** Monday of the week, in the user's own calendar. */
  weekStart: LocalDate;
  sessions: number;
  minutes: number | null;
  workingSets: number;
  volumeKg: number | null;
  averageRpe: number | null;
}

export interface TrainingConsistency {
  weeks: TrainingWeek[];
  /** Mean sessions per week across the whole window, including empty weeks. */
  sessionsPerWeek: number | null;
  averageSessionMinutes: number | null;
  averageRpe: number | null;
  /** Weeks in the window that recorded no session at all. */
  emptyWeeks: number;
}

/**
 * Training week by week (spec §12).
 *
 * EMPTY WEEKS COUNT. A month with three good weeks and one missed one is three
 * sessions a week, not four - averaging only the weeks that happened would
 * describe a training history nobody had. Every week in the window appears,
 * including the ones with nothing in them.
 *
 * Sets are matched to weeks by their session, so a week with sessions but no
 * set-level detail reports its sessions and a null volume rather than a zero.
 */
export function trainingConsistency(
  sessions: TrainingSession[],
  sets: LoggedSet[],
  end: LocalDate,
  weeks: number,
): Derived<TrainingConsistency> {
  const inputs = { end, weeks, sessionCount: sessions.length, setCount: sets.length };

  if (weeks < 1) {
    return insufficient<TrainingConsistency>(
      'Training consistency', inputs, 'A window of at least one week is needed.', 0,
    );
  }

  const lastWeekStart = startOfWeek(end);
  const starts: LocalDate[] = [];
  for (let i = weeks - 1; i >= 0; i -= 1) {
    starts.push(addDays(lastWeekStart, -7 * i));
  }
  const earliest = starts[0]!;

  const completed = sessions.filter((s) => s.completed && s.date >= earliest && s.date <= end);
  const working = workingSets(sets).filter((s) => s.date >= earliest && s.date <= end);

  if (completed.length === 0) {
    return insufficient<TrainingConsistency>(
      'Training consistency',
      inputs,
      `No training sessions recorded in the last ${weeks} weeks.`,
      0,
    );
  }

  const weekOf = (date: LocalDate): LocalDate => startOfWeek(date);
  const buckets = new Map<LocalDate, TrainingWeek>();
  for (const start of starts) {
    buckets.set(start, {
      weekStart: start, sessions: 0, minutes: null,
      workingSets: 0, volumeKg: null, averageRpe: null,
    });
  }

  const minutesByWeek = new Map<LocalDate, number[]>();
  const volumeByWeek = new Map<LocalDate, number[]>();
  const rpeByWeek = new Map<LocalDate, number[]>();

  for (const session of completed) {
    const week = buckets.get(weekOf(session.date));
    if (!week) continue;
    week.sessions += 1;
    if (session.durationMinutes !== null) {
      const list = minutesByWeek.get(week.weekStart) ?? [];
      list.push(session.durationMinutes);
      minutesByWeek.set(week.weekStart, list);
    }
  }

  for (const set of working) {
    const week = buckets.get(weekOf(set.date));
    if (!week) continue;
    week.workingSets += 1;
    const volume = setVolume(set);
    if (volume !== null) {
      const list = volumeByWeek.get(week.weekStart) ?? [];
      list.push(volume);
      volumeByWeek.set(week.weekStart, list);
    }
    if (set.rpe !== null) {
      const list = rpeByWeek.get(week.weekStart) ?? [];
      list.push(set.rpe);
      rpeByWeek.set(week.weekStart, list);
    }
  }

  for (const week of buckets.values()) {
    const minutes = minutesByWeek.get(week.weekStart);
    week.minutes = minutes?.length ? roundTo(minutes.reduce((a, b) => a + b, 0), 1) : null;
    const volume = volumeByWeek.get(week.weekStart);
    week.volumeKg = volume?.length ? roundTo(volume.reduce((a, b) => a + b, 0), 1) : null;
    const rpe = rpeByWeek.get(week.weekStart);
    week.averageRpe = rpe?.length ? roundTo(mean(rpe)!, 1) : null;
  }

  const ordered = [...buckets.values()];
  const allMinutes = completed
    .map((s) => s.durationMinutes)
    .filter((v): v is number => v !== null);
  const allRpe = working.map((s) => s.rpe).filter((v): v is number => v !== null);

  const value: TrainingConsistency = {
    weeks: ordered,
    // Divided by the whole window, empty weeks included.
    sessionsPerWeek: roundTo(completed.length / weeks, 2),
    averageSessionMinutes: allMinutes.length ? roundTo(mean(allMinutes)!, 1) : null,
    averageRpe: allRpe.length ? roundTo(mean(allRpe)!, 1) : null,
    emptyWeeks: ordered.filter((week) => week.sessions === 0).length,
  };

  const notes: string[] = [];
  if (value.emptyWeeks > 0) {
    notes.push(
      `${value.emptyWeeks} of ${weeks} weeks recorded no session. They are included `
      + 'in the average, which is what makes it an average per week rather than '
      + 'per week trained.',
    );
  }
  if (allRpe.length === 0) {
    notes.push('No RPE was recorded, so intensity is not summarised.');
  }

  return derived(
    value,
    'Training consistency',
    { ...inputs, sessionsCounted: completed.length, workingSetsCounted: working.length },
    weeks >= 4 ? 'HIGH' : 'MODERATE',
    notes,
    completed.length,
  );
}
