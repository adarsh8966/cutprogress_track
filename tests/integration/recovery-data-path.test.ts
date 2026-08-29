/**
 * The complete resting-heart-rate / HRV path, end to end (spec §14, §16, §33).
 *
 * THE BUG THIS PINS. A live import wrote resting heart rate and HRV for four
 * days. Every layer stored and carried them correctly, and the Recovery page
 * reported "Resting heart rate: not logged". Nothing was lost: the page's only
 * reader for those two metrics was a 30-day average, which correctly refuses to
 * be computed from 13% coverage, and the refusal was then rendered with the
 * same words as "you never recorded this".
 *
 * Each step in the chain was individually plausible, so this test walks the
 * whole chain in one place, on the exact figures from the live session:
 *
 *   metric_observations  (what the importer writes)
 *     -> rebuildDailyMetrics   the REAL function, against the REAL migrations
 *     -> daily_metrics         real columns, real CHECK constraints, real RLS
 *     -> getDailyMetrics's row mapper
 *     -> recoverySummary       what the Recovery page displays
 *
 * Running as the `authenticated` role with auth.uid() bound means the RLS
 * policies are the deployed ones. Scope note as ever: this proves the SQL and
 * the policy logic, not that a hosted Supabase project is configured correctly.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTestDb, createUser, withUser, type TestDb } from '../helpers/pglite';
import { supabaseOverPglite } from '../helpers/supabaseOverPglite';
import { recoverySummary } from '@/lib/analytics/recovery';
import { latestReading } from '@/lib/analytics/latest';
import { pickMetric } from '@/lib/analytics/series';
// The row mapper is deliberately free of `server-only` so the shape the pages
// receive can be asserted without a server runtime.
import { rowsToDailyMetrics } from '@/lib/data/rows';
import type { LocalDate } from '@/lib/types';

// canonicalise.ts is server-only by design; the marker package has no runtime
// behaviour to preserve, and the function under test is the point.
vi.mock('server-only', () => ({}));

const { rebuildDailyMetrics } = await import('@/lib/data/canonicalise');

/** Exactly what the live stress test imported. Note the gap at the 27th. */
const LIVE_IMPORT: { date: LocalDate; rhr: number; hrv: number }[] = [
  { date: '2026-08-24', rhr: 62, hrv: 51 },
  { date: '2026-08-25', rhr: 59, hrv: 57 },
  { date: '2026-08-26', rhr: 58, hrv: 64 },
  { date: '2026-08-28', rhr: 58, hrv: 62 },
];

/** The day the live session was looking at the Recovery page. */
const TODAY: LocalDate = '2026-08-29';
const MISSING_DAY: LocalDate = '2026-08-27';

describe('recovery data path: import -> canonicalise -> query -> display', () => {
  let db: TestDb;
  let alice: string;

  beforeAll(async () => {
    db = await createTestDb();
    alice = await createUser(db, 'alice@example.com');

    // Written exactly as app/actions/import.ts writes them: one
    // metric_observations row per metric, source IMPORT_TEXT.
    await withUser(db, alice, async (tx) => {
      for (const { date, rhr, hrv } of LIVE_IMPORT) {
        await tx.query(
          `insert into metric_observations
             (user_id, metric, value, measured_at, local_date, source)
           values ($1, 'RESTING_HEART_RATE', $2, now(), $3, 'IMPORT_TEXT'),
                  ($1, 'HRV_MS',             $4, now(), $3, 'IMPORT_TEXT')`,
          [alice, rhr, date, hrv],
        );
      }
      // Sleep on the same days. Sleep was visible while RHR and HRV were not,
      // so it is here to keep that asymmetry in the test rather than in prose.
      for (const { date } of LIVE_IMPORT) {
        await tx.query(
          `insert into sleep_records (user_id, local_date, duration_minutes, source)
           values ($1, $2, 430, 'IMPORT_TEXT')`,
          [alice, date],
        );
      }
    });

    // The REAL canonicaliser, over the REAL schema. This is the step that had
    // never been executed by a test.
    await withUser(db, alice, async (tx) => {
      const client = supabaseOverPglite(tx);
      for (const { date } of LIVE_IMPORT) {
        await rebuildDailyMetrics(client as never, alice, date);
      }
      // The gap day is rebuilt too: a day with no observations must resolve to
      // nulls, not to zeroes, and not be skipped so it silently keeps old data.
      await rebuildDailyMetrics(client as never, alice, MISSING_DAY);
    });
  });

  afterAll(async () => {
    await db?.close();
  });

  // ---------------------------------------------------------------- storage

  it('canonicalises every imported RHR and HRV into daily_metrics', async () => {
    const { rows } = await withUser(db, alice, (tx) =>
      tx.query<{ local_date: string; resting_heart_rate: string | null; hrv_ms: string | null }>(
        `select local_date::text, resting_heart_rate::text, hrv_ms::text
           from daily_metrics order by local_date`,
      ),
    );

    const byDate = new Map(rows.map((r) => [r.local_date, r]));
    for (const { date, rhr, hrv } of LIVE_IMPORT) {
      const row = byDate.get(date);
      expect(row, `daily_metrics row for ${date}`).toBeDefined();
      expect(Number(row!.resting_heart_rate)).toBe(rhr);
      expect(Number(row!.hrv_ms)).toBe(hrv);
    }
  });

  it('leaves a day with no observation null, never zero (spec §33)', async () => {
    const { rows } = await withUser(db, alice, (tx) =>
      tx.query<{ resting_heart_rate: string | null; hrv_ms: string | null }>(
        `select resting_heart_rate::text, hrv_ms::text
           from daily_metrics where local_date = $1`,
        [MISSING_DAY],
      ),
    );
    expect(rows[0]!.resting_heart_rate).toBeNull();
    expect(rows[0]!.hrv_ms).toBeNull();
  });

  it('records the source that won, so the value can answer "where from?"', async () => {
    const { rows } = await withUser(db, alice, (tx) =>
      tx.query<{ provenance: Record<string, { source: string }> }>(
        `select provenance from daily_metrics where local_date = $1`,
        ['2026-08-24'],
      ),
    );
    expect(rows[0]!.provenance.restingHeartRate?.source).toBe('IMPORT_TEXT');
    expect(rows[0]!.provenance.hrvMs?.source).toBe('IMPORT_TEXT');
  });

  it('rebuilds idempotently - running it again resolves the same values', async () => {
    await withUser(db, alice, async (tx) => {
      const client = supabaseOverPglite(tx);
      await rebuildDailyMetrics(client as never, alice, '2026-08-24');
    });
    const { rows } = await withUser(db, alice, (tx) =>
      tx.query<{ resting_heart_rate: string }>(
        `select resting_heart_rate::text from daily_metrics where local_date = $1`,
        ['2026-08-24'],
      ),
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.resting_heart_rate)).toBe(62);
  });

  // ---------------------------------------------------------------- display

  /**
   * The canonical rows in the shape the app receives them: local_date as an
   * ISO string, numerics as strings, exactly as PostgREST hands them over.
   */
  async function canonicalRows() {
    const { rows } = await withUser(db, alice, (tx) =>
      tx.query<Record<string, unknown>>(
        `select d.*, to_char(d.local_date, 'YYYY-MM-DD') as local_date_text
           from daily_metrics d order by d.local_date`,
      ),
    );
    return rows.map((row) => ({ ...row, local_date: row.local_date_text }));
  }

  /** What the Recovery page displays, through the real mapper and selectors. */
  async function asDisplayed() {
    return recoverySummary(rowsToDailyMetrics(await canonicalRows() as never), TODAY);
  }

  it('DISPLAYS the latest resting heart rate and HRV, with their real dates', async () => {
    const recovery = await asDisplayed();

    // The reported bug, stated as an assertion: these were both null.
    expect(recovery.restingHeartRate.latest.value).toBe(58);
    expect(recovery.restingHeartRate.latest.inputs.observedOn).toBe('2026-08-28');

    expect(recovery.hrv.latest.value).toBe(62);
    expect(recovery.hrv.latest.inputs.observedOn).toBe('2026-08-28');

    // Reported as one day old rather than as today's reading.
    expect(recovery.restingHeartRate.latest.inputs.ageDays).toBe(1);
  });

  it('charts every imported day on the day it was measured', async () => {
    const recovery = await asDisplayed();
    const rhrByDate = new Map(
      recovery.restingHeartRate.series.map((p) => [p.date, p.value]),
    );
    const hrvByDate = new Map(recovery.hrv.series.map((p) => [p.date, p.value]));

    for (const { date, rhr, hrv } of LIVE_IMPORT) {
      expect(rhrByDate.get(date), `RHR on ${date}`).toBe(rhr);
      expect(hrvByDate.get(date), `HRV on ${date}`).toBe(hrv);
    }
    expect(rhrByDate.get(MISSING_DAY)).toBeNull();
    expect(hrvByDate.get(MISSING_DAY)).toBeNull();
  });

  it('says "not enough data" for the 30-day average, not "not logged"', async () => {
    const recovery = await asDisplayed();
    const average = recovery.restingHeartRate.average30;

    // The coverage gate still refuses: four days is not a 30-day average, and
    // weakening that would be the fabrication spec §33 forbids.
    expect(average.value).toBeNull();
    expect(average.confidence).toBe('INSUFFICIENT');

    // But it now reports that measurements DO exist, which is what lets the UI
    // distinguish a gated figure from one that was never recorded.
    expect(average.observations).toBe(4);
  });

  it('reports a genuinely unlogged metric as absent, with zero observations', async () => {
    const recovery = await asDisplayed();
    // Nothing wrote a weight, so this is the "never logged" case and must stay
    // distinguishable from the sparse case above.
    expect(recovery.sleepScore.latest.value).toBeNull();
    expect(recovery.sleepScore.latest.observations).toBe(0);
  });

  it('keeps sleep working, the metric that was visible all along', async () => {
    const recovery = await asDisplayed();
    // 4 of the 7 days ending 2026-08-29 carry sleep, which clears the gate -
    // which is exactly why sleep was visible while RHR and HRV were not.
    expect(recovery.sleep7.value).toBe(430);
  });

  // ------------------------------------------------------------ convergence

  /**
   * The importer and the manual form must agree.
   *
   * Two ways of recording the same measurement that resolve differently is the
   * same bug in a slower form: the value is visible when typed and missing when
   * imported, or the reverse. They write the same table with the same metric
   * keys and differ only in `source`, and this pins that.
   */
  it('resolves an imported and a hand-entered reading identically', async () => {
    const imported: LocalDate = '2026-07-10';
    const manual: LocalDate = '2026-07-11';

    await withUser(db, alice, async (tx) => {
      await tx.query(
        `insert into metric_observations
           (user_id, metric, value, measured_at, local_date, source)
         values ($1, 'RESTING_HEART_RATE', 57, now(), $2, 'IMPORT_TEXT'),
                ($1, 'HRV_MS',             68, now(), $2, 'IMPORT_TEXT'),
                ($1, 'RESTING_HEART_RATE', 57, now(), $3, 'MANUAL'),
                ($1, 'HRV_MS',             68, now(), $3, 'MANUAL')`,
        [alice, imported, manual],
      );
      const client = supabaseOverPglite(tx);
      await rebuildDailyMetrics(client as never, alice, imported);
      await rebuildDailyMetrics(client as never, alice, manual);
    });

    const { rows } = await withUser(db, alice, (tx) =>
      tx.query<{ resting_heart_rate: string; hrv_ms: string }>(
        `select resting_heart_rate::text, hrv_ms::text from daily_metrics
           where local_date in ($1, $2) order by local_date`,
        [imported, manual],
      ),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(rows[1]);
    expect(Number(rows[0]!.resting_heart_rate)).toBe(57);
    expect(Number(rows[0]!.hrv_ms)).toBe(68);
  });

  it('breaks a same-instant tie by source priority', async () => {
    const date: LocalDate = '2026-07-15';
    await withUser(db, alice, async (tx) => {
      // Both rows take their measured_at from the same now() inside one
      // transaction, so they are recorded at the SAME INSTANT and recency
      // cannot separate them. That is the question source priority answers.
      // Neither row is deleted - the raw layer keeps both (spec §6, §48).
      await tx.query(
        `insert into metric_observations
           (user_id, metric, value, measured_at, local_date, source)
         values ($1, 'RESTING_HEART_RATE', 71, now(), $2, 'IMPORT_TEXT'),
                ($1, 'RESTING_HEART_RATE', 57, now(), $2, 'MANUAL')`,
        [alice, date],
      );
      await rebuildDailyMetrics(supabaseOverPglite(tx) as never, alice, date);
    });

    const { rows } = await withUser(db, alice, (tx) =>
      tx.query<{ rhr: string; provenance: Record<string, { source: string; candidates: number }> }>(
        `select resting_heart_rate::text as rhr, provenance from daily_metrics
           where local_date = $1`,
        [date],
      ),
    );
    expect(Number(rows[0]!.rhr)).toBe(57);
    expect(rows[0]!.provenance.restingHeartRate?.source).toBe('MANUAL');
    // Both readings competed; neither was discarded.
    expect(rows[0]!.provenance.restingHeartRate?.candidates).toBe(2);
  });

  /**
   * The corrected-import bug, end to end through the real schema.
   *
   * Source priority used to beat recency outright, so a value typed by hand
   * outranked every later correction from anywhere, permanently. The import was
   * written, reported as imported, and the day kept showing the old number.
   */
  it('lets a later import correct a value entered by hand earlier', async () => {
    const date: LocalDate = '2026-07-16';
    await withUser(db, alice, async (tx) => {
      await tx.query(
        `insert into metric_observations
           (user_id, metric, value, measured_at, local_date, source)
         values ($1, 'RESTING_HEART_RATE', 71, now() - interval '6 hours', $2, 'MANUAL')`,
        [alice, date],
      );
      await tx.query(
        `insert into metric_observations
           (user_id, metric, value, measured_at, local_date, source)
         values ($1, 'RESTING_HEART_RATE', 57, now(), $2, 'IMPORT_TEXT')`,
        [alice, date],
      );
      await rebuildDailyMetrics(supabaseOverPglite(tx) as never, alice, date);
    });

    const { rows } = await withUser(db, alice, (tx) =>
      tx.query<{ rhr: string; provenance: Record<string, { source: string }> }>(
        `select resting_heart_rate::text as rhr, provenance from daily_metrics
           where local_date = $1`,
        [date],
      ),
    );
    expect(Number(rows[0]!.rhr)).toBe(57);
    expect(rows[0]!.provenance.restingHeartRate?.source).toBe('IMPORT_TEXT');
  });

  /**
   * Re-logging a value to correct it is the documented way to fix a scalar
   * observation, and it used to CRASH the rebuild: measured_at comes back from
   * the driver as a Date, and the resolver only compared timestamps when two
   * observations shared a source - which is precisely this case. The day failed
   * to canonicalise rather than resolving to the corrected value.
   */
  it('resolves a re-logged correction to the newer value', async () => {
    const date: LocalDate = '2026-07-17';
    await withUser(db, alice, async (tx) => {
      await tx.query(
        `insert into metric_observations
           (user_id, metric, value, measured_at, local_date, source)
         values ($1, 'HRV_MS', 41, now() - interval '2 hours', $2, 'MANUAL')`,
        [alice, date],
      );
      await tx.query(
        `insert into metric_observations
           (user_id, metric, value, measured_at, local_date, source)
         values ($1, 'HRV_MS', 68, now(), $2, 'MANUAL')`,
        [alice, date],
      );
      await rebuildDailyMetrics(supabaseOverPglite(tx) as never, alice, date);
    });

    const { rows } = await withUser(db, alice, (tx) =>
      tx.query<{
        hrv: string;
        provenance: Record<string, { candidates: number; sources: number; confidence: string }>;
      }>(
        `select hrv_ms::text as hrv, provenance from daily_metrics where local_date = $1`,
        [date],
      ),
    );
    expect(Number(rows[0]!.hrv)).toBe(68);
    // Two observations, one source: a correction, not a disagreement. The
    // confidence of the day must not drop because the user fixed a typo.
    expect(rows[0]!.provenance.hrvMs?.candidates).toBe(2);
    expect(rows[0]!.provenance.hrvMs?.sources).toBe(1);
    expect(rows[0]!.provenance.hrvMs?.confidence).toBe('HIGH');
  });

  it('reads a real measured zero as zero, not as missing', async () => {
    const zeroDay: LocalDate = '2026-08-20';
    await withUser(db, alice, async (tx) => {
      await tx.query(
        `insert into metric_observations
           (user_id, metric, value, measured_at, local_date, source)
         values ($1, 'HRV_MS', 0, now(), $2, 'MANUAL')`,
        [alice, zeroDay],
      );
      await rebuildDailyMetrics(supabaseOverPglite(tx) as never, alice, zeroDay);
    });

    const series = pickMetric(rowsToDailyMetrics(await canonicalRows() as never), 'hrvMs');
    expect(series.find((p) => p.date === zeroDay)?.value).toBe(0);
    // And a zero is a reading, so it is findable as one.
    expect(latestReading(series, zeroDay, 30).value).toBe(0);
  });
});
