/**
 * Hevy's vocabulary -> CUT OS's, with nothing invented on the way.
 *
 * PURE. No Supabase, no I/O, no clock beyond what is handed in. That is what
 * makes the rules below testable in isolation, and it is the same bargain
 * lib/analytics and lib/normalization already strike.
 *
 * THIS FILE IS WHERE §4 IS ENFORCED, AND IT IS ENFORCED BY A TYPE.
 * NormalisedWorkout has no field for body weight, body fat, waist, any body
 * measurement, active calories, steps, heart rate, HRV, sleep, nutrition or
 * water. Hevy serves several of those - /v1/body_measurements alone carries
 * weight, lean mass, fat percent, waist, hips and every limb - and this
 * integration is for TRAINING. The writer accepts this type and only this type,
 * so writing a body measurement from a Hevy payload is not a rule someone must
 * remember; it is a value with nowhere to go.
 *
 * A VALUE OUT OF RANGE BECOMES NULL AND A WARNING, NEVER A CLAMP. Clamping an
 * RPE of 12 to 10 stores a number nobody reported, which is fabrication in the
 * one place it is easiest to excuse. Dropping it stores "not recorded", which
 * is true, and the warning is what stops the drop from being silent.
 *
 * SET TYPE IS CARRIED, NOT INTERPRETED. The published documentation elides the
 * members of Set.type - the schema shows `[...]` and only "normal" appears in
 * an example - so the raw string is stored and exactly one value is acted on:
 * `warmup`, which is what keeps a warm-up out of training volume. Every other
 * value is reported in the sync summary, so the first real sync says which set
 * types this account actually uses instead of leaving it to be guessed.
 */
import type { LocalDate } from '@/lib/types';
import type { SessionTypeEnum } from '@/lib/supabase/types';
import { toLocalDate } from '@/lib/normalization/dates';
import { toSessionType } from '@/lib/health/sessionTypes';
import type { HevyWorkout } from './types';

/** One set, in CUT OS's units and vocabulary. */
export interface NormalisedSet {
  /** 1-based, and continued across repeats of the same exercise in a workout. */
  setNumber: number;
  /** Hevy's own word for the set, verbatim. */
  setType: string | null;
  /** True only for the exact type `warmup`. Warm-ups are excluded from volume. */
  warmup: boolean;
  weightKg: number | null;
  reps: number | null;
  rpe: number | null;
  distanceKm: number | null;
  durationSeconds: number | null;
}

export interface NormalisedExercise {
  /** Hevy's stable template id: the key exercise resolution turns on. */
  templateId: string;
  title: string;
  /** Position within the workout, 0-based, as Hevy ordered it. */
  index: number;
  notes: string | null;
  supersetId: number | null;
  sets: NormalisedSet[];
}

/**
 * A workout, ready for the write path.
 *
 * Read the field list as a statement of scope: this is everything Hevy is
 * allowed to tell CUT OS. Adding a body-data field here would be the change
 * that breaks §4, which is why the boundary test reads this type.
 */
export interface NormalisedWorkout {
  externalId: string;
  externalUpdatedAt: string;
  localDate: LocalDate;
  /** Hevy's workout name. Kept whole, whatever sessionType it maps to. */
  title: string;
  /** Hevy's `description`: the workout note. */
  notes: string | null;
  startTime: string;
  endTime: string | null;
  durationMinutes: number | null;
  sessionType: SessionTypeEnum;
  exercises: NormalisedExercise[];
}

export interface MappedWorkout {
  workout: NormalisedWorkout;
  /** Everything the mapping could not carry cleanly, named. */
  warnings: string[];
  /** Distinct Set.type values seen, so a sync can report the vocabulary. */
  setTypes: string[];
}

/** Column bounds from 0004/0014, mirrored so a violation is caught before the write. */
const LIMITS = {
  /** workout_sets.rpe: numeric(3,1) check between 1 and 10. */
  rpe: { min: 1, max: 10 },
  /** workout_sets.weight_kg: numeric(6,2) check >= 0. */
  weightKg: { min: 0, max: 9999.99 },
  /** workout_sets.reps: smallint check >= 0. */
  reps: { min: 0, max: 32767 },
  /** workout_sessions.duration_minutes: numeric(6,1) check between 0 and 1440. */
  durationMinutes: { min: 0, max: 1440 },
  /** workout_sets.distance_km: numeric(7,3) check >= 0. */
  distanceKm: { min: 0, max: 9999.999 },
  /** workout_sets.superset_id / exercise_index: smallint. */
  smallint: { min: -32768, max: 32767 },
} as const;

/**
 * A number the database will accept, or null with a reason.
 *
 * The alternative - letting it through and finding out at the INSERT - fails
 * the whole workout over one bad field, and the check constraint's message says
 * nothing about which set it came from.
 */
function bounded(
  value: number | null,
  limit: { min: number; max: number },
  label: string,
  warnings: string[],
): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value)) {
    warnings.push(`${label} was not a finite number, so it was not recorded.`);
    return null;
  }
  if (value < limit.min || value > limit.max) {
    warnings.push(
      `${label} was ${value}, outside the range ${limit.min}–${limit.max} this app `
      + 'stores, so it was not recorded rather than being adjusted to fit.',
    );
    return null;
  }
  return value;
}

/**
 * Whether a set is a warm-up.
 *
 * Case and surrounding space are normalised - the same word written differently
 * is the same word - and nothing else is. A type of "dropset", "failure" or
 * anything else Hevy may use is NOT read as a warm-up and NOT read as anything
 * else either: it is stored verbatim and reported. Getting this wrong in the
 * permissive direction would quietly inflate training volume with warm-up sets.
 */
export function isWarmupSetType(setType: string | null): boolean {
  return setType !== null && setType.trim().toLowerCase() === 'warmup';
}

/** Minutes between two instants, or null when either is missing. */
export function durationMinutesBetween(
  startTime: string,
  endTime: string | null,
): number | null {
  if (endTime === null) return null;
  const start = Date.parse(startTime);
  const end = Date.parse(endTime);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.round(((end - start) / 60000) * 10) / 10;
}

/**
 * One Hevy workout, in CUT OS's terms.
 *
 * `timezone` is the profile's, and it decides which calendar day the workout
 * belongs to (§40). A session finishing at 23:30 belongs to that day, and to
 * the day it is 23:30 for the USER - never UTC's.
 */
export function mapWorkout(
  hevy: HevyWorkout,
  options: { timezone: string },
): MappedWorkout {
  const warnings: string[] = [];
  const setTypes = new Set<string>();

  let endTime = hevy.end_time;
  if (endTime !== null && Date.parse(endTime) < Date.parse(hevy.start_time)) {
    // An end before its start is a transcription error, not a measurement, and
    // the interval CHECK on workout_sessions would refuse the row anyway.
    warnings.push(
      `Workout "${hevy.title}" ended before it started, so its end time and `
      + 'duration were not recorded.',
    );
    endTime = null;
  }

  const durationMinutes = bounded(
    durationMinutesBetween(hevy.start_time, endTime),
    LIMITS.durationMinutes,
    `Duration of "${hevy.title}"`,
    warnings,
  );

  /**
   * Set numbers continue across repeats of one exercise.
   *
   * workout_sets is unique on (session_id, exercise_id, set_number), and a
   * workout may perform the same movement twice - Bench Press at position 0 and
   * again at position 5. Numbering per-occurrence would give both a set 1 and
   * the second block would be refused. Counting per template keeps every set,
   * keeps them ordered, and keeps the two blocks apart through exercise_index.
   */
  const nextSetNumber = new Map<string, number>();

  const exercises: NormalisedExercise[] = hevy.exercises.map((exercise) => {
    const label = `"${exercise.title}" in "${hevy.title}"`;

    return {
      templateId: exercise.exercise_template_id,
      title: exercise.title,
      index: bounded(exercise.index, LIMITS.smallint, `Position of ${label}`, warnings) ?? 0,
      notes: exercise.notes,
      supersetId: bounded(
        exercise.supersets_id, LIMITS.smallint, `Superset id of ${label}`, warnings,
      ),
      sets: exercise.sets.map((set) => {
        const setNumber = nextSetNumber.get(exercise.exercise_template_id) ?? 1;
        nextSetNumber.set(exercise.exercise_template_id, setNumber + 1);
        if (set.type !== null) setTypes.add(set.type);

        return {
          setNumber,
          setType: set.type,
          warmup: isWarmupSetType(set.type),
          weightKg: bounded(set.weight_kg, LIMITS.weightKg, `Load on set ${setNumber} of ${label}`, warnings),
          reps: (() => {
            const reps = bounded(set.reps, LIMITS.reps, `Reps on set ${setNumber} of ${label}`, warnings);
            return reps === null ? null : Math.round(reps);
          })(),
          rpe: bounded(set.rpe, LIMITS.rpe, `RPE on set ${setNumber} of ${label}`, warnings),
          // Metres to kilometres: storage is metric and distance is km
          // throughout (cardio_sessions.distance_km), so the conversion happens
          // once, here, at the boundary.
          distanceKm: (() => {
            if (set.distance_meters === null) return null;
            return bounded(
              Math.round((set.distance_meters / 1000) * 1000) / 1000,
              LIMITS.distanceKm,
              `Distance on set ${setNumber} of ${label}`,
              warnings,
            );
          })(),
          durationSeconds: (() => {
            const seconds = bounded(
              set.duration_seconds, { min: 0, max: 86_400 },
              `Duration of set ${setNumber} of ${label}`, warnings,
            );
            return seconds === null ? null : Math.round(seconds);
          })(),
        };
      }),
    };
  });

  const type = toSessionType(hevy.title);

  return {
    workout: {
      externalId: hevy.id,
      externalUpdatedAt: hevy.updated_at,
      localDate: toLocalDate(new Date(hevy.start_time), options.timezone),
      title: hevy.title,
      // Hevy's `description` IS the workout note. There is no `notes` field on
      // a workout, and this is the one the user specifically asked to keep.
      notes: hevy.description,
      startTime: hevy.start_time,
      endTime,
      durationMinutes,
      // A title that maps to nothing lands on OTHER and is kept whole in
      // `title` - the same bargain lib/health/sessionTypes.ts strikes for a
      // pasted label. Nothing is lost by an unrecognised name.
      sessionType: type.value,
      exercises,
    },
    warnings,
    setTypes: [...setTypes].sort(),
  };
}
