/**
 * confirmImport: what the review screen promised must be what the database
 * receives (spec §8, §17, §38, §41).
 *
 * The parser is covered elsewhere. This file pins the half that actually
 * writes, and specifically the four properties the importer used to get wrong:
 *
 *   - every parsed session reaches a table, instead of being dropped silently
 *   - a failed insert is reported, instead of being swallowed under a cheerful
 *     "imported" message
 *   - the import row is only marked CONFIRMED once every write has landed
 *   - one bad or duplicated day does not take the rest of the week with it
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const USER = '11111111-1111-1111-1111-111111111111';

interface FakeError { message: string; code?: string }

const db = vi.hoisted(() => ({
  inserted: {} as Record<string, Record<string, unknown>[]>,
  updated: [] as { table: string; values: Record<string, unknown> }[],
  /** Injected insert failures, keyed by table. */
  errors: {} as Record<string, { message: string; code?: string }>,
  /** Injected update failures, keyed by table. Separate, because a unique
   *  violation applies to the insert alone. */
  updateErrors: {} as Record<string, { message: string }>,
  user: null as { id: string } | null,
  /** What a lookup on health_imports should find, if anything. */
  existingImport: null as { id: string; status: string } | null,
  /** Rows an earlier unfinished attempt left behind, keyed by table. */
  resumeWrote: {} as Record<string, string[]>,
  /**
   * The sessions a REPLACE targets, as they currently stand. superseded_at is
   * what says whether an earlier attempt finished marking them.
   */
  supersessionTargets: {} as Record<string, { id: string; superseded_at: string | null }[]>,
  /** Injected read failures, keyed by table. */
  selectErrors: {} as Record<string, { message: string }>,
  nextId: 0,
  reset() {
    this.inserted = {};
    this.updated = [];
    this.errors = {};
    this.updateErrors = {};
    this.user = { id: USER };
    this.existingImport = null;
    this.resumeWrote = {};
    this.supersessionTargets = {};
    this.selectErrors = {};
    this.nextId = 0;
  },
}));

function rowsFor(table: string): Record<string, unknown>[] {
  return db.inserted[table] ?? [];
}

/** A Supabase client just real enough for the action's call shapes. */
function fakeClient() {
  return {
    auth: {
      getUser: async () => ({
        data: { user: db.user },
        error: db.user ? null : { message: 'no session' },
      }),
    },
    from(table: string) {
      const error: FakeError | null = db.errors[table] ?? null;
      return {
        insert(payload: Record<string, unknown> | Record<string, unknown>[]) {
          const rows = Array.isArray(payload) ? payload : [payload];
          // One id per row, so `.insert(rows).select('id')` can hand back a row
          // per insert the way PostgREST does - that is how a REPLACE finds the
          // id of the session it just wrote in order to supersede the old one.
          const ids = rows.map(() => ({ id: `id-${(db.nextId += 1)}` }));
          if (!error) {
            (db.inserted[table] ??= []).push(...rows);
          }
          const single = { data: error ? null : ids[0] ?? null, error };
          const many = { data: error ? null : ids, error };
          return {
            select: () => ({
              single: async () => single,
              then: (resolve: (value: typeof many) => unknown) => resolve(many),
            }),
            then: (resolve: (value: { data: null; error: FakeError | null }) => unknown) =>
              resolve({ data: null, error }),
          };
        },
        update(values: Record<string, unknown>) {
          const updateError = db.updateErrors[table] ?? null;
          return {
            eq: async () => {
              if (!updateError) db.updated.push({ table, values });
              return { error: updateError };
            },
          };
        },
        select(columns = '*') {
          const selectError = db.selectErrors[table] ?? null;
          // Awaiting the builder resolves the query. Which query it is comes
          // from the column list, which is how the two reads the resume path
          // makes are told apart: the supersession targets ask for
          // superseded_at, the import's own rows do not.
          const resolved = () => ({
            data: selectError
              ? null
              : columns.includes('superseded_at')
                ? db.supersessionTargets[table] ?? []
                : (db.resumeWrote[table] ?? []).map((id) => ({ id })),
            error: selectError,
          });
          const filtered = {
            eq: () => filtered,
            in: () => filtered,
            maybeSingle: async () => ({ data: db.existingImport, error: null }),
            /** Rows a previous, unfinished attempt already wrote to this table. */
            limit: async () => ({
              data: (db.resumeWrote[table] ?? []).map((id) => ({ id })),
              error: selectError,
            }),
            then: (resolve: (value: ReturnType<typeof resolved>) => unknown) =>
              resolve(resolved()),
          };
          return filtered;
        },
      };
    },
  };
}

const rebuildRange = vi.hoisted(() =>
  vi.fn(async (): Promise<{ failed: { date: string; message: string }[] }> => ({ failed: [] })),
);

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createActionClient: async () => fakeClient() as never,
}));
vi.mock('@/lib/data/canonicalise', () => ({ rebuildRange }));
vi.mock('@/lib/data/queries', () => ({
  getProfile: async () => ({ timezone: 'America/New_York' }),
}));

const { confirmImport } = await import('@/app/actions/import');
type Payload = Parameters<typeof confirmImport>[0];
type Record_ = Payload['records'][number];
type Session = Record_['sessions'][number];

function record(overrides: Partial<Record_> = {}): Record_ {
  return {
    rawText: 'Date: 2026-09-01\nSteps: 15000',
    date: '2026-09-01',
    weightKg: null, waistCm: null, calories: null, proteinG: null, carbsG: null,
    fatG: null, fiberG: null, steps: null, activeCalories: null,
    restingHeartRate: null, hrvMs: null, sleepMinutes: null,
    sessions: [],
    ...overrides,
  };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    kind: 'WORKOUT',
    sessionType: 'PUSH',
    cardioType: 'OTHER',
    rawLabel: 'Push',
    sessionMinutes: null, distanceKm: null, averageHeartRate: null,
    maxHeartRate: null, sessionCalories: null, hrZone: null,
    // ADD is the default and what every existing case expects: write the
    // session alongside anything already on the day.
    disposition: 'ADD', supersedes: null,
    ...overrides,
  };
}

beforeEach(() => {
  db.reset();
  rebuildRange.mockClear();
});

describe('what the review screen promised is what gets written', () => {
  it('writes one row per domain, in canonical units', async () => {
    const result = await confirmImport({
      records: [record({
        weightKg: 92.4, waistCm: 89.916,
        calories: 2001, proteinG: 172, carbsG: 198, fatG: 67, fiberG: 29,
        steps: 15000, activeCalories: 640,
        restingHeartRate: 58, hrvMs: 71, sleepMinutes: 450,
      })],
    });

    expect(result.ok).toBe(true);

    expect(rowsFor('body_measurements')).toHaveLength(1);
    expect(rowsFor('body_measurements')[0]).toMatchObject({
      user_id: USER, local_date: '2026-09-01',
      weight_kg: 92.4, waist_cm: 89.916, source: 'IMPORT_TEXT',
    });

    expect(rowsFor('nutrition_logs')[0]).toMatchObject({
      calories: 2001, protein_g: 172, carbs_g: 198, fat_g: 67, fiber_g: 29,
    });

    expect(rowsFor('metric_observations').map((r) => r.metric)).toEqual(
      ['STEPS', 'ACTIVE_CALORIES', 'RESTING_HEART_RATE', 'HRV_MS'],
    );
    expect(rowsFor('sleep_records')[0]).toMatchObject({ duration_minutes: 450 });
  });

  it('reports exactly which rows it wrote', async () => {
    const result = await confirmImport({
      records: [record({ steps: 15000, sleepMinutes: 450 })],
    });
    expect(result.records[0]!.wrote).toEqual([
      { table: 'metric_observations', rows: 1 },
      { table: 'sleep_records', rows: 1 },
    ]);
  });

  it('leaves an unlogged field null, never zero', async () => {
    await confirmImport({ records: [record({ calories: 1950 })] });
    const nutrition = rowsFor('nutrition_logs')[0]!;
    expect(nutrition.calories).toBe(1950);
    expect(nutrition.protein_g).toBeNull();
    expect(nutrition.fiber_g).toBeNull();
    // Nothing to weigh means no observation at all, not a zero-weight one.
    expect(rowsFor('body_measurements')).toHaveLength(0);
    expect(rowsFor('sleep_records')).toHaveLength(0);
  });

  it('keeps a measured zero', async () => {
    await confirmImport({ records: [record({ steps: 0, calories: 0 })] });
    expect(rowsFor('metric_observations')[0]!.value).toBe(0);
    expect(rowsFor('nutrition_logs')[0]!.calories).toBe(0);
  });

  it('writes a workout session with its heart rates and burn', async () => {
    await confirmImport({
      records: [record({
        sessions: [session({
          sessionMinutes: 55, averageHeartRate: 128, maxHeartRate: 161,
          sessionCalories: 430,
        })],
      })],
    });

    expect(rowsFor('workout_sessions')[0]).toMatchObject({
      user_id: USER, local_date: '2026-09-01',
      session_type: 'PUSH', duration_minutes: 55,
      average_heart_rate: 128, max_heart_rate: 161, calories: 430,
      notes: 'Push', completed: true, source: 'IMPORT_TEXT',
    });
  });

  it('writes a cardio session with its distance and zone', async () => {
    await confirmImport({
      records: [record({
        sessions: [session({
          kind: 'CARDIO', cardioType: 'RUNNING', rawLabel: 'Running',
          sessionMinutes: 38, distanceKm: 4.988, averageHeartRate: 152,
          maxHeartRate: 178, sessionCalories: 465, hrZone: 3,
        })],
      })],
    });

    expect(rowsFor('cardio_sessions')[0]).toMatchObject({
      cardio_type: 'RUNNING', duration_minutes: 38, distance_km: 4.988,
      average_heart_rate: 152, max_heart_rate: 178, calories: 465,
      hr_zone: 3, notes: 'Running',
    });
  });

  /**
   * Corrected imports (spec §38).
   *
   * daily_metrics SUMS a day's sessions, so re-importing Aug 28 to fix a
   * duration used to make the day 58 + 65 = 123 minutes: two true rows and one
   * false total. The reviewer now chooses per session, and REPLACE records the
   * correction as a NEW row that supersedes the old one - nothing is updated in
   * place and nothing is deleted.
   */
  describe('corrected imports', () => {
    it('ADD writes the session and supersedes nothing', async () => {
      await confirmImport({
        records: [record({
          sessions: [session({ sessionMinutes: 65, disposition: 'ADD' })],
        })],
      });
      expect(rowsFor('workout_sessions')).toHaveLength(1);
      // health_imports is still flipped to CONFIRMED; no session is superseded.
      expect(db.updated.filter((u) => u.table === 'workout_sessions')).toHaveLength(0);
    });

    it('REPLACE writes the new session and marks the old one superseded', async () => {
      await confirmImport({
        records: [record({
          sessions: [session({
            sessionMinutes: 65, disposition: 'REPLACE',
            supersedes: '11111111-1111-4111-8111-111111111111',
          })],
        })],
      });

      // The correction is a new observation, exactly like every other one.
      expect(rowsFor('workout_sessions')).toHaveLength(1);
      expect(rowsFor('workout_sessions')[0]!.duration_minutes).toBe(65);

      // And the row it replaces stops counting, without being touched otherwise.
      const supersession = db.updated.find((u) => u.table === 'workout_sessions');
      expect(supersession).toBeDefined();
      expect(supersession!.values.superseded_by).toBeTruthy();
      expect(supersession!.values.superseded_at).toBeTruthy();
      // No measurement is rewritten by a supersession.
      expect(Object.keys(supersession!.values).sort())
        .toEqual(['superseded_at', 'superseded_by']);
    });

    it('KEEP writes nothing at all for that session', async () => {
      await confirmImport({
        records: [record({
          steps: 12000,
          sessions: [session({ sessionMinutes: 65, disposition: 'KEEP' })],
        })],
      });
      expect(rowsFor('workout_sessions')).toHaveLength(0);
      expect(db.updated.filter((u) => u.table === 'workout_sessions')).toHaveLength(0);
      // The rest of the day still imports; KEEP is about that session only.
      expect(rowsFor('metric_observations')).toHaveLength(1);
    });

    it('KEEP on cardio leaves the existing cardio session alone', async () => {
      await confirmImport({
        records: [record({
          sessions: [session({
            kind: 'CARDIO', cardioType: 'RUNNING', rawLabel: 'Run',
            sessionMinutes: 30, disposition: 'KEEP',
          })],
        })],
      });
      expect(rowsFor('cardio_sessions')).toHaveLength(0);
    });

    it('REPLACE on cardio supersedes the row it names', async () => {
      await confirmImport({
        records: [record({
          sessions: [session({
            kind: 'CARDIO', cardioType: 'RUNNING', rawLabel: 'Run',
            sessionMinutes: 30, disposition: 'REPLACE',
            supersedes: '22222222-2222-4222-8222-222222222222',
          })],
        })],
      });
      expect(rowsFor('cardio_sessions')).toHaveLength(1);
      expect(db.updated.some((u) => u.table === 'cardio_sessions')).toBe(true);
    });

    it('refuses a REPLACE that does not name what it replaces', async () => {
      const result = await confirmImport({
        records: [record({
          sessions: [session({ sessionMinutes: 65, disposition: 'REPLACE', supersedes: null })],
        })],
      });
      expect(result.ok).toBe(false);
      expect(rowsFor('workout_sessions')).toHaveLength(0);
    });

    it('replaces only the session it was told to, on a day with several', async () => {
      await confirmImport({
        records: [record({
          sessions: [
            session({ sessionType: 'PUSH', rawLabel: 'Push', sessionMinutes: 45 }),
            session({
              sessionType: 'PULL', rawLabel: 'Pull', sessionMinutes: 65,
              disposition: 'REPLACE',
              supersedes: '33333333-3333-4333-8333-333333333333',
            }),
          ],
        })],
      });
      expect(rowsFor('workout_sessions')).toHaveLength(2);
      const updates = db.updated.filter((u) => u.table === 'workout_sessions');
      expect(updates).toHaveLength(1);
    });
  });

  it('keeps the original label even when the type falls back to OTHER', async () => {
    await confirmImport({
      records: [record({
        sessions: [session({ sessionType: 'OTHER', rawLabel: 'Arms and abs', sessionMinutes: 40 })],
      })],
    });
    expect(rowsFor('workout_sessions')[0]!.notes).toBe('Arms and abs');
  });

  it('writes several sessions on one day without them overwriting each other', async () => {
    await confirmImport({
      records: [record({
        sessions: [
          session({ sessionType: 'PUSH', rawLabel: 'Push', sessionMinutes: 45 }),
          session({ sessionType: 'LEGS', rawLabel: 'Legs', sessionMinutes: 50 }),
          session({ kind: 'CARDIO', cardioType: 'WALKING', rawLabel: 'Walk', sessionMinutes: 25 }),
          session({ kind: 'CARDIO', cardioType: 'CYCLING', rawLabel: 'Bike', sessionMinutes: 40 }),
        ],
      })],
    });
    expect(rowsFor('workout_sessions')).toHaveLength(2);
    expect(rowsFor('cardio_sessions')).toHaveLength(2);
    expect(rowsFor('cardio_sessions').map((r) => r.duration_minutes)).toEqual([25, 40]);
  });
});

describe('multiple days', () => {
  it('writes every day and rebuilds each one', async () => {
    const result = await confirmImport({
      records: [
        record({ rawText: 'Date: 2026-09-01\nSteps: 15000', date: '2026-09-01', steps: 15000 }),
        record({ rawText: 'Date: 2026-09-02\nSteps: 11250', date: '2026-09-02', steps: 11250 }),
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.records.map((r) => r.status)).toEqual(['IMPORTED', 'IMPORTED']);
    expect(rowsFor('health_imports')).toHaveLength(2);
    expect(rowsFor('metric_observations').map((r) => r.local_date))
      .toEqual(['2026-09-01', '2026-09-02']);
    expect(rebuildRange).toHaveBeenCalledWith(
      expect.anything(), USER, ['2026-09-01', '2026-09-02'],
    );
  });

  it('gives each day its own idempotency key', async () => {
    await confirmImport({
      records: [
        record({ rawText: 'Date: 2026-09-01\nSteps: 15000', date: '2026-09-01', steps: 15000 }),
        record({ rawText: 'Date: 2026-09-02\nSteps: 11250', date: '2026-09-02', steps: 11250 }),
      ],
    });
    const keys = rowsFor('health_imports').map((r) => r.idempotency_key);
    expect(new Set(keys).size).toBe(2);
  });
});

describe('failures are reported, never swallowed', () => {
  it('marks the import PENDING first and CONFIRMED only after every write', async () => {
    await confirmImport({ records: [record({ steps: 15000 })] });
    expect(rowsFor('health_imports')[0]).toMatchObject({
      status: 'PENDING', confirmed_at: null, confirmed: null,
    });
    expect(db.updated).toHaveLength(1);
    expect(db.updated[0]!.values).toMatchObject({ status: 'CONFIRMED' });
  });

  it('reports a rejected row instead of claiming success', async () => {
    db.errors.body_measurements = { message: 'violates check constraint' };
    const result = await confirmImport({
      records: [record({ weightKg: 92.4, steps: 15000 })],
    });

    expect(result.ok).toBe(false);
    expect(result.records[0]!.status).toBe('FAILED');
    expect(result.records[0]!.message).toContain('violates check constraint');
    // The raw text survives, but the import is never marked confirmed.
    expect(rowsFor('health_imports')).toHaveLength(1);
    expect(db.updated).toHaveLength(0);
    // And it stops before writing anything else for that day.
    expect(rowsFor('metric_observations')).toHaveLength(0);
  });

  it('reports a rejected session', async () => {
    db.errors.cardio_sessions = { message: 'duration_minutes violates not-null' };
    const result = await confirmImport({
      records: [record({
        sessions: [session({ kind: 'CARDIO', cardioType: 'RUNNING', sessionMinutes: 30 })],
      })],
    });
    expect(result.records[0]!.status).toBe('FAILED');
    expect(result.records[0]!.message).toContain('Cardio:');
    expect(db.updated).toHaveLength(0);
  });

  it('does not rebuild a day where nothing was written at all', async () => {
    db.errors.nutrition_logs = { message: 'nope' };
    await confirmImport({ records: [record({ calories: 2000 })] });
    expect(rowsFor('nutrition_logs')).toHaveLength(0);
    expect(rebuildRange).not.toHaveBeenCalled();
  });

  it('refuses a maximum heart rate below the average, before writing', async () => {
    // Migration 0010's CHECK would reject this at the insert. Catching it here
    // is what keeps the review screen from promising a row that cannot land.
    const result = await confirmImport({
      records: [record({
        sessions: [session({ averageHeartRate: 160, maxHeartRate: 120, sessionMinutes: 45 })],
      })],
    });

    expect(result.ok).toBe(false);
    expect(result.errors?.['records.0.sessions.0.maxHeartRate'])
      .toMatch(/below the average/);
    expect(rowsFor('health_imports')).toHaveLength(0);
  });
});

describe('duplicates (spec §38)', () => {
  it('refuses a repeat without touching the rest of the batch', async () => {
    db.errors.health_imports = { message: 'duplicate key', code: '23505' };
    db.existingImport = { id: 'previous', status: 'CONFIRMED' };
    const result = await confirmImport({ records: [record({ steps: 15000 })] });

    expect(result.records[0]!.status).toBe('DUPLICATE');
    // Refusing a repeat is §38 working, not a failure the user must act on.
    expect(result.ok).toBe(true);
    expect(result.message).toBe('1 already imported.');
    expect(rowsFor('metric_observations')).toHaveLength(0);
    expect(rowsFor('system_events')[0]).toMatchObject({
      kind: 'IMPORT_DUPLICATE_REJECTED',
    });
  });

  it('summarises a mixed outcome honestly', async () => {
    const result = await confirmImport({
      records: [
        record({ rawText: 'a', date: '2026-09-01', steps: 1 }),
        record({ rawText: 'b', date: '2026-09-02', steps: 2 }),
      ],
    });
    expect(result.message).toBe('2 days imported.');
  });
});

describe('a rebuild failure does not lose the report of what was written', () => {
  it('reports the day as imported and explains the cache failure', async () => {
    // daily_metrics is a rebuildable cache. Throwing here would reject the whole
    // action after every day had already been written and confirmed, leaving the
    // user with no account of it at all.
    rebuildRange.mockResolvedValueOnce({
      failed: [{ date: '2026-09-01', message: 'upsert failed' }],
    });
    const result = await confirmImport({ records: [record({ steps: 15000 })] });

    expect(result.records[0]!.status).toBe('IMPORTED');
    expect(rowsFor('metric_observations')).toHaveLength(1);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('upsert failed');
    expect(result.message).toMatch(/imported data is safe/);
  });
});

describe('an unverifiable resume refuses rather than risking a double', () => {
  it('fails the record when it cannot check what was already written', async () => {
    // Reading a failed lookup as "nothing written yet" would re-insert a
    // session row and permanently double the day's training minutes.
    db.errors.health_imports = { message: 'duplicate key', code: '23505' };
    db.existingImport = { id: 'unfinished', status: 'PENDING' };
    db.selectErrors.workout_sessions = { message: 'connection reset' };

    const result = await confirmImport({
      records: [record({ steps: 15000, sessions: [session({ sessionMinutes: 55 })] })],
    });

    expect(result.records[0]!.status).toBe('FAILED');
    expect(result.records[0]!.message).toMatch(/Could not check/);
    expect(rowsFor('workout_sessions')).toHaveLength(0);
    expect(rowsFor('metric_observations')).toHaveLength(0);
  });
});

describe('a resumed import still rebuilds its day', () => {
  it('rebuilds even when every remaining write was already in place', async () => {
    // daily_metrics may never have seen the rows the first attempt landed.
    db.errors.health_imports = { message: 'duplicate key', code: '23505' };
    db.existingImport = { id: 'unfinished', status: 'PENDING' };
    db.resumeWrote = { workout_sessions: ['already-there'] };

    const result = await confirmImport({
      records: [record({ sessions: [session({ sessionMinutes: 55 })] })],
    });

    expect(result.records[0]!.status).toBe('IMPORTED');
    expect(result.records[0]!.wrote).toEqual([]);
    expect(rebuildRange).toHaveBeenCalledWith(expect.anything(), USER, ['2026-09-01']);
  });
});

/**
 * The hole this closes: an attempt that inserted the replacement and then
 * failed before superseding the row it replaces left BOTH counting, and the
 * resume said "kept as it was, so the day is not counted twice" - which was
 * the one thing that was not true. 58 + 65 = 123, reached by the single path
 * that skipped migration 0011.
 */
describe('a resumed REPLACE finishes superseding what it replaced', () => {
  function resumingReplace() {
    db.errors.health_imports = { message: 'duplicate key', code: '23505' };
    db.existingImport = { id: 'unfinished', status: 'PENDING' };
    db.resumeWrote = { workout_sessions: ['the-replacement'] };
  }

  const replacing = (supersedes: string) =>
    record({
      sessions: [session({ sessionMinutes: 65, disposition: 'REPLACE', supersedes })],
    });

  const OLD = '44444444-4444-4444-8444-444444444444';
  const OTHER = '55555555-5555-4555-8555-555555555555';

  it('completes the supersession the earlier attempt did not', async () => {
    resumingReplace();
    db.supersessionTargets = { workout_sessions: [{ id: OLD, superseded_at: null }] };

    const result = await confirmImport({ records: [replacing(OLD)] });

    expect(result.records[0]!.status).toBe('IMPORTED');
    // No second insert: that is what would double the day.
    expect(rowsFor('workout_sessions')).toHaveLength(0);
    const supersession = db.updated.find(
      (u) => u.table === 'workout_sessions' && u.values.superseded_by !== undefined,
    );
    expect(supersession).toBeDefined();
    expect(supersession!.values.superseded_by).toBe('the-replacement');
    expect(supersession!.values.superseded_at).toEqual(expect.any(String));
  });

  it('does nothing when the earlier attempt already superseded it', async () => {
    resumingReplace();
    db.supersessionTargets = {
      workout_sessions: [{ id: OLD, superseded_at: '2026-09-01T10:00:00Z' }],
    };

    const result = await confirmImport({ records: [replacing(OLD)] });

    expect(result.records[0]!.status).toBe('IMPORTED');
    expect(
      db.updated.filter((u) => u.table === 'workout_sessions'),
    ).toHaveLength(0);
  });

  it('fails loudly rather than guessing when the pairing is ambiguous', async () => {
    resumingReplace();
    db.resumeWrote = { workout_sessions: ['replacement-a', 'replacement-b'] };
    db.supersessionTargets = {
      workout_sessions: [
        { id: OLD, superseded_at: null },
        { id: OTHER, superseded_at: null },
      ],
    };

    const result = await confirmImport({
      records: [record({
        sessions: [
          session({ sessionMinutes: 65, disposition: 'REPLACE', supersedes: OLD }),
          session({ sessionMinutes: 40, disposition: 'REPLACE', supersedes: OTHER }),
        ],
      })],
    });

    expect(result.ok).toBe(false);
    expect(result.records[0]!.status).toBe('FAILED');
    // The user is told the day is currently wrong, not that it was fine.
    expect(result.records[0]!.message).toMatch(/counted in this day/i);
    expect(
      db.updated.filter((u) => u.values.superseded_by !== undefined),
    ).toHaveLength(0);
  });

  it('reports a failed lookup instead of assuming nothing is outstanding', async () => {
    resumingReplace();
    db.supersessionTargets = { workout_sessions: [{ id: OLD, superseded_at: null }] };
    db.selectErrors.workout_sessions = { message: 'connection reset' };

    const result = await confirmImport({ records: [replacing(OLD)] });

    // The resume check itself reads this table first, so the failure surfaces
    // there. Either way the day is reported as failed, never as kept.
    expect(result.records[0]!.status).toBe('FAILED');
    expect(
      db.updated.filter((u) => u.values.superseded_by !== undefined),
    ).toHaveLength(0);
  });
});

describe('counts are stored as whole numbers', () => {
  it('refuses a fractional heart-rate zone rather than letting Postgres round it', async () => {
    // hr_zone is a smallint: 2.5 would be stored as 3, so the review screen
    // would have shown a zone the database does not hold.
    const result = await confirmImport({
      records: [record({
        sessions: [session({ kind: 'CARDIO', cardioType: 'RUNNING', sessionMinutes: 30, hrZone: 2.5 })],
      })],
    });
    expect(result.ok).toBe(false);
    expect(Object.keys(result.errors ?? {})).toContain('records.0.sessions.0.hrZone');
  });

  it('refuses a fractional step count', async () => {
    const result = await confirmImport({ records: [record({ steps: 15000.5 })] });
    expect(result.ok).toBe(false);
    expect(Object.keys(result.errors ?? {})).toContain('records.0.steps');
  });
});

describe('a day with nothing in it is not an import', () => {
  it('skips it rather than claiming a day was imported', async () => {
    const result = await confirmImport({ records: [record()] });
    expect(result.records[0]!.status).toBe('SKIPPED');
    expect(result.records[0]!.message).toMatch(/Nothing could be read/);
    // A blank day is reported, not treated as a failure: there is nothing for
    // the user to correct, so the review screen has no reason to stay open.
    expect(result.ok).toBe(true);
    expect(result.message).toBe('1 had nothing to import.');
  });

  it('says so when even the text could not be kept', async () => {
    db.errors.health_imports = { message: 'disk full' };
    const result = await confirmImport({ records: [record()] });
    expect(result.records[0]!.message).toContain('disk full');
  });

  it('still keeps the original text, filed as discarded (spec §17)', async () => {
    // A day nothing could be read from is exactly the one worth re-deriving
    // later if the parser turns out to have been wrong.
    await confirmImport({ records: [record({ rawText: 'Date: 2026-09-01\nMood: fine' })] });
    expect(rowsFor('health_imports')).toHaveLength(1);
    expect(rowsFor('health_imports')[0]).toMatchObject({
      raw_text: 'Date: 2026-09-01\nMood: fine',
      status: 'DISCARDED',
      target_local_date: '2026-09-01',
    });
    // But nothing that would read as data.
    expect(rowsFor('metric_observations')).toHaveLength(0);
    expect(rowsFor('nutrition_logs')).toHaveLength(0);
  });

  it('still imports the days either side of it', async () => {
    const result = await confirmImport({
      records: [
        record({ rawText: 'a', date: '2026-09-01', steps: 1 }),
        record({ rawText: 'b', date: '2026-09-02' }),
        record({ rawText: 'c', date: '2026-09-03', steps: 3 }),
      ],
    });
    expect(result.records.map((r) => r.status)).toEqual(['IMPORTED', 'SKIPPED', 'IMPORTED']);
    expect(result.message).toBe('2 days imported, 1 had nothing to import.');
    // Three rows: two imports, and the blank day's text kept as DISCARDED.
    expect(rowsFor('health_imports').map((r) => r.status))
      .toEqual(['PENDING', 'DISCARDED', 'PENDING']);
  });
});

describe('the review screen’s payload is one the action accepts', () => {
  it('accepts a payload built by lib/health/importPayload from a real parse', async () => {
    // Guards the seam between the pure builder the review screen uses and the
    // zod schema here. A shape the builder emits that this rejects would be an
    // import that fails only in production.
    const { parseText } = await import('@/lib/health/parser');
    const { toSessionType, toCardioType } = await import('@/lib/health/sessionTypes');
    const { editsFromPreview, buildConfirmPayload } =
      await import('@/lib/health/importPayload');

    const units = { weight: 'LB', length: 'IN', distance: 'MI' } as const;
    const parsed = parseText([
      'Date: 2026-09-01', 'Weight: 203.7 lb', 'Waist: 35.4 in', 'Calories: 2001',
      'Protein: 172g', 'Steps: 15000', 'Sleep: 7h 30m', 'Resting HR: 58 bpm',
      'Workout: Push', 'Duration: 55 min', 'Avg HR: 128 bpm', 'Max HR: 161 bpm',
      'Cardio: Running', 'Duration: 38 min', 'Distance: 3.1 mi', 'Zone: 3',
    ].join('\n'), 2026);

    const records = parsed.records.map((r) => ({
      fields: r.fields,
      rawText: r.rawText,
      targetDate: r.localDate,
      sessions: r.sessions.map((session) => ({
        kind: session.kind,
        rawLabel: session.rawLabel,
        sessionType: toSessionType(session.rawLabel).value,
        cardioType: toCardioType(session.rawLabel).value,
        fields: session.fields,
      })),
    }));
    const edits = editsFromPreview(records, units, '2026-09-01');
    edits.dates = parsed.records.map((r) => r.localDate!);

    const result = await confirmImport(
      buildConfirmPayload(records, edits, units, '2026-09-01'),
    );

    expect(result.errors).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(rowsFor('workout_sessions')[0]).toMatchObject({
      session_type: 'PUSH', duration_minutes: 55,
      average_heart_rate: 128, max_heart_rate: 161,
    });
    expect(rowsFor('cardio_sessions')[0]).toMatchObject({
      cardio_type: 'RUNNING', duration_minutes: 38, hr_zone: 3,
    });
  });
});

describe('an unfinished import can be retried', () => {
  it('resumes a PENDING row instead of calling the retry a duplicate', async () => {
    // health_imports has no delete policy, so a PENDING row from a failed
    // attempt holds the day's key forever. Reporting the retry as "already
    // imported" would be false and would strand the day permanently.
    db.errors.health_imports = { message: 'duplicate key', code: '23505' };
    db.existingImport = { id: 'unfinished', status: 'PENDING' };

    const result = await confirmImport({ records: [record({ steps: 15000 })] });

    expect(result.records[0]!.status).toBe('IMPORTED');
    expect(rowsFor('metric_observations')[0]).toMatchObject({ import_id: 'unfinished' });
    expect(db.updated[0]!.values).toMatchObject({ status: 'CONFIRMED' });
    expect(rowsFor('system_events').map((e) => e.kind)).not.toContain(
      'IMPORT_DUPLICATE_REJECTED',
    );
  });

  it('does not write a session the first attempt already wrote', async () => {
    // daily_metrics SUMS a day's sessions, so re-inserting a workout row on a
    // retry would permanently double the day's training minutes - and no delete
    // policy exists to undo it.
    db.errors.health_imports = { message: 'duplicate key', code: '23505' };
    db.existingImport = { id: 'unfinished', status: 'PENDING' };
    db.resumeWrote = { workout_sessions: ['already-there'] };

    const result = await confirmImport({
      records: [record({
        steps: 15000,
        sessions: [session({ sessionMinutes: 55 })],
      })],
    });

    expect(result.records[0]!.status).toBe('IMPORTED');
    expect(rowsFor('workout_sessions')).toHaveLength(0);
    expect(rowsFor('metric_observations')).toHaveLength(1);
    // And it says so, rather than reporting a session it did not write.
    expect(result.records[0]!.message).toMatch(/workouts from an earlier attempt/);
  });

  it('does re-insert a corrected scalar, because that is how a correction works', async () => {
    // body_measurements is resolved by recency, not summed. Skipping it would
    // silently drop a value the user fixed on the review screen.
    db.errors.health_imports = { message: 'duplicate key', code: '23505' };
    db.existingImport = { id: 'unfinished', status: 'PENDING' };
    db.resumeWrote = { workout_sessions: ['already-there'] };

    await confirmImport({
      records: [record({
        weightKg: 91.2,
        sessions: [session({ sessionMinutes: 55 })],
      })],
    });

    expect(rowsFor('body_measurements')).toHaveLength(1);
    expect(rowsFor('body_measurements')[0]).toMatchObject({ weight_kg: 91.2 });
  });

  it('still reports a genuine duplicate when the earlier import finished', async () => {
    db.errors.health_imports = { message: 'duplicate key', code: '23505' };
    db.existingImport = { id: 'finished', status: 'CONFIRMED' };
    const result = await confirmImport({ records: [record({ steps: 15000 })] });
    expect(result.records[0]!.status).toBe('DUPLICATE');
    expect(rowsFor('metric_observations')).toHaveLength(0);
  });

  it('rebuilds a day whose writes only partly landed', async () => {
    // daily_metrics is a pure function of the raw layer, and a row written
    // before the failure is permanent. Skipping the rebuild would leave the
    // canonical layer denying data that exists.
    db.errors.nutrition_logs = { message: 'nope' };
    const result = await confirmImport({
      records: [record({ weightKg: 92.4, calories: 2000 })],
    });

    expect(result.records[0]!.status).toBe('FAILED');
    expect(rowsFor('body_measurements')).toHaveLength(1);
    expect(rebuildRange).toHaveBeenCalledWith(expect.anything(), USER, ['2026-09-01']);
  });
});

describe('validation happens before any write', () => {
  it('refuses a cardio session with no duration', async () => {
    const result = await confirmImport({
      records: [record({
        sessions: [session({ kind: 'CARDIO', cardioType: 'RUNNING', sessionMinutes: null })],
      })],
    });

    expect(result.ok).toBe(false);
    expect(result.errors?.['records.0.sessions.0.sessionMinutes'])
      .toMatch(/needs a duration/);
    expect(rowsFor('health_imports')).toHaveLength(0);
  });

  it('refuses a value the database would reject', async () => {
    const result = await confirmImport({ records: [record({ weightKg: 4535 })] });
    expect(result.ok).toBe(false);
    expect(Object.keys(result.errors ?? {})).toContain('records.0.weightKg');
    expect(rowsFor('health_imports')).toHaveLength(0);
  });

  it('refuses an invalid date', async () => {
    const result = await confirmImport({ records: [record({ date: '2026-02-30' })] });
    expect(result.ok).toBe(false);
    expect(rowsFor('health_imports')).toHaveLength(0);
  });

  it('refuses to write when nobody is signed in', async () => {
    db.user = null;
    const result = await confirmImport({ records: [record({ steps: 1 })] });
    expect(result.ok).toBe(false);
    expect(result.message).toBe('Not signed in.');
    expect(rowsFor('health_imports')).toHaveLength(0);
  });
});
