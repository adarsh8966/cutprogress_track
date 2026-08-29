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

  /**
   * 0012 gave the observation tables a narrow update, so this is no longer a
   * silent no-op: the statement is REFUSED. That is the stronger of the two
   * outcomes - a rejected write cannot be mistaken for a successful one - and
   * it is what the column-level grant buys. The measurement is unchanged
   * either way, which is the property spec §6 actually asks for.
   */
  it('makes raw measurements unoverwritable (spec §6)', async () => {
    await expect(
      withUser(db, alice, (tx) =>
        tx.query(`update body_measurements set weight_kg = 1`),
      ),
    ).rejects.toThrow(/permission denied/i);

    const after = await withUser(db, alice, (tx) =>
      tx.query<{ weight_kg: string }>(`select weight_kg from body_measurements`),
    );
    expect(Number(after.rows[0]!.weight_kg)).toBeCloseTo(92.986, 3);
  });

  /**
   * THE OBSERVATION TABLES' PRIVILEGES, IN FULL.
   *
   * Each has select, insert, and - since 0011 for cardio and 0012 for the rest
   * - an update policy, so a correction can mark the row it replaces as
   * superseded. The policy alone would be far too much power: it would make
   * every measurement editable in place and undo spec §48. So the UPDATE
   * privilege is granted per COLUMN, and Postgres requires BOTH the policy and
   * the column privilege. The measurement columns are not in the grant.
   *
   * None of them has a delete policy, and none ever should.
   */
  it.each([
    'metric_observations',
    'nutrition_logs',
    'sleep_records',
    'body_measurements',
    'cardio_sessions',
  ])('scopes %s to select, insert and the supersession columns', async (table) => {
    const { rows } = await db.query<{ cmd: string }>(
      `select cmd from pg_policies where tablename = $1`,
      [table],
    );
    const commands = rows.map((r) => r.cmd);
    expect(commands).toContain('SELECT');
    expect(commands).toContain('INSERT');
    expect(commands).toContain('UPDATE');
    // History is permanent. There is no delete policy on any of these.
    expect(commands).not.toContain('DELETE');

    const { rows: grants } = await db.query<{ column_name: string }>(
      `select column_name from information_schema.column_privileges
        where table_name = $1
          and grantee = 'authenticated'
          and privilege_type = 'UPDATE'
        order by column_name`,
      [table],
    );
    expect(grants.map((g) => g.column_name)).toEqual(['superseded_at', 'superseded_by']);
  });

  /**
   * The privileges above, exercised rather than inspected. A grant that reads
   * correctly in the catalogue and behaves differently is worth nothing.
   */
  describe('superseding an observation', () => {
    it("lets a user withdraw their own observation without touching its value", async () => {
      const id = await withUser(db, alice, async (tx) => {
        const r = await tx.query<{ id: string }>(
          `insert into sleep_records (user_id, local_date, duration_minutes)
           values ($1, '2026-09-10', 450) returning id`,
          [alice],
        );
        return r.rows[0]!.id;
      });

      await withUser(db, alice, (tx) =>
        tx.query(`update sleep_records set superseded_at = now() where id = $1`, [id]),
      );

      const after = await withUser(db, alice, (tx) =>
        tx.query<{ duration_minutes: string; superseded_at: string | null }>(
          `select duration_minutes, superseded_at from sleep_records where id = $1`,
          [id],
        ),
      );
      // Still on disk, still holding what it measured, no longer live.
      expect(Number(after.rows[0]!.duration_minutes)).toBe(450);
      expect(after.rows[0]!.superseded_at).not.toBeNull();
    });

    it('refuses to change the measurement under cover of a supersession', async () => {
      await expect(
        withUser(db, alice, (tx) =>
          tx.query(
            `update sleep_records set superseded_at = now(), duration_minutes = 1`,
          ),
        ),
      ).rejects.toThrow(/permission denied/i);
    });

    it("cannot reach another user's observation", async () => {
      const { rows } = await withUser(db, bob, (tx) =>
        tx.query(`update sleep_records set superseded_at = now() returning id`),
      );
      // RLS scopes the update to bob's own rows, and he has none here.
      expect(rows).toHaveLength(0);
    });

    it('refuses a row that names a replacement without saying when', async () => {
      const id = await withUser(db, alice, async (tx) => {
        const r = await tx.query<{ id: string }>(
          `insert into body_measurements (user_id, measured_at, local_date, weight_kg)
           values ($1, now(), '2026-09-11', 93) returning id`,
          [alice],
        );
        return r.rows[0]!.id;
      });

      await expect(
        withUser(db, alice, (tx) =>
          tx.query(`update body_measurements set superseded_by = $1 where id = $1`, [id]),
        ),
      ).rejects.toThrow(/supersession_coherent|not_self_superseding/i);
    });
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
