/**
 * The write actions, at the boundary where a correction can go wrong.
 *
 * These are the actions the forms call. They are covered here rather than only
 * through the pure analytics because the mistakes that matter live in the
 * action: writing a row the database will refuse, editing a record that no
 * longer counts, or reporting a success the canonical layer never saw.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const USER = '11111111-1111-1111-1111-111111111111';
const SESSION = '11111111-1111-4111-8111-111111111111';

interface Row { [key: string]: unknown }

const db = vi.hoisted(() => ({
  inserted: {} as Record<string, Row[]>,
  updated: [] as { table: string; values: Row }[],
  /** What a `.select(...).eq(...).maybeSingle()` finds, keyed by table. */
  singles: {} as Record<string, Row | null>,
  errors: {} as Record<string, { message: string }>,
  user: null as { id: string } | null,
  nextId: 0,
  reset() {
    this.inserted = {};
    this.updated = [];
    this.singles = {};
    this.errors = {};
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
          const ids = rows.map(() => ({ id: `id-${(db.nextId += 1)}` }));
          return {
            select: () => ({
              single: async () => ({ data: error ? null : ids[0] ?? null, error }),
              then: (resolve: (v: unknown) => unknown) =>
                resolve({ data: error ? null : ids, error }),
            }),
            then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error }),
          };
        },
        update(values: Row) {
          const builder = {
            eq: () => {
              if (!error) db.updated.push({ table, values });
              return builder;
            },
            then: (resolve: (v: unknown) => unknown) => resolve({ error }),
          };
          return builder;
        },
        select() {
          const builder = {
            eq: () => builder,
            is: () => builder,
            maybeSingle: async () => ({
              data: db.singles[table] ?? null,
              error,
            }),
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

const { updateWorkoutSession } = await import('@/app/actions/log');

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

beforeEach(() => {
  db.reset();
  rebuildDailyMetrics.mockClear();
});

describe('updateWorkoutSession', () => {
  const valid = {
    sessionId: SESSION,
    sessionType: 'PULL',
    duration: '65',
    averageHeartRate: '',
    maxHeartRate: '',
    calories: '',
    notes: '',
  };

  it('corrects a live session and rebuilds the day it belongs to', async () => {
    db.singles.workout_sessions = { local_date: '2026-08-28', superseded_at: null };

    const result = await updateWorkoutSession(form(valid));

    expect(result.ok).toBe(true);
    expect(db.updated).toHaveLength(1);
    expect(db.updated[0]!.values.duration_minutes).toBe(65);
    // The day's rollup is a pure function of the raw layer; without this the
    // Dashboard keeps showing the duration that was replaced.
    expect(rebuildDailyMetrics).toHaveBeenCalledWith(
      expect.anything(), USER, '2026-08-28',
    );
  });

  /**
   * A superseded session is history. A later observation replaced it and the
   * day's totals already exclude it (migration 0011), so editing it would
   * appear to work, change no total anywhere, and rewrite a record kept
   * precisely so the correction stays traceable.
   */
  it('refuses to edit a session a later correction replaced', async () => {
    db.singles.workout_sessions = {
      local_date: '2026-08-28',
      superseded_at: '2026-08-29T09:00:00Z',
    };

    const result = await updateWorkoutSession(form(valid));

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/replaced by a later correction/i);
    expect(db.updated).toHaveLength(0);
    expect(rebuildDailyMetrics).not.toHaveBeenCalled();
  });

  it('says so when the session is gone rather than writing nothing quietly', async () => {
    db.singles.workout_sessions = null;

    const result = await updateWorkoutSession(form(valid));

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no longer exists/i);
    expect(db.updated).toHaveLength(0);
  });

  it('refuses a maximum heart rate below the average, as the CHECK would', async () => {
    db.singles.workout_sessions = { local_date: '2026-08-28', superseded_at: null };

    const result = await updateWorkoutSession(
      form({ ...valid, averageHeartRate: '150', maxHeartRate: '120' }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors?.maxHeartRate).toBeTruthy();
    expect(db.updated).toHaveLength(0);
  });

  it('records a cleared field as not logged, not as zero', async () => {
    db.singles.workout_sessions = { local_date: '2026-08-28', superseded_at: null };

    await updateWorkoutSession(form({ ...valid, duration: '', calories: '' }));

    expect(db.updated[0]!.values.duration_minutes).toBeNull();
    expect(db.updated[0]!.values.calories).toBeNull();
  });
});
