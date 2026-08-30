/**
 * Hevy cannot touch anything but training (§4), proved against the database.
 *
 * The unit tests prove the CLIENT has no method for body data and the MAPPER's
 * output type has no field for it. This proves the consequence: after a sync,
 * every health measurement CUT OS holds is byte-identical to what it held
 * before, and the canonical row for the day still resolves to the values the
 * user recorded.
 *
 * The day is 2026-08-29 deliberately - the day of the manual-then-imported
 * weight correction this repository already pins in
 * tests/integration/weight-correction-path.test.ts. A Hevy sync landing on that
 * day must not disturb that resolution in either direction: it must not become
 * a candidate for the weight, and it must not knock the existing candidates out.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, createUser, withUser, type TestDb } from '../helpers/pglite';

vi.mock('server-only', () => ({}));

import { supabaseOverPglite } from '../helpers/supabaseOverPglite';
import { fakeHevy, hevyWorkout } from '../helpers/hevyFixtures';
import { createHevyClient } from '@/lib/integrations/hevy/client';
import { runHevySync } from '@/lib/integrations/hevy/sync';
import { canonicalWeight, displayWeight } from '@/lib/normalization/units';

const TZ = 'America/New_York';
const DAY = '2026-08-29';

describe('a Hevy sync cannot write health data', () => {
  let db: TestDb;
  let alice: string;

  beforeEach(async () => {
    db = await createTestDb();
    alice = await createUser(db, 'alice@example.com');
    await db.query(`insert into profiles (id, timezone) values ($1, $2)`, [alice, TZ]);

    // A day already carrying everything Hevy must never touch.
    await withUser(db, alice, async (tx) => {
      await tx.query(
        `insert into body_measurements (user_id, measured_at, local_date, weight_kg, waist_cm, source)
         values ($1, '2026-08-29T12:00:00Z', $2, $3, 88.9, 'MANUAL')`,
        [alice, DAY, canonicalWeight(203.0, 'LB')],
      );
      await tx.query(
        `insert into metric_observations (user_id, metric, value, measured_at, local_date, source)
         values ($1, 'STEPS', 15000, '2026-08-29T23:00:00Z', $2, 'MANUAL'),
                ($1, 'ACTIVE_CALORIES', 640, '2026-08-29T23:00:00Z', $2, 'MANUAL'),
                ($1, 'RESTING_HEART_RATE', 48, '2026-08-29T08:00:00Z', $2, 'MANUAL'),
                ($1, 'HRV_MS', 62, '2026-08-29T08:00:00Z', $2, 'MANUAL')`,
        [alice, DAY],
      );
      await tx.query(
        `insert into nutrition_logs (user_id, local_date, calories, protein_g, source)
         values ($1, $2, 2001, 185, 'MANUAL')`,
        [alice, DAY],
      );
      await tx.query(
        `insert into sleep_records (user_id, local_date, duration_minutes, sleep_score, source)
         values ($1, $2, 431, 82, 'MANUAL')`,
        [alice, DAY],
      );
      await tx.query(
        `insert into cardio_sessions
           (user_id, local_date, cardio_type, duration_minutes, distance_km, hr_zone, source)
         values ($1, $2, 'INCLINE_WALKING', 30, 2.4, 2, 'MANUAL')`,
        [alice, DAY],
      );
    });
  });

  afterEach(async () => {
    await db?.close();
  });

  /** Everything the sync must leave exactly as it found it. */
  async function healthSnapshot() {
    const { rows } = await withUser(db, alice, (tx) =>
      tx.query<{ table_name: string; digest: string }>(`
        select 'body_measurements' as table_name,
               coalesce(md5(string_agg(t::text, '|' order by t.id)), 'empty') as digest
          from body_measurements t
        union all select 'metric_observations',
               coalesce(md5(string_agg(t::text, '|' order by t.id)), 'empty') from metric_observations t
        union all select 'nutrition_logs',
               coalesce(md5(string_agg(t::text, '|' order by t.id)), 'empty') from nutrition_logs t
        union all select 'sleep_records',
               coalesce(md5(string_agg(t::text, '|' order by t.id)), 'empty') from sleep_records t
        union all select 'cardio_sessions',
               coalesce(md5(string_agg(t::text, '|' order by t.id)), 'empty') from cardio_sessions t
        order by table_name
      `));
    return rows;
  }

  async function sync() {
    return withUser(db, alice, async (tx) => {
      const api = createHevyClient({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.test',
        // A payload that also carries body-shaped fields, in case Hevy ever
        // starts sending them on a workout. They must go nowhere.
        fetch: fakeHevy({
          events: [{
            type: 'updated',
            workout: {
              ...hevyWorkout(),
              weight_kg: 90.1,
              body_fat_percent: 17.2,
              waist_cm: 84,
              steps: 99,
              active_calories: 1,
              resting_heart_rate: 200,
              hrv_ms: 1,
              sleep_minutes: 1,
              calories_consumed: 9999,
            },
          }],
        }),
        sleep: async () => {},
      });
      return runHevySync(supabaseOverPglite(tx) as never, alice, {
        api, trigger: 'MANUAL',
      });
    });
  }

  it('leaves every health observation byte-identical', async () => {
    const before = await healthSnapshot();
    const result = await sync();
    expect(result.ok).toBe(true);
    // The training itself definitely landed - otherwise this asserts nothing.
    expect(result.workoutsCreated).toBe(1);

    expect(await healthSnapshot()).toEqual(before);
  });

  it('writes no new row to any health table', async () => {
    await sync();
    const { rows } = await withUser(db, alice, (tx) =>
      tx.query<{ n: string }>(`
        select (
          (select count(*) from body_measurements)
          + (select count(*) from metric_observations)
          + (select count(*) from nutrition_logs)
          + (select count(*) from sleep_records)
          + (select count(*) from cardio_sessions)
        )::text as n`));
    // 1 body + 4 metrics + 1 nutrition + 1 sleep + 1 cardio, and not one more.
    expect(rows[0]!.n).toBe('8');
  });

  it('leaves the day’s canonical health values resolving exactly as before', async () => {
    await sync();

    const { rows } = await withUser(db, alice, (tx) =>
      tx.query<{
        weight_kg: string | null; waist_cm: string | null; steps: number | null;
        active_calories: string | null; resting_heart_rate: string | null;
        hrv_ms: string | null; sleep_duration_minutes: string | null;
        calories_consumed: string | null; cardio_minutes: string | null;
        zone2_minutes: string | null; workout_minutes: string | null;
        training_sessions: number | null;
      }>(`select * from daily_metrics where local_date = $1`, [DAY]));

    const day = rows[0]!;
    // The user's own measurements, untouched by a sync that had numbers of its
    // own for every one of them.
    // weight_kg is numeric(6,3), so a pound value round-trips to within a
    // thousandth of a kilo. The point is that it is the USER's 203.0 and not
    // the 90.1 kg the sync payload carried.
    expect(displayWeight(Number(day.weight_kg), 'LB')).toBeCloseTo(203.0, 2);
    expect(Number(day.waist_cm)).toBe(88.9);
    expect(day.steps).toBe(15000);
    expect(Number(day.active_calories)).toBe(640);
    expect(Number(day.resting_heart_rate)).toBe(48);
    expect(Number(day.hrv_ms)).toBe(62);
    expect(Number(day.sleep_duration_minutes)).toBe(431);
    expect(Number(day.calories_consumed)).toBe(2001);
    // Cardio stays CUT OS's own, even though the workout carried per-set
    // distance and duration of its own.
    expect(Number(day.cardio_minutes)).toBe(30);
    expect(Number(day.zone2_minutes)).toBe(30);

    // And the training DID land, on the same day, through the same rebuild.
    expect(Number(day.workout_minutes)).toBe(64);
    expect(day.training_sessions).toBe(1);
  });

  it('does not become a candidate for the day’s weight', async () => {
    await sync();
    const { rows } = await withUser(db, alice, (tx) =>
      tx.query<{ provenance: Record<string, { source: string; candidates: number }> }>(
        `select provenance from daily_metrics where local_date = $1`, [DAY],
      ));
    const provenance = rows[0]!.provenance;
    // One candidate, from MANUAL. A sync that had a weight in its payload did
    // not add itself to the resolution - which is what §4 means in practice.
    expect(provenance.weightKg).toMatchObject({ source: 'MANUAL', candidates: 1 });
    expect(provenance.steps).toMatchObject({ source: 'MANUAL' });
    expect(provenance.sleepDurationMinutes).toMatchObject({ source: 'MANUAL' });
  });

  it('records the training in the tables it IS allowed to write', async () => {
    await sync();
    const { rows } = await withUser(db, alice, (tx) =>
      tx.query<{ table_name: string; n: string }>(`
        select 'workout_sessions' as table_name, count(*)::text as n from workout_sessions
        union all select 'workout_sets', count(*)::text from workout_sets
        union all select 'health_imports', count(*)::text from health_imports
        order by table_name`));
    expect(rows).toEqual([
      { table_name: 'health_imports', n: '1' },
      { table_name: 'workout_sessions', n: '1' },
      { table_name: 'workout_sets', n: '5' },
    ]);
  });

  it('keeps the workout payload verbatim, so nothing has to be asked twice', async () => {
    await sync();
    const { rows } = await withUser(db, alice, (tx) =>
      tx.query<{ raw_text: string; source: string; status: string }>(
        `select raw_text, source, status from health_imports`,
      ));
    expect(rows[0]!.source).toBe('HEVY');
    expect(rows[0]!.status).toBe('CONFIRMED');
    // §17: the original input is kept, whole. Even the body-shaped fields the
    // mapper refused are still there - stored, and never acted on.
    const stored = JSON.parse(rows[0]!.raw_text);
    expect(stored.title).toBe('Push Day');
    expect(stored.weight_kg).toBe(90.1);
  });
});
