/**
 * Row-level-security behaviour (spec §34, §48).
 *
 * These run against real PostgreSQL (PGlite) as the non-superuser
 * `authenticated` role with auth.uid() bound to a specific user, which is what
 * actually puts the policies in force.
 *
 * Scope: this proves the POLICY LOGIC in 0008_rls.sql is correct. It is not a
 * substitute for verifying the hosted Supabase deployment.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, createUser, withUser, type TestDb } from '../helpers/pglite';

describe('row level security', () => {
  let db: TestDb;
  let alice: string;
  let bob: string;

  beforeAll(async () => {
    db = await createTestDb();
    alice = await createUser(db, 'alice@example.com');
    bob = await createUser(db, 'bob@example.com');

    await withUser(db, alice, async (tx) => {
      await tx.query(
        `insert into body_measurements (user_id, measured_at, local_date, weight_kg)
         values ($1, '2026-08-28T17:30:00Z', '2026-08-28', 92.986)`,
        [alice],
      );
      await tx.query(
        `insert into daily_metrics (user_id, local_date, weight_kg)
         values ($1, '2026-08-28', 92.986)`,
        [alice],
      );
    });
  });

  afterAll(async () => {
    await db?.close();
  });

  it('shows a user only their own observations', async () => {
    const mine = await withUser(db, alice, (tx) =>
      tx.query(`select id from body_measurements`),
    );
    expect(mine.rows).toHaveLength(1);

    const theirs = await withUser(db, bob, (tx) =>
      tx.query(`select id from body_measurements`),
    );
    expect(theirs.rows).toHaveLength(0);
  });

  it("refuses an insert that claims another user's id", async () => {
    await expect(
      withUser(db, bob, (tx) =>
        tx.query(
          `insert into body_measurements (user_id, measured_at, local_date, weight_kg)
           values ($1, now(), current_date, 80)`,
          [alice],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('makes historical observations undeletable (spec §48)', async () => {
    await withUser(db, alice, async (tx) => {
      await tx.query(`delete from body_measurements`);
    });

    const after = await withUser(db, alice, (tx) =>
      tx.query(`select weight_kg from body_measurements`),
    );
    // No delete policy exists, so the delete matches nothing and the
    // observation survives. This is the structural form of "never delete
    // historical observations".
    expect(after.rows).toHaveLength(1);
  });

  it('makes raw measurements unoverwritable (spec §6)', async () => {
    await withUser(db, alice, async (tx) => {
      await tx.query(`update body_measurements set weight_kg = 1`);
    });

    const after = await withUser(db, alice, (tx) =>
      tx.query<{ weight_kg: string }>(`select weight_kg from body_measurements`),
    );
    expect(Number(after.rows[0]!.weight_kg)).toBeCloseTo(92.986, 3);
  });

  it.each([
    'metric_observations',
    'nutrition_logs',
    'sleep_records',
    'cardio_sessions',
    'body_measurements',
  ])('grants no update or delete policy on %s', async (table) => {
    const { rows } = await db.query<{ cmd: string }>(
      `select cmd from pg_policies where tablename = $1`,
      [table],
    );
    const commands = rows.map((r) => r.cmd);
    expect(commands).toContain('SELECT');
    expect(commands).toContain('INSERT');
    expect(commands).not.toContain('UPDATE');
    expect(commands).not.toContain('DELETE');
  });

  it.each(['system_events', 'context_exports'])(
    'keeps %s append-only (spec §41)',
    async (table) => {
      const { rows } = await db.query<{ cmd: string }>(
        `select cmd from pg_policies where tablename = $1`,
        [table],
      );
      const commands = rows.map((r) => r.cmd);
      expect(commands).toEqual(expect.arrayContaining(['SELECT', 'INSERT']));
      expect(commands).not.toContain('UPDATE');
      expect(commands).not.toContain('DELETE');
    },
  );

  it('does not let a signed-in user write the shared exercise catalog', async () => {
    // The catalog is reference data, seeded by migration under the service
    // role. An ordinary user may read it and nothing more.
    await expect(
      withUser(db, alice, (tx) =>
        tx.query(
          `insert into exercises (exercise_id, name, primary_muscle_group, equipment)
           values ('made-up', 'Made Up', 'Chest', 'Cable')`,
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('allows correcting a set while a workout is being logged', async () => {
    // Seeded the way 0009 seeds it: as the migration role, not as the user.
    await db.query(
      `insert into exercises (exercise_id, name, primary_muscle_group, equipment)
       values ('cable-row', 'Cable Row', 'Back', 'Cable')
       on conflict do nothing`,
    );

    const sessionId = await withUser(db, alice, async (tx) => {
      const r = await tx.query<{ id: string }>(
        `insert into workout_sessions (user_id, local_date, session_type)
         values ($1, '2026-08-28', 'PULL') returning id`,
        [alice],
      );
      return r.rows[0]!.id;
    });

    await withUser(db, alice, async (tx) => {
      await tx.query(
        `insert into workout_sets (user_id, session_id, exercise_id, set_number, weight_kg, reps)
         values ($1, $2, 'cable-row', 1, 31.75, 12)`,
        [alice, sessionId],
      );
      await tx.query(`update workout_sets set reps = 11 where session_id = $1`, [
        sessionId,
      ]);
    });

    const after = await withUser(db, alice, (tx) =>
      tx.query<{ reps: number }>(`select reps from workout_sets`),
    );
    expect(after.rows[0]!.reps).toBe(11);
  });

  it('lets the rebuildable canonical cache be discarded and recomputed', async () => {
    await withUser(db, alice, async (tx) => {
      await tx.query(`delete from daily_metrics`);
    });
    const after = await withUser(db, alice, (tx) =>
      tx.query(`select id from daily_metrics`),
    );
    expect(after.rows).toHaveLength(0);
  });

  it('forces RLS so the table owner cannot bypass it', async () => {
    const { rows } = await db.query<{ relname: string; relforcerowsecurity: boolean }>(
      `select relname, relforcerowsecurity from pg_class
       where relname in ('body_measurements', 'daily_metrics', 'profiles')`,
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.relforcerowsecurity, `${row.relname} must FORCE RLS`).toBe(true);
    }
  });
});
