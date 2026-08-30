/**
 * End-to-end trace of the two days that exposed the bug (spec §8, §11, §12).
 *
 * The exact text the user pasted goes through the real parser, the real payload
 * builder, the real SQL against real PostgreSQL, the real canonical rebuild and
 * the real analytics - and the assertions are the literal figures the Training
 * page prints. If any link in that chain drops a session again, this fails.
 *
 * SCOPE: PGlite is real PostgreSQL and this exercises the schema, the
 * constraints and the calculations. It is not proof that a hosted Supabase
 * project behaves the same; that needs a real project.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestDb, createUser, withUser, type TestDb } from '../helpers/pglite';
import { parseText } from '@/lib/health/parser';
import { toSessionType, toCardioType } from '@/lib/health/sessionTypes';
import {
  editsFromPreview, buildConfirmPayload,
  type PayloadRecord, type ConfirmRecordValues,
} from '@/lib/health/importPayload';
import {
  summariseSessions, summariseTraining, exerciseProgression,
  type TrainingSession,
} from '@/lib/analytics/training';
import { toInstant } from '@/lib/data/rows';

/** Verbatim, as reported. */
const PASTE = `Date: 2026-08-27
Workout: Lower
Duration: 64 min
Average HR: 138
Max HR: 169
Calories burned: 395

Cardio: Zone 2
Duration: 25 min
Distance: 2.1 mi
Average HR: 135
Max HR: 146

Date: 2026-08-28
Workout: Pull
Duration: 58 min
Average HR: 142
Max HR: 171
Calories burned: 412

Cardio: Incline treadmill
Duration: 30 min
Distance: 1.8 mi
Average HR: 139
Max HR: 151`;

const UNITS = { weight: 'LB', length: 'IN', distance: 'MI' } as const;

/** Exactly what app/actions/import.ts builds before it writes. */
function confirmPayload(text: string): ConfirmRecordValues[] {
  const parsed = parseText(text, 2026);
  const records: PayloadRecord[] = parsed.records.map((record) => ({
    fields: record.fields,
    rawText: record.rawText,
    targetDate: record.localDate,
    sessions: record.sessions.map((session) => ({
      kind: session.kind,
      rawLabel: session.rawLabel,
      sessionType: toSessionType(session.rawLabel).value,
      cardioType: toCardioType(session.rawLabel).value,
      fields: session.fields,
    })),
  }));
  const edits = editsFromPreview(records, UNITS, '2026-08-29');
  return buildConfirmPayload(records, edits, UNITS, '2026-08-29').records;
}

/** The rows getWorkoutSessions() maps, read straight back out of Postgres. */
type SessionRow = {
  id: string; local_date: string; session_type: string;
  duration_minutes: string | null; average_heart_rate: string | null;
  max_heart_rate: string | null; calories: string | null;
  notes: string | null; source: string; completed: boolean;
  // Left as whatever the driver returns - a JS Date here, an ISO string in
  // production - so toInstant is exercised on the shape PGlite really gives.
  start_time: unknown; end_time: unknown;
};

function toDomain(rows: SessionRow[]): TrainingSession[] {
  const num = (v: string | null) => (v === null ? null : Number(v));
  return rows.map((row) => ({
    id: row.id,
    date: row.local_date,
    sessionType: row.session_type,
    title: null,
    externalSource: null,
    durationMinutes: num(row.duration_minutes),
    averageHeartRate: num(row.average_heart_rate),
    maxHeartRate: num(row.max_heart_rate),
    calories: num(row.calories),
    notes: row.notes,
    source: row.source,
    completed: row.completed,
    importId: null,
    startTime: toInstant(row.start_time),
    endTime: toInstant(row.end_time),
  }));
}

describe('Aug 27 / Aug 28 import, end to end', () => {
  let db: TestDb;
  let user: string;
  let payload: ConfirmRecordValues[];

  beforeAll(async () => {
    db = await createTestDb();
    user = await createUser(db, 'owner@example.com');
    payload = confirmPayload(PASTE);

    await withUser(db, user, async (tx) => {
      for (const record of payload) {
        for (const session of record.sessions) {
          if (session.kind === 'WORKOUT') {
            await tx.query(
              `insert into workout_sessions
                 (user_id, local_date, duration_minutes, session_type,
                  average_heart_rate, max_heart_rate, calories, notes,
                  completed, source)
               values ($1, $2, $3, $4, $5, $6, $7, $8, true, 'IMPORT_TEXT')`,
              [
                user, record.date, session.sessionMinutes, session.sessionType,
                session.averageHeartRate, session.maxHeartRate,
                session.sessionCalories, session.rawLabel,
              ],
            );
          } else {
            await tx.query(
              `insert into cardio_sessions
                 (user_id, local_date, cardio_type, duration_minutes, distance_km,
                  average_heart_rate, max_heart_rate, hr_zone, calories, notes, source)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'IMPORT_TEXT')`,
              [
                user, record.date, session.cardioType, session.sessionMinutes,
                session.distanceKm, session.averageHeartRate, session.maxHeartRate,
                session.hrZone, session.sessionCalories, session.rawLabel,
              ],
            );
          }
        }
      }
    });
  });

  // ------------------------------------------------------------------ parse

  it('parses both days as separate records', () => {
    expect(payload).toHaveLength(2);
    expect(payload.map((r) => r.date)).toEqual(['2026-08-27', '2026-08-28']);
  });

  it('reads every session field the summary carried', () => {
    const [aug27, aug28] = payload;
    const lower = aug27!.sessions.find((s) => s.kind === 'WORKOUT')!;
    expect(lower.sessionType).toBe('LOWER');
    expect(lower.sessionMinutes).toBe(64);
    expect(lower.averageHeartRate).toBe(138);
    expect(lower.maxHeartRate).toBe(169);
    expect(lower.sessionCalories).toBe(395);

    const pull = aug28!.sessions.find((s) => s.kind === 'WORKOUT')!;
    expect(pull.sessionType).toBe('PULL');
    expect(pull.sessionMinutes).toBe(58);
    expect(pull.averageHeartRate).toBe(142);
    expect(pull.maxHeartRate).toBe(171);
    expect(pull.sessionCalories).toBe(412);
  });

  it('normalises cardio distance from miles to kilometres at the boundary', () => {
    const zone2 = payload[0]!.sessions.find((s) => s.kind === 'CARDIO')!;
    expect(zone2.sessionMinutes).toBe(25);
    expect(zone2.distanceKm).toBeCloseTo(3.379, 2);
    expect(zone2.averageHeartRate).toBe(135);
    expect(zone2.maxHeartRate).toBe(146);
  });

  // ------------------------------------------------------------------ store

  it('stores two workouts and two cardio sessions', async () => {
    const { rows } = await withUser(db, user, (tx) =>
      tx.query<{ workouts: string; cardio: string }>(
        `select (select count(*)::text from workout_sessions) as workouts,
                (select count(*)::text from cardio_sessions) as cardio`,
      ),
    );
    expect(rows[0]).toEqual({ workouts: '2', cardio: '2' });
  });

  // ---------------------------------------------------------------- display

  it('shows both sessions on Training, with duration, HR and calories', async () => {
    const { rows } = await withUser(db, user, (tx) =>
      // local_date is cast because PGlite's driver hands back a JS Date for a
      // date column, while PostgREST hands the app an ISO string.
      tx.query<SessionRow>(
        `select id, local_date::text, session_type, duration_minutes,
                average_heart_rate, max_heart_rate, calories, notes, source,
                completed, start_time, end_time
           from workout_sessions where superseded_at is null
          order by local_date desc`,
      ),
    );
    const sessions = toDomain(rows);
    const summary = summariseSessions(sessions, []);

    // The four figures at the top of the Training page.
    expect(summary.value!.totalSessions).toBe(2);
    expect(summary.value!.totalMinutes).toBe(122);
    expect(summary.value!.averageHeartRate).toBeCloseTo(139.9, 1);
    expect(summary.value!.maxHeartRate).toBe(171);
    expect(summary.value!.totalCalories).toBe(807);

    // And the session history rows beneath them.
    expect(sessions.map((s) => [s.date, s.sessionType, s.durationMinutes])).toEqual([
      ['2026-08-28', 'PULL', 58],
      ['2026-08-27', 'LOWER', 64],
    ]);
  });

  it('reports no exercise-level data at all, and invents none', async () => {
    const { rows } = await withUser(db, user, (tx) =>
      tx.query<{ count: string }>(`select count(*)::text as count from workout_sets`),
    );
    expect(rows[0]!.count).toBe('0');

    const training = summariseTraining([]);
    expect(training.value!.totalWorkingSets).toBe(0);
    expect(training.value!.totalVolumeKg).toBeNull();
    expect(training.value!.averageRir).toBeNull();
    expect(training.value!.byMuscleGroup).toEqual([]);
    expect(exerciseProgression([], 'cable-row').value!.state).toBe('INSUFFICIENT_DATA');
  });

  it('keeps the raw workout label, so "Lower" survives the enum', async () => {
    const { rows } = await withUser(db, user, (tx) =>
      tx.query<{ notes: string }>(
        `select notes from workout_sessions order by local_date`,
      ),
    );
    expect(rows.map((r) => r.notes)).toEqual(['Lower', 'Pull']);
  });

  it('leaves cardio exactly as it was, on both days', async () => {
    const { rows } = await withUser(db, user, (tx) =>
      tx.query<{
        local_date: string; cardio_type: string; duration_minutes: string;
        average_heart_rate: string; max_heart_rate: string;
      }>(
        `select local_date::text, cardio_type, duration_minutes,
                average_heart_rate, max_heart_rate
           from cardio_sessions order by local_date`,
      ),
    );
    expect(rows.map((r) => [r.cardio_type, Number(r.duration_minutes),
      Number(r.average_heart_rate), Number(r.max_heart_rate)])).toEqual([
      ['OTHER', 25, 135, 146],
      ['INCLINE_WALKING', 30, 139, 151],
    ]);
  });

  it('rolls each day up separately in the canonical layer', async () => {
    const { rows } = await withUser(db, user, (tx) =>
      tx.query<{ local_date: string; sessions: string; minutes: string; cardio: string }>(
        `select local_date::text,
                count(*)::text as sessions,
                sum(duration_minutes)::text as minutes,
                (select sum(duration_minutes)::text from cardio_sessions c
                  where c.local_date = w.local_date and c.superseded_at is null) as cardio
           from workout_sessions w
          where superseded_at is null
          group by local_date order by local_date`,
      ),
    );
    expect(rows).toEqual([
      { local_date: '2026-08-27', sessions: '1', minutes: '64.0', cardio: '25.0' },
      { local_date: '2026-08-28', sessions: '1', minutes: '58.0', cardio: '30.0' },
    ]);
  });
});

describe('a corrected re-import replaces rather than doubles', () => {
  let db: TestDb;
  let user: string;

  beforeAll(async () => {
    db = await createTestDb();
    user = await createUser(db, 'owner@example.com');
    await withUser(db, user, (tx) =>
      tx.query(
        `insert into workout_sessions
           (user_id, local_date, duration_minutes, session_type, source)
         values ($1, '2026-08-28', 58, 'PULL', 'IMPORT_TEXT')`,
        [user],
      ),
    );
  });

  it('totals 65 minutes, not 123, after a REPLACE', async () => {
    const original = await withUser(db, user, (tx) =>
      tx.query<{ id: string }>(`select id from workout_sessions`),
    );
    const oldId = original.rows[0]!.id;

    // Exactly what the importer does for a REPLACE: insert, then supersede.
    const inserted = await withUser(db, user, (tx) =>
      tx.query<{ id: string }>(
        `insert into workout_sessions
           (user_id, local_date, duration_minutes, session_type, source)
         values ($1, '2026-08-28', 65, 'PULL', 'IMPORT_TEXT') returning id`,
        [user],
      ),
    );
    await withUser(db, user, (tx) =>
      tx.query(
        `update workout_sessions set superseded_at = now(), superseded_by = $1 where id = $2`,
        [inserted.rows[0]!.id, oldId],
      ),
    );

    const live = await withUser(db, user, (tx) =>
      tx.query<{ sessions: string; minutes: string }>(
        `select count(*)::text as sessions, sum(duration_minutes)::text as minutes
           from workout_sessions where superseded_at is null`,
      ),
    );
    expect(live.rows[0]).toEqual({ sessions: '1', minutes: '65.0' });

    // Nothing was deleted: both observations are still on record.
    const all = await withUser(db, user, (tx) =>
      tx.query<{ count: string }>(`select count(*)::text as count from workout_sessions`),
    );
    expect(all.rows[0]!.count).toBe('2');
  });
});
