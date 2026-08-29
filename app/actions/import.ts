'use server';

/**
 * Import actions (spec §8, §17, §28, §38, §41).
 *
 * Two steps, deliberately separate:
 *
 *   parseImport()    reads the text and returns what it found. Writes nothing.
 *   confirmImport()  writes what the USER confirmed, after editing.
 *
 * The separation is the point. Parsed data is never trusted (§8), so nothing
 * reaches the database until a human has seen every field. The original text is
 * stored verbatim and forever (§17), and the idempotency key makes a repeated
 * paste a no-op rather than a duplicate day (§38).
 *
 * A paste may describe several days. Each day is its own health_imports row
 * with its own idempotency key, so re-pasting a week after correcting one day
 * imports the corrected day and refuses the other six, rather than duplicating
 * all seven.
 *
 * EVERY write is checked. An import that reports success must have written
 * exactly what the review screen showed; a row the database refuses is reported
 * as a failure, with the import's raw text still preserved.
 */
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { createActionClient } from '@/lib/supabase/server';
import { rebuildRange } from '@/lib/data/canonicalise';
import { getProfile } from '@/lib/data/queries';
import {
  parseText, PARSER_NAME, PARSER_VERSION,
  type ParsedField, type NotStored, type SessionKind,
} from '@/lib/health/parser';
import {
  toSessionType, toCardioType,
  SESSION_TYPE_VALUES, CARDIO_TYPE_VALUES,
} from '@/lib/health/sessionTypes';
import { idempotencyKey } from '@/lib/health/idempotency';
import { isLocalDate, localToday } from '@/lib/normalization/dates';
import { OBSERVATION_RANGES, type ObservationKey } from '@/lib/validation/observations';
import type { LocalDate } from '@/lib/types';
import type { CardioTypeEnum, SessionTypeEnum } from '@/lib/supabase/types';

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/** A session already on the day an import is about to write to. */
export interface ExistingSession {
  id: string;
  kind: SessionKind;
  /** The stored enum: 'PULL', 'INCLINE_WALKING' and so on. */
  label: string;
  durationMinutes: number | null;
  date: LocalDate;
}

export interface PreviewSession {
  kind: SessionKind;
  /** The opener's text as written, kept for the session's notes column. */
  rawLabel: string;
  openerRawText: string;
  /** Suggested enum. Editable in review, like every other proposed value. */
  sessionType: SessionTypeEnum;
  cardioType: CardioTypeEnum;
  /** False when the label did not match a known type and fell back to OTHER. */
  typeRecognised: boolean;
  fields: ParsedField[];
  notStored: NotStored[];
}

export interface PreviewRecord {
  targetDate: LocalDate | null;
  dateRawText: string | null;
  dateNote: string | null;
  fields: ParsedField[];
  sessions: PreviewSession[];
  unrecognisedLines: string[];
  notStored: NotStored[];
  /** This record's own lines. Hashed for idempotency and stored verbatim. */
  rawText: string;
  /** True when this exact day has already been imported (spec §38). */
  alreadyImported: boolean;
  previousImportDate: string | null;
  /**
   * Sessions already recorded on `existingSessionsDate`. daily_metrics SUMS a
   * day's sessions rather than resolving them, so importing adds to these
   * rather than replacing them - which the reviewer needs to know before
   * confirming. The date is reported alongside the count because the reviewer
   * may then move the record to a different day.
   */
  existingSessions: number;
  existingSessionsDate: LocalDate | null;
  /**
   * The live sessions already recorded on that date. A correction needs to name
   * the row it replaces, so the reviewer can say "this 65-minute Pull replaces
   * the 58-minute one" instead of the day quietly totalling 123 minutes.
   */
  existingSessionRows: ExistingSession[];
  /**
   * The date the two checks above were run against. The reviewer can move a
   * record to another day, at which point both become advisory - so the date is
   * named rather than the banners implying they still apply.
   */
  checkedDate: LocalDate;
}

export interface ParsePreview {
  records: PreviewRecord[];
  /**
   * True when the "already imported" lookup could not run. The database still
   * refuses a genuine repeat, but the review screen must not claim a day is new
   * on the strength of a query that failed.
   */
  duplicateCheckFailed: boolean;
  /**
   * True when the count of sessions already recorded could not be read, so the
   * review screen cannot say whether importing will add to existing ones.
   */
  sessionCheckFailed: boolean;
  parserName: string;
  parserVersion: string;
}

export async function parseImport(rawText: string): Promise<ParsePreview> {
  const profile = await getProfile();
  const timezone = profile?.timezone ?? 'UTC';
  const today = localToday(timezone);
  const referenceYear = Number(today.slice(0, 4));

  const result = parseText(rawText, referenceYear);

  const supabase = await createActionClient();
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id ?? null;

  // Every lookup the preview needs, in three queries rather than three per day:
  // a thirty-day paste should not cost ninety round trips before it renders.
  const keys = result.records.map((record) => idempotencyKey(record.rawText, record.localDate ?? today));
  const sessionDates = [...new Set(
    result.records.filter((r) => r.sessions.length > 0).map((r) => r.localDate ?? today),
  )];

  const priorImports = new Map<string, { created_at: string; status: string }>();
  const priorSessions = new Map<string, number>();
  const priorSessionRows = new Map<string, ExistingSession[]>();

  // Not being able to identify the user means neither check below runs at all,
  // which must read as "unknown", not as "no repeats and no existing sessions".
  let duplicateCheckFailed = userId === null && keys.length > 0;
  if (userId && keys.length > 0) {
    const { data: existing, error } = await supabase
      .from('health_imports')
      .select('created_at, status, idempotency_key')
      .eq('user_id', userId)
      .in('idempotency_key', keys);
    // Saying nothing is the same as saying "not imported before", so a lookup
    // that failed has to be reported rather than read as a clean result.
    if (error) duplicateCheckFailed = true;
    for (const row of existing ?? []) priorImports.set(row.idempotency_key, row);
  }

  // Checked against the date the review screen will show, which is the parsed
  // one when there is one and today otherwise - not only when the paste carried
  // a date, or an undated record would add a second session to today with no
  // warning at all.
  let sessionCheckFailed = userId === null && sessionDates.length > 0;
  if (userId && sessionDates.length > 0) {
    // The rows themselves, not just how many: to offer "replace the 58-minute
    // Pull already on this day" the review screen has to be able to name it.
    // Superseded rows are already-corrected history and must not be offered.
    const [workouts, cardio] = await Promise.all([
      supabase
        .from('workout_sessions')
        .select('id, local_date, session_type, duration_minutes')
        .is('superseded_at', null)
        .in('local_date', sessionDates),
      supabase
        .from('cardio_sessions')
        .select('id, local_date, cardio_type, duration_minutes')
        .is('superseded_at', null)
        .in('local_date', sessionDates),
    ]);
    // A count of zero from a failed query would silently withdraw the "this
    // adds to what is already there" warning, which is the one thing standing
    // between the user and a permanently doubled training day.
    if (workouts.error || cardio.error) sessionCheckFailed = true;

    for (const row of workouts.data ?? []) {
      priorSessions.set(row.local_date, (priorSessions.get(row.local_date) ?? 0) + 1);
      const list = priorSessionRows.get(row.local_date) ?? [];
      list.push({
        id: row.id,
        kind: 'WORKOUT',
        label: String(row.session_type),
        durationMinutes: row.duration_minutes === null ? null : Number(row.duration_minutes),
        date: row.local_date as LocalDate,
      });
      priorSessionRows.set(row.local_date, list);
    }
    for (const row of cardio.data ?? []) {
      priorSessions.set(row.local_date, (priorSessions.get(row.local_date) ?? 0) + 1);
      const list = priorSessionRows.get(row.local_date) ?? [];
      list.push({
        id: row.id,
        kind: 'CARDIO',
        label: String(row.cardio_type),
        durationMinutes: row.duration_minutes === null ? null : Number(row.duration_minutes),
        date: row.local_date as LocalDate,
      });
      priorSessionRows.set(row.local_date, list);
    }
  }

  const records: PreviewRecord[] = [];
  result.records.forEach((record, index) => {
    // The idempotency key is checked BEFORE the user fills anything in, so a
    // repeat paste is called out immediately rather than after they redo the
    // review.
    const existing = priorImports.get(keys[index]!);
    const alreadyImported = Boolean(existing && existing.status === 'CONFIRMED');
    const previousImportDate = existing?.created_at ?? null;
    const sessionDate = record.localDate ?? today;
    const existingSessions = record.sessions.length > 0
      ? priorSessions.get(sessionDate) ?? 0
      : 0;

    records.push({
      targetDate: record.localDate,
      dateRawText: record.date?.rawText ?? null,
      dateNote: record.date?.note ?? null,
      fields: record.fields,
      sessions: record.sessions.map((session) => {
        const workout = toSessionType(session.rawLabel);
        const cardio = toCardioType(session.rawLabel);
        return {
          kind: session.kind,
          rawLabel: session.rawLabel,
          openerRawText: session.openerRawText,
          sessionType: workout.value,
          cardioType: cardio.value,
          typeRecognised: session.kind === 'WORKOUT' ? workout.recognised : cardio.recognised,
          fields: session.fields,
          notStored: session.notStored,
        };
      }),
      unrecognisedLines: record.unrecognisedLines,
      notStored: record.notStored,
      rawText: record.rawText,
      alreadyImported,
      previousImportDate,
      existingSessions,
      existingSessionsDate: existingSessions > 0 ? sessionDate : null,
      existingSessionRows: record.sessions.length > 0
        ? priorSessionRows.get(sessionDate) ?? []
        : [],
      /** The date `alreadyImported` was checked against, which the reviewer may change. */
      checkedDate: sessionDate,
    });
  });

  return {
    records,
    duplicateCheckFailed,
    sessionCheckFailed,
    parserName: result.parserName,
    parserVersion: result.parserVersion,
  };
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

/**
 * Bounds come from the range rails rather than being retyped here, so the zod
 * schema, the parser's warnings and the database CHECK constraints cannot drift
 * apart.
 */
function ranged(key: ObservationKey) {
  const rule = OBSERVATION_RANGES[key];
  return z.number().min(rule.min).max(rule.max);
}

function optional(key: ObservationKey) {
  return ranged(key).nullable().optional();
}

/** For a count. Postgres would round 2.5 into a smallint and store a 3. */
function optionalInteger(key: ObservationKey) {
  return ranged(key).int().nullable().optional();
}

const sessionSchema = z.object({
  kind: z.enum(['WORKOUT', 'CARDIO']),
  sessionType: z.enum(SESSION_TYPE_VALUES as [SessionTypeEnum, ...SessionTypeEnum[]]),
  cardioType: z.enum(CARDIO_TYPE_VALUES as [CardioTypeEnum, ...CardioTypeEnum[]]),
  rawLabel: z.string().max(500),
  sessionMinutes: optional('sessionMinutes'),
  distanceKm: optional('distanceKm'),
  averageHeartRate: optional('averageHeartRate'),
  maxHeartRate: optional('maxHeartRate'),
  sessionCalories: optional('sessionCalories'),
  hrZone: optionalInteger('hrZone'),
  /**
   * What to do about a session already recorded on this day (spec §38).
   *
   *   ADD     - write it alongside; the day holds both. The default, and the
   *             right answer for a second real session on one day.
   *   REPLACE - write it and mark `supersedes` as superseded, so the day counts
   *             the correction instead of summing the two readings.
   *   KEEP    - write nothing; the session already on the day stands.
   */
  disposition: z.enum(['ADD', 'REPLACE', 'KEEP']).default('ADD'),
  supersedes: z.string().uuid().nullable().default(null),
}).refine(
  (v) => v.disposition !== 'REPLACE' || v.supersedes !== null,
  { message: 'Replacing a session needs the session it replaces.', path: ['supersedes'] },
);

/** The reviewed, user-edited values. All optional; blank stays blank. */
const recordSchema = z.object({
  rawText: z.string().min(1),
  date: z.string().refine(isLocalDate, 'A valid date is required before importing.'),
  weightKg: optional('weightKg'),
  waistCm: optional('waistCm'),
  calories: optional('calories'),
  proteinG: optional('proteinG'),
  carbsG: optional('carbsG'),
  fatG: optional('fatG'),
  fiberG: optional('fiberG'),
  steps: optionalInteger('steps'),
  activeCalories: optional('activeCalories'),
  restingHeartRate: optional('restingHeartRate'),
  hrvMs: optional('hrvMs'),
  sleepMinutes: optional('sleepMinutes'),
  sessions: z.array(sessionSchema).max(20),
});

const confirmSchema = z.object({
  records: z.array(recordSchema).min(1)
    .max(60, 'A single import can cover at most 60 days. Split the paste up.'),
});

export type ConfirmSession = z.infer<typeof sessionSchema>;
export type ConfirmRecord = z.infer<typeof recordSchema>;
export type ConfirmPayload = z.infer<typeof confirmSchema>;

export type RecordStatus = 'IMPORTED' | 'DUPLICATE' | 'SKIPPED' | 'FAILED';

export interface WroteRow {
  table: string;
  rows: number;
}

export interface RecordOutcome {
  date: string;
  status: RecordStatus;
  message: string;
  /** Exactly what reached the database, so the report matches the writes. */
  wrote: WroteRow[];
}

export interface ImportResult {
  ok: boolean;
  message: string;
  records: RecordOutcome[];
  errors?: Record<string, string>;
}

function countWord(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export async function confirmImport(payload: ConfirmPayload): Promise<ImportResult> {
  const parsed = confirmSchema.safeParse(payload);
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.');
      if (!errors[path]) errors[path] = issue.message;
    }
    return { ok: false, message: 'Check the highlighted fields.', records: [], errors };
  }

  // Two rails zod cannot express field by field.
  const errors: Record<string, string> = {};
  parsed.data.records.forEach((record, recordIndex) => {
    record.sessions.forEach((session, sessionIndex) => {
      const at = `records.${recordIndex}.sessions.${sessionIndex}`;
      // cardio_sessions.duration_minutes is NOT NULL. A cardio session without
      // one cannot be written, and inventing a zero would fabricate a
      // measurement.
      if (session.kind === 'CARDIO' && session.sessionMinutes == null) {
        errors[`${at}.sessionMinutes`] =
          'A cardio session needs a duration before it can be saved.';
      }
      // Migration 0010's *_hr_ordered CHECK refuses a maximum below the
      // average. Catching the transposition here is the whole point of
      // checking before the write rather than after it.
      if (
        session.averageHeartRate != null &&
        session.maxHeartRate != null &&
        session.maxHeartRate < session.averageHeartRate
      ) {
        errors[`${at}.maxHeartRate`] =
          `A maximum heart rate of ${session.maxHeartRate} bpm is below the average of `
          + `${session.averageHeartRate} bpm. Check whether the two are the wrong way round.`;
      }
    });
  });
  if (Object.keys(errors).length > 0) {
    return { ok: false, message: 'Check the highlighted fields.', records: [], errors };
  }

  const supabase = await createActionClient();
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError || !auth.user) {
    return { ok: false, message: 'Not signed in.', records: [] };
  }
  const userId = auth.user.id;

  const profile = await getProfile();
  const referenceYear = Number(localToday(profile?.timezone ?? 'UTC').slice(0, 4));

  const outcomes: RecordOutcome[] = [];
  const touchedDates = new Set<LocalDate>();
  /** Whether anything reached health_imports, which is what /import lists. */
  let importRowWritten = false;

  for (const record of parsed.data.records) {
    // A day carrying no measurement is not an import: writing observation rows
    // for it and reporting "1 day imported" would claim something the database
    // never received. But the text is still kept verbatim (§17) - a day nothing
    // could be read from is precisely the one worth re-deriving later if the
    // parser turns out to have been wrong - filed as DISCARDED so the /import
    // list does not present it as data.
    if (!hasAnything(record)) {
      const { error } = await supabase.from('health_imports').insert({
        user_id: userId,
        raw_text: record.rawText,
        parsed: parseText(record.rawText, referenceYear).records as unknown as Record<string, unknown>,
        confirmed: null,
        parser_name: PARSER_NAME,
        parser_version: PARSER_VERSION,
        target_local_date: record.date,
        source: 'IMPORT_TEXT',
        status: 'DISCARDED',
        confirmed_at: null,
        idempotency_key: idempotencyKey(record.rawText, record.date as LocalDate),
      });
      importRowWritten = importRowWritten || !error;
      outcomes.push({
        date: record.date,
        status: 'SKIPPED',
        message: error
          ? 'Nothing could be read from this day, and the text could not be kept either: '
            + error.message
          : 'Nothing could be read from this day, so no measurement was recorded. '
            + 'The text itself was kept.',
        wrote: [],
      });
      continue;
    }
    const outcome = await importOneRecord(supabase, userId, record, referenceYear);
    outcomes.push(outcome);
    // Any day whose raw layer changed needs rebuilding, INCLUDING one that
    // failed partway: daily_metrics is a pure function of the raw rows, and a
    // row that landed before the failure is real, permanent (no delete policy)
    // and must be reflected in the canonical layer.
    //
    // An IMPORTED day is always rebuilt even when it wrote nothing new, because
    // a resumed import may have found every session already in place - the rows
    // exist and the canonical layer may never have seen them.
    if (outcome.status === 'IMPORTED' || outcome.wrote.length > 0) {
      touchedDates.add(record.date as LocalDate);
    }
    if (outcome.status !== 'SKIPPED') importRowWritten = true;
  }

  // A day is rebuilt once however many records landed on it.
  //
  // daily_metrics is a rebuildable cache, so a failure here loses nothing that
  // cannot be recomputed - but it must not throw away the per-day report of
  // what WAS written, which is the only account the user gets of it.
  let rebuildFailure: string | null = null;
  if (touchedDates.size > 0) {
    const { failed } = await rebuildRange(supabase, userId, [...touchedDates]);
    if (failed.length > 0) {
      rebuildFailure = failed
        .map(({ date, message }) => `${date}: ${message}`)
        .join('; ');
    }
    for (const path of ['/dashboard', '/progress', '/nutrition', '/recovery', '/training', '/context']) {
      revalidatePath(path);
    }
  }

  // /import lists every import row - a PENDING one left by a record that failed
  // partway, and a DISCARDED one holding the text of a day nothing could be
  // read from - so it is refreshed whenever any row was created, not only when
  // a measurement landed.
  if (importRowWritten) revalidatePath('/import');

  const imported = outcomes.filter((o) => o.status === 'IMPORTED').length;
  const duplicates = outcomes.filter((o) => o.status === 'DUPLICATE').length;
  const skipped = outcomes.filter((o) => o.status === 'SKIPPED').length;
  const failed = outcomes.filter((o) => o.status === 'FAILED').length;

  const parts: string[] = [];
  if (imported > 0) parts.push(`${countWord(imported, 'day', 'days')} imported`);
  if (duplicates > 0) parts.push(`${duplicates} already imported`);
  if (skipped > 0) parts.push(`${skipped} had nothing to import`);
  if (failed > 0) parts.push(`${failed} could not be saved`);

  const message = parts.length > 0 ? `${parts.join(', ')}.` : 'Nothing was imported.';

  return {
    // A re-paste of a week already imported is §38 working exactly as intended,
    // and a blank day is nothing to fix. Only a day that could not be saved is
    // a failure the user has to act on.
    ok: failed === 0 && rebuildFailure === null,
    message: rebuildFailure === null
      ? message
      : `${message} The daily summary could not be rebuilt (${rebuildFailure}); `
        + 'the imported data is safe and will be recomputed on the next write.',
    records: outcomes,
  };
}

/**
 * The two tables daily_metrics SUMS rather than resolves. A repeated row here
 * permanently doubles a day's training or cardio minutes, and no delete policy
 * exists to undo it, so a resumed import must not write them twice.
 *
 * The scalar tables are deliberately NOT in this list: re-inserting one is how
 * a correction is recorded (spec §6/§48), and the canonical resolver picks the
 * most recent. Skipping them would silently drop an edit made in review.
 */
const SUMMED_TABLES = ['workout_sessions', 'cardio_sessions'] as const;

/**
 * Marks the rows a REPLACE supersedes (spec §6, §38).
 *
 * Runs AFTER the inserts, so the replacement exists before anything points at
 * it and a failure here leaves the new row in place rather than a dangling
 * reference. Nothing is deleted and nothing is overwritten: the replaced row
 * keeps every measurement it recorded, and only stops counting towards the
 * day's totals, which is what makes re-importing a corrected day produce 65
 * minutes rather than 58 + 65.
 *
 * Returns an error message, or null when every supersession landed.
 */
async function supersede(
  supabase: ActionClient,
  table: 'workout_sessions' | 'cardio_sessions',
  sessions: ConfirmSession[],
  inserted: { id: string }[],
): Promise<string | null> {
  const now = new Date().toISOString();

  for (const [index, session] of sessions.entries()) {
    if (session.disposition !== 'REPLACE' || !session.supersedes) continue;
    // Insert order matches the array order, so the nth new row replaces the
    // nth session's target.
    const replacement = inserted[index];
    if (!replacement) {
      return 'the replacement session could not be identified, so nothing was superseded.';
    }
    const { error } = await supabase
      .from(table)
      .update({ superseded_at: now, superseded_by: replacement.id })
      .eq('id', session.supersedes);
    if (error) return error.message;
  }
  return null;
}

/** True when the day carries at least one measurement or session. */
function hasAnything(record: ConfirmRecord): boolean {
  if (record.sessions.length > 0) return true;
  return DAY_VALUE_KEYS.some((key) => record[key] != null);
}

const DAY_VALUE_KEYS = [
  'weightKg', 'waistCm', 'calories', 'proteinG', 'carbsG', 'fatG', 'fiberG',
  'steps', 'activeCalories', 'restingHeartRate', 'hrvMs', 'sleepMinutes',
] as const;

type ActionClient = Awaited<ReturnType<typeof createActionClient>>;

/**
 * One day. The raw text is stored FIRST and kept regardless of what happens
 * next (spec §17), as PENDING; it is only marked CONFIRMED once every domain
 * write has actually succeeded.
 */
async function importOneRecord(
  supabase: ActionClient,
  userId: string,
  values: ConfirmRecord,
  referenceYear: number,
): Promise<RecordOutcome> {
  const date = values.date;
  const key = idempotencyKey(values.rawText, date as LocalDate);
  const wrote: WroteRow[] = [];
  /**
   * Summed tables a previous, unfinished attempt at this same paste already
   * wrote. Only SUMMED_TABLES are tracked - re-inserting a scalar observation
   * is how a correction is recorded, so those are never skipped.
   */
  const alreadyWritten = new Set<string>();
  /** Sessions left as the earlier attempt wrote them, named in the outcome. */
  const kept: string[] = [];

  const { data: importRow, error: importError } = await supabase
    .from('health_imports')
    .insert({
      user_id: userId,
      raw_text: values.rawText,
      parsed: parseText(values.rawText, referenceYear).records as unknown as Record<string, unknown>,
      confirmed: null,
      parser_name: PARSER_NAME,
      parser_version: PARSER_VERSION,
      target_local_date: date,
      source: 'IMPORT_TEXT',
      status: 'PENDING',
      confirmed_at: null,
      idempotency_key: key,
    })
    .select('id')
    .single();

  let importId: string;

  if (importError) {
    // 23505 is unique_violation: this exact day's text is already on file. That
    // is the §38 guarantee, enforced by the database rather than by a check we
    // could race past. But it does NOT necessarily mean the day was imported -
    // a previous attempt that kept its raw text and then failed a write holds
    // the same key at PENDING, so the two cases have to be told apart.
    if (importError.code !== '23505') {
      return { date, status: 'FAILED', message: importError.message, wrote: [] };
    }

    const { data: existing } = await supabase
      .from('health_imports')
      .select('id, status')
      .eq('user_id', userId)
      .eq('idempotency_key', key)
      .maybeSingle();

    if (!existing) return { date, status: 'FAILED', message: importError.message, wrote: [] };

    if (existing.status === 'CONFIRMED') {
      await supabase.from('system_events').insert({
        user_id: userId,
        kind: 'IMPORT_DUPLICATE_REJECTED',
        summary: 'A repeated paste was rejected before it could duplicate a day.',
        detail: { targetDate: date, idempotencyKey: key },
        previous_value: null,
        new_value: null,
        reason: 'Identical import already recorded.',
        status: 'RECORDED',
      });
      return {
        date,
        status: 'DUPLICATE',
        message: 'Already imported. Nothing was changed for this day.',
        wrote: [],
      };
    }

    // An unfinished earlier attempt. Resume into its row rather than leaving
    // the day permanently unimportable behind a key nothing can release: with
    // no delete policy on health_imports, refusing here would be final.
    importId = existing.id;
    // Whatever that attempt did land stays, and cannot be deleted. Reading a
    // failed lookup as "nothing written yet" would re-insert a session row and
    // permanently double the day's training minutes, so the record is failed
    // instead - a retry costs the user a click, a doubled day cannot be undone.
    for (const table of SUMMED_TABLES) {
      const { data: rows, error } = await supabase
        .from(table)
        .select('id')
        .eq('import_id', importId)
        .limit(1);
      if (error) {
        return {
          date,
          status: 'FAILED',
          message:
            `Could not check what an earlier attempt at this day already wrote (${error.message}). `
            + 'Nothing was changed. Try again.',
          wrote: [],
        };
      }
      if (rows && rows.length > 0) alreadyWritten.add(table);
    }
  } else {
    importId = importRow.id;
  }

  const now = new Date().toISOString();
  const fail = (message: string): RecordOutcome => ({
    date, status: 'FAILED', message, wrote,
  });

  // Each domain gets its own raw row, all tagged with the import that made them.
  if (values.weightKg != null || values.waistCm != null) {
    const { error } = await supabase.from('body_measurements').insert({
      user_id: userId,
      measured_at: now,
      local_date: date,
      weight_kg: values.weightKg ?? null,
      waist_cm: values.waistCm ?? null,
      notes: null,
      source: 'IMPORT_TEXT',
      import_id: importId,
    });
    if (error) return fail(`Body measurement: ${error.message}`);
    wrote.push({ table: 'body_measurements', rows: 1 });
  }

  const nutritionValues = [
    values.calories, values.proteinG, values.carbsG, values.fatG, values.fiberG,
  ];
  if (nutritionValues.some((v) => v != null)) {
    const { error } = await supabase.from('nutrition_logs').insert({
      user_id: userId,
      local_date: date,
      calories: values.calories ?? null,
      protein_g: values.proteinG ?? null,
      carbs_g: values.carbsG ?? null,
      fat_g: values.fatG ?? null,
      fiber_g: values.fiberG ?? null,
      fruit_veg_servings: null,
      notes: null,
      source: 'IMPORT_TEXT',
      import_id: importId,
    });
    if (error) return fail(`Nutrition: ${error.message}`);
    wrote.push({ table: 'nutrition_logs', rows: 1 });
  }

  const metricRows = (
    [
      ['STEPS', values.steps],
      ['ACTIVE_CALORIES', values.activeCalories],
      ['RESTING_HEART_RATE', values.restingHeartRate],
      ['HRV_MS', values.hrvMs],
    ] as const
  )
    .filter(([, value]) => value != null)
    .map(([metric, value]) => ({
      user_id: userId,
      metric,
      value: value!,
      measured_at: now,
      local_date: date,
      source: 'IMPORT_TEXT' as const,
      import_id: importId,
      notes: null,
    }));
  if (metricRows.length > 0) {
    const { error } = await supabase.from('metric_observations').insert(metricRows);
    if (error) return fail(`Daily metrics: ${error.message}`);
    wrote.push({ table: 'metric_observations', rows: metricRows.length });
  }

  if (values.sleepMinutes != null) {
    const { error } = await supabase.from('sleep_records').insert({
      user_id: userId,
      local_date: date,
      sleep_start: null,
      sleep_end: null,
      duration_minutes: values.sleepMinutes,
      sleep_score: null,
      source: 'IMPORT_TEXT',
      import_id: importId,
      notes: null,
    });
    if (error) return fail(`Sleep: ${error.message}`);
    wrote.push({ table: 'sleep_records', rows: 1 });
  }

  // Training and cardio. The label the user wrote is preserved in notes, so a
  // session that mapped to OTHER has still lost nothing.
  //
  // A session the reviewer marked KEEP writes nothing at all: the row already
  // on the day is the one they want, and importing over it would only make the
  // day's minutes the sum of two readings of the same session.
  const workouts = values.sessions.filter(
    (s) => s.kind === 'WORKOUT' && s.disposition !== 'KEEP',
  );
  if (workouts.length > 0 && alreadyWritten.has('workout_sessions')) {
    kept.push('workouts');
  } else if (workouts.length > 0) {
    const { data: inserted, error } = await supabase.from('workout_sessions').insert(
      workouts.map((session) => ({
        user_id: userId,
        local_date: date,
        start_time: null,
        end_time: null,
        duration_minutes: session.sessionMinutes ?? null,
        session_type: session.sessionType,
        average_heart_rate: session.averageHeartRate ?? null,
        max_heart_rate: session.maxHeartRate ?? null,
        calories: session.sessionCalories ?? null,
        notes: session.rawLabel || null,
        completed: true,
        source: 'IMPORT_TEXT' as const,
        import_id: importId,
      })),
    ).select('id');
    if (error) return fail(`Workout: ${error.message}`);
    wrote.push({ table: 'workout_sessions', rows: workouts.length });

    const failure = await supersede(
      supabase, 'workout_sessions', workouts, inserted ?? [],
    );
    if (failure) return fail(`Workout: ${failure}`);
  }

  const cardio = values.sessions.filter(
    (s) => s.kind === 'CARDIO' && s.disposition !== 'KEEP',
  );
  if (cardio.length > 0 && alreadyWritten.has('cardio_sessions')) {
    kept.push('cardio sessions');
  } else if (cardio.length > 0) {
    const { data: inserted, error } = await supabase.from('cardio_sessions').insert(
      cardio.map((session) => ({
        user_id: userId,
        local_date: date,
        started_at: null,
        cardio_type: session.cardioType,
        // Guaranteed present: a cardio session without a duration is rejected
        // before any write happens.
        duration_minutes: session.sessionMinutes!,
        distance_km: session.distanceKm ?? null,
        average_heart_rate: session.averageHeartRate ?? null,
        max_heart_rate: session.maxHeartRate ?? null,
        hr_zone: session.hrZone ?? null,
        calories: session.sessionCalories ?? null,
        notes: session.rawLabel || null,
        source: 'IMPORT_TEXT' as const,
        import_id: importId,
      })),
    ).select('id');
    if (error) return fail(`Cardio: ${error.message}`);
    wrote.push({ table: 'cardio_sessions', rows: cardio.length });

    const failure = await supersede(
      supabase, 'cardio_sessions', cardio, inserted ?? [],
    );
    if (failure) return fail(`Cardio: ${failure}`);
  }

  // Only now is the import a confirmed one. Until this update lands it stays
  // PENDING with its raw text intact, which is what the /import list shows.
  const { error: confirmError } = await supabase
    .from('health_imports')
    .update({
      status: 'CONFIRMED',
      confirmed_at: new Date().toISOString(),
      confirmed: values as unknown as Record<string, unknown>,
    })
    .eq('id', importId);
  if (confirmError) return fail(confirmError.message);

  // Spec §41: the import is recorded in the audit log with what it resolved to.
  await supabase.from('system_events').insert({
    user_id: userId,
    kind: 'IMPORT_CONFIRMED',
    summary: `Imported data for ${date}.`,
    detail: { importId, wrote } as unknown as Record<string, unknown>,
    previous_value: null,
    new_value: null,
    reason: 'User confirmed a reviewed text import.',
    status: 'RECORDED',
  });

  const rows = wrote.reduce((total, w) => total + w.rows, 0);
  const keptNote = kept.length === 0
    ? ''
    : ` The ${kept.join(' and ')} from an earlier attempt at this paste were kept as they`
      + ' were, so the day is not counted twice.';

  return {
    date,
    status: 'IMPORTED',
    message: rows === 0
      ? `Nothing new was written for this day.${keptNote}`
      : `Imported ${rows} rows.${keptNote}`,
    wrote,
  };
}
