import 'server-only';

/**
 * Writing a Hevy workout into CUT OS's own tables (spec §11, §17, §38, §48).
 *
 * THIS IS NOT A HEVY WRITE PATH. It writes workout_sessions, workout_sets,
 * exercises and health_imports - the tables the manual logger and the paste
 * importer already write - so a synced workout is read by getWorkoutSessions,
 * counted by rebuildDailyMetrics and analysed by lib/analytics/training exactly
 * as any other. There is no parallel model and no second canonical layer.
 *
 * THE CLIENT IS ALWAYS INJECTED. This module never constructs one, and in
 * particular never reaches for the service-role client: it is handed whichever
 * client the caller is entitled to use - the signed-in user's under RLS from a
 * server action, or the scheduled one - and every statement is scoped by an
 * explicit user_id besides. The second belt matters because the scheduled
 * caller has no RLS behind it.
 *
 * IDEMPOTENCY IS THE DATABASE'S JOB, IN TWO PLACES:
 *
 *   health_imports  UNIQUE (user_id, idempotency_key), where the key is the
 *                   workout id and its updated_at. An unchanged workout is
 *                   refused here, which is what makes re-syncing free.
 *   workout_sessions UNIQUE (user_id, external_source, external_id). At most
 *                   one session per Hevy workout can exist, so an update is an
 *                   UPDATE of the row that is already there - there is no path
 *                   by which a second one gets written and the day's minutes
 *                   become the sum of two readings of one session.
 *
 * NOTHING IS DELETED. A set removed in Hevy is marked superseded and keeps
 * every value it recorded; a workout deleted in Hevy withdraws the session the
 * same way a user withdrawing it by hand would (§48).
 */
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/supabase/types';
import type { LocalDate } from '@/lib/types';
import { externalIdempotencyKey } from '@/lib/health/idempotency';
import { toLocalDate } from '@/lib/data/rows';
import type { MappedWorkout } from './mapper';
import type { ExerciseResolver } from './exerciseResolver';
import { HEVY_SOURCE } from './exercises';

type Client = SupabaseClient<Database>;

export const HEVY_PARSER_NAME = 'hevy-api';
export const HEVY_PARSER_VERSION = '0.1.0';

/** PostgreSQL's unique_violation. The signal that idempotency did its job. */
const UNIQUE_VIOLATION = '23505';

export type WriteOutcome = 'CREATED' | 'UPDATED' | 'UNCHANGED' | 'FAILED';

export interface WriteResult {
  outcome: WriteOutcome;
  externalId: string;
  /** The day whose canonical row needs rebuilding. Null when nothing changed. */
  localDate: LocalDate | null;
  /**
   * The day this workout used to be on, when it moved.
   *
   * A field rather than a sentence in `message`, because the caller has to ACT
   * on it: the day a workout left is left holding a rollup that still counts
   * it, and only a rebuild of that day fixes it. Parsing it back out of prose
   * would make the correctness of the totals depend on the wording.
   */
  previousLocalDate: LocalDate | null;
  message: string | null;
  warnings: string[];
}

/**
 * One workout, written or confirmed to be already written.
 *
 * `raw` is the untouched response body. It is stored verbatim and forever
 * (§17): if the mapping turns out to be wrong in six months, every workout can
 * be re-derived from what Hevy actually said, without asking Hevy again - which
 * matters most for the workouts that have since been edited or deleted there.
 */
export async function writeWorkout(
  supabase: Client,
  userId: string,
  mapped: MappedWorkout,
  raw: unknown,
  exercises: ExerciseResolver,
): Promise<WriteResult> {
  const { workout } = mapped;
  const warnings = [...mapped.warnings];
  const fail = (message: string): WriteResult => ({
    outcome: 'FAILED', externalId: workout.externalId, localDate: null,
    previousLocalDate: null, message, warnings,
  });

  const key = externalIdempotencyKey(
    HEVY_SOURCE, workout.externalId, workout.externalUpdatedAt,
  );

  // ---------------------------------------------------------------- §17, §38
  // The payload is stored BEFORE anything is derived from it, exactly as
  // app/actions/import.ts stores a paste before writing a measurement.
  const created = await supabase
    .from('health_imports')
    .insert({
      user_id: userId,
      raw_text: JSON.stringify(raw),
      parsed: workout as unknown as Record<string, unknown>,
      confirmed: null,
      parser_name: HEVY_PARSER_NAME,
      parser_version: HEVY_PARSER_VERSION,
      target_local_date: workout.localDate,
      source: 'HEVY',
      status: 'PENDING',
      confirmed_at: null,
      idempotency_key: key,
    })
    .select('id')
    .single();

  let importId: string;

  if (created.error) {
    if (created.error.code !== UNIQUE_VIOLATION) return fail(created.error.message);

    // This exact version of this workout has been seen before. That is either
    // "nothing changed" or "an earlier attempt died partway", and the two are
    // told apart the same way importOneRecord tells them apart.
    const existing = await supabase
      .from('health_imports')
      .select('id, status')
      .eq('user_id', userId)
      .eq('idempotency_key', key)
      .maybeSingle();
    if (existing.error) return fail(existing.error.message);
    if (!existing.data) return fail(created.error.message);

    if (existing.data.status === 'CONFIRMED') {
      return {
        outcome: 'UNCHANGED',
        externalId: workout.externalId,
        localDate: null,
        previousLocalDate: null,
        message: null,
        warnings,
      };
    }

    // Resume into the earlier attempt's row. Safe to replay without any of the
    // bookkeeping the paste importer needs, because every write below is KEYED:
    // the session by its external id, each set by its exercise and number. A
    // second run rewrites the same rows rather than adding to them.
    importId = existing.data.id;
  } else {
    importId = created.data.id;
  }

  // ------------------------------------------------------------- the exercises
  const resolved = new Map<string, string>();
  for (const exercise of workout.exercises) {
    const result = await exercises.resolve({
      id: exercise.templateId,
      title: exercise.title,
    });
    if (!result.ok) return fail(`Exercise "${exercise.title}": ${result.message}`);
    resolved.set(exercise.templateId, result.exerciseId);
    warnings.push(...result.warnings);
  }

  // --------------------------------------------------------------- the session
  const existingSession = await supabase
    .from('workout_sessions')
    .select('id, local_date')
    .eq('user_id', userId)
    .eq('external_source', HEVY_SOURCE)
    .eq('external_id', workout.externalId)
    .maybeSingle();
  if (existingSession.error) return fail(existingSession.error.message);

  const fields = {
    local_date: workout.localDate,
    start_time: workout.startTime,
    end_time: workout.endTime,
    duration_minutes: workout.durationMinutes,
    session_type: workout.sessionType,
    title: workout.title,
    notes: workout.notes,
    completed: true,
    source: 'HEVY' as const,
    import_id: importId,
    external_source: HEVY_SOURCE,
    external_id: workout.externalId,
    external_updated_at: workout.externalUpdatedAt,
    // Hevy's workout payload carries no heart rate and no energy figure, so
    // these stay NULL - "not reported", never zero (§33). They are named rather
    // than omitted so an edit at the source cannot leave a stale value behind
    // from some earlier writer.
    average_heart_rate: null,
    max_heart_rate: null,
    calories: null,
  };

  let sessionId: string;
  let outcome: WriteOutcome;
  /** A workout moved to another day leaves the day it left needing a rebuild. */
  let previousDate: LocalDate | null = null;

  if (existingSession.data) {
    sessionId = existingSession.data.id;
    outcome = 'UPDATED';
    // toLocalDate, not a bare comparison: what a driver returns for a `date`
    // column is not guaranteed to be a string (lib/data/rows.ts says why), and
    // a Date object compared against 'YYYY-MM-DD' is never equal - which would
    // report every re-sync as a day move and rebuild a day for no reason.
    const wasOn = toLocalDate(existingSession.data.local_date);
    if (wasOn !== workout.localDate) previousDate = wasOn;
    // UPDATE, not insert-and-supersede: the row's identity is the point. Its id
    // is the /training/<id> URL, and the unique index means there is exactly one
    // row to update, so a re-sync cannot make the day total two readings of one
    // session - the arithmetic migration 0011 exists to prevent.
    const updated = await supabase
      .from('workout_sessions')
      .update({ ...fields, superseded_at: null, superseded_by: null })
      .eq('id', sessionId)
      .eq('user_id', userId);
    if (updated.error) return fail(updated.error.message);
  } else {
    const inserted = await supabase
      .from('workout_sessions')
      .insert({ user_id: userId, ...fields })
      .select('id')
      .single();
    if (inserted.error || !inserted.data) {
      return fail(inserted.error?.message ?? 'the session could not be written.');
    }
    sessionId = inserted.data.id;
    outcome = 'CREATED';
  }

  // ------------------------------------------------------------------ the sets
  const setsFailure = await writeSets(
    supabase, userId, sessionId, mapped, resolved,
  );
  if (setsFailure) return fail(setsFailure);

  // Only now is this version of the workout fully written.
  const confirmed = await supabase
    .from('health_imports')
    .update({
      status: 'CONFIRMED',
      confirmed_at: new Date().toISOString(),
      confirmed: {
        sessionId,
        outcome,
        exercises: workout.exercises.length,
        sets: workout.exercises.reduce((total, e) => total + e.sets.length, 0),
      },
    })
    .eq('id', importId)
    .eq('user_id', userId);
  if (confirmed.error) return fail(confirmed.error.message);

  return {
    outcome,
    externalId: workout.externalId,
    localDate: workout.localDate,
    previousLocalDate: previousDate,
    message: previousDate === null
      ? null
      : `"${workout.title}" moved from ${previousDate} to ${workout.localDate}.`,
    warnings,
  };
}

/**
 * The session's sets, keyed rather than replaced.
 *
 * The key is (exercise_id, set_number), which is the table's own unique
 * constraint, and the mapper produces it deterministically - so the same
 * workout mapped twice asks for the same rows twice. That gives three cases and
 * no fourth:
 *
 *   in both      UPDATE in place, and un-supersede it if it had been removed
 *                and has since come back. workout_sets permits update by
 *                design (0008: a rep count gets corrected mid-set), and here
 *                the source is the authority on what the set was.
 *   new          INSERT
 *   gone         MARK SUPERSEDED. Never deleted: the set keeps every value it
 *                recorded and stops counting (§48).
 */
async function writeSets(
  supabase: Client,
  userId: string,
  sessionId: string,
  mapped: MappedWorkout,
  resolved: Map<string, string>,
): Promise<string | null> {
  const existing = await supabase
    .from('workout_sets')
    .select('id, exercise_id, set_number, superseded_at')
    .eq('session_id', sessionId)
    .eq('user_id', userId);
  if (existing.error) return existing.error.message;

  const keyOf = (exerciseId: string, setNumber: number) => `${exerciseId}#${setNumber}`;
  const onDisk = new Map(
    (existing.data ?? []).map((row) => [keyOf(row.exercise_id, row.set_number), row]),
  );

  const wanted = new Set<string>();
  const now = new Date().toISOString();

  for (const exercise of mapped.workout.exercises) {
    const exerciseId = resolved.get(exercise.templateId)!;

    for (const set of exercise.sets) {
      const key = keyOf(exerciseId, set.setNumber);
      wanted.add(key);

      const row = {
        exercise_index: exercise.index,
        exercise_notes: exercise.notes,
        superset_id: exercise.supersetId,
        set_type: set.setType,
        weight_kg: set.weightKg,
        reps: set.reps,
        rpe: set.rpe,
        distance_km: set.distanceKm,
        duration_seconds: set.durationSeconds,
        warmup: set.warmup,
        // Hevy records RPE, not RIR, and its workout payload carries no rest
        // taken - `rest_seconds` exists only on a ROUTINE, which is planned
        // rest and a different measurement. Both stay NULL rather than being
        // derived from something that is not them.
        rir: null,
        rest_seconds: null,
        to_failure: false,
        notes: null,
      };

      const found = onDisk.get(key);
      if (found) {
        const updated = await supabase
          .from('workout_sets')
          // A set that was removed at the source and has come back is restored
          // rather than duplicated - the same restore corrections.ts performs.
          .update({ ...row, superseded_at: null, superseded_by: null })
          .eq('id', found.id)
          .eq('user_id', userId);
        if (updated.error) return updated.error.message;
      } else {
        const inserted = await supabase.from('workout_sets').insert({
          user_id: userId,
          session_id: sessionId,
          exercise_id: exerciseId,
          set_number: set.setNumber,
          ...row,
        });
        if (inserted.error) return inserted.error.message;
      }
    }
  }

  const removed = (existing.data ?? []).filter(
    (row) => row.superseded_at === null && !wanted.has(keyOf(row.exercise_id, row.set_number)),
  );
  for (const row of removed) {
    const marked = await supabase
      .from('workout_sets')
      .update({ superseded_at: now })
      .eq('id', row.id)
      .eq('user_id', userId);
    if (marked.error) return marked.error.message;
  }

  return null;
}

/**
 * A workout deleted at the source.
 *
 * Withdrawn, not deleted - the same mechanism a user gets from the day view,
 * and for the same reason (§48). The session keeps every value it recorded and
 * every set stays attached to it; it simply stops counting, which is what
 * joinLoggedSets and rebuildDailyMetrics already honour. `superseded_by` is
 * NULL because nothing replaced it: this is a withdrawal, not a correction.
 *
 * A deletion IS worth an audit entry, and it is the only thing a sync writes to
 * that log: it is the one event that takes data out of a day. Created and
 * updated workouts are recorded in sync_runs instead, so a backfill of several
 * hundred cannot bury the target changes the log exists to make visible.
 */
export async function withdrawWorkout(
  supabase: Client,
  userId: string,
  externalId: string,
  deletedAt: string | null,
): Promise<{ withdrawn: boolean; localDate: LocalDate | null; message: string | null }> {
  const found = await supabase
    .from('workout_sessions')
    .select('id, local_date, title, superseded_at')
    .eq('user_id', userId)
    .eq('external_source', HEVY_SOURCE)
    .eq('external_id', externalId)
    .maybeSingle();
  if (found.error) {
    return { withdrawn: false, localDate: null, message: found.error.message };
  }
  // A workout deleted at the source that never reached here is not a problem to
  // solve. There is nothing to withdraw and nothing to report.
  if (!found.data) return { withdrawn: false, localDate: null, message: null };
  if (found.data.superseded_at !== null) {
    return { withdrawn: false, localDate: null, message: null };
  }

  const marked = await supabase
    .from('workout_sessions')
    .update({ superseded_at: deletedAt ?? new Date().toISOString(), superseded_by: null })
    .eq('id', found.data.id)
    .eq('user_id', userId);
  if (marked.error) {
    return { withdrawn: false, localDate: null, message: marked.error.message };
  }

  await supabase.from('system_events').insert({
    user_id: userId,
    kind: 'OBSERVATION_SUPERSEDED',
    summary:
      `Withdrew the training session "${found.data.title ?? externalId}" on `
      + `${found.data.local_date}: it was deleted in Hevy.`,
    detail: { table: 'workout_sessions', sessionId: found.data.id, externalId },
    previous_value: null,
    new_value: null,
    reason: 'The workout was deleted at its source. The record is kept and no longer counts.',
    status: 'RECORDED',
  });

  return {
    withdrawn: true,
    localDate: toLocalDate(found.data.local_date),
    message: null,
  };
}

/** Stable hash of a payload, for tests that assert a replay changed nothing. */
export function payloadFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
