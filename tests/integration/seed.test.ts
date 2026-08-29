/**
 * Verifies the generated seed migration against real PostgreSQL, and that it
 * stays in step with data/exercises/catalog.json.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/pglite';
import { loadCatalog } from '@/lib/health/catalog';

describe('exercise seed (spec §10)', () => {
  let db: TestDb;
  const catalog = loadCatalog();

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db?.close();
  });

  it('loads every catalog entry into the database', async () => {
    const { rows } = await db.query<{ count: string }>(
      'select count(*)::text as count from exercises',
    );
    expect(Number(rows[0]!.count)).toBe(catalog.length);
  });

  it('preserves ids, muscle groups and equipment exactly', async () => {
    const { rows } = await db.query<{
      exercise_id: string;
      name: string;
      primary_muscle_group: string;
      equipment: string;
      muscle_subgroups: string[];
      nippard_tier: string | null;
      apartment_gym: boolean;
    }>('select * from exercises order by exercise_id');

    expect(rows.length).toBe(catalog.length);
    const sorted = [...catalog].sort((a, b) => a.exerciseId.localeCompare(b.exerciseId));
    rows.forEach((row, i) => {
      const entry = sorted[i]!;
      expect(row.exercise_id).toBe(entry.exerciseId);
      expect(row.name).toBe(entry.name);
      expect(row.primary_muscle_group).toBe(entry.primaryMuscleGroup);
      expect(row.equipment).toBe(entry.equipment);
      expect(row.muscle_subgroups).toEqual(entry.muscleSubgroups);
      expect(row.nippard_tier).toBeNull();
      expect(row.apartment_gym).toBe(entry.apartmentGym);
    });
  });

  it('is safe to re-run - re-seeding updates rather than duplicating', async () => {
    const seed = await import('node:fs/promises').then((fs) =>
      fs.readFile(
        new URL('../../supabase/migrations/0009_seed_exercises.sql', import.meta.url),
        'utf8',
      ),
    );
    await db.exec(seed);
    const { rows } = await db.query<{ count: string }>(
      'select count(*)::text as count from exercises',
    );
    expect(Number(rows[0]!.count)).toBe(catalog.length);
  });

  it('keeps historical workout references intact across a re-seed', async () => {
    // The point of a stable slug id: importing an updated catalog must never
    // orphan a logged set (spec §48).
    const { rows: users } = await db.query<{ id: string }>(
      `insert into auth.users (email) values ('reseed@example.com') returning id`,
    );
    const userId = users[0]!.id;
    const { rows: sessions } = await db.query<{ id: string }>(
      `insert into workout_sessions (user_id, local_date, session_type)
       values ($1, '2026-08-28', 'PULL') returning id`,
      [userId],
    );
    await db.query(
      `insert into workout_sets (user_id, session_id, exercise_id, set_number, weight_kg, reps)
       values ($1, $2, 'cable-row', 1, 31.75, 12)`,
      [userId, sessions[0]!.id],
    );

    const seed = await import('node:fs/promises').then((fs) =>
      fs.readFile(
        new URL('../../supabase/migrations/0009_seed_exercises.sql', import.meta.url),
        'utf8',
      ),
    );
    await db.exec(seed);

    const { rows } = await db.query(
      `select ws.reps, e.name from workout_sets ws
       join exercises e on e.exercise_id = ws.exercise_id
       where ws.user_id = $1`,
      [userId],
    );
    expect(rows).toHaveLength(1);
  });
});
