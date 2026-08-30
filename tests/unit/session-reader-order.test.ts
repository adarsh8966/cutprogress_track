/**
 * What getWorkoutSessions asks the database for, and in what order.
 *
 * The reader used to order by local_date alone. Two sessions on the same day
 * therefore came back in whatever sequence PostgREST happened to choose, so the
 * Training page's own order was an accident that happened to be stable - the
 * kind of thing that looks fine until the day it does not.
 *
 * Ordering is asserted here rather than through a live query because the two
 * parts most easily lost are both invisible in a result set that happens to
 * come back sorted: the second sort term, and NULLS LAST. A descending sort in
 * Postgres puts NULLs FIRST by default, so dropping `nullsFirst: false` would
 * float every date-only session above the timed ones - agreeing with nothing,
 * least of all composeTraining, and only on days that mix the two.
 */
import { describe, it, expect, vi } from 'vitest';
import type { WorkoutSessionRow } from '@/lib/supabase/types';

vi.mock('server-only', () => ({}));

interface OrderCall {
  column: string;
  options: { ascending: boolean; nullsFirst?: boolean };
}

const calls = vi.hoisted(() => ({ order: [] as OrderCall[], filters: [] as string[] }));

const ROWS: Partial<WorkoutSessionRow>[] = [
  {
    id: 'evening', local_date: '2026-08-29', session_type: 'PULL',
    start_time: '2026-08-29T18:30:00Z', end_time: null,
    duration_minutes: 58, average_heart_rate: null, max_heart_rate: null,
    calories: null, notes: null, completed: true, source: 'HEVY',
    import_id: null, title: null, external_source: null,
  },
];

vi.mock('@/lib/supabase/server', () => {
  const builder = {
    select: () => builder,
    is: (column: string) => { calls.filters.push(`is:${column}`); return builder; },
    gte: (column: string) => { calls.filters.push(`gte:${column}`); return builder; },
    lte: (column: string) => { calls.filters.push(`lte:${column}`); return builder; },
    order(column: string, options: OrderCall['options']) {
      calls.order.push({ column, options });
      return builder;
    },
    then: (resolve: (r: unknown) => unknown) => resolve({ data: ROWS, error: null }),
  };
  return {
    createServerComponentClient: async () => ({ from: () => builder }) as never,
  };
});

const { getWorkoutSessions } = await import('@/lib/data/queries');

describe('getWorkoutSessions ordering', () => {
  it('asks for a total order: day, then start time, then id', async () => {
    calls.order.length = 0;
    await getWorkoutSessions('2026-08-01', '2026-08-31');

    expect(calls.order).toEqual([
      { column: 'local_date', options: { ascending: false } },
      { column: 'start_time', options: { ascending: false, nullsFirst: false } },
      { column: 'id', options: { ascending: true } },
    ]);
  });

  it('puts date-only sessions LAST within a day, not first', () => {
    const startTime = calls.order.find((call) => call.column === 'start_time')!;
    // Descending defaults to NULLS FIRST in Postgres. Stating it is the whole
    // point of the option; without it the default silently disagrees with
    // composeTraining, which sorts a recorded start ahead of an absent one.
    expect(startTime.options.ascending).toBe(false);
    expect(startTime.options.nullsFirst).toBe(false);
  });

  it('still reads only live rows, over the window it was given', async () => {
    calls.filters.length = 0;
    await getWorkoutSessions('2026-08-01', '2026-08-31');
    // Ordering is not filtering: the same rows, in a defined sequence.
    expect(calls.filters).toEqual([
      'is:superseded_at', 'gte:local_date', 'lte:local_date',
    ]);
  });

  it('returns sessions through the mapper, timing included', async () => {
    const sessions = await getWorkoutSessions('2026-08-01', '2026-08-31');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.startTime).toBe('2026-08-29T18:30:00.000Z');
    expect(sessions[0]!.endTime).toBeNull();
  });
});
