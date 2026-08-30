/**
 * Every imported value, followed all the way to something that reads it.
 *
 * API -> external_observations -> domain table -> daily_metrics -> reader.
 *
 * THE FAILURE THIS EXISTS TO CATCH is the one this codebase has hit twice
 * already and documents in two places: a value that is fetched faithfully,
 * stored correctly, resolved into the canonical row, and then read by nothing.
 * It looks healthy in the database and it is invisible in the app. Asserting
 * the write is not enough; each case below ends at a reader.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTestDb, createUser, withUser, type TestDb } from '../helpers/pglite';

vi.mock('server-only', () => ({}));

import { supabaseOverPglite } from '../helpers/supabaseOverPglite';
import {
  fakeGoogleHealth, ALL_SCOPES, sample, daily, interval,
  exerciseSession, sleepSession, heartRateSamples,
} from '../helpers/googleHealthFixtures';
import { createGoogleHealthClient } from '@/lib/integrations/googleHealth/client';
import { runGoogleHealthSync } from '@/lib/integrations/googleHealth/sync';
import { rowToDailyMetrics } from '@/lib/data/rows';
import { canonicalSummary } from '@/lib/data/dayRecords';
import { recoverySummary } from '@/lib/analytics/recovery';
import type { DailyMetricsRow } from '@/lib/supabase/types';

const TZ = 'America/New_York';
const DAY = '2026-08-29';
const NOW = new Date('2026-08-29T20:00:00Z');

/** One sync carrying one of everything the four scopes permit. */
const EVERYTHING = {
  weight: [sample('weight', 'w1', '2026-08-29T12:00:00Z', { kilograms: 84.2 })],
  'body-fat': [sample('body-fat', 'bf1', '2026-08-29T12:00:00Z', { percentage: 17.6 })],
  'daily-resting-heart-rate': [
    daily('daily-resting-heart-rate', 'rhr1', DAY, { beatsPerMinute: 54 }),
  ],
  'daily-heart-rate-variability': [
    daily('daily-heart-rate-variability', 'hrv1', DAY, { rmssd: 62 }),
  ],
  'daily-respiratory-rate': [
    daily('daily-respiratory-rate', 'rr1', DAY, { breathsPerMinute: 14.2 }),
  ],
  'daily-oxygen-saturation': [
    daily('daily-oxygen-saturation', 'spo1', DAY, { averagePercentage: 96.4 }),
  ],
  'vo2-max': [sample('vo2-max', 'v1', '2026-08-29T12:00:00Z', { vo2Max: 45.8 })],
  steps: [interval('steps', 's1', '2026-08-29T12:00:00Z', '2026-08-29T13:00:00Z',
    { countSum: 11_240 })],
  distance: [interval('distance', 'd1', '2026-08-29T12:00:00Z', '2026-08-29T13:00:00Z',
    { distanceMillimetersSum: 8_400_000 })],
  floors: [interval('floors', 'f1', '2026-08-29T12:00:00Z', '2026-08-29T13:00:00Z',
    { countSum: 14 })],
  'active-minutes': [interval('active-minutes', 'am1', '2026-08-29T12:00:00Z',
    '2026-08-29T13:00:00Z', { durationSum: '3300s' })],
  'active-zone-minutes': [interval('active-zone-minutes', 'azm1', '2026-08-29T12:00:00Z',
    '2026-08-29T13:00:00Z', { minutesSum: 41 })],
  'active-energy-burned': [interval('active-energy-burned', 'e1', '2026-08-29T12:00:00Z',
    '2026-08-29T13:00:00Z', { kcalSum: 620 })],
  'total-calories': [interval('total-calories', 'tc1', '2026-08-29T12:00:00Z',
    '2026-08-29T13:00:00Z', { kcalSum: 2480 })],
  sleep: [sleepSession()],
  'daily-sleep-temperature-derivations': [
    daily('daily-sleep-temperature-derivations', 'st1', DAY, { nightlyRelativeCelsius: -0.42 }),
  ],
  exercise: [exerciseSession({
    startTime: '2026-08-29T10:02:00Z', endTime: '2026-08-29T11:07:00Z',
    caloriesKcal: 415, averageHeartRate: '128', activeZoneMinutes: '24',
    heartRateZoneDurations: { lightTime: '900s', fatBurnTime: '1320s' },
  })],
  'heart-rate': heartRateSamples('2026-08-29T10:02:00Z', 63, () => 120),
};

describe('a Google Health day survives the whole chain', () => {
  let db: TestDb;
  let alice: string;
  let sessionId: string;
  let canonicalRow: DailyMetricsRow;

  beforeAll(async () => {
    db = await createTestDb();
    alice = await createUser(db, 'alice@example.com');
    await db.query('insert into profiles (id, timezone) values ($1, $2)', [alice, TZ]);

    // A Hevy workout for the exercise session to correlate with.
    sessionId = await withUser(db, alice, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        'insert into workout_sessions (user_id, local_date, start_time, end_time, '
        + "duration_minutes, session_type, source, external_source, external_id) "
        + "values ($1, $2, $3, $4, 65, 'PUSH', 'HEVY', 'HEVY', 'hevy-1') returning id",
        [alice, DAY, '2026-08-29T10:02:00Z', '2026-08-29T11:07:00Z'],
      );
      return rows[0]!.id;
    });

    // A maximum heart rate, so the zone calculation has boundaries to use.
    await withUser(db, alice, async (tx) => {
      for (const [zone, lower, upper] of [
        [1, 95, 114], [2, 114, 133], [3, 133, 152], [4, 152, 171], [5, 171, null],
      ] as const) {
        await tx.query(
          'insert into hr_zone_definitions (user_id, zone, lower_bpm, upper_bpm, method, '
          + "max_heart_rate, derived_from) values ($1, $2, $3, $4, 'MEASURED_MAX', 190, 'test')",
          [alice, zone, lower, upper],
        );
      }
    });

    const result = await withUser(db, alice, async (tx) => runGoogleHealthSync(
      supabaseOverPglite(tx) as never, alice, {
        api: createGoogleHealthClient({
          accessToken: async () => 'access-token',
          baseUrl: 'https://health.googleapis.com',
          fetch: fakeGoogleHealth({ points: EVERYTHING }),
          sleep: async () => {},
        }),
        trigger: 'MANUAL',
        grantedScopes: ALL_SCOPES,
        backfillDays: 3,
        now: () => NOW,
      },
    ));
    expect(['SUCCEEDED', 'PARTIAL']).toContain(result.status);

    const { rows } = await db.query<DailyMetricsRow>(
      'select * from daily_metrics where user_id = $1 and local_date = $2', [alice, DAY],
    );
    canonicalRow = rows[0]!;
    expect(canonicalRow).toBeDefined();
  });

  afterAll(async () => { await db.close(); });

  /**
   * Every field, followed from the API response to the canonical column.
   *
   * Table-driven so that adding a data type to the registry and forgetting to
   * wire its canonical destination fails here rather than in six months on a
   * page that shows a blank.
   */
  it.each([
    ['weight_kg', 84.2],
    ['body_fat_pct', 17.6],
    ['resting_heart_rate', 54],
    ['hrv_ms', 62],
    ['respiratory_rate', 14.2],
    ['oxygen_saturation_pct', 96.4],
    ['vo2_max', 45.8],
    ['steps', 11_240],
    ['distance_km', 8.4],
    ['floors', 14],
    ['active_minutes', 55],
    ['active_calories', 620],
    ['total_calories_burned', 2480],
    ['sleep_duration_minutes', 435],
    ['deep_minutes', 90],
    ['rem_minutes', 120],
    ['light_minutes', 225],
    ['awake_minutes', 45],
    ['sleep_temperature_delta_c', -0.42],
  ])('%s reaches the canonical row as %s', (column, expected) => {
    const value = canonicalRow[column as keyof DailyMetricsRow];
    expect(value, `${column} did not reach daily_metrics`).not.toBeNull();
    expect(Number(value)).toBeCloseTo(expected as number, 2);
  });

  it('carries the provider’s own zone accounting without confusing it for zone 2', () => {
    // active_zone_minutes is Google's bands; zone2_minutes is the user's.
    expect(Number(canonicalRow.active_zone_minutes)).toBe(41);
    expect(canonicalRow.zone2_minutes).not.toBeNull();
  });

  it('never touches nutrition', () => {
    expect(canonicalRow.calories_consumed).toBeNull();
    expect(canonicalRow.protein_g).toBeNull();
    expect(canonicalRow.carbs_g).toBeNull();
    expect(canonicalRow.fat_g).toBeNull();
  });

  it('shows every imported field on the day view', () => {
    // canonicalSummary is what /day/[date] renders. A field missing from it is
    // one whose provenance the user cannot inspect.
    const summary = canonicalSummary(rowToDailyMetrics(canonicalRow));
    const populated = new Set(summary.filter((f) => f.value !== null).map((f) => f.key));
    for (const field of [
      'weightKg', 'bodyFatPct', 'restingHeartRate', 'hrvMs', 'respiratoryRate',
      'oxygenSaturationPct', 'vo2Max', 'steps', 'distanceKm', 'floors',
      'activeMinutes', 'activeZoneMinutes', 'activeCalories', 'totalCaloriesBurned',
      'sleepDurationMinutes', 'deepMinutes', 'remMinutes', 'lightMinutes',
      'awakeMinutes', 'sleepTemperatureDeltaC',
    ]) {
      expect(populated.has(field), `${field} is missing from the day view`).toBe(true);
    }
  });

  it('reaches the Recovery page through recoverySummary', () => {
    // The page does no arithmetic of its own, so what this returns is what
    // renders.
    const summary = recoverySummary([rowToDailyMetrics(canonicalRow)], DAY);
    expect(summary.restingHeartRate.latest.value).toBe(54);
    expect(summary.hrv.latest.value).toBe(62);
    expect(summary.respiratoryRate.latest.value).toBeCloseTo(14.2, 1);
    expect(summary.oxygenSaturation.latest.value).toBeCloseTo(96.4, 1);
    expect(summary.deepMinutes.latest.value).toBe(90);
    expect(summary.remMinutes.latest.value).toBe(120);
    expect(summary.sleepTemperatureDelta.latest.value).toBeCloseTo(-0.42, 2);
    expect(summary.activeZoneMinutes.latest.value).toBe(41);
  });

  it('records the provenance of every resolved field as Google Health', async () => {
    const provenance = canonicalRow.provenance as Record<string, { source?: string }>;
    for (const field of ['weightKg', 'restingHeartRate', 'hrvMs', 'steps',
      'sleepDurationMinutes', 'bodyFatPct']) {
      expect(provenance[field]?.source, `${field} has no provenance`).toBe('GOOGLE_HEALTH');
    }
  });

  it('keeps the raw provider record for every value it wrote', async () => {
    const { rows } = await db.query<{ data_type: string; mapped_to: string | null }>(
      'select data_type, mapped_to from external_observations where user_id = $1', [alice],
    );
    const byType = new Map(rows.map((r) => [r.data_type, r.mapped_to]));
    expect(byType.get('weight')).toBe('body_measurements');
    expect(byType.get('daily-resting-heart-rate')).toBe('metric_observations');
    expect(byType.get('sleep')).toBe('sleep_records');
    // The correlated exercise points at the session it enriched, not at a
    // session of its own.
    expect(byType.get('exercise')).toBe('session_telemetry');
  });

  it('computes zone minutes for the correlated session from the samples', async () => {
    const { rows } = await db.query<{
      zone_minutes: Record<string, number>;
      hr_sample_count: number;
      hr_coverage_pct: string | null;
      average_hr: string | null;
    }>('select * from session_telemetry where session_id = $1', [sessionId]);

    const telemetry = rows[0]!;
    // 63 samples at 120 bpm, which sits in zone 2 (114-133).
    expect(telemetry.hr_sample_count).toBeGreaterThan(60);
    expect(Number(telemetry.zone_minutes['2'])).toBeGreaterThan(55);
    expect(Number(telemetry.average_hr)).toBeCloseTo(120, 0);
    expect(Number(telemetry.hr_coverage_pct)).toBeGreaterThan(90);
  });

  it('fills the session’s own heart-rate summary, which Hevy could not', async () => {
    const { rows } = await db.query<{ average_heart_rate: string | null; calories: string | null }>(
      'select average_heart_rate, calories from workout_sessions where id = $1', [sessionId],
    );
    expect(Number(rows[0]!.average_heart_rate)).toBeCloseTo(120, 0);
    expect(Number(rows[0]!.calories)).toBe(415);
  });
});
