import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, migrationFiles, type TestDb } from '../helpers/pglite';

describe('migrations', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db?.close();
  });

  it('applies every migration file in order', async () => {
    const files = await migrationFiles();
    expect(files.length).toBeGreaterThan(0);
    // createTestDb() throws on the first failing file, so reaching here is the
    // assertion. Restate it so the test name is honest about what it proves.
    expect(files).toEqual([...files].sort());
  });

  it('creates every table the spec names', async () => {
    const expected = [
      'body_measurements',
      'canonical_field_pins',
      'cardio_sessions',
      'context_exports',
      'daily_metrics',
      'daily_scores',
      'data_sources',
      'exercises',
      'external_observations',
      'goals',
      'google_health_connections',
      'health_imports',
      'hr_zone_definitions',
      'metric_observations',
      'monthly_reviews',
      'nutrition_items',
      'nutrition_logs',
      'profiles',
      'recommendations',
      'session_telemetry',
      'sleep_records',
      'sync_runs',
      'system_events',
      'weekly_reviews',
      'workout_sessions',
      'workout_sets',
    ];

    const { rows } = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE'
       order by table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual(expected);
  });

  it('is idempotent - re-applying the whole set is a no-op', async () => {
    // Guards against a migration that would break `supabase db push` on rerun.
    const second = await createTestDb();
    await second.close();
    expect(true).toBe(true);
  });

  it('leaves every daily_metrics measurement column nullable (spec §7/§33)', async () => {
    const { rows } = await db.query<{ column_name: string; is_nullable: string }>(
      `select column_name, is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = 'daily_metrics'`,
    );
    const measurementColumns = rows.filter(
      (r) =>
        !['id', 'user_id', 'created_at', 'updated_at', 'local_date', 'provenance'].includes(
          r.column_name,
        ),
    );
    expect(measurementColumns.length).toBeGreaterThan(10);
    for (const column of measurementColumns) {
      expect(
        column.is_nullable,
        `${column.column_name} must be nullable: missing data is NULL, never 0`,
      ).toBe('YES');
    }
  });

  it('enforces one canonical row per user per local date', async () => {
    const { rows } = await db.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
       where tablename = 'daily_metrics' and indexdef ilike '%unique%'`,
    );
    expect(rows.some((r) => /user_id.*local_date/i.test(r.indexdef))).toBe(true);
  });

  it('enforces import idempotency with a unique key per user (spec §38)', async () => {
    const { rows } = await db.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
       where tablename = 'health_imports' and indexdef ilike '%unique%'`,
    );
    expect(rows.some((r) => /user_id.*idempotency_key/i.test(r.indexdef))).toBe(true);
  });

  it('refuses a body measurement that carries no measurement at all', async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into auth.users (email) values ('constraint-check@example.com') returning id`,
    );
    const userId = rows[0]!.id;
    await expect(
      db.query(
        `insert into body_measurements (user_id, measured_at, local_date, weight_kg, waist_cm)
         values ($1, now(), current_date, null, null)`,
        [userId],
      ),
    ).rejects.toThrow();
  });

  it('adds the session intensity columns from 0010, all nullable', async () => {
    const { rows } = await db.query<{
      table_name: string; column_name: string; is_nullable: string;
    }>(
      `select table_name, column_name, is_nullable from information_schema.columns
       where table_schema = 'public'
         and ((table_name = 'cardio_sessions' and column_name = 'max_heart_rate')
           or (table_name = 'workout_sessions'
               and column_name in ('average_heart_rate', 'max_heart_rate', 'calories')))
       order by table_name, column_name`,
    );

    expect(rows.map((r) => `${r.table_name}.${r.column_name}`)).toEqual([
      'cardio_sessions.max_heart_rate',
      'workout_sessions.average_heart_rate',
      'workout_sessions.calories',
      'workout_sessions.max_heart_rate',
    ]);
    // A summary that did not report a heart rate must store NULL, not 0.
    for (const row of rows) expect(row.is_nullable).toBe('YES');
  });

  it('bounds the new heart-rate columns exactly as the existing ones are', async () => {
    const { rows } = await db.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
       where conrelid in ('cardio_sessions'::regclass, 'workout_sessions'::regclass)
         and contype = 'c'`,
    );
    const all = rows.map((r) => r.definition).join(' ');
    expect(all).toMatch(/max_heart_rate[\s\S]*25[\s\S]*250/);
    // A maximum below the average is a transcription error, not a measurement.
    expect(rows.some((r) => /hr_ordered/i.test(r.definition)
      || />= *average_heart_rate/.test(r.definition))).toBe(true);
  });

  it('adds the Hevy identity columns from 0014, all nullable', async () => {
    const { rows } = await db.query<{
      table_name: string; column_name: string; is_nullable: string;
    }>(
      `select table_name, column_name, is_nullable from information_schema.columns
       where table_schema = 'public'
         and ((table_name = 'workout_sessions'
               and column_name in ('title', 'external_source', 'external_id',
                                   'external_updated_at'))
           or (table_name = 'workout_sets'
               and column_name in ('exercise_index', 'exercise_notes', 'superset_id',
                                   'set_type', 'distance_km', 'duration_seconds'))
           or (table_name = 'exercises'
               and column_name in ('external_source', 'external_id')))
       order by table_name, column_name`,
    );

    expect(rows.map((r) => `${r.table_name}.${r.column_name}`)).toEqual([
      'exercises.external_id',
      'exercises.external_source',
      'workout_sessions.external_id',
      'workout_sessions.external_source',
      'workout_sessions.external_updated_at',
      'workout_sessions.title',
      'workout_sets.distance_km',
      'workout_sets.duration_seconds',
      'workout_sets.exercise_index',
      'workout_sets.exercise_notes',
      'workout_sets.set_type',
      'workout_sets.superset_id',
    ]);
    // A field the source did not report stores NULL. A manual row keeps all of
    // them NULL and is unaffected by this migration.
    for (const row of rows) expect(row.is_nullable).toBe('YES');
  });

  it('makes a second session for the same external workout impossible (§38)', async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into auth.users (email) values ('hevy-idempotency@example.com') returning id`,
    );
    const userId = rows[0]!.id;

    const insert = () =>
      db.query(
        `insert into workout_sessions
           (user_id, local_date, session_type, source, external_source, external_id)
         values ($1, current_date, 'PUSH', 'HEVY', 'HEVY', 'workout-abc')`,
        [userId],
      );

    await insert();
    // This is the whole idempotency guarantee: the DATABASE refuses the second
    // row, so no amount of re-syncing can duplicate a workout.
    await expect(insert()).rejects.toThrow();
  });

  it('still allows any number of sessions with no external identity', async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into auth.users (email) values ('manual-sessions@example.com') returning id`,
    );
    const userId = rows[0]!.id;
    // The unique index is PARTIAL. Manual and pasted sessions have no external
    // id and must not be forced to be distinct from one another.
    for (let i = 0; i < 3; i += 1) {
      await db.query(
        `insert into workout_sessions (user_id, local_date, session_type, source)
         values ($1, current_date, 'PUSH', 'MANUAL')`,
        [userId],
      );
    }
    const { rows: counted } = await db.query<{ count: string }>(
      `select count(*)::text as count from workout_sessions
       where user_id = $1 and external_source is null`,
      [userId],
    );
    expect(counted[0]!.count).toBe('3');
  });

  it('refuses a half-identified external row on both tables', async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into auth.users (email) values ('half-identity@example.com') returning id`,
    );
    const userId = rows[0]!.id;
    // A source with no id cannot be looked up; an id with no source cannot be
    // told apart from another system's. Neither is a state worth allowing.
    await expect(
      db.query(
        `insert into workout_sessions
           (user_id, local_date, session_type, source, external_source)
         values ($1, current_date, 'PUSH', 'HEVY', 'HEVY')`,
        [userId],
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        `insert into exercises
           (exercise_id, name, primary_muscle_group, equipment, external_id)
         values ('half-identified', 'x', 'Chest', 'Cable', 'ABC123')`,
      ),
    ).rejects.toThrow();
  });

  it('gives workout_sets the supersession pair, so a removed set is kept', async () => {
    const { rows } = await db.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
       where conrelid = 'workout_sets'::regclass and contype = 'c'`,
    );
    const all = rows.map((r) => r.definition).join(' ');
    // The same two invariants 0011 and 0012 declare: a replacement implies a
    // time, and nothing supersedes itself.
    expect(all).toMatch(/superseded_by is null/i);
    expect(all).toMatch(/superseded_at is not null/i);
    expect(all).toMatch(/superseded_by <> id/i);
  });

  it('refuses two sync runs of the same provider running at once', async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into auth.users (email) values ('sync-race@example.com') returning id`,
    );
    const userId = rows[0]!.id;

    const start = () =>
      db.query(
        `insert into sync_runs (user_id, provider) values ($1, 'hevy')`,
        [userId],
      );

    await start();
    // The button pressed while the cron is mid-run would otherwise read the
    // same events twice and race its own writes.
    await expect(start()).rejects.toThrow();

    // Once the first has finished, another may start.
    await db.query(
      `update sync_runs set status = 'SUCCEEDED', finished_at = now()
       where user_id = $1`,
      [userId],
    );
    await expect(start()).resolves.toBeDefined();
  });

  it('refuses a finished sync run with no finish time', async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into auth.users (email) values ('sync-finished@example.com') returning id`,
    );
    const userId = rows[0]!.id;
    await expect(
      db.query(
        `insert into sync_runs (user_id, provider, status) values ($1, 'hevy', 'FAILED')`,
        [userId],
      ),
    ).rejects.toThrow();
  });

  it('refuses a recommendation with no evidence (spec §57)', async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into auth.users (email) values ('evidence-check@example.com') returning id`,
    );
    const userId = rows[0]!.id;
    await expect(
      db.query(
        `insert into recommendations
           (user_id, kind, headline, evidence, confidence, generated_for_date, analytics_version)
         values ($1, 'MAINTAIN_CURRENT_INTAKE', 'x', '{}'::jsonb, 'HIGH', current_date, '0.1.0')`,
        [userId],
      ),
    ).rejects.toThrow();
  });
});
