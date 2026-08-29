/**
 * The importer's write path, against real PostgreSQL (spec §8, §17, §38, §48).
 *
 * tests/unit/import-action.test.ts pins what confirmImport ASKS the database
 * for. This file runs those same row shapes through the actual schema, as the
 * non-superuser `authenticated` role with auth.uid() bound, so the CHECK
 * constraints, the unique index behind import idempotency and the RLS policies
 * are the real ones.
 *
 * Scope: this proves the SQL and the policy logic. It is not a substitute for
 * verifying the hosted Supabase deployment, which needs a real project.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, createUser, withUser, type TestDb } from '../helpers/pglite';
import { idempotencyKey } from '@/lib/health/idempotency';
import { SEVEN_DAY_REPORT } from '../helpers/importFixtures';
import { parseText } from '@/lib/health/parser';

const SOURCE = 'IMPORT_TEXT';

/** Inserts a health_imports row exactly as confirmImport does: PENDING first. */
async function startImport(
  db: TestDb, userId: string, rawText: string, date: string,
): Promise<string> {
  const { rows } = await withUser(db, userId, (tx) =>
    tx.query<{ id: string }>(
      `insert into health_imports
         (user_id, raw_text, parsed, parser_name, parser_version,
          target_local_date, source, status, idempotency_key)
       values ($1, $2, '{}'::jsonb, 'text-line-parser', '2.0.0', $3, $4, 'PENDING', $5)
       returning id`,
      [userId, rawText, date, SOURCE, idempotencyKey(rawText, date as never)],
    ),
  );
  return rows[0]!.id;
}

describe('import write path', () => {
  let db: TestDb;
  let alice: string;

  beforeAll(async () => {
    db = await createTestDb();
    alice = await createUser(db, 'alice@example.com');
  });

  afterAll(async () => {
    await db?.close();
  });

  it('writes a full day across every domain table', async () => {
    const date = '2026-09-01';
    const importId = await startImport(db, alice, 'Date: 2026-09-01\nfull day', date);

    await withUser(db, alice, async (tx) => {
      await tx.query(
        `insert into body_measurements
           (user_id, measured_at, local_date, weight_kg, waist_cm, source, import_id)
         values ($1, now(), $2, 92.397, 89.9, $3, $4)`,
        [alice, date, SOURCE, importId],
      );
      await tx.query(
        `insert into nutrition_logs
           (user_id, local_date, calories, protein_g, carbs_g, fat_g, fiber_g, source, import_id)
         values ($1, $2, 2001, 172, 198, 67, 29, $3, $4)`,
        [alice, date, SOURCE, importId],
      );
      await tx.query(
        `insert into metric_observations
           (user_id, metric, value, measured_at, local_date, source, import_id)
         values ($1, 'STEPS', 15000, now(), $2, $3, $4),
                ($1, 'ACTIVE_CALORIES', 640, now(), $2, $3, $4),
                ($1, 'RESTING_HEART_RATE', 58, now(), $2, $3, $4),
                ($1, 'HRV_MS', 71, now(), $2, $3, $4)`,
        [alice, date, SOURCE, importId],
      );
      await tx.query(
        `insert into sleep_records
           (user_id, local_date, duration_minutes, source, import_id)
         values ($1, $2, 450, $3, $4)`,
        [alice, date, SOURCE, importId],
      );
      await tx.query(
        `insert into workout_sessions
           (user_id, local_date, duration_minutes, session_type,
            average_heart_rate, max_heart_rate, calories, notes, source, import_id)
         values ($1, $2, 55, 'PUSH', 128, 161, 430, 'Push', $3, $4)`,
        [alice, date, SOURCE, importId],
      );
      await tx.query(
        `insert into cardio_sessions
           (user_id, local_date, cardio_type, duration_minutes, distance_km,
            average_heart_rate, max_heart_rate, hr_zone, calories, notes, source, import_id)
         values ($1, $2, 'INCLINE_WALKING', 30, 2.4, 118, 132, 2, 210, 'Incline walk', $3, $4)`,
        [alice, date, SOURCE, importId],
      );

      await tx.query(
        `update health_imports set status = 'CONFIRMED', confirmed_at = now() where id = $1`,
        [importId],
      );
    });

    const { rows } = await withUser(db, alice, (tx) =>
      tx.query<{ status: string }>(`select status from health_imports where id = $1`, [importId]),
    );
    expect(rows[0]!.status).toBe('CONFIRMED');
  });

  it('stores the units it was given, unchanged', async () => {
    const { rows } = await withUser(db, alice, (tx) =>
      tx.query<{ weight_kg: string; waist_cm: string }>(
        `select weight_kg, waist_cm from body_measurements where local_date = '2026-09-01'`,
      ),
    );
    expect(Number(rows[0]!.weight_kg)).toBeCloseTo(92.397, 3);
    expect(Number(rows[0]!.waist_cm)).toBeCloseTo(89.9, 1);
  });

  it('keeps every unlogged field null rather than zero', async () => {
    const { rows } = await withUser(db, alice, (tx) =>
      tx.query<{ fruit_veg_servings: number | null; notes: string | null }>(
        `select fruit_veg_servings, notes from nutrition_logs where local_date = '2026-09-01'`,
      ),
    );
    expect(rows[0]!.fruit_veg_servings).toBeNull();
    expect(rows[0]!.notes).toBeNull();

    const sleep = await withUser(db, alice, (tx) =>
      tx.query<{ sleep_score: number | null }>(
        `select sleep_score from sleep_records where local_date = '2026-09-01'`,
      ),
    );
    expect(sleep.rows[0]!.sleep_score).toBeNull();
  });

  it('links every row back to the import that made it', async () => {
    const { rows } = await withUser(db, alice, (tx) =>
      tx.query<{ n: string }>(
        `select count(*)::text as n from (
           select import_id from body_measurements where local_date = '2026-09-01'
           union all select import_id from nutrition_logs where local_date = '2026-09-01'
           union all select import_id from sleep_records where local_date = '2026-09-01'
           union all select import_id from workout_sessions where local_date = '2026-09-01'
           union all select import_id from cardio_sessions where local_date = '2026-09-01'
         ) t where import_id is not null`,
      ),
    );
    expect(Number(rows[0]!.n)).toBe(5);
  });

  it('rebuilds daily_metrics by summing the day’s sessions', async () => {
    // The aggregation lib/data/canonicalise.ts performs, run as SQL against the
    // rows just written: cardio and training totals are sums, not resolutions.
    const { rows } = await withUser(db, alice, (tx) =>
      tx.query<{ workout: string; cardio: string; zone2: string; sessions: string }>(
        `select
           (select coalesce(sum(duration_minutes), 0)::text from workout_sessions
             where local_date = '2026-09-01' and completed) as workout,
           (select coalesce(sum(duration_minutes), 0)::text from cardio_sessions
             where local_date = '2026-09-01') as cardio,
           (select coalesce(sum(duration_minutes), 0)::text from cardio_sessions
             where local_date = '2026-09-01' and hr_zone = 2) as zone2,
           (select count(*)::text from workout_sessions
             where local_date = '2026-09-01' and completed) as sessions`,
      ),
    );
    expect(Number(rows[0]!.workout)).toBe(55);
    expect(Number(rows[0]!.cardio)).toBe(30);
    expect(Number(rows[0]!.zone2)).toBe(30);
    expect(Number(rows[0]!.sessions)).toBe(1);
  });
});

describe('the CHECK constraints the range rails mirror', () => {
  let db: TestDb;
  let alice: string;

  beforeAll(async () => {
    db = await createTestDb();
    alice = await createUser(db, 'alice@example.com');
  });

  afterAll(async () => {
    await db?.close();
  });

  const refuses = (sql: string, params: unknown[]) =>
    expect(withUser(db, alice, (tx) => tx.query(sql, params))).rejects.toThrow();

  it('refuses an implausible weight', async () => {
    await refuses(
      `insert into body_measurements (user_id, measured_at, local_date, weight_kg)
       values ($1, now(), '2026-09-01', 4535)`, [alice],
    );
  });

  it('refuses a negative waist', async () => {
    await refuses(
      `insert into body_measurements (user_id, measured_at, local_date, waist_cm)
       values ($1, now(), '2026-09-01', -12)`, [alice],
    );
  });

  it('refuses an impossible heart rate', async () => {
    await refuses(
      `insert into cardio_sessions
         (user_id, local_date, cardio_type, duration_minutes, average_heart_rate)
       values ($1, '2026-09-01', 'RUNNING', 30, 900)`, [alice],
    );
  });

  it('refuses a maximum heart rate below the average', async () => {
    await refuses(
      `insert into cardio_sessions
         (user_id, local_date, cardio_type, duration_minutes,
          average_heart_rate, max_heart_rate)
       values ($1, '2026-09-01', 'RUNNING', 30, 160, 120)`, [alice],
    );
  });

  it('refuses a heart-rate zone outside 1-5', async () => {
    await refuses(
      `insert into cardio_sessions
         (user_id, local_date, cardio_type, duration_minutes, hr_zone)
       values ($1, '2026-09-01', 'RUNNING', 30, 7)`, [alice],
    );
  });

  it('refuses a sleep record longer than a day', async () => {
    await refuses(
      `insert into sleep_records (user_id, local_date, duration_minutes)
       values ($1, '2026-09-01', 1500)`, [alice],
    );
  });

  it('refuses a cardio session with no duration', async () => {
    await refuses(
      `insert into cardio_sessions (user_id, local_date, cardio_type)
       values ($1, '2026-09-01', 'RUNNING')`, [alice],
    );
  });

  it('accepts a session that reports no heart rate at all', async () => {
    await withUser(db, alice, (tx) =>
      tx.query(
        `insert into workout_sessions (user_id, local_date, session_type, duration_minutes)
         values ($1, '2026-09-02', 'PUSH', 55)`, [alice],
      ),
    );
    const { rows } = await withUser(db, alice, (tx) =>
      tx.query<{ average_heart_rate: number | null; calories: number | null }>(
        `select average_heart_rate, calories from workout_sessions where local_date = '2026-09-02'`,
      ),
    );
    expect(rows[0]!.average_heart_rate).toBeNull();
    expect(rows[0]!.calories).toBeNull();
  });
});

describe('idempotency and multi-day imports (spec §38)', () => {
  let db: TestDb;
  let alice: string;
  let bob: string;
  const week = parseText(SEVEN_DAY_REPORT, 2026).records;

  beforeAll(async () => {
    db = await createTestDb();
    alice = await createUser(db, 'alice@example.com');
    bob = await createUser(db, 'bob@example.com');
  });

  afterAll(async () => {
    await db?.close();
  });

  it('imports a seven-day paste as seven rows', async () => {
    for (const record of week) {
      await startImport(db, alice, record.rawText, record.localDate!);
    }
    const { rows } = await withUser(db, alice, (tx) =>
      tx.query<{ n: string }>(`select count(*)::text as n from health_imports`),
    );
    expect(Number(rows[0]!.n)).toBe(7);
  });

  it('refuses a repeat of any one of those days', async () => {
    const third = week[2]!;
    await expect(
      startImport(db, alice, third.rawText, third.localDate!),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it('still accepts the other days after a repeat is refused', async () => {
    // The key is per-day, so correcting one day and re-pasting the week must
    // not duplicate the six days that did not change.
    const eighth = 'Date: 2026-09-08\nSteps: 9000';
    const id = await startImport(db, alice, eighth, '2026-09-08');
    expect(id).toBeTruthy();
    const { rows } = await withUser(db, alice, (tx) =>
      tx.query<{ n: string }>(`select count(*)::text as n from health_imports`),
    );
    expect(Number(rows[0]!.n)).toBe(8);
  });

  it('scopes the key to one user, so two people may paste the same report', async () => {
    const first = week[0]!;
    const id = await startImport(db, bob, first.rawText, first.localDate!);
    expect(id).toBeTruthy();
  });

  it('keeps each day’s observations on its own date', async () => {
    await withUser(db, alice, async (tx) => {
      for (const [date, steps] of [['2026-09-01', 15000], ['2026-09-02', 11250]] as const) {
        await tx.query(
          `insert into metric_observations
             (user_id, metric, value, measured_at, local_date, source)
           values ($1, 'STEPS', $2, now(), $3, 'IMPORT_TEXT')`,
          [alice, steps, date],
        );
      }
    });
    const { rows } = await withUser(db, alice, (tx) =>
      tx.query<{ local_date: string; value: string }>(
        `select local_date::text, value::text from metric_observations order by local_date`,
      ),
    );
    expect(rows).toHaveLength(2);
    expect(Number(rows[0]!.value)).toBe(15000);
    expect(Number(rows[1]!.value)).toBe(11250);
  });

  it('lets several sessions coexist on one day without overwriting', async () => {
    await withUser(db, alice, async (tx) => {
      await tx.query(
        `insert into workout_sessions (user_id, local_date, session_type, duration_minutes)
         values ($1, '2026-09-05', 'PUSH', 45), ($1, '2026-09-05', 'LEGS', 50)`,
        [alice],
      );
      await tx.query(
        `insert into cardio_sessions (user_id, local_date, cardio_type, duration_minutes)
         values ($1, '2026-09-05', 'WALKING', 25), ($1, '2026-09-05', 'CYCLING', 40)`,
        [alice],
      );
    });
    const { rows } = await withUser(db, alice, (tx) =>
      tx.query<{ workouts: string; cardio: string }>(
        `select
           (select count(*)::text from workout_sessions where local_date = '2026-09-05') as workouts,
           (select count(*)::text from cardio_sessions where local_date = '2026-09-05') as cardio`,
      ),
    );
    expect(Number(rows[0]!.workouts)).toBe(2);
    expect(Number(rows[0]!.cardio)).toBe(2);
  });
});

describe('imports respect row-level security (spec §34, §48)', () => {
  let db: TestDb;
  let alice: string;
  let bob: string;

  beforeAll(async () => {
    db = await createTestDb();
    alice = await createUser(db, 'alice@example.com');
    bob = await createUser(db, 'bob@example.com');

    const importId = await startImport(db, alice, 'Date: 2026-09-01\nSteps: 15000', '2026-09-01');
    await withUser(db, alice, async (tx) => {
      await tx.query(
        `insert into workout_sessions
           (user_id, local_date, session_type, duration_minutes, source, import_id)
         values ($1, '2026-09-01', 'PUSH', 55, 'IMPORT_TEXT', $2)`,
        [alice, importId],
      );
      await tx.query(
        `insert into cardio_sessions
           (user_id, local_date, cardio_type, duration_minutes, source, import_id)
         values ($1, '2026-09-01', 'RUNNING', 30, 'IMPORT_TEXT', $2)`,
        [alice, importId],
      );
    });
  });

  afterAll(async () => {
    await db?.close();
  });

  it('hides one user’s imported sessions from another', async () => {
    const theirs = await withUser(db, bob, (tx) =>
      tx.query(`select id from workout_sessions union all select id from cardio_sessions`),
    );
    expect(theirs.rows).toHaveLength(0);

    const mine = await withUser(db, alice, (tx) =>
      tx.query(`select id from workout_sessions union all select id from cardio_sessions`),
    );
    expect(mine.rows).toHaveLength(2);
  });

  it('hides one user’s imports from another', async () => {
    const theirs = await withUser(db, bob, (tx) =>
      tx.query(`select id from health_imports`),
    );
    expect(theirs.rows).toHaveLength(0);
  });

  it("refuses an import row that claims another user's id", async () => {
    await expect(
      withUser(db, bob, (tx) =>
        tx.query(
          `insert into health_imports
             (user_id, raw_text, parser_name, parser_version, idempotency_key)
           values ($1, 'x', 'p', '2.0.0', 'k')`,
          [alice],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('never lets an imported observation be deleted', async () => {
    // No delete policy exists on the observation tables, so the delete is a
    // silent no-op rather than an error. History is permanent (spec §48).
    await withUser(db, alice, (tx) => tx.query(`delete from cardio_sessions`));
    const { rows } = await withUser(db, alice, (tx) =>
      tx.query(`select id from cardio_sessions`),
    );
    expect(rows).toHaveLength(1);
  });

  it('never lets an imported cardio session be edited', async () => {
    // Since 0011 this is refused outright rather than silently ignored: the
    // update privilege on cardio_sessions is granted per column and the
    // measurement columns are not among them. An attempt to rewrite a
    // measurement is now an error, which is the stronger guarantee.
    await expect(
      withUser(db, alice, (tx) =>
        tx.query(`update cardio_sessions set duration_minutes = 999`),
      ),
    ).rejects.toThrow(/permission denied/i);

    const { rows } = await withUser(db, alice, (tx) =>
      tx.query<{ duration_minutes: string }>(`select duration_minutes from cardio_sessions`),
    );
    expect(Number(rows[0]!.duration_minutes)).toBe(30);
  });

  it('does let an imported cardio session be marked superseded', async () => {
    // The one write 0011 opens up: a corrected import records a NEW row and
    // marks the one it replaces, so the day's total counts the correction
    // instead of summing both. The original row is still there.
    await withUser(db, alice, (tx) =>
      tx.query(`update cardio_sessions set superseded_at = now()`),
    );
    const { rows } = await withUser(db, alice, (tx) =>
      tx.query<{ duration_minutes: string; superseded_at: string | null }>(
        `select duration_minutes, superseded_at from cardio_sessions`,
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.superseded_at).not.toBeNull();
    expect(Number(rows[0]!.duration_minutes)).toBe(30);
  });

  it('does let the import row itself be marked confirmed', async () => {
    // health_imports is an authored record, not an observation: the confirm
    // step needs to update its status once the writes have landed.
    await withUser(db, alice, (tx) =>
      tx.query(`update health_imports set status = 'CONFIRMED'`),
    );
    const { rows } = await withUser(db, alice, (tx) =>
      tx.query<{ status: string }>(`select status from health_imports`),
    );
    expect(rows[0]!.status).toBe('CONFIRMED');
  });
});
