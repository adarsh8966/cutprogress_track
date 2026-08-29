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
          if (!error) {
            const rows = Array.isArray(payload) ? payload : [payload];
            (db.inserted[table] ??= []).push(...rows);
          }
          const result = {
            data: error ? null : { id: `id-${(db.nextId += 1)}` },
            error,
          };
          return {
            select: () => ({ single: async () => result }),
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
        select() {
          const filtered = {
            eq: () => filtered,
            maybeSingle: async () => ({ data: db.existingImport, error: null }),
            /** Rows a previous, unfinished attempt already wrote to this table. */
            limit: async () => ({
              data: (db.resumeWrote[table] ?? []).map((id) => ({ id })),
              error: db.selectErrors[table] ?? null,
            }),
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
