/**
 * MANUAL 203.0 lb -> later IMPORT 200.9 lb -> the app must show 200.9 lb.
 *
 * THE REPORT THIS PINS. On 2026-08-29 a weight was typed by hand as 203.0 lb
 * and an import of 200.9 lb for the same day was then confirmed. The imported
 * row was written faithfully and the screen went on showing 203.0. That is the
 * failure this whole system exists to prevent: stored, confirmed, and
 * invisible.
 *
 * lib/normalization/canonical.ts resolves by recency and has a unit test that
 * says so. This test exists because that was not enough evidence. The unit test
 * hands the resolver two hand-built Observation objects; it never touches
 * `body_measurements`, never runs the SQL, never goes through
 * rebuildDailyMetrics, and never asks what the pages would then read. Every
 * layer in between was individually plausible, so the whole chain is walked
 * here in one place, on the exact figures from the live session:
 *
 *   body_measurements    (what logBodyMeasurement and confirmImport write)
 *     -> rebuildDailyMetrics   the REAL function, against the REAL migrations
 *     -> daily_metrics         real columns, real CHECKs, real RLS
 *     -> rowsToDailyMetrics    the row mapper every page's data goes through
 *     -> pickMetric/latestPresent   what the Dashboard and /day actually read
 *
 * Values are written in canonical kg through canonicalWeight() and asserted
 * back through displayWeight(), so the test speaks in the pounds the report was
 * written in and the conversion boundary is exercised rather than assumed.
 *
 * Running as the `authenticated` role with auth.uid() bound means the RLS
 * policies are the deployed ones. Scope note as ever: this proves the SQL and
 * the policy logic, not that a hosted Supabase project is configured correctly.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTestDb, createUser, withUser, type TestDb } from '../helpers/pglite';

// canonicalise.ts is server-only by design; the marker package has no runtime
// behaviour, so stubbing it lets the real function run here.
vi.mock('server-only', () => ({}));

import { supabaseOverPglite } from '../helpers/supabaseOverPglite';
import { rebuildDailyMetrics } from '@/lib/data/canonicalise';
import { rowsToDailyMetrics } from '@/lib/data/rows';
import { pickMetric, latestPresent } from '@/lib/analytics/series';
import { canonicalWeight, displayWeight } from '@/lib/normalization/units';
import type { ProvenanceMap } from '@/lib/normalization/canonical';
import type { DailyMetricsRow } from '@/lib/supabase/types';
import type { LocalDate } from '@/lib/types';

/** The day, and the two readings, exactly as reported. */
const DATE: LocalDate = '2026-08-29';
const TYPED_LB = 203.0;
const IMPORTED_LB = 200.9;

const TYPED_KG = canonicalWeight(TYPED_LB, 'LB');
const IMPORTED_KG = canonicalWeight(IMPORTED_LB, 'LB');

interface RawRow {
  id: string;
  source: string;
  weight_kg: string | null;
  measured_at: string;
  superseded_at: string | null;
}

describe('manual then imported weight: the newest observation wins', () => {
  let db: TestDb;
  let alice: string;

  beforeAll(async () => {
    db = await createTestDb();
    alice = await createUser(db, 'alice@example.com');
  });

  afterAll(async () => {
    await db?.close();
  });

  /**
   * One weight observation, written the way both writers write one: source
   * named, `measured_at` set to the moment of RECORDING (both
   * app/actions/log.ts and app/actions/import.ts stamp `new Date()`, not a
   * measurement time), and nothing updated or deleted.
   *
   * `at` is passed explicitly rather than using now(), because two statements
   * inside one PGlite transaction share a now() and the point of this test is
   * that one row is genuinely later than the other.
   */
  async function record(
    date: LocalDate, kg: number, source: string, at: string,
  ): Promise<string> {
    return withUser(db, alice, async (tx) => {
      const r = await tx.query<{ id: string }>(
        `insert into body_measurements
           (user_id, measured_at, local_date, weight_kg, source)
         values ($1, $2::timestamptz, $3, $4, $5) returning id`,
        [alice, at, date, kg, source],
      );
      return r.rows[0]!.id;
    });
  }

  async function rebuild(date: LocalDate) {
    await withUser(db, alice, async (tx) => {
      await rebuildDailyMetrics(supabaseOverPglite(tx) as never, alice, date);
    });
  }

  /** The canonical row, read exactly as lib/data/queries.ts reads it. */
  async function canonical(date: LocalDate) {
    const { rows } = await withUser(db, alice, (tx) =>
      tx.query<DailyMetricsRow>(
        `select * from daily_metrics where local_date = $1`, [date],
      ),
    );
    return rows[0] ?? null;
  }

  /** Every raw observation on the day, newest first. Superseded ones included. */
  async function rawRows(date: LocalDate): Promise<RawRow[]> {
    const { rows } = await withUser(db, alice, (tx) =>
      tx.query<RawRow>(
        `select id, source::text, weight_kg::text, measured_at::text,
                superseded_at::text
           from body_measurements where local_date = $1
          order by measured_at desc`,
        [date],
      ),
    );
    return rows;
  }

  /** What the canonical row displays, in the pounds the report was written in. */
  function displayedLb(row: DailyMetricsRow): number | null {
    const [day] = rowsToDailyMetrics([row]);
    return day?.weightKg == null ? null : displayWeight(day.weightKg, 'LB');
  }

  // -------------------------------------------------------------- the report

  describe('the reported case: typed 203.0, then imported 200.9', () => {
    let typedId: string;
    let importedId: string;

    beforeAll(async () => {
      // 08:12 - the morning weigh-in, typed by hand.
      typedId = await record(DATE, TYPED_KG, 'MANUAL', '2026-08-29T08:12:00Z');
      await rebuild(DATE);

      // 23:41 - the day's report is pasted in, carrying the scale's own figure.
      // A correction is always the later observation; that is what makes it a
      // correction rather than a competing opinion.
      importedId = await record(
        DATE, IMPORTED_KG, 'IMPORT_TEXT', '2026-08-29T23:41:00Z',
      );
      await rebuild(DATE);
    });

    it('resolves the day to the imported 200.9 lb', async () => {
      const row = await canonical(DATE);
      expect(row).not.toBeNull();
      expect(displayedLb(row!)).toBeCloseTo(IMPORTED_LB, 1);
    });

    it('keeps BOTH raw observations, neither superseded', async () => {
      const rows = await rawRows(DATE);
      expect(rows).toHaveLength(2);

      const byId = new Map(rows.map((r) => [r.id, r]));
      // The one that lost is still on disk, still carrying what it measured.
      const typed = byId.get(typedId);
      expect(typed, 'the hand-typed observation').toBeDefined();
      expect(Number(typed!.weight_kg)).toBeCloseTo(TYPED_KG, 3);
      expect(typed!.superseded_at).toBeNull();

      const imported = byId.get(importedId);
      expect(imported, 'the imported observation').toBeDefined();
      expect(Number(imported!.weight_kg)).toBeCloseTo(IMPORTED_KG, 3);
      expect(imported!.superseded_at).toBeNull();
    });

    it('agrees, in the database, that the import is the newer row', async () => {
      // The premise the resolver runs on, asserted against the column
      // canonicalisation actually orders by rather than assumed from the
      // insert order.
      const rows = await rawRows(DATE);
      expect(rows[0]!.id).toBe(importedId);
      expect(rows[1]!.id).toBe(typedId);
    });

    it('records WHICH observation won, and that two competed', async () => {
      const row = await canonical(DATE);
      const provenance = (row!.provenance ?? {}) as unknown as ProvenanceMap;
      expect(provenance.weightKg).toMatchObject({
        source: 'IMPORT_TEXT',
        observationId: importedId,
        candidates: 2,
        sources: 2,
      });
    });

    it('is what the pages read, not just what the table holds', async () => {
      // The Dashboard hero and the /day view both end here: canonical row ->
      // row mapper -> series -> latest present value. A fix that stopped short
      // of this would still leave 203.0 on screen.
      const days = rowsToDailyMetrics([(await canonical(DATE))!]);
      const latest = latestPresent(pickMetric(days, 'weightKg'));
      expect(latest).not.toBeNull();
      expect(displayWeight(latest!.value!, 'LB')).toBeCloseTo(IMPORTED_LB, 1);
    });

    it('resolves to the same value however many times it is rebuilt', async () => {
      // daily_metrics is a cache of a pure function. Rebuilding is the
      // remediation offered in Settings, so it has to be safe to run twice.
      const before = await canonical(DATE);
      await rebuild(DATE);
      await rebuild(DATE);
      const after = await canonical(DATE);
      expect(displayedLb(after!)).toBe(displayedLb(before!));
      expect(displayedLb(after!)).toBeCloseTo(IMPORTED_LB, 1);
      expect(await rawRows(DATE)).toHaveLength(2);
    });
  });

  // ------------------------------------------------------------- the inverse

  /**
   * The same rule read from the other end. A hand-typed correction of an
   * imported figure has to win too - otherwise "newest wins" would just be
   * "imports win", which is priority-first again with the ranks swapped.
   */
  describe('the inverse: imported 200.9, then typed 203.0', () => {
    const date: LocalDate = '2026-08-28';
    let importedId: string;
    let typedId: string;

    beforeAll(async () => {
      importedId = await record(
        date, IMPORTED_KG, 'IMPORT_TEXT', '2026-08-28T07:05:00Z',
      );
      await rebuild(date);
      typedId = await record(date, TYPED_KG, 'MANUAL', '2026-08-28T19:30:00Z');
      await rebuild(date);
    });

    it('resolves the day to the later hand-typed 203.0 lb', async () => {
      expect(displayedLb((await canonical(date))!)).toBeCloseTo(TYPED_LB, 1);
    });

    it('keeps both raw observations here too', async () => {
      const rows = await rawRows(date);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.id).sort()).toEqual([importedId, typedId].sort());
      expect(rows.every((r) => r.superseded_at === null)).toBe(true);
    });

    it('names the hand-typed observation as the winner', async () => {
      const provenance =
        ((await canonical(date))!.provenance ?? {}) as unknown as ProvenanceMap;
      expect(provenance.weightKg).toMatchObject({
        source: 'MANUAL', observationId: typedId, candidates: 2, sources: 2,
      });
    });
  });

  // --------------------------------------------------------- the genuine tie

  /**
   * Priority's actual job. Two readings of the SAME instant cannot be ordered
   * by recency, and that - and only that - is the question
   * DEFAULT_SOURCE_PRIORITY answers. MANUAL outranks IMPORT_TEXT there, which
   * is the documented default in lib/normalization/canonical.ts.
   */
  describe('two observations recorded at the same instant', () => {
    const date: LocalDate = '2026-08-27';

    beforeAll(async () => {
      const at = '2026-08-27T06:00:00Z';
      await record(date, IMPORTED_KG, 'IMPORT_TEXT', at);
      await record(date, TYPED_KG, 'MANUAL', at);
      await rebuild(date);
    });

    it('breaks the tie by source priority, giving MANUAL', async () => {
      expect(displayedLb((await canonical(date))!)).toBeCloseTo(TYPED_LB, 1);
      const provenance =
        ((await canonical(date))!.provenance ?? {}) as unknown as ProvenanceMap;
      expect(provenance.weightKg!.source).toBe('MANUAL');
    });

    it('still keeps both, and still calls it two sources', async () => {
      const rows = await rawRows(date);
      expect(rows).toHaveLength(2);
      const provenance =
        ((await canonical(date))!.provenance ?? {}) as unknown as ProvenanceMap;
      expect(provenance.weightKg).toMatchObject({ candidates: 2, sources: 2 });
    });
  });

  // ------------------------------------------------- the days stay separate

  it('does not let one day’s correction touch another day', async () => {
    // Three days now hold competing weights. Each resolved independently, and
    // a rebuild of one must not disturb the others - local_date is the key the
    // whole canonical layer is built on.
    await rebuild(DATE);
    expect(displayedLb((await canonical(DATE))!)).toBeCloseTo(IMPORTED_LB, 1);
    expect(displayedLb((await canonical('2026-08-28'))!)).toBeCloseTo(TYPED_LB, 1);
    expect(displayedLb((await canonical('2026-08-27'))!)).toBeCloseTo(TYPED_LB, 1);
  });
});
