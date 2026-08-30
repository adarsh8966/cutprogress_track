/**
 * Database rows -> domain objects. Pure, and deliberately importable without
 * `server-only`.
 *
 * The mapping is where a stored value most easily stops being represented: a
 * column selected but never mapped is invisible to every page while looking
 * perfectly healthy in the database. That has happened twice in this codebase
 * already, so the mapper is a testable unit rather than a closure inside a
 * query function no test can call.
 *
 * Every numeric column goes through toNumber(), which preserves null as null:
 * PostgREST returns numerics as strings in some configurations, and Number(null)
 * would produce 0 - the missing-data bug spec §33 exists to prevent.
 */
import type { DailyMetrics, Instant, LocalDate, UserProfile } from '@/lib/types';
import type {
  DailyMetricsRow, ProfileRow, WorkoutSetRow, WorkoutSessionRow, ExerciseRow,
} from '@/lib/supabase/types';
import type { LoggedSet, TrainingSession } from '@/lib/analytics/training';
import type { Exercise } from '@/lib/health/catalog';
import { toNumber } from '@/lib/normalization/numbers';

/**
 * A `date` column as the `YYYY-MM-DD` string LocalDate claims to be.
 *
 * Same reasoning as toNumber() below, for the column that matters most. What a
 * driver hands back for a `date` is not guaranteed to be a string: PostgREST
 * serialises it to text, other drivers return a Date object at UTC midnight.
 *
 * And localDate is not just another field - it is the KEY every series is
 * built on. A Date arriving where a string was expected does not misformat one
 * figure; it makes `'2026-11-02'` fail to match `'2026-11-02T00:00:00.000Z'`,
 * so every trailing window, every latest reading and every chart silently
 * finds nothing for a day that is sitting right there.
 *
 * The UTC parts are read deliberately. A date column carries no time zone, and
 * reading it through local-time getters west of Greenwich would move the whole
 * series back a day.
 */
export function toLocalDate(value: unknown): LocalDate {
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

/**
 * A `timestamptz` column as the ISO-8601 string Instant claims to be.
 *
 * The same hazard as toLocalDate above, one column type over: PostgREST
 * serialises a timestamptz to text, while node-postgres and PGlite hand back a
 * Date object. Left uncoerced, a Date arrives where a string is declared, and
 * every consumer that compares two of them as text silently stops ordering -
 * which is the one thing these columns are being mapped for.
 *
 * Normalised to UTC, so two instants that came from two drivers, or that were
 * written with different offsets, compare as strings as well as they compare
 * as times. Postgres' own `2026-08-29 22:00:00+00` parses too.
 *
 * An unreadable value becomes null rather than a guess or an epoch: a time
 * that cannot be read is not known, and null already means exactly that here
 * (spec §7, §33).
 */
export function toInstant(value: unknown): Instant | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

export function rowToProfile(row: ProfileRow): UserProfile {
  return {
    heightCm: toNumber(row.height_cm),
    sex: row.sex,
    dateOfBirth: row.date_of_birth,
    timezone: row.timezone,
    startingWeightKg: toNumber(row.starting_weight_kg),
    targetWeightKg: toNumber(row.target_weight_kg),
    phase: row.phase,
    targets: {
      calories: toNumber(row.target_calories),
      proteinG: toNumber(row.target_protein_g),
      fiberG: toNumber(row.target_fiber_g),
      steps: toNumber(row.target_steps),
      trainingSessionsPerWeek: toNumber(row.target_training_sessions_per_week),
      cardioMinutesPerWeek: toNumber(row.target_cardio_minutes_per_week),
    },
    maxWeeklyLossRatePct: toNumber(row.max_weekly_loss_rate_pct) ?? 1,
    cutStartDate: row.cut_start_date,
    weightDisplayUnit: row.weight_display_unit,
    distanceDisplayUnit: row.distance_display_unit,
    lengthDisplayUnit: row.length_display_unit,
  };
}

/**
 * One canonical day.
 *
 * EVERY measurement column on daily_metrics is mapped here. A column added to
 * the table and to DailyMetrics but forgotten here is stored, resolved and
 * unreachable - see tests/unit/canonical-readers.test.ts, which fails when a
 * field has no reader.
 */
export function rowToDailyMetrics(row: DailyMetricsRow): DailyMetrics {
  return {
    localDate: toLocalDate(row.local_date),
    weightKg: toNumber(row.weight_kg),
    waistCm: toNumber(row.waist_cm),
    steps: toNumber(row.steps),
    activeCalories: toNumber(row.active_calories),
    totalCaloriesBurned: toNumber(row.total_calories_burned),
    workoutMinutes: toNumber(row.workout_minutes),
    cardioMinutes: toNumber(row.cardio_minutes),
    zone2Minutes: toNumber(row.zone2_minutes),
    restingHeartRate: toNumber(row.resting_heart_rate),
    hrvMs: toNumber(row.hrv_ms),
    sleepDurationMinutes: toNumber(row.sleep_duration_minutes),
    sleepScore: toNumber(row.sleep_score),
    // 0016. Mapped here or they are invisible to every page - a column selected
    // and not mapped looks healthy in the database and reaches nothing, which
    // this file's header records having happened twice already.
    bodyFatPct: toNumber(row.body_fat_pct),
    vo2Max: toNumber(row.vo2_max),
    distanceKm: toNumber(row.distance_km),
    floors: toNumber(row.floors),
    activeMinutes: toNumber(row.active_minutes),
    activeZoneMinutes: toNumber(row.active_zone_minutes),
    respiratoryRate: toNumber(row.respiratory_rate),
    oxygenSaturationPct: toNumber(row.oxygen_saturation_pct),
    remMinutes: toNumber(row.rem_minutes),
    deepMinutes: toNumber(row.deep_minutes),
    lightMinutes: toNumber(row.light_minutes),
    awakeMinutes: toNumber(row.awake_minutes),
    sleepTemperatureDeltaC: toNumber(row.sleep_temperature_delta_c),
    caloriesConsumed: toNumber(row.calories_consumed),
    proteinG: toNumber(row.protein_g),
    carbsG: toNumber(row.carbs_g),
    fatG: toNumber(row.fat_g),
    fiberG: toNumber(row.fiber_g),
    fruitVegServings: toNumber(row.fruit_veg_servings),
    trainingSessions: toNumber(row.training_sessions),
  };
}

export function rowsToDailyMetrics(rows: DailyMetricsRow[]): DailyMetrics[] {
  return rows.map(rowToDailyMetrics);
}

/**
 * Sets, joined to the session they belong to and the exercise they name.
 *
 * PURE, AND THAT IS THE POINT. This used to be a closure inside getLoggedSets()
 * over a PostgREST embedded select - `workout_sessions!inner(local_date)` -
 * which no test could call and which quietly returned an embedded row as either
 * an object or a one-element array depending on the query. It also had no way
 * to express the rule below, so it did not: a session withdrawn by a correction
 * went on contributing its sets to volume, e1RM and every muscle-group total,
 * on every page, indefinitely.
 *
 * TWO SUPERSESSION RULES, BOTH REQUIRED, AND NEITHER IS THE OTHER:
 *
 *   a set removed at the source stops counting        (workout_sets, 0014)
 *   a session withdrawn takes ALL its sets with it    (workout_sessions, 0011)
 *
 * The second is the one that was missing. A withdrawn session is not a session
 * whose sets are individually marked - marking them would be a second, lossier
 * record of the same fact - so the sets have to be excluded by their parent.
 * Filtering happens HERE rather than in SQL so that both rules are one readable
 * expression a test can drive, instead of a filter on an embedded resource that
 * only a live PostgREST can evaluate.
 *
 * A set whose exercise is missing is DROPPED rather than named "Unknown". The
 * foreign key makes that unreachable in practice; if it ever happens, a set
 * with a fabricated exercise name is worse than a set that is absent, because
 * it would be silently attributed to the wrong movement.
 *
 * Ordered as the source ordered it: exercise block first, then set number.
 * A set with no exercise_index sorts last - it was logged by hand, where the
 * only order is the order it was entered in.
 */
export function joinLoggedSets(
  sessions: Pick<WorkoutSessionRow, 'id' | 'local_date' | 'superseded_at'>[],
  sets: WorkoutSetRow[],
  exercises: Pick<ExerciseRow, 'exercise_id' | 'name' | 'primary_muscle_group'>[],
): LoggedSet[] {
  const liveSessions = new Map<string, LocalDate>();
  for (const session of sessions) {
    // `== null` accepts undefined too, exactly as canonicalise.ts does: a row
    // read back from a project still on an older migration has no such key at
    // all, and reading that as "withdrawn" would empty the page rather than
    // fill it. A withdrawal has to be stated to count.
    if (session.superseded_at == null) {
      liveSessions.set(session.id, toLocalDate(session.local_date));
    }
  }

  const byExercise = new Map(exercises.map((e) => [e.exercise_id, e]));

  return sets
    .filter((set) => set.superseded_at == null && liveSessions.has(set.session_id))
    .flatMap((set) => {
      const exercise = byExercise.get(set.exercise_id);
      if (!exercise) return [];
      return [{
        date: liveSessions.get(set.session_id)!,
        sessionId: set.session_id,
        exerciseId: set.exercise_id,
        exerciseName: exercise.name,
        primaryMuscleGroup: exercise.primary_muscle_group,
        setNumber: toNumber(set.set_number) ?? 0,
        weightKg: toNumber(set.weight_kg),
        reps: toNumber(set.reps),
        rir: toNumber(set.rir),
        rpe: toNumber(set.rpe),
        warmup: set.warmup,
        exerciseIndex: toNumber(set.exercise_index),
        exerciseNotes: set.exercise_notes,
        setType: set.set_type,
        supersetId: toNumber(set.superset_id),
        distanceKm: toNumber(set.distance_km),
        durationSeconds: toNumber(set.duration_seconds),
      }];
    })
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? -1 : 1;
      const ai = a.exerciseIndex ?? Number.MAX_SAFE_INTEGER;
      const bi = b.exerciseIndex ?? Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      return a.setNumber - b.setNumber;
    });
}

/**
 * A session row as the analytics and the Training page read it.
 *
 * Extracted here for the same reason as the mapper above: `title` and
 * `external_source` are new columns, and a column that is selected but never
 * mapped is invisible to every page while looking perfectly healthy in the
 * database.
 *
 * `start_time` and `end_time` were exactly that for far longer. They have been
 * written since 0004 by all three writers - the Hevy sync, the logger and the
 * paste importer - selected by `select('*')` on every read, and mapped by
 * nothing, so the true order of two sessions on one day was unknowable
 * downstream of a table that had known it all along.
 *
 * duration_minutes is NOT re-derived from the pair. A row that has both
 * instants and a null duration keeps the null: computing one would infer a
 * measurement the source never reported, and it feeds the duration-weighted
 * average heart rate in summariseSessions.
 */
export function rowToTrainingSession(row: WorkoutSessionRow): TrainingSession {
  return {
    id: row.id,
    date: toLocalDate(row.local_date),
    startTime: toInstant(row.start_time),
    endTime: toInstant(row.end_time),
    sessionType: row.session_type as string,
    title: row.title,
    externalSource: row.external_source,
    durationMinutes: toNumber(row.duration_minutes),
    averageHeartRate: toNumber(row.average_heart_rate),
    maxHeartRate: toNumber(row.max_heart_rate),
    calories: toNumber(row.calories),
    notes: row.notes,
    source: row.source as string,
    completed: row.completed,
    importId: row.import_id,
  };
}

/**
 * An exercise row as the pickers and the catalog helpers read one.
 *
 * The shape is the catalog's, deliberately: data/exercises/catalog.json seeds
 * this table and lib/health/catalog.ts already validates that shape, so a row
 * read back from the database and an entry read out of the JSON are the same
 * kind of thing to everything downstream. What differs is only WHICH exercises
 * exist - the database also holds the ones a sync created.
 */
export function rowToExercise(row: ExerciseRow): Exercise {
  return {
    exerciseId: row.exercise_id,
    name: row.name,
    primaryMuscleGroup: row.primary_muscle_group,
    equipment: row.equipment,
    nippardTier: row.nippard_tier,
    muscleSubgroups: row.muscle_subgroups ?? [],
    demonstrationUrl: row.demonstration_url,
    active: row.active,
    apartmentGym: row.apartment_gym,
  };
}
