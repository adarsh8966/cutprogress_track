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

const { rebuildRange } = await import('@/lib/data/canonicalise');

/** Enough of a Supabase client for the rebuild, failing on the named date. */
function clientFailingOn(badDate: string) {
  const upserted: string[] = [];
  const client = {
    from: () => ({
      select: () => ({ eq: async () => ({ data: [], error: null }) }),
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
        select: () => ({ eq: async () => ({ data: [], error: null }) }),
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
