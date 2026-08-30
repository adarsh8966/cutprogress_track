/**
 * The Google Health sync, end to end, against real PostgreSQL.
 *
 * Every layer between Google and the database is the real one: the real client
 * over an injected fetch, the real registry, the real mapper, the real writer,
 * the real correlation, the real rebuildDailyMetrics, the real migrations and
 * the real RLS policies. The only thing standing in for anything is Google.
 *
 * That matters because none of the guarantees under test is a property of one
 * layer. "Syncing twice imports nothing twice" is a claim about a unique index,
 * a version key derived in one file and a branch taken in another; asserting it
 * against a mock asserts the mock.
 *
 * SCOPE, as everywhere else: PGlite is real PostgreSQL and this exercises the
 * schema, the constraints, the policies and the code. It is not proof that a
 * hosted Supabase project behaves the same.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, createUser, withUser, type TestDb } from '../helpers/pglite';

vi.mock('server-only', () => ({}));

import { supabaseOverPglite } from '../helpers/supabaseOverPglite';
import {
  fakeGoogleHealth, ALL_SCOPES, sample, daily, interval,
  exerciseSession, sleepSession, heartRateSamples,
  stepsDay, namelessDaily, namelessSample,
} from '../helpers/googleHealthFixtures';
import { isDerivedExternalId } from '@/lib/integrations/googleHealth/identity';
import { createGoogleHealthClient } from '@/lib/integrations/googleHealth/client';
import { runGoogleHealthSync } from '@/lib/integrations/googleHealth/sync';
import { rebuildDailyMetrics } from '@/lib/data/canonicalise';

const TZ = 'America/New_York';
/** 2026-08-29 in New York. All fixture instants are chosen to land on it. */
const DAY = '2026-08-29';

/** A fixed "now", so today's window always covers the fixture day. */
const NOW = new Date('2026-08-29T20:00:00Z');

function apiFor(points: Record<string, unknown[]>, extra = {}) {
  return createGoogleHealthClient({
    accessToken: async () => 'access-token',
    baseUrl: 'https://health.googleapis.com',
    fetch: fakeGoogleHealth({ points, ...extra }),
    sleep: async () => {},
  });
}

describe('Google Health sync', () => {
  let db: TestDb;
  let alice: string;

  beforeEach(async () => {
    db = await createTestDb();
    alice = await createUser(db, 'alice@example.com');
    await db.query('insert into profiles (id, timezone) values ($1, $2)', [alice, TZ]);
  });

  afterEach(async () => { await db.close(); });

  const run = (points: Record<string, unknown[]>, extra = {}) =>
    withUser(db, alice, async (tx) => runGoogleHealthSync(
      supabaseOverPglite(tx) as never,
      alice,
      {
        api: apiFor(points, extra),
        trigger: 'MANUAL',
        grantedScopes: ALL_SCOPES,
        // One recent window only, so a test is not 60 requests long.
        backfillDays: 3,
        now: () => NOW,
      },
    ));

  const rows = async (sql: string, params: unknown[] = []) =>
    (await db.query(sql, params)).rows as Record<string, unknown>[];

  /* ------------------------------------------------------------ first sync */

  it('imports a weight and resolves it into the day', async () => {
    const result = await run({
      weight: [sample('weight', 'w1', '2026-08-29T12:00:00Z', { kilograms: 84.2 })],
    });

    expect(result.status).toBe('SUCCEEDED');
    expect(result.recordsCreated).toBeGreaterThan(0);

    const measurements = await rows(
      'select weight_kg, source, local_date from body_measurements where user_id = $1', [alice],
    );
    expect(measurements).toHaveLength(1);
    expect(Number(measurements[0]!.weight_kg)).toBeCloseTo(84.2, 3);
    expect(measurements[0]!.source).toBe('GOOGLE_HEALTH');

    // And it reaches the canonical row, which is what every page reads.
    const canonical = await rows(
      'select weight_kg from daily_metrics where user_id = $1 and local_date = $2',
      [alice, DAY],
    );
    expect(Number(canonical[0]!.weight_kg)).toBeCloseTo(84.2, 3);
  });

  it('imports a resting heart rate and an HRV as daily metrics', async () => {
    await run({
      'daily-resting-heart-rate': [
        daily('daily-resting-heart-rate', 'rhr1', DAY, { beatsPerMinute: 54 }),
      ],
      'daily-heart-rate-variability': [
        daily('daily-heart-rate-variability', 'hrv1', DAY, { rmssd: 62 }),
      ],
    });

    const canonical = await rows(
      'select resting_heart_rate, hrv_ms from daily_metrics where user_id = $1 and local_date = $2',
      [alice, DAY],
    );
    expect(Number(canonical[0]!.resting_heart_rate)).toBe(54);
    expect(Number(canonical[0]!.hrv_ms)).toBe(62);
  });

  it('imports a sleep session with its stages', async () => {
    await run({ sleep: [sleepSession()] });

    const sleep = await rows(
      'select duration_minutes, rem_minutes, deep_minutes, light_minutes, awake_minutes, '
      + 'external_source, external_id from sleep_records where user_id = $1', [alice],
    );
    expect(sleep).toHaveLength(1);
    expect(Number(sleep[0]!.duration_minutes)).toBe(435);
    expect(Number(sleep[0]!.deep_minutes)).toBe(90);
    expect(Number(sleep[0]!.rem_minutes)).toBe(120);
    expect(sleep[0]!.external_source).toBe('GOOGLE_HEALTH');

    const canonical = await rows(
      'select sleep_duration_minutes, deep_minutes from daily_metrics '
      + 'where user_id = $1 and local_date = $2', [alice, DAY],
    );
    expect(Number(canonical[0]!.sleep_duration_minutes)).toBe(435);
    expect(Number(canonical[0]!.deep_minutes)).toBe(90);
  });

  it('keeps the provider record verbatim beside every value it wrote', async () => {
    await run({
      weight: [sample('weight', 'w1', '2026-08-29T12:00:00Z', { kilograms: 84.2 })],
    });

    const external = await rows(
      "select data_type, external_id, mapped_to, payload, value, unit "
      + "from external_observations where user_id = $1 and data_type = 'weight'", [alice],
    );
    expect(external).toHaveLength(1);
    expect(external[0]!.mapped_to).toBe('body_measurements');
    expect(external[0]!.unit).toBe('kg');
    // §17: the payload as the provider sent it, before parsing dropped
    // anything the schema does not model.
    expect(JSON.stringify(external[0]!.payload)).toContain('kilograms');
  });

  /* ---------------------------------------------------------- idempotency */

  it('imports nothing twice when the same window is synced again', async () => {
    const points = {
      weight: [sample('weight', 'w1', '2026-08-29T12:00:00Z', { kilograms: 84.2 })],
      sleep: [sleepSession()],
    };

    await run(points);
    const second = await run(points);

    expect(second.recordsCreated).toBe(0);
    expect(second.recordsUnchanged).toBeGreaterThan(0);
    expect(await rows('select id from body_measurements where user_id = $1', [alice]))
      .toHaveLength(1);
    expect(await rows(
      'select id from sleep_records where user_id = $1 and superseded_at is null', [alice],
    )).toHaveLength(1);
  });

  it('syncing three times still produces exactly one of each record', async () => {
    const points = {
      weight: [sample('weight', 'w1', '2026-08-29T12:00:00Z', { kilograms: 84.2 })],
    };
    await run(points);
    await run(points);
    await run(points);
    expect(await rows('select id from body_measurements where user_id = $1', [alice]))
      .toHaveLength(1);
  });

  /* ------------------------------------------------------------ corrections */

  it('writes a corrected record as a new observation and supersedes the old one', async () => {
    await run({
      weight: [sample('weight', 'w1', '2026-08-29T12:00:00Z', { kilograms: 84.2 },
        '2026-08-29T12:05:00Z')],
    });
    // The same record, edited at the source: a new updateTime, a new value.
    await run({
      weight: [sample('weight', 'w1', '2026-08-29T12:00:00Z', { kilograms: 83.9 },
        '2026-08-29T18:00:00Z')],
    });

    const all = await rows(
      'select weight_kg, superseded_at from body_measurements where user_id = $1 '
      + 'order by created_at', [alice],
    );
    // BOTH survive. The old one is marked, not destroyed.
    expect(all).toHaveLength(2);
    expect(all.filter((r) => r.superseded_at === null)).toHaveLength(1);
    expect(Number(all.find((r) => r.superseded_at === null)!.weight_kg)).toBeCloseTo(83.9, 2);

    const canonical = await rows(
      'select weight_kg from daily_metrics where user_id = $1 and local_date = $2',
      [alice, DAY],
    );
    expect(Number(canonical[0]!.weight_kg)).toBeCloseTo(83.9, 2);
  });

  it('keeps every version of a record on file', async () => {
    await run({
      weight: [sample('weight', 'w1', '2026-08-29T12:00:00Z', { kilograms: 84.2 },
        '2026-08-29T12:05:00Z')],
    });
    await run({
      weight: [sample('weight', 'w1', '2026-08-29T12:00:00Z', { kilograms: 83.9 },
        '2026-08-29T18:00:00Z')],
    });

    // The external ledger is the record's history, not only its latest state.
    const versions = await rows(
      "select external_updated_at, superseded_at from external_observations "
      + "where user_id = $1 and data_type = 'weight' order by created_at", [alice],
    );
    expect(versions).toHaveLength(2);
    expect(versions.filter((v) => v.superseded_at === null)).toHaveLength(1);
  });

  /* ------------------------------------------------------- manual precedence */

  it('never moves a value the user entered by hand', async () => {
    // The user weighs in by hand at 08:00 and pins the field.
    await withUser(db, alice, async (tx) => {
      await tx.query(
        'insert into body_measurements (user_id, measured_at, local_date, weight_kg, source) '
        + "values ($1, $2, $3, $4, 'MANUAL')",
        [alice, '2026-08-29T12:00:00Z', DAY, 85.5],
      );
      await tx.query(
        'insert into canonical_field_pins (user_id, local_date, field) values ($1, $2, $3)',
        [alice, DAY, 'weightKg'],
      );
    });

    // Google then reports a LATER reading, which recency alone would prefer.
    await run({
      weight: [sample('weight', 'w1', '2026-08-29T18:00:00Z', { kilograms: 84.2 })],
    });

    const canonical = await rows(
      'select weight_kg from daily_metrics where user_id = $1 and local_date = $2',
      [alice, DAY],
    );
    expect(Number(canonical[0]!.weight_kg)).toBeCloseTo(85.5, 2);

    // And the imported reading is still stored, in full, with its provenance -
    // available, not applied.
    const imported = await rows(
      "select weight_kg from body_measurements where user_id = $1 and source = 'GOOGLE_HEALTH'",
      [alice],
    );
    expect(imported).toHaveLength(1);
    expect(Number(imported[0]!.weight_kg)).toBeCloseTo(84.2, 2);
  });

  it('lets the imported value through once the pin is lifted', async () => {
    await withUser(db, alice, async (tx) => {
      await tx.query(
        'insert into body_measurements (user_id, measured_at, local_date, weight_kg, source) '
        + "values ($1, $2, $3, $4, 'MANUAL')",
        [alice, '2026-08-29T12:00:00Z', DAY, 85.5],
      );
      await tx.query(
        'insert into canonical_field_pins (user_id, local_date, field) values ($1, $2, $3)',
        [alice, DAY, 'weightKg'],
      );
    });
    await run({
      weight: [sample('weight', 'w1', '2026-08-29T18:00:00Z', { kilograms: 84.2 })],
    });

    await withUser(db, alice, async (tx) => {
      await tx.query(
        'update canonical_field_pins set cleared_at = now() where user_id = $1', [alice],
      );
      await rebuildDailyMetrics(supabaseOverPglite(tx) as never, alice, DAY);
    });

    const canonical = await rows(
      'select weight_kg from daily_metrics where user_id = $1 and local_date = $2',
      [alice, DAY],
    );
    // Recency governs again, and the later reading wins.
    expect(Number(canonical[0]!.weight_kg)).toBeCloseTo(84.2, 2);
  });

  /* ------------------------------------------------------------- nutrition */

  it('writes nothing to nutrition, whatever arrives', async () => {
    await run({
      'active-energy-burned': [
        // Mid-day in UTC, so it lands unambiguously on the 29th in New York.
        // 00:00Z would be 19:00 on the 28th locally - correct, and not what
        // this test is about.
        interval('active-energy-burned', 'e1', '2026-08-29T12:00:00Z',
          '2026-08-29T13:00:00Z', { kcalSum: 620 }),
      ],
    });

    // Calories BURNED land in the activity column...
    const canonical = await rows(
      'select active_calories, calories_consumed from daily_metrics '
      + 'where user_id = $1 and local_date = $2', [alice, DAY],
    );
    expect(Number(canonical[0]!.active_calories)).toBe(620);
    // ...and calories CONSUMED stay untouched. Different measurements.
    expect(canonical[0]!.calories_consumed).toBeNull();
    expect(await rows('select id from nutrition_logs where user_id = $1', [alice]))
      .toHaveLength(0);
  });

  /* ------------------------------------------------------- partial failure */

  it('loses one data type to a missing scope and keeps the rest', async () => {
    const result = await run(
      { weight: [sample('weight', 'w1', '2026-08-29T12:00:00Z', { kilograms: 84.2 })] },
      { fail: { sleep: { status: 403, body: '{"reason":"MISSING_OAUTH_SCOPE"}' } } },
    );

    expect(result.status).toBe('PARTIAL');
    // The weight still landed.
    expect(await rows('select id from body_measurements where user_id = $1', [alice]))
      .toHaveLength(1);
    // And the failure is named rather than counted.
    expect(result.warnings.join(' ')).toMatch(/permission/i);
  });

  it('leaves the cursor alone after a partial run, so the window is re-read', async () => {
    await run(
      { weight: [sample('weight', 'w1', '2026-08-29T12:00:00Z', { kilograms: 84.2 })] },
      { fail: { sleep: { status: 403, body: 'MISSING_OAUTH_SCOPE' } } },
    );
    const runs = await rows(
      "select status, cursor_after from sync_runs where user_id = $1 "
      + "and provider = 'google-health'", [alice],
    );
    expect(runs[0]!.status).toBe('PARTIAL');
    expect(runs[0]!.cursor_after).toBeNull();
  });

  it('fails the whole run on a refused token rather than twenty times over', async () => {
    const result = await run(
      { weight: [sample('weight', 'w1', '2026-08-29T12:00:00Z', { kilograms: 84.2 })] },
      { fail: { weight: { status: 401 } } },
    );
    expect(result.status).toBe('FAILED');
    expect(result.message).toMatch(/reconnect/i);
  });

  it('records every run, including the ones that failed', async () => {
    await run({}, { fail: { weight: { status: 401 } } });
    const runs = await rows(
      "select status, error from sync_runs where user_id = $1 "
      + "and provider = 'google-health'", [alice],
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('FAILED');
    expect(runs[0]!.error).not.toBeNull();
  });

  it('refuses a second concurrent run', async () => {
    await withUser(db, alice, async (tx) => {
      await tx.query(
        "insert into sync_runs (user_id, provider, status) values ($1, 'google-health', 'RUNNING')",
        [alice],
      );
    });
    const result = await run({});
    expect(result.message).toMatch(/already running/i);
  });

  /* -------------------------------------------------------- unmapped types */

  it('keeps a supported data type that has nowhere to go', async () => {
    await run({
      'sedentary-period': [
        interval('sedentary-period', 'sp1', '2026-08-29T00:00:00Z',
          '2026-08-30T00:00:00Z', { durationSum: '28800s' }),
      ],
    });

    const kept = await rows(
      "select data_type, mapped_to, value from external_observations "
      + "where user_id = $1 and data_type = 'sedentary-period'", [alice],
    );
    expect(kept).toHaveLength(1);
    // Detected, preserved, and honestly marked as not yet mapped.
    expect(kept[0]!.mapped_to).toBeNull();
    expect(Number(kept[0]!.value)).toBe(480);
  });

  /* ----------------------------------------------------------- correlation */

  it('attaches heart rate to a workout it overlaps, without creating a session', async () => {
    // A Hevy workout already on file, 10:02 to 11:07.
    const session = await withUser(db, alice, async (tx) => {
      const { rows: inserted } = await tx.query<{ id: string }>(
        'insert into workout_sessions '
        + '(user_id, local_date, start_time, end_time, duration_minutes, session_type, '
        + " source, external_source, external_id) values "
        + "($1, $2, $3, $4, 65, 'PUSH', 'HEVY', 'HEVY', 'hevy-1') returning id",
        [alice, DAY, '2026-08-29T10:02:00Z', '2026-08-29T11:07:00Z'],
      );
      return inserted[0]!.id;
    });

    await run({
      exercise: [exerciseSession({
        startTime: '2026-08-29T10:01:14Z',
        endTime: '2026-08-29T11:04:37Z',
        caloriesKcal: 415,
        averageHeartRate: '128',
        activeZoneMinutes: '24',
        heartRateZoneDurations: { lightTime: '900s', fatBurnTime: '1320s' },
      })],
      'heart-rate': heartRateSamples('2026-08-29T10:02:00Z', 60, () => 120),
    });

    // Exactly one session: the Hevy one. The Google recording did not become a
    // second workout, which would have doubled the day's training.
    const sessions = await rows(
      'select id, average_heart_rate, calories from workout_sessions where user_id = $1 '
      + 'and superseded_at is null', [alice],
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).toBe(session);
    expect(Number(sessions[0]!.average_heart_rate)).toBeGreaterThan(100);

    const telemetry = await rows(
      'select match_method, match_confidence, hr_sample_count, zone_minutes, '
      + 'provider_zone_minutes, active_zone_minutes from session_telemetry '
      + 'where session_id = $1', [session],
    );
    expect(telemetry).toHaveLength(1);
    expect(telemetry[0]!.match_method).toBe('INTERVAL_OVERLAP');
    expect(Number(telemetry[0]!.match_confidence)).toBeGreaterThan(0.7);
    expect(Number(telemetry[0]!.hr_sample_count)).toBeGreaterThan(50);
    // The provider's own bands are kept beside the computed ones, never merged.
    expect(telemetry[0]!.provider_zone_minutes).toMatchObject({ fatBurnTime: 1320 });
  });

  it('writes an unmatched activity as a cardio session of its own', async () => {
    await run({
      exercise: [exerciseSession({
        id: 'walk-1',
        exerciseType: 'WALKING',
        displayName: 'Walk',
        startTime: '2026-08-29T13:00:00Z',
        endTime: '2026-08-29T13:40:00Z',
        activeDuration: '2400s',
        distanceMm: 3_200_000,
        caloriesKcal: 160,
      })],
    });

    const cardio = await rows(
      'select cardio_type, duration_minutes, distance_km, external_id '
      + 'from cardio_sessions where user_id = $1', [alice],
    );
    expect(cardio).toHaveLength(1);
    expect(cardio[0]!.cardio_type).toBe('WALKING');
    expect(Number(cardio[0]!.duration_minutes)).toBe(40);
    expect(Number(cardio[0]!.distance_km)).toBeCloseTo(3.2, 2);
  });

  it('does not duplicate an unmatched activity on a repeat sync', async () => {
    const points = {
      exercise: [exerciseSession({
        id: 'walk-1', exerciseType: 'WALKING',
        startTime: '2026-08-29T13:00:00Z', endTime: '2026-08-29T13:40:00Z',
      })],
    };
    await run(points);
    await run(points);
    expect(await rows(
      'select id from cardio_sessions where user_id = $1 and superseded_at is null', [alice],
    )).toHaveLength(1);
  });

  it('keeps two workouts on one day as two workouts', async () => {
    const ids = await withUser(db, alice, async (tx) => {
      const morning = await tx.query<{ id: string }>(
        'insert into workout_sessions (user_id, local_date, start_time, end_time, '
        + "session_type, source) values ($1, $2, $3, $4, 'PUSH', 'HEVY') returning id",
        [alice, DAY, '2026-08-29T07:00:00Z', '2026-08-29T08:00:00Z'],
      );
      const evening = await tx.query<{ id: string }>(
        'insert into workout_sessions (user_id, local_date, start_time, end_time, '
        + "session_type, source) values ($1, $2, $3, $4, 'PULL', 'HEVY') returning id",
        [alice, DAY, '2026-08-29T18:00:00Z', '2026-08-29T19:00:00Z'],
      );
      return [morning.rows[0]!.id, evening.rows[0]!.id];
    });

    await run({
      exercise: [
        exerciseSession({
          id: 'rec-morning',
          startTime: '2026-08-29T07:01:00Z', endTime: '2026-08-29T07:58:00Z',
        }),
        exerciseSession({
          id: 'rec-evening',
          startTime: '2026-08-29T18:02:00Z', endTime: '2026-08-29T19:01:00Z',
        }),
      ],
    });

    const telemetry = await rows(
      'select session_id, external_id from session_telemetry where user_id = $1', [alice],
    );
    expect(telemetry).toHaveLength(2);
    const bySession = new Map(telemetry.map((t) => [t.session_id, String(t.external_id)]));
    expect(bySession.get(ids[0]!)).toContain('rec-morning');
    expect(bySession.get(ids[1]!)).toContain('rec-evening');
  });

  it('records heart rate for a session the source did not record as an exercise', async () => {
    // The normal case for lifting: the watch measured the heart rate but the
    // lift was never logged as a workout of its own.
    const session = await withUser(db, alice, async (tx) => {
      const { rows: inserted } = await tx.query<{ id: string }>(
        'insert into workout_sessions (user_id, local_date, start_time, end_time, '
        + "session_type, source) values ($1, $2, $3, $4, 'PUSH', 'HEVY') returning id",
        [alice, DAY, '2026-08-29T10:00:00Z', '2026-08-29T11:00:00Z'],
      );
      return inserted[0]!.id;
    });

    await run({ 'heart-rate': heartRateSamples('2026-08-29T10:00:00Z', 60, () => 118) });

    const telemetry = await rows(
      'select match_method, external_id, hr_sample_count from session_telemetry '
      + 'where session_id = $1', [session],
    );
    expect(telemetry[0]!.match_method).toBe('INTERVAL_ONLY');
    expect(telemetry[0]!.external_id).toBeNull();
    expect(Number(telemetry[0]!.hr_sample_count)).toBeGreaterThan(50);
  });

  /* --------------------------------------------------- data points with no name */

  /**
   * The failure the first real sync found, end to end.
   *
   * Google documents DataPoint.name as supported for a subset of identifiable
   * data types; the steps response carries a `dataSource` and a body and no
   * name at all. The schema required one, so the ENVELOPE failed to parse, the
   * window was lost, and the sync moved on to the next data type - which is how
   * one optional field cost most of a year of activity data.
   *
   * `-14400` is New York's August offset, so the day runs 04:00Z to 04:00Z and
   * lands on the 29th in the profile's timezone rather than UTC's.
   */
  const NY_OFFSET = -14_400;

  it('imports a steps response that has no name on its data points', async () => {
    const result = await run({
      steps: [stepsDay(DAY, 8421, { utcOffsetSeconds: NY_OFFSET })],
    });

    expect(result.status).toBe('SUCCEEDED');
    expect(result.warnings).toEqual([]);

    // It reaches the canonical row, which is what every page reads.
    const canonical = await rows(
      'select steps from daily_metrics where user_id = $1 and local_date = $2',
      [alice, DAY],
    );
    expect(Number(canonical[0]!.steps)).toBe(8421);

    // Under an identity of CUT OS's own, which cannot be mistaken for Google's.
    const external = await rows(
      "select external_id, content_version, payload, record_type from external_observations "
      + "where user_id = $1 and data_type = 'steps'", [alice],
    );
    expect(external).toHaveLength(1);
    expect(isDerivedExternalId(String(external[0]!.external_id))).toBe(true);
    expect(external[0]!.content_version).toBeTruthy();
  });

  it('keeps the nameless record verbatim, and does not put a name into it', async () => {
    // §17: the payload is what the provider sent, before anything interpreted
    // it. Minting an identity must not edit the record it identifies.
    const point = stepsDay(DAY, 8421, { utcOffsetSeconds: NY_OFFSET });
    await run({ steps: [point] });

    const external = await rows(
      "select payload, mapped_to, mapped_id, local_date, value from external_observations "
      + "where user_id = $1 and data_type = 'steps'", [alice],
    );
    expect(external[0]!.payload).toEqual(point);
    expect(external[0]!.payload).not.toHaveProperty('name');
    // And it points at what it became, so the value can be traced back.
    expect(external[0]!.mapped_to).toBe('metric_observations');
    expect(external[0]!.mapped_id).not.toBeNull();

    const provenance = await rows(
      'select provenance from daily_metrics where user_id = $1 and local_date = $2',
      [alice, DAY],
    );
    const recorded = provenance[0]!.provenance as Record<string, { source: string } | undefined>;
    expect(recorded.steps?.source).toBe('GOOGLE_HEALTH');
  });

  it('imports several nameless points as several observations', async () => {
    await run({
      steps: [
        stepsDay('2026-08-27', 6210, { utcOffsetSeconds: NY_OFFSET }),
        stepsDay('2026-08-28', 9004, { utcOffsetSeconds: NY_OFFSET }),
        stepsDay(DAY, 8421, { utcOffsetSeconds: NY_OFFSET }),
      ],
    });

    const days = await rows(
      "select local_date, value from external_observations where user_id = $1 "
      + "and data_type = 'steps' order by local_date", [alice],
    );
    expect(days).toHaveLength(3);
    expect(new Set(days.map((d) => d.local_date)).size).toBe(3);

    const canonical = await rows(
      'select local_date, steps from daily_metrics where user_id = $1 '
      + 'and steps is not null order by local_date', [alice],
    );
    expect(canonical.map((r) => Number(r.steps))).toEqual([6210, 9004, 8421]);
  });

  it('imports nothing twice when a nameless point is synced again', async () => {
    // The property the derived identity exists for. A random id here - a UUID
    // per point - would duplicate the whole history on the second press.
    const points = { steps: [stepsDay(DAY, 8421, { utcOffsetSeconds: NY_OFFSET })] };

    await run(points);
    const second = await run(points);
    const third = await run(points);

    expect(second.recordsCreated).toBe(0);
    expect(second.recordsUnchanged).toBe(1);
    expect(third.recordsCreated).toBe(0);

    expect(await rows(
      "select id from external_observations where user_id = $1 and data_type = 'steps'", [alice],
    )).toHaveLength(1);
    expect(await rows(
      "select id from metric_observations where user_id = $1 and metric = 'STEPS'", [alice],
    )).toHaveLength(1);
  });

  it('applies a revised count as a correction, not as a second reading', async () => {
    // A day still accumulating: the morning's rollup is partial, and the
    // evening's is the real figure. Neither carries an updateTime, so without a
    // content version the second read looks identical to the first and the day
    // keeps the partial count for good.
    await run({ steps: [stepsDay(DAY, 3100, { utcOffsetSeconds: NY_OFFSET })] });
    const revised = await run({ steps: [stepsDay(DAY, 8421, { utcOffsetSeconds: NY_OFFSET })] });

    expect(revised.recordsUpdated).toBe(1);

    // Both observations survive; exactly one counts.
    const all = await rows(
      "select value, superseded_at from external_observations where user_id = $1 "
      + "and data_type = 'steps' order by created_at", [alice],
    );
    expect(all).toHaveLength(2);
    expect(all.filter((r) => r.superseded_at === null)).toHaveLength(1);
    expect(Number(all.find((r) => r.superseded_at === null)!.value)).toBe(8421);

    const live = await rows(
      "select value, superseded_at from metric_observations where user_id = $1 "
      + "and metric = 'STEPS' and superseded_at is null", [alice],
    );
    expect(live).toHaveLength(1);

    const canonical = await rows(
      'select steps from daily_metrics where user_id = $1 and local_date = $2',
      [alice, DAY],
    );
    expect(Number(canonical[0]!.steps)).toBe(8421);
  });

  it('lands named and nameless points from one run side by side', async () => {
    await run({
      steps: [stepsDay(DAY, 8421, { utcOffsetSeconds: NY_OFFSET })],
      weight: [sample('weight', 'w1', '2026-08-29T12:00:00Z', { kilograms: 84.2 })],
      'daily-resting-heart-rate': [
        namelessDaily('daily-resting-heart-rate', DAY, { beatsPerMinute: 54 }),
      ],
    });

    const canonical = await rows(
      'select steps, weight_kg, resting_heart_rate from daily_metrics '
      + 'where user_id = $1 and local_date = $2', [alice, DAY],
    );
    expect(Number(canonical[0]!.steps)).toBe(8421);
    expect(Number(canonical[0]!.weight_kg)).toBeCloseTo(84.2, 2);
    expect(Number(canonical[0]!.resting_heart_rate)).toBe(54);

    const ids = await rows(
      'select data_type, external_id from external_observations where user_id = $1', [alice],
    );
    const byType = new Map(ids.map((r) => [String(r.data_type), String(r.external_id)]));
    // The provider's id where there was one, ours where there was not, and the
    // difference stays legible in the row itself.
    expect(byType.get('weight')!.startsWith('users/')).toBe(true);
    expect(isDerivedExternalId(byType.get('steps')!)).toBe(true);
    expect(isDerivedExternalId(byType.get('daily-resting-heart-rate')!)).toBe(true);
  });

  it('never moves a hand-entered value, even for a nameless import', async () => {
    // The pin has to hold against the derived-identity path exactly as it does
    // against the provider-identity one.
    await withUser(db, alice, async (tx) => {
      await tx.query(
        'insert into metric_observations (user_id, metric, value, measured_at, local_date, source) '
        + "values ($1, 'STEPS', $2, $3, $4, 'MANUAL')",
        [alice, 12000, '2026-08-29T12:00:00Z', DAY],
      );
      await tx.query(
        'insert into canonical_field_pins (user_id, local_date, field) values ($1, $2, $3)',
        [alice, DAY, 'steps'],
      );
    });

    await run({ steps: [stepsDay(DAY, 8421, { utcOffsetSeconds: NY_OFFSET })] });

    const canonical = await rows(
      'select steps from daily_metrics where user_id = $1 and local_date = $2',
      [alice, DAY],
    );
    expect(Number(canonical[0]!.steps)).toBe(12000);

    // Stored, with its provenance, and shown as available rather than applied.
    const imported = await rows(
      "select value from metric_observations where user_id = $1 and source = 'GOOGLE_HEALTH'",
      [alice],
    );
    expect(imported).toHaveLength(1);
    expect(Number(imported[0]!.value)).toBe(8421);
  });

  /* ------------------------------------------- one bad point is one bad point */

  it('keeps the rest of a window when one data point cannot be read', async () => {
    const result = await run({
      steps: [
        stepsDay('2026-08-28', 6210, { utcOffsetSeconds: NY_OFFSET }),
        // Not a data point: dataSource is a string where an object belongs.
        { dataSource: 'a phone', steps: { countSum: '99' } },
        stepsDay(DAY, 8421, { utcOffsetSeconds: NY_OFFSET }),
      ],
    });

    // The window is not lost, and the failure is not hidden either.
    expect(result.recordsCreated).toBe(2);
    expect(result.recordsFailed).toBe(1);
    expect(result.status).toBe('PARTIAL');
    expect(result.warnings.some((w) => w.includes('dataSource'))).toBe(true);

    const canonical = await rows(
      'select local_date, steps from daily_metrics where user_id = $1 '
      + 'and steps is not null order by local_date', [alice],
    );
    expect(canonical.map((r) => Number(r.steps))).toEqual([6210, 8421]);
  });

  it('does not abandon a data type after a bad point, as it used to', async () => {
    // The old behaviour threw at the envelope, so the FIRST bad element ended
    // the window AND the data type. Everything after it went missing.
    const result = await run({
      steps: [
        'not a data point at all',
        stepsDay(DAY, 8421, { utcOffsetSeconds: NY_OFFSET }),
      ],
      weight: [sample('weight', 'w1', '2026-08-29T12:00:00Z', { kilograms: 84.2 })],
    });

    expect(Number((await rows(
      'select steps from daily_metrics where user_id = $1 and local_date = $2', [alice, DAY],
    ))[0]!.steps)).toBe(8421);
    expect(result.byDataType.find((o) => o.dataType === 'steps')!.created).toBe(1);
    expect(await rows('select id from body_measurements where user_id = $1', [alice]))
      .toHaveLength(1);
  });

  it('says a repeated problem once per data type, not once per record', async () => {
    // What the failing sync did: the same 300-character validation dump, once
    // for every data type it touched, in the panel and in the run history.
    const bad = (n: number) => Array.from(
      { length: n }, () => ({ dataSource: 'a phone', steps: { countSum: '1' } }),
    );
    const result = await run({
      steps: bad(20),
      distance: bad(20),
      floors: bad(20),
    });

    expect(result.recordsFailed).toBe(60);
    // Three data types, three sentences - each carrying its own count.
    expect(result.warnings).toHaveLength(3);
    for (const warning of result.warnings) {
      expect(warning).toContain('and 19 more like it');
    }

    const run_ = await rows(
      "select error from sync_runs where user_id = $1 and provider = 'google-health'", [alice],
    );
    // And the run history gets one line, not a paragraph of duplicated JSON.
    expect(String(run_[0]!.error).length).toBeLessThan(300);
    expect(String(run_[0]!.error)).toContain('60 warnings');
  });

  it('says so when two nameless records cannot be told apart', async () => {
    // A minted identity is only as unique as the fields it is built from. If a
    // data type ever returns two genuinely different points sharing a time AND
    // a source, they mint one id - and the second is then refused by the
    // idempotency index, which looks exactly like "already imported". Silently
    // losing a measurement is the one failure this system may not have, so the
    // run says what happened and the fix is a discriminator on the registry
    // entry (see time-in-heart-rate-zone, which needs one).
    const result = await run({
      steps: [
        stepsDay(DAY, 8421, { utcOffsetSeconds: NY_OFFSET }),
        stepsDay(DAY, 3100, { utcOffsetSeconds: NY_OFFSET }),
      ],
    });

    expect(result.warnings.some((w) => w.includes('cannot tell apart'))).toBe(true);

    // Both are in the raw layer. Nothing was thrown away.
    const all = await rows(
      "select value, superseded_at from external_observations where user_id = $1 "
      + "and data_type = 'steps'", [alice],
    );
    expect(all).toHaveLength(2);
    expect(all.filter((r) => r.superseded_at === null)).toHaveLength(1);
  });

  it('imports a nameless sample whose response omits the device entirely', async () => {
    // Provider and device metadata are optional in a real response, and an
    // identity that needs them is an identity that breaks on the first point
    // that leaves them out.
    const result = await run({
      weight: [namelessSample('weight', '2026-08-29T12:00:00Z', { kilograms: 84.2 }, null)],
    });

    expect(result.status).toBe('SUCCEEDED');
    const measurements = await rows(
      'select weight_kg from body_measurements where user_id = $1', [alice],
    );
    expect(Number(measurements[0]!.weight_kg)).toBeCloseTo(84.2, 2);
  });
});
