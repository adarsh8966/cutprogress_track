/**
 * Correcting and withdrawing, end to end through the real schema.
 *
 * tests/unit/corrections.test.ts pins what the actions ASK the database for.
 * This runs the same sequence against real PostgreSQL as the non-superuser
 * `authenticated` role with auth.uid() bound, so migration 0012's column-level
 * GRANT, its CHECK constraints and the RLS policies are the real ones - and
 * then rebuilds the canonical layer with the real rebuildDailyMetrics to prove
 * the correction actually reaches the figures every page reads.
 *
 * That last step is the point. A withdrawal the database accepts and the
 * canonical layer ignores would leave the app agreeing a record was removed
 * while every derived number went on including it.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTestDb, createUser, withUser, type TestDb } from '../helpers/pglite';

// canonicalise.ts is server-only by design; the marker package has no runtime
// behaviour, so stubbing it lets the real function run here.
vi.mock('server-only', () => ({}));

import { supabaseOverPglite } from '../helpers/supabaseOverPglite';
import { rebuildDailyMetrics } from '@/lib/data/canonicalise';
import type { LocalDate } from '@/lib/types';

describe('correction path: withdraw -> rebuild -> read', () => {
  let db: TestDb;
  let alice: string;

  beforeAll(async () => {
    db = await createTestDb();
    alice = await createUser(db, 'alice@example.com');
  });

  afterAll(async () => {
    await db?.close();
  });

  /** The one canonical row for a day, as the pages would read it. */
  async function canonical(date: LocalDate) {
    const { rows } = await withUser(db, alice, (tx) =>
      tx.query<{
        weight_kg: string | null;
        steps: string | null;
        sleep_duration_minutes: string | null;
        calories_consumed: string | null;
        cardio_minutes: string | null;
        workout_minutes: string | null;
        training_sessions: number | null;
      }>(
        `select weight_kg::text, steps::text, sleep_duration_minutes::text,
                calories_consumed::text, cardio_minutes::text, workout_minutes::text,
                training_sessions
           from daily_metrics where local_date = $1`,
        [date],
      ),
    );
    return rows[0] ?? null;
  }

  async function rebuild(date: LocalDate) {
    await withUser(db, alice, async (tx) => {
      await rebuildDailyMetrics(supabaseOverPglite(tx) as never, alice, date);
    });
  }

  it('takes a withdrawn weight out of the day without deleting it', async () => {
    const date: LocalDate = '2026-10-01';
    const id = await withUser(db, alice, async (tx) => {
      const r = await tx.query<{ id: string }>(
        `insert into body_measurements (user_id, measured_at, local_date, weight_kg)
         values ($1, now(), $2, 92.4) returning id`,
        [alice, date],
      );
      return r.rows[0]!.id;
    });
    await rebuild(date);
    expect(Number((await canonical(date))!.weight_kg)).toBeCloseTo(92.4, 3);

    // The withdrawal, through the column-level GRANT rather than a delete.
    await withUser(db, alice, (tx) =>
      tx.query(`update body_measurements set superseded_at = now() where id = $1`, [id]),
    );
    await rebuild(date);

    // Gone from the day...
    expect((await canonical(date))!.weight_kg).toBeNull();
    // ...and still on disk, with what it measured intact.
    const { rows } = await withUser(db, alice, (tx) =>
      tx.query<{ weight_kg: string }>(
        `select weight_kg::text from body_measurements where id = $1`, [id],
      ),
    );
    expect(Number(rows[0]!.weight_kg)).toBeCloseTo(92.4, 3);
  });

  it('restores a withdrawn observation back into the day', async () => {
    const date: LocalDate = '2026-10-02';
    const id = await withUser(db, alice, async (tx) => {
      const r = await tx.query<{ id: string }>(
        `insert into metric_observations
           (user_id, metric, value, measured_at, local_date)
         values ($1, 'STEPS', 15000, now(), $2) returning id`,
        [alice, date],
      );
      return r.rows[0]!.id;
    });

    await withUser(db, alice, (tx) =>
      tx.query(`update metric_observations set superseded_at = now() where id = $1`, [id]),
    );
    await rebuild(date);
    expect((await canonical(date))!.steps).toBeNull();

    await withUser(db, alice, (tx) =>
      tx.query(
        `update metric_observations set superseded_at = null, superseded_by = null
          where id = $1`,
        [id],
      ),
    );
    await rebuild(date);
    expect(Number((await canonical(date))!.steps)).toBe(15000);
  });

  /**
   * The whole reason withdrawal had to exist. Resolution is newest-wins, so a
   * WRONG value can be corrected by recording the right one - but there is no
   * number that means "I did not sleep that night", and writing 0 would
   * fabricate a measurement. Withdrawing is the only honest way to say it.
   */
  it('leaves a withdrawn field null, not zero', async () => {
    const date: LocalDate = '2026-10-03';
    const id = await withUser(db, alice, async (tx) => {
      const r = await tx.query<{ id: string }>(
        `insert into sleep_records (user_id, local_date, duration_minutes)
         values ($1, $2, 450) returning id`,
        [alice, date],
      );
      return r.rows[0]!.id;
    });

    await withUser(db, alice, (tx) =>
      tx.query(`update sleep_records set superseded_at = now() where id = $1`, [id]),
    );
    await rebuild(date);

    expect((await canonical(date))!.sleep_duration_minutes).toBeNull();
  });

  /**
   * A day's cardio is SUMMED, so this is the case a bare re-log gets wrong:
   * 30 corrected to 35 must be 35, never 65.
   */
  it('counts a corrected cardio session once, not twice', async () => {
    const date: LocalDate = '2026-10-04';
    const original = await withUser(db, alice, async (tx) => {
      const r = await tx.query<{ id: string }>(
        `insert into cardio_sessions
           (user_id, local_date, cardio_type, duration_minutes)
         values ($1, $2, 'INCLINE_WALKING', 30) returning id`,
        [alice, date],
      );
      return r.rows[0]!.id;
    });
    await rebuild(date);
    expect(Number((await canonical(date))!.cardio_minutes)).toBe(30);

    // The correction: a new row, then the old one superseded BY it.
    const replacement = await withUser(db, alice, async (tx) => {
      const r = await tx.query<{ id: string }>(
        `insert into cardio_sessions
           (user_id, local_date, cardio_type, duration_minutes)
         values ($1, $2, 'INCLINE_WALKING', 35) returning id`,
        [alice, date],
      );
      return r.rows[0]!.id;
    });
    await withUser(db, alice, (tx) =>
      tx.query(
        `update cardio_sessions set superseded_at = now(), superseded_by = $2
          where id = $1`,
        [original, replacement],
      ),
    );
    await rebuild(date);

    expect(Number((await canonical(date))!.cardio_minutes)).toBe(35);

    // Both rows are still on file, and the correction is traceable forwards.
    const { rows } = await withUser(db, alice, (tx) =>
      tx.query<{ id: string; superseded_by: string | null }>(
        `select id, superseded_by from cardio_sessions where local_date = $1
          order by duration_minutes`,
        [date],
      ),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.superseded_by).toBe(replacement);
  });

  it('takes a withdrawn training session out of the day count', async () => {
    const date: LocalDate = '2026-10-05';
    const id = await withUser(db, alice, async (tx) => {
      const r = await tx.query<{ id: string }>(
        `insert into workout_sessions
           (user_id, local_date, session_type, duration_minutes)
         values ($1, $2, 'PULL', 58) returning id`,
        [alice, date],
      );
      return r.rows[0]!.id;
    });
    await rebuild(date);
    expect((await canonical(date))!.training_sessions).toBe(1);
    expect(Number((await canonical(date))!.workout_minutes)).toBe(58);

    await withUser(db, alice, (tx) =>
      tx.query(`update workout_sessions set superseded_at = now() where id = $1`, [id]),
    );
    await rebuild(date);

    // No sessions left on the day at all: null, which is "not logged", rather
    // than 0, which would claim a day with a zero-minute workout on it.
    expect((await canonical(date))!.training_sessions).toBeNull();
    expect((await canonical(date))!.workout_minutes).toBeNull();
  });

  it('leaves the other observations on the day alone', async () => {
    const date: LocalDate = '2026-10-06';
    const weightId = await withUser(db, alice, async (tx) => {
      await tx.query(
        `insert into nutrition_logs (user_id, local_date, calories)
         values ($1, $2, 2001)`,
        [alice, date],
      );
      const r = await tx.query<{ id: string }>(
        `insert into body_measurements (user_id, measured_at, local_date, weight_kg)
         values ($1, now(), $2, 93.1) returning id`,
        [alice, date],
      );
      return r.rows[0]!.id;
    });

    await withUser(db, alice, (tx) =>
      tx.query(`update body_measurements set superseded_at = now() where id = $1`, [weightId]),
    );
    await rebuild(date);

    const day = (await canonical(date))!;
    expect(day.weight_kg).toBeNull();
    expect(Number(day.calories_consumed)).toBe(2001);
  });
});
