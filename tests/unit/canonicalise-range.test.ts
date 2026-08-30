/**
 * A multi-day rebuild must survive one bad day (spec §16, §17).
 *
 * daily_metrics is a cache of a pure function over the raw layer, so a day that
 * fails to resolve has lost nothing. But letting the first failure abort the
 * loop would leave every LATER day missing from the dashboard and the Context
 * Pack with no route back - re-pasting is refused as a duplicate, so it never
 * triggers another rebuild.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { rebuildRange, rebuildDailyMetrics } = await import('@/lib/data/canonicalise');

/**
 * A result that can be awaited directly or narrowed further first.
 *
 * The rebuild filters some reads by date alone and others by date AND a null
 * column - canonical_field_pins is `.eq(date).is('cleared_at', null)` - so a
 * stub whose `eq` is a bare async function stops being enough. Returning a
 * thenable that also carries the extra filters keeps every read shape working
 * without the stub having to model a query builder.
 */
function result<T>(value: T) {
  const self = {
    then: (resolve: (v: T) => unknown) => Promise.resolve(value).then(resolve),
    eq: () => self,
    is: () => self,
    in: () => self,
    not: () => self,
    order: () => self,
    limit: () => self,
  };
  return self;
}

/** Enough of a Supabase client for the rebuild, failing on the named date. */
function clientFailingOn(badDate: string) {
  const upserted: string[] = [];
  const client = {
    from: () => ({
      select: () => result({ data: [], error: null }),
      upsert: async (row: Record<string, unknown>) => {
        if (row.local_date === badDate) return { error: { message: 'upsert refused' } };
        upserted.push(String(row.local_date));
        return { error: null };
      },
    }),
  };
  return { client, upserted };
}

describe('rebuildRange', () => {
  it('rebuilds every day when nothing fails', async () => {
    const { client, upserted } = clientFailingOn('never');
    const { failed } = await rebuildRange(
      client as never, 'user', ['2026-09-01', '2026-09-02', '2026-09-03'],
    );
    expect(failed).toEqual([]);
    expect(upserted).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
  });

  it('keeps going past a day that cannot be resolved', async () => {
    const { client, upserted } = clientFailingOn('2026-09-02');
    const { failed } = await rebuildRange(
      client as never, 'user', ['2026-09-01', '2026-09-02', '2026-09-03'],
    );

    expect(failed).toHaveLength(1);
    expect(failed[0]!.date).toBe('2026-09-02');
    expect(failed[0]!.message).toContain('upsert refused');
    // The day AFTER the failure was still resolved.
    expect(upserted).toEqual(['2026-09-01', '2026-09-03']);
  });

  it('names every day that failed, not just the first', async () => {
    const client = {
      from: () => ({
        select: () => result({ data: [], error: null }),
        upsert: async () => ({ error: { message: 'refused' } }),
      }),
    };
    const { failed } = await rebuildRange(
      client as never, 'user', ['2026-09-01', '2026-09-02'],
    );
    expect(failed.map((f) => f.date)).toEqual(['2026-09-01', '2026-09-02']);
  });

  it('does nothing for an empty range', async () => {
    const { client, upserted } = clientFailingOn('never');
    expect(await rebuildRange(client as never, 'user', [])).toEqual({ failed: [] });
    expect(upserted).toEqual([]);
  });
});

/**
 * A REBUILD THAT COULD NOT READ MUST NOT WRITE.
 *
 * These two cases are the difference between "this day holds no measurement"
 * and "this day could not be read", which the canonical layer used to collapse
 * into the same row of nulls - and then upsert over real values, reporting
 * success. daily_metrics is what every page reads, so that is a stored
 * measurement disappearing from the app while sitting safely on disk.
 */
describe('rebuildDailyMetrics does not write an answer it does not have', () => {
  /** A client whose reads all succeed except for the named table. */
  function clientFailingToRead(badTable: string, rows: Record<string, unknown>[] = []) {
    const upserts: Record<string, unknown>[] = [];
    const client = {
      from: (table: string) => ({
        select: () => result(
          table === badTable
            ? { data: null, error: { message: 'connection reset' } }
            : { data: table === 'body_measurements' ? rows : [], error: null },
        ),
        upsert: async (row: Record<string, unknown>) => {
          upserts.push(row);
          return { error: null };
        },
      }),
    };
    return { client, upserts };
  }

  it('throws instead of blanking the day when a read fails', async () => {
    const { client, upserts } = clientFailingToRead('body_measurements');
    await expect(
      rebuildDailyMetrics(client as never, 'user', '2026-08-29'),
    ).rejects.toThrow(/could not read body_measurements/);
    // The crucial half: nothing reached daily_metrics, so whatever the day
    // already resolved to is still there.
    expect(upserts).toEqual([]);
  });

  it('names the table that failed, so the failure is actionable', async () => {
    const { client } = clientFailingToRead('cardio_sessions');
    await expect(
      rebuildDailyMetrics(client as never, 'user', '2026-08-29'),
    ).rejects.toThrow(/cardio_sessions.*connection reset/s);
  });

  /**
   * The under-migrated database. Migration 0012 adds superseded_at to the
   * scalar observation tables; a project that has not run it returns rows with
   * no such key. A strict `=== null` test reads every one of them as withdrawn
   * and resolves the whole day to nulls - the measurement is on disk, the app
   * says it was never recorded.
   */
  it('counts an observation whose supersession column is absent', async () => {
    const { client, upserts } = clientFailingToRead('none', [
      { id: 'a', weight_kg: 92.079, waist_cm: null, source: 'MANUAL',
        measured_at: '2026-08-29T08:12:00Z' },
    ]);
    await rebuildDailyMetrics(client as never, 'user', '2026-08-29');
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.weight_kg).toBeCloseTo(92.079, 3);
  });

  it('still excludes an observation that says it was superseded', async () => {
    const { client, upserts } = clientFailingToRead('none', [
      { id: 'a', weight_kg: 92.079, waist_cm: null, source: 'MANUAL',
        measured_at: '2026-08-29T08:12:00Z',
        superseded_at: '2026-08-30T09:00:00Z', superseded_by: null },
    ]);
    await rebuildDailyMetrics(client as never, 'user', '2026-08-29');
    expect(upserts[0]!.weight_kg).toBeNull();
  });
});
