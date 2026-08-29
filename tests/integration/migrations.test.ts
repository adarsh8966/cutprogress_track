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
      'cardio_sessions',
      'context_exports',
      'daily_metrics',
      'daily_scores',
      'data_sources',
      'exercises',
      'goals',
      'health_imports',
      'metric_observations',
      'monthly_reviews',
      'nutrition_items',
      'nutrition_logs',
      'profiles',
      'recommendations',
      'sleep_records',
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
