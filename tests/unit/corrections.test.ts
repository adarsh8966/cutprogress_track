/**
 * Withdrawing and correcting a record (spec §6, §41, §48).
 *
 * The rule these exist to hold: NOTHING IS EVER DELETED, and nothing is ever
 * reported as removed while it goes on counting. A control that says
 * "withdrawn" and leaves the value in every figure derived from the day is
 * worse than no control at all.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WITHDRAWABLE, isWithdrawableTable } from '@/lib/health/corrections';

vi.mock('server-only', () => ({}));

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const USER = '11111111-1111-1111-1111-111111111111';
const ROW = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

interface Row { [key: string]: unknown }

const db = vi.hoisted(() => ({
  updated: [] as { table: string; values: Row }[],
  inserted: {} as Record<string, Row[]>,
  /** What `.select(...).eq('id', ...).maybeSingle()` finds, keyed by table. */
  singles: {} as Record<string, Row | null>,
  errors: {} as Record<string, { message: string }>,
  /**
   * Update failures, kept apart from insert failures. The interesting cardio
   * case is precisely the one where the insert LANDS and the supersession does
   * not - a single error map could not express it.
   */
  updateErrors: {} as Record<string, { message: string }>,
  user: null as { id: string } | null,
  nextId: 0,
  reset() {
    this.updated = [];
    this.inserted = {};
    this.singles = {};
    this.errors = {};
    this.updateErrors = {};
    this.user = { id: USER };
    this.nextId = 0;
  },
}));

function fakeClient() {
  return {
    auth: {
      getUser: async () => ({
        data: { user: db.user },
        error: db.user ? null : { message: 'no session' },
      }),
    },
    from(table: string) {
      const error = db.errors[table] ?? null;
      return {
        insert(payload: Row | Row[]) {
          const rows = Array.isArray(payload) ? payload : [payload];
          if (!error) (db.inserted[table] ??= []).push(...rows);
          const ids = rows.map(() => ({ id: `new-${(db.nextId += 1)}` }));
          return {
            select: () => ({
              single: async () => ({ data: error ? null : ids[0] ?? null, error }),
            }),
            then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error }),
          };
        },
        update(values: Row) {
          const updateError = db.updateErrors[table] ?? error;
          const builder = {
            eq: () => {
              if (!updateError) db.updated.push({ table, values });
              return builder;
            },
            then: (resolve: (v: unknown) => unknown) => resolve({ error: updateError }),
          };
          return builder;
        },
        select() {
          const builder = {
            eq: () => builder,
            maybeSingle: async () => ({ data: db.singles[table] ?? null, error }),
            then: (resolve: (v: unknown) => unknown) =>
              resolve({ data: error ? null : [], error }),
          };
          return builder;
        },
      };
    },
  };
}

const rebuildDailyMetrics = vi.hoisted(() => vi.fn(async () => ({ provenance: {} })));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createActionClient: async () => fakeClient() as never,
}));
vi.mock('@/lib/data/canonicalise', () => ({ rebuildDailyMetrics }));
vi.mock('@/lib/data/queries', () => ({
  getProfile: async () => ({
    timezone: 'America/New_York',
    weightDisplayUnit: 'LB',
    lengthDisplayUnit: 'IN',
    distanceDisplayUnit: 'MI',
  }),
}));

const { withdrawObservation, restoreObservation, correctCardioSession } =
  await import('@/app/actions/corrections');

beforeEach(() => {
  db.reset();
  rebuildDailyMetrics.mockClear();
});

/**
 * The invariant that makes the whole feature honest.
 *
 * A table is withdrawable only if the canonical rebuild EXCLUDES superseded
 * rows from it. Listing one without that would let the user withdraw a record
 * on screen while it went on counting in every derived figure - the app
 * agreeing it was removed and the analytics disagreeing.
 */
describe('every withdrawable table is excluded from the rebuild when superseded', () => {
  const canonicalise = readFileSync(`${ROOT}lib/data/canonicalise.ts`, 'utf8');

  it('filters superseded rows in exactly one place', () => {
    // A single `live()` helper, applied per source. If this stops being how it
    // is written the per-table assertions below need rechecking by hand.
    expect(canonicalise).toContain("superseded_at === null");
  });

  it.each(Object.keys(WITHDRAWABLE))('%s is read through the live filter', (table) => {
    // The rebuild names each source by its result variable; every one of them
    // is wrapped in live(...).
    const source: Record<string, string> = {
      body_measurements: 'live(body.data',
      metric_observations: 'live(metrics.data',
      nutrition_logs: 'live(nutrition.data',
      sleep_records: 'live(sleep.data',
      cardio_sessions: 'live(cardio.data',
      workout_sessions: 'live(sessions.data',
    };
    expect(
      canonicalise.includes(source[table]!),
      `${table} must be filtered by live() or withdrawing from it does nothing`,
    ).toBe(true);
  });

  it('rejects a table that is not withdrawable', () => {
    expect(isWithdrawableTable('workout_sets')).toBe(false);
    expect(isWithdrawableTable('daily_metrics')).toBe(false);
    expect(isWithdrawableTable('body_measurements')).toBe(true);
  });
});

describe('withdrawObservation', () => {
  it('marks the row superseded without touching what it measured', async () => {
    db.singles.body_measurements = { local_date: '2026-08-28', superseded_at: null };

    const result = await withdrawObservation({ table: 'body_measurements', id: ROW });

    expect(result.ok).toBe(true);
    expect(db.updated).toHaveLength(1);
    // Exactly the two bookkeeping columns. No measurement is rewritten, which
    // is also all the column-level GRANT would permit.
    expect(Object.keys(db.updated[0]!.values).sort())
      .toEqual(['superseded_at', 'superseded_by']);
    expect(db.updated[0]!.values.superseded_by).toBeNull();
  });

  it('rebuilds the day, or the withdrawn value stays on every page', async () => {
    db.singles.sleep_records = { local_date: '2026-08-28', superseded_at: null };

    await withdrawObservation({ table: 'sleep_records', id: ROW });

    expect(rebuildDailyMetrics).toHaveBeenCalledWith(
      expect.anything(), USER, '2026-08-28',
    );
  });

  it('records the change in the audit log (spec §41)', async () => {
    db.singles.nutrition_logs = { local_date: '2026-08-28', superseded_at: null };

    await withdrawObservation({ table: 'nutrition_logs', id: ROW });

    const events = db.inserted.system_events ?? [];
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('OBSERVATION_SUPERSEDED');
    expect(events[0]!.reason).toBeTruthy();
  });

  it('refuses a table it does not own', async () => {
    const result = await withdrawObservation({ table: 'daily_metrics', id: ROW });

    expect(result.ok).toBe(false);
    expect(db.updated).toHaveLength(0);
  });

  it('refuses a record that is already withdrawn', async () => {
    db.singles.body_measurements = {
      local_date: '2026-08-28', superseded_at: '2026-08-29T10:00:00Z',
    };

    const result = await withdrawObservation({ table: 'body_measurements', id: ROW });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/already been withdrawn or replaced/i);
    expect(db.updated).toHaveLength(0);
  });

  it('says so when the record is gone rather than reporting success', async () => {
    db.singles.body_measurements = null;

    const result = await withdrawObservation({ table: 'body_measurements', id: ROW });

    expect(result.ok).toBe(false);
    expect(db.updated).toHaveLength(0);
  });

  /**
   * The row is withdrawn but the day still shows the old figure. Reporting
   * that as a success is the exact failure mode this application must not
   * have, so it is reported as a failure with what to do about it.
   */
  it('does not report success when the day could not be rebuilt', async () => {
    db.singles.body_measurements = { local_date: '2026-08-28', superseded_at: null };
    rebuildDailyMetrics.mockRejectedValueOnce(new Error('connection reset') as never);

    const result = await withdrawObservation({ table: 'body_measurements', id: ROW });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/could not be recomputed/i);
    expect(result.message).toMatch(/rebuild the daily summary/i);
  });
});

describe('restoreObservation', () => {
  it('puts a withdrawn record back and rebuilds the day', async () => {
    db.singles.sleep_records = {
      local_date: '2026-08-28', superseded_at: '2026-08-29T10:00:00Z', superseded_by: null,
    };

    const result = await restoreObservation({ table: 'sleep_records', id: ROW });

    expect(result.ok).toBe(true);
    expect(db.updated[0]!.values).toEqual({ superseded_at: null, superseded_by: null });
    expect(rebuildDailyMetrics).toHaveBeenCalled();
  });

  /**
   * A row replaced by a correction has a successor still in place. Restoring
   * it would put two readings of one session back into a summed day - the
   * 58 + 65 = 123 doubling migration 0011 exists to prevent.
   */
  it('refuses to restore a record that a correction replaced', async () => {
    db.singles.cardio_sessions = {
      local_date: '2026-08-28',
      superseded_at: '2026-08-29T10:00:00Z',
      superseded_by: OTHER,
    };

    const result = await restoreObservation({ table: 'cardio_sessions', id: ROW });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/count the same thing twice/i);
    expect(db.updated).toHaveLength(0);
  });

  it('refuses a record that is already counting', async () => {
    db.singles.body_measurements = {
      local_date: '2026-08-28', superseded_at: null, superseded_by: null,
    };

    const result = await restoreObservation({ table: 'body_measurements', id: ROW });

    expect(result.ok).toBe(false);
    expect(db.updated).toHaveLength(0);
  });
});

describe('correctCardioSession', () => {
  function form(values: Record<string, string>): FormData {
    const data = new FormData();
    const base: Record<string, string> = {
      supersedes: ROW,
      date: '2026-08-28',
      type: 'INCLINE_WALKING',
      duration: '35',
      distance: '',
      hrZone: '',
      averageHeartRate: '',
      maxHeartRate: '',
      calories: '',
    };
    for (const [key, value] of Object.entries({ ...base, ...values })) {
      data.set(key, value);
    }
    return data;
  }

  it('writes the corrected session and supersedes the one it replaces', async () => {
    db.singles.cardio_sessions = { local_date: '2026-08-28', superseded_at: null };

    const result = await correctCardioSession(form({ duration: '35' }));

    expect(result.ok).toBe(true);
    // A NEW row, because cardio is a closed observation. Not an edit in place.
    expect(db.inserted.cardio_sessions).toHaveLength(1);
    expect(db.inserted.cardio_sessions![0]!.duration_minutes).toBe(35);
    // And the old one stops counting, so the day is 35 minutes and not 65.
    const supersession = db.updated.find((u) => u.table === 'cardio_sessions');
    expect(supersession!.values.superseded_by).toBe('new-1');
    expect(Object.keys(supersession!.values).sort())
      .toEqual(['superseded_at', 'superseded_by']);
  });

  it('refuses a correction that does not say what it replaces', async () => {
    const result = await correctCardioSession(form({ supersedes: '' }));

    expect(result.ok).toBe(false);
    expect(db.inserted.cardio_sessions).toBeUndefined();
  });

  it('refuses to correct a session that was already replaced', async () => {
    db.singles.cardio_sessions = {
      local_date: '2026-08-28', superseded_at: '2026-08-29T10:00:00Z',
    };

    const result = await correctCardioSession(form({}));

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/already been replaced or withdrawn/i);
    expect(db.inserted.cardio_sessions).toBeUndefined();
  });

  it('reports a doubled day rather than claiming success', async () => {
    // The insert lands, the supersession does not. Both readings now count,
    // and saying "corrected" would be the lie that matters most here.
    db.singles.cardio_sessions = { local_date: '2026-08-28', superseded_at: null };
    db.updateErrors.cardio_sessions = { message: 'permission denied' };

    const result = await correctCardioSession(form({}));

    // The corrected session is on disk; the old one is still counting.
    expect(db.inserted.cardio_sessions).toHaveLength(1);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/counts both/i);
  });

  it('records the correction in the audit log', async () => {
    db.singles.cardio_sessions = { local_date: '2026-08-28', superseded_at: null };

    await correctCardioSession(form({}));

    const events = db.inserted.system_events ?? [];
    expect(events.some((e) => e.kind === 'OBSERVATION_SUPERSEDED')).toBe(true);
  });

  /**
   * A correction may move the session to another day. The day it left is then
   * holding a total for a session no longer in it, so it has to be recomputed
   * too - logCardio only rebuilds the day the correction landed on.
   */
  it('rebuilds the day a moved session left behind', async () => {
    db.singles.cardio_sessions = { local_date: '2026-08-28', superseded_at: null };

    await correctCardioSession(form({ date: '2026-08-29' }));

    const dates = rebuildDailyMetrics.mock.calls.map((call) => (call as unknown[])[2]);
    expect(dates).toContain('2026-08-29');
    expect(dates).toContain('2026-08-28');
  });
});
