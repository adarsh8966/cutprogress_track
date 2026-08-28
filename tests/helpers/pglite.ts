/**
 * PGlite test harness.
 *
 * PGlite is real PostgreSQL compiled to WASM, running in-process. It lets the
 * migration set be applied and exercised for real - schema, constraints and RLS
 * policy logic - without Docker or a hosted Supabase project.
 *
 * IMPORTANT SCOPE NOTE: this reproduces the parts of the Supabase environment
 * the migrations depend on (the `auth` schema, `auth.uid()`, and the
 * `authenticated`/`anon` roles). It verifies that the SQL is valid and that the
 * policies behave as written. It is NOT proof that the hosted Supabase
 * integration works - that requires a real project and is verified by the user.
 */
import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../supabase/migrations', import.meta.url),
);

/**
 * Recreates the pieces of Supabase's managed `auth` schema that the migrations
 * reference. Mirrors Supabase's own definition of auth.uid().
 */
const SUPABASE_AUTH_SHIM = `
  create schema if not exists auth;

  create table if not exists auth.users (
    id uuid primary key default gen_random_uuid(),
    email text unique
  );

  create or replace function auth.uid() returns uuid
    language sql stable
  as $fn$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid
  $fn$;

  do $r$ begin
    create role anon nologin noinherit;
  exception when duplicate_object then null; end $r$;

  do $r$ begin
    create role authenticated nologin noinherit;
  exception when duplicate_object then null; end $r$;

  grant usage on schema auth to authenticated, anon;
  grant execute on function auth.uid() to authenticated, anon;
`;

export type TestDb = PGlite;

/** Reads the migration files in lexical (i.e. execution) order. */
export async function migrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries.filter((f) => f.endsWith('.sql')).sort();
}

/**
 * Boots an in-memory Postgres with the auth shim and every migration applied,
 * in order. Throws with the offending filename if any migration fails.
 */
export async function createTestDb(): Promise<TestDb> {
  const db = new PGlite();
  await db.exec(SUPABASE_AUTH_SHIM);

  for (const file of await migrationFiles()) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    try {
      await db.exec(sql);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Migration ${file} failed: ${message}`);
    }
  }

  return db;
}

/** Inserts a user into the shimmed auth.users and returns its id. */
export async function createUser(db: TestDb, email: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    'insert into auth.users (email) values ($1) returning id',
    [email],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`failed to create user ${email}`);
  return row.id;
}

/**
 * Runs `fn` as the `authenticated` role with auth.uid() resolving to `userId`,
 * which is what actually puts the RLS policies in force. PGlite's default role
 * is a superuser and would bypass them entirely.
 */
export async function asUser<T>(
  db: TestDb,
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await db.exec(`set local role authenticated;`);
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: userId, role: 'authenticated' }),
  ]);
  try {
    return await fn();
  } finally {
    await db.exec('reset role;');
  }
}

/**
 * Same as asUser but inside an explicit transaction, so `set local` sticks for
 * the whole block. Use this for multi-statement RLS assertions.
 */
export async function withUser<T>(
  db: TestDb,
  userId: string,
  fn: (tx: TestDb) => Promise<T>,
): Promise<T> {
  await db.exec('begin;');
  try {
    await db.exec('set local role authenticated;');
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ]);
    const result = await fn(db);
    await db.exec('commit;');
    return result;
  } catch (error) {
    await db.exec('rollback;');
    throw error;
  }
}
