import 'server-only';

/**
 * A normalised Google Health record -> the tables CUT OS already has.
 *
 * CLIENT-AGNOSTIC AND USER-SCOPED. This file constructs no Supabase client. It
 * takes the one its caller is entitled to use - today only the Sync button's,
 * which is the signed-in user's and runs under RLS - plus a userId that every
 * read and write is filtered by regardless. RLS is the boundary; the explicit
 * filter is a second belt, free to keep and the half that would be missing if a
 * caller without a session ever appeared.
 *
 * THERE IS NO GOOGLE HEALTH WRITE PATH. Weight goes to body_measurements. Steps
 * and heart-rate summaries go to metric_observations. Sleep goes to
 * sleep_records. A workout goes to workout_sessions or cardio_sessions. These
 * are the same tables the manual logger and the paste importer write, so a
 * synced measurement is read, resolved and analysed by everything downstream
 * exactly as a typed one is. The only table this integration owns is
 * external_observations, which holds the provider's record verbatim and is read
 * by nothing downstream.
 *
 * TWO WRITES, IN THIS ORDER, ALWAYS:
 *
 *   1. the domain row - the measurement, in the table that measurement lives in
 *   2. external_observations - the raw record, pointing at what it became
 *
 * That order matters on failure. If the second write fails, the measurement is
 * still recorded and the next sync re-writes it (the idempotency index refuses
 * only when the external row exists, so a missing one means "do it again").
 * The reverse order would mark a record as ingested and then lose it.
 *
 * AN UPDATED RECORD IS A NEW OBSERVATION, NOT AN EDIT. The observation tables
 * grant no UPDATE on their measurement columns - only on the supersession pair
 * - so a value corrected at the source cannot overwrite the one already here.
 * The old row is MARKED and a new one is written beside it, which is the same
 * correction semantics the whole raw layer uses and means nothing is ever lost.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, MetricKeyEnum } from '@/lib/supabase/types';
import type { LocalDate } from '@/lib/types';
import type { DataTypeSpec } from './registry';
import type {
  NormalisedObservation, NormalisedSleep, NormalisedExercise,
} from './mapper';
import { GOOGLE_HEALTH_SOURCE } from './mapper';

type Client = SupabaseClient<Database>;

export const GOOGLE_HEALTH_PROVIDER = 'google-health';
/** The value written to external_source columns. Matches the data_source enum. */
export const GOOGLE_HEALTH_EXTERNAL_SOURCE = 'GOOGLE_HEALTH';

const UNIQUE_VIOLATION = '23505';

export type WriteOutcome = 'CREATED' | 'UPDATED' | 'UNCHANGED' | 'SKIPPED' | 'FAILED';

export interface WriteResult {
  outcome: WriteOutcome;
  externalId: string;
  localDate: LocalDate | null;
  /** Set when a correction moved the record to a different day. */
  previousLocalDate: LocalDate | null;
  message: string | null;
  warnings: string[];
}

function result(partial: Partial<WriteResult> & { externalId: string }): WriteResult {
  return {
    outcome: 'FAILED',
    localDate: null,
    previousLocalDate: null,
    message: null,
    warnings: [],
    ...partial,
  };
}

/**
 * A timestamp as a comparable string, whatever the driver handed back.
 *
 * PostgREST serialises a timestamptz to ISO-8601 text; PGlite and node-postgres
 * return a Date object. This function is what decides whether a record has
 * ALREADY BEEN IMPORTED, by comparing the version on file with the version that
 * just arrived - so a Date meeting a string here does not degrade the
 * comparison, it makes every re-sync look like a correction: the old row is
 * superseded, a new one is inserted, and the insert is then refused by the
 * unique index. The day ends up with no live record at all.
 *
 * The same hazard, and the same fix, as toIsoString in lib/data/canonicalise.ts.
 */
function versionOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
  }
  if (value instanceof Date) return value.toISOString();
  return null;
}

interface ExistingRecord {
  id: string;
  externalUpdatedAt: string | null;
  mappedTo: string | null;
  mappedId: string | null;
  supersededAt: string | null;
}

/**
 * What this provider has already recorded for one external id.
 *
 * Every version, newest first, so the caller can tell "already have this exact
 * version" from "have an older version of this" - which are the two questions
 * that decide between doing nothing and writing a correction.
 */
async function existingVersions(
  supabase: Client,
  userId: string,
  dataType: string,
  externalId: string,
): Promise<{ rows: ExistingRecord[] } | { error: string }> {
  const { data, error } = await supabase
    .from('external_observations')
    .select('*')
    .eq('user_id', userId)
    .eq('provider', GOOGLE_HEALTH_PROVIDER)
    .eq('data_type', dataType)
    .eq('external_id', externalId);

  if (error) return { error: error.message };
  return {
    rows: (data ?? []).map((row) => ({
      id: row.id,
      externalUpdatedAt: versionOf(row.external_updated_at),
      mappedTo: row.mapped_to,
      mappedId: row.mapped_id,
      supersededAt: row.superseded_at,
    })),
  };
}

/**
 * Marks a superseded record and the domain row it produced.
 *
 * Both, or the day double-counts: the canonical rebuild reads the domain
 * tables, so a superseded external record whose measurement is still live
 * changes nothing at all. The external row is marked too because it is the
 * ledger, and a ledger that does not record a withdrawal is not one.
 */
async function withdrawVersion(
  supabase: Client,
  userId: string,
  version: ExistingRecord,
  at: string,
): Promise<string | null> {
  if (version.supersededAt !== null) return null;

  const marked = await supabase
    .from('external_observations')
    .update({ superseded_at: at })
    .eq('id', version.id)
    .eq('user_id', userId);
  if (marked.error) return marked.error.message;

  if (version.mappedTo === null || version.mappedId === null) return null;

  // Only the tables this integration writes. A mapped_to naming anything else
  // is a bug here, and refusing it is better than issuing an update against a
  // table this file has no business touching.
  const withdrawable = new Set([
    'body_measurements', 'metric_observations', 'sleep_records', 'cardio_sessions',
  ]);
  if (!withdrawable.has(version.mappedTo)) return null;

  const domain = await supabase
    .from(version.mappedTo as 'metric_observations')
    .update({ superseded_at: at })
    .eq('id', version.mappedId)
    .eq('user_id', userId);
  return domain.error?.message ?? null;
}

/** Records the provider's raw record and what it became. */
async function recordExternal(
  supabase: Client,
  userId: string,
  record: {
    dataType: string;
    externalId: string;
    externalUpdatedAt: string | null;
    recordType: NormalisedObservation['recordType'];
    observedAt: string | null;
    intervalStart: string | null;
    intervalEnd: string | null;
    utcOffsetSeconds: number | null;
    localDate: LocalDate;
    value: number | null;
    unit: string | null;
    payload: unknown;
    mappedTo: string | null;
    mappedId: string | null;
  },
): Promise<string | null> {
  const { error } = await supabase.from('external_observations').insert({
    user_id: userId,
    provider: GOOGLE_HEALTH_PROVIDER,
    data_type: record.dataType,
    external_id: record.externalId,
    external_updated_at: versionOf(record.externalUpdatedAt),
    record_type: record.recordType,
    observed_at: record.observedAt,
    interval_start: record.intervalStart,
    interval_end: record.intervalEnd,
    utc_offset_seconds: record.utcOffsetSeconds,
    local_date: record.localDate,
    value: record.value,
    unit: record.unit,
    payload: (record.payload ?? {}) as Record<string, unknown>,
    mapped_to: record.mappedTo,
    mapped_id: record.mappedId,
  });
  // A duplicate here means this exact version is already on file, which is the
  // idempotency guarantee doing its job rather than a failure.
  if (error && error.code !== UNIQUE_VIOLATION) return error.message;
  return null;
}

/**
 * Writes one scalar observation - a weight, a step count, a resting heart rate.
 *
 * The whole decision tree in one place:
 *   this exact version already on file    -> UNCHANGED, nothing written
 *   an older version on file              -> write the new value, withdraw the old
 *   nothing on file                       -> write it
 *   no canonical destination              -> SKIPPED, but the record is kept
 */
export async function writeObservation(
  supabase: Client,
  userId: string,
  observation: NormalisedObservation,
  spec: DataTypeSpec,
  options: { now?: () => Date } = {},
): Promise<WriteResult> {
  const now = options.now ?? (() => new Date());
  const base = { externalId: observation.externalId, warnings: observation.warnings };

  const existing = await existingVersions(
    supabase, userId, observation.dataType, observation.externalId,
  );
  if ('error' in existing) {
    return result({ ...base, message: `Could not check for an existing record: ${existing.error}` });
  }

  const thisVersion = versionOf(observation.externalUpdatedAt);
  const sameVersion = existing.rows.find((row) => row.externalUpdatedAt === thisVersion);
  if (sameVersion !== undefined && sameVersion.supersededAt === null) {
    return result({
      ...base, outcome: 'UNCHANGED', localDate: observation.timing.localDate,
    });
  }

  const live = existing.rows.filter((row) => row.supersededAt === null);
  const isCorrection = live.length > 0;

  let mappedTo: string | null = null;
  let mappedId: string | null = null;

  /**
   * A value that could not be read still gets its record kept, and nothing is
   * written to a measurement table. A null in metric_observations.value is not
   * even possible - the column is NOT NULL - and writing a zero to satisfy it
   * would be fabricating a measurement.
   */
  if (observation.value !== null) {
    if (spec.destination.kind === 'METRIC') {
      const inserted = await supabase.from('metric_observations').insert({
        user_id: userId,
        metric: spec.destination.metric as MetricKeyEnum,
        value: observation.value,
        measured_at: observation.timing.observedAt
          ?? observation.timing.intervalStart
          ?? `${observation.timing.localDate}T12:00:00Z`,
        local_date: observation.timing.localDate,
        source: GOOGLE_HEALTH_SOURCE,
        import_id: null,
        notes: null,
      }).select('id').single();
      if (inserted.error || !inserted.data) {
        return result({
          ...base,
          message: `Could not store ${spec.label}: ${inserted.error?.message ?? 'unknown error'}`,
        });
      }
      mappedTo = 'metric_observations';
      mappedId = inserted.data.id;
    } else if (spec.destination.kind === 'BODY') {
      const inserted = await supabase.from('body_measurements').insert({
        user_id: userId,
        measured_at: observation.timing.observedAt
          ?? `${observation.timing.localDate}T12:00:00Z`,
        local_date: observation.timing.localDate,
        weight_kg: observation.value,
        waist_cm: null,
        notes: null,
        source: GOOGLE_HEALTH_SOURCE,
        import_id: null,
      }).select('id').single();
      if (inserted.error || !inserted.data) {
        return result({
          ...base,
          message: `Could not store ${spec.label}: ${inserted.error?.message ?? 'unknown error'}`,
        });
      }
      mappedTo = 'body_measurements';
      mappedId = inserted.data.id;
    }
  }

  const stored = await recordExternal(supabase, userId, {
    dataType: observation.dataType,
    externalId: observation.externalId,
    externalUpdatedAt: observation.externalUpdatedAt,
    recordType: observation.recordType,
    observedAt: observation.timing.observedAt,
    intervalStart: observation.timing.intervalStart,
    intervalEnd: observation.timing.intervalEnd,
    utcOffsetSeconds: observation.timing.utcOffsetSeconds,
    localDate: observation.timing.localDate,
    value: observation.value,
    unit: observation.unit,
    payload: observation.payload,
    mappedTo,
    mappedId,
  });
  if (stored !== null) {
    return result({ ...base, message: `Could not record the source data: ${stored}` });
  }

  const warnings = [...observation.warnings];
  if (isCorrection) {
    const at = now().toISOString();
    for (const version of live) {
      const failure = await withdrawVersion(supabase, userId, version, at);
      if (failure !== null) warnings.push(`A superseded record could not be marked: ${failure}`);
    }
  }

  return result({
    ...base,
    warnings,
    outcome: mappedTo === null
      ? 'SKIPPED'
      : isCorrection ? 'UPDATED' : 'CREATED',
    localDate: observation.timing.localDate,
    // A scalar observation carries its own date and cannot move between days:
    // a corrected reading for the 3rd is still a reading for the 3rd. Only a
    // session can be re-dated, and those paths report it.
    previousLocalDate: null,
  });
}

/**
 * Writes a sleep session.
 *
 * sleep_records carries external identity since 0016, so a re-synced night
 * cannot become a second row - but the table is an immutable observation, so a
 * CORRECTED night is a new row that supersedes the old one rather than an
 * update. Both facts are needed: the index stops duplication, the supersession
 * stops the day summing two versions of the same sleep.
 */
export async function writeSleep(
  supabase: Client,
  userId: string,
  sleep: NormalisedSleep,
  extras: { temperatureDeltaC?: number | null; respiratoryRate?: number | null;
    oxygenSaturationPct?: number | null } = {},
  options: { now?: () => Date } = {},
): Promise<WriteResult> {
  const now = options.now ?? (() => new Date());
  const base = { externalId: sleep.externalId, warnings: sleep.warnings };

  const existing = await existingVersions(supabase, userId, 'sleep', sleep.externalId);
  if ('error' in existing) {
    return result({ ...base, message: `Could not check for an existing night: ${existing.error}` });
  }

  const thisVersion = versionOf(sleep.externalUpdatedAt);
  const sameVersion = existing.rows.find((row) => row.externalUpdatedAt === thisVersion);
  if (sameVersion !== undefined && sameVersion.supersededAt === null) {
    return result({ ...base, outcome: 'UNCHANGED', localDate: sleep.localDate });
  }

  const live = existing.rows.filter((row) => row.supersededAt === null);
  const at = now().toISOString();

  // The old row goes first here, unlike the scalar path: sleep_records has a
  // unique index on (user, external_source, external_id), so the new row cannot
  // be inserted while the old one holds the identity.
  for (const version of live) {
    const failure = await withdrawVersion(supabase, userId, version, at);
    if (failure !== null) {
      return result({ ...base, message: `The previous night could not be superseded: ${failure}` });
    }
  }

  // A night already on file under this identity but recorded by an earlier
  // sync that did not finish. Superseded rather than left to collide.
  const priorRow = await supabase
    .from('sleep_records')
    .select('id, local_date')
    .eq('user_id', userId)
    .eq('external_source', GOOGLE_HEALTH_EXTERNAL_SOURCE)
    .eq('external_id', sleep.externalId)
    .is('superseded_at', null)
    .maybeSingle();

  let previousLocalDate: LocalDate | null = null;
  if (!priorRow.error && priorRow.data) {
    previousLocalDate = String(priorRow.data.local_date).slice(0, 10) as LocalDate;
    await supabase.from('sleep_records')
      .update({ superseded_at: at })
      .eq('id', priorRow.data.id)
      .eq('user_id', userId);
  }

  const inserted = await supabase.from('sleep_records').insert({
    user_id: userId,
    local_date: sleep.localDate,
    sleep_start: sleep.sleepStart,
    sleep_end: sleep.sleepEnd,
    duration_minutes: sleep.durationMinutes,
    sleep_score: null,
    source: GOOGLE_HEALTH_SOURCE,
    import_id: null,
    notes: null,
    rem_minutes: sleep.remMinutes,
    deep_minutes: sleep.deepMinutes,
    light_minutes: sleep.lightMinutes,
    awake_minutes: sleep.awakeMinutes,
    short_awakenings: sleep.shortAwakenings,
    temperature_delta_c: extras.temperatureDeltaC ?? null,
    respiratory_rate: extras.respiratoryRate ?? null,
    oxygen_saturation_pct: extras.oxygenSaturationPct ?? null,
    external_source: GOOGLE_HEALTH_EXTERNAL_SOURCE,
    external_id: sleep.externalId,
    external_updated_at: sleep.externalUpdatedAt,
  }).select('id').single();

  if (inserted.error || !inserted.data) {
    return result({
      ...base,
      message: `Could not store the sleep session: ${inserted.error?.message ?? 'unknown error'}`,
    });
  }

  const stored = await recordExternal(supabase, userId, {
    dataType: 'sleep',
    externalId: sleep.externalId,
    externalUpdatedAt: sleep.externalUpdatedAt,
    recordType: 'SESSION',
    observedAt: null,
    intervalStart: sleep.sleepStart,
    intervalEnd: sleep.sleepEnd,
    utcOffsetSeconds: null,
    localDate: sleep.localDate,
    value: sleep.durationMinutes,
    unit: 'min',
    payload: sleep.payload,
    mappedTo: 'sleep_records',
    mappedId: inserted.data.id,
  });
  if (stored !== null) {
    return result({ ...base, message: `Could not record the source data: ${stored}` });
  }

  return result({
    ...base,
    outcome: live.length > 0 || previousLocalDate !== null ? 'UPDATED' : 'CREATED',
    localDate: sleep.localDate,
    previousLocalDate: previousLocalDate !== sleep.localDate ? previousLocalDate : null,
  });
}

/**
 * Writes an exercise session that no training session claimed.
 *
 * WHY THIS IS NOT ALWAYS WRITTEN. A Google exercise that CORRELATES with a Hevy
 * workout must not become a session of its own: the workout is already
 * recorded, and a second row for the same hour would double the day's training
 * count and its minutes. The correlation runs first; only what is left over
 * reaches here.
 *
 * Cardio goes to cardio_sessions, everything else to workout_sessions - see
 * CARDIO_EXERCISE_TYPES in mapper.ts for why that split is explicit rather than
 * inferred.
 */
export async function writeExerciseSession(
  supabase: Client,
  userId: string,
  exercise: NormalisedExercise,
  options: { now?: () => Date } = {},
): Promise<WriteResult> {
  const now = options.now ?? (() => new Date());
  const base = { externalId: exercise.externalId, warnings: exercise.warnings };

  const existing = await existingVersions(supabase, userId, 'exercise', exercise.externalId);
  if ('error' in existing) {
    return result({ ...base, message: `Could not check for an existing session: ${existing.error}` });
  }

  const thisVersion = versionOf(exercise.externalUpdatedAt);
  const sameVersion = existing.rows.find((row) => row.externalUpdatedAt === thisVersion);
  if (sameVersion !== undefined && sameVersion.supersededAt === null) {
    return result({ ...base, outcome: 'UNCHANGED', localDate: exercise.localDate });
  }

  const live = existing.rows.filter((row) => row.supersededAt === null);
  const at = now().toISOString();
  for (const version of live) {
    const failure = await withdrawVersion(supabase, userId, version, at);
    if (failure !== null) {
      return result({ ...base, message: `The previous session could not be superseded: ${failure}` });
    }
  }

  const table = exercise.isCardio ? 'cardio_sessions' : 'workout_sessions';
  let previousLocalDate: LocalDate | null = null;

  const prior = await supabase
    .from(table)
    .select('id, local_date')
    .eq('user_id', userId)
    .eq('external_source', GOOGLE_HEALTH_EXTERNAL_SOURCE)
    .eq('external_id', exercise.externalId)
    .is('superseded_at', null)
    .maybeSingle();
  if (!prior.error && prior.data) {
    previousLocalDate = String(prior.data.local_date).slice(0, 10) as LocalDate;
    await supabase.from(table)
      .update({ superseded_at: at })
      .eq('id', prior.data.id)
      .eq('user_id', userId);
  }

  let mappedId: string;
  if (exercise.isCardio) {
    const inserted = await supabase.from('cardio_sessions').insert({
      user_id: userId,
      local_date: exercise.localDate,
      started_at: exercise.startTime,
      cardio_type: exercise.cardioType,
      // NOT NULL on this table. Active duration is the honest figure - it is
      // what the API reports as true moving time - and elapsed is the fallback.
      duration_minutes: exercise.activeMinutes ?? exercise.durationMinutes ?? 0,
      distance_km: exercise.distanceKm,
      average_heart_rate: exercise.averageHeartRate,
      max_heart_rate: null,
      // Left null on purpose: a session's single zone is a claim about the
      // whole session, and the per-zone breakdown from session_telemetry is a
      // better answer. Filling it from an average would invent a summary.
      hr_zone: null,
      calories: exercise.caloriesKcal,
      notes: exercise.displayName,
      source: GOOGLE_HEALTH_SOURCE,
      import_id: null,
      external_source: GOOGLE_HEALTH_EXTERNAL_SOURCE,
      external_id: exercise.externalId,
      external_updated_at: exercise.externalUpdatedAt,
    }).select('id').single();
    if (inserted.error || !inserted.data) {
      return result({
        ...base,
        message: `Could not store the activity: ${inserted.error?.message ?? 'unknown error'}`,
      });
    }
    mappedId = inserted.data.id;
  } else {
    const inserted = await supabase.from('workout_sessions').insert({
      user_id: userId,
      local_date: exercise.localDate,
      start_time: exercise.startTime,
      end_time: exercise.endTime,
      duration_minutes: exercise.activeMinutes ?? exercise.durationMinutes,
      session_type: exercise.sessionType,
      title: exercise.displayName,
      notes: null,
      completed: true,
      average_heart_rate: exercise.averageHeartRate,
      max_heart_rate: null,
      calories: exercise.caloriesKcal,
      source: GOOGLE_HEALTH_SOURCE,
      import_id: null,
      external_source: GOOGLE_HEALTH_EXTERNAL_SOURCE,
      external_id: exercise.externalId,
      external_updated_at: exercise.externalUpdatedAt,
    }).select('id').single();
    if (inserted.error || !inserted.data) {
      return result({
        ...base,
        message: `Could not store the session: ${inserted.error?.message ?? 'unknown error'}`,
      });
    }
    mappedId = inserted.data.id;
  }

  const stored = await recordExternal(supabase, userId, {
    dataType: 'exercise',
    externalId: exercise.externalId,
    externalUpdatedAt: exercise.externalUpdatedAt,
    recordType: 'SESSION',
    observedAt: null,
    intervalStart: exercise.startTime,
    intervalEnd: exercise.endTime,
    utcOffsetSeconds: null,
    localDate: exercise.localDate,
    value: exercise.activeMinutes ?? exercise.durationMinutes,
    unit: 'min',
    payload: exercise.payload,
    mappedTo: table,
    mappedId,
  });
  if (stored !== null) {
    return result({ ...base, message: `Could not record the source data: ${stored}` });
  }

  return result({
    ...base,
    outcome: live.length > 0 || previousLocalDate !== null ? 'UPDATED' : 'CREATED',
    localDate: exercise.localDate,
    previousLocalDate: previousLocalDate !== exercise.localDate ? previousLocalDate : null,
  });
}

/**
 * Records an exercise session that correlated with a training session, without
 * creating a session of its own.
 *
 * The measurement it carries belongs to a workout that is already recorded, so
 * the only new row is the external record - kept, as always, so the correlation
 * can be re-derived and so the payload survives.
 */
export async function recordCorrelatedExercise(
  supabase: Client,
  userId: string,
  exercise: NormalisedExercise,
  sessionId: string,
): Promise<string | null> {
  return recordExternal(supabase, userId, {
    dataType: 'exercise',
    externalId: exercise.externalId,
    externalUpdatedAt: exercise.externalUpdatedAt,
    recordType: 'SESSION',
    observedAt: null,
    intervalStart: exercise.startTime,
    intervalEnd: exercise.endTime,
    utcOffsetSeconds: null,
    localDate: exercise.localDate,
    value: exercise.activeMinutes ?? exercise.durationMinutes,
    unit: 'min',
    payload: exercise.payload,
    mappedTo: 'session_telemetry',
    mappedId: sessionId,
  });
}

/** Records a data type that has no canonical destination yet. */
export async function recordUnmapped(
  supabase: Client,
  userId: string,
  observation: NormalisedObservation,
): Promise<string | null> {
  return recordExternal(supabase, userId, {
    dataType: observation.dataType,
    externalId: observation.externalId,
    externalUpdatedAt: observation.externalUpdatedAt,
    recordType: observation.recordType,
    observedAt: observation.timing.observedAt,
    intervalStart: observation.timing.intervalStart,
    intervalEnd: observation.timing.intervalEnd,
    utcOffsetSeconds: observation.timing.utcOffsetSeconds,
    localDate: observation.timing.localDate,
    value: observation.value,
    unit: observation.unit,
    payload: observation.payload,
    mappedTo: null,
    mappedId: null,
  });
}
