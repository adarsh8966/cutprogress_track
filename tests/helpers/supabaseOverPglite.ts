/**
 * A supabase-js shaped client backed by PGlite.
 *
 * WHY THIS EXISTS. lib/data/canonicalise.ts is the step that turns append-only
 * observations into the row every page reads, and nothing tested it. The unit
 * test mocks the client and only checks error collection; the integration test
 * re-implemented the aggregation as hand-written SQL and asserted against its
 * own copy. So the function that decides whether an imported resting heart rate
 * ever becomes visible had never been run against the real schema.
 *
 * It now serves the Hevy write path as well, for the same reason and with the
 * higher stakes: writeWorkout and runHevySync decide whether re-syncing a
 * workout updates one row or writes a second, and asserting that against a
 * hand-written copy of the query would assert nothing at all. So the REAL
 * functions run here, against real PostgreSQL, with the real migrations and the
 * real RLS policies.
 *
 * DELIBERATELY NOT A GENERAL SUPABASE EMULATOR. It implements the query shapes
 * those functions actually use, and anything else throws loudly rather than
 * quietly returning an empty result - because a silent empty result is
 * precisely the failure mode under test. A shape that is not supported should
 * be added here, visibly, rather than worked around at the call site.
 *
 * NUMERIC STRINGS ARE THE POINT, NOT AN ARTEFACT. PGlite returns `numeric`
 * columns as strings, exactly as PostgREST does in some configurations, so this
 * harness exercises the coercion that lib/normalization/numbers.ts performs.
 */
import type { PGlite } from '@electric-sql/pglite';

type Row = Record<string, unknown>;
interface Result<T> { data: T | null; error: { message: string; code?: string } | null }

/**
 * Runs one statement so that a failure does not poison the transaction.
 *
 * WHY THIS IS NECESSARY, AND WHY IT IS FAITHFUL. withUser() opens a
 * transaction so `set local role` sticks and RLS is genuinely in force. But in
 * PostgreSQL a failed statement aborts the whole transaction: every later
 * statement answers "current transaction is aborted" until it ends. Real
 * Supabase does not behave that way - each PostgREST request is its own
 * statement - and the code under test DEPENDS on that difference. Its
 * idempotency turns on catching a unique violation and carrying on: a repeated
 * sync is SUPPOSED to hit 23505 on health_imports and then continue. Without
 * savepoints, the first expected error breaks everything after it and the test
 * measures the harness rather than the code.
 *
 * So each statement gets a savepoint, released on success and rolled back to on
 * failure. The error still reaches the caller exactly as before; what does not
 * happen is the rest of the transaction being lost with it.
 */
async function statement<T>(
  db: PGlite,
  run: () => Promise<T>,
): Promise<{ data: T; error: null } | { data: null; error: { message: string; code?: string } }> {
  await db.exec('savepoint supabase_shim;');
  try {
    const data = await run();
    await db.exec('release savepoint supabase_shim;');
    return { data, error: null };
  } catch (error) {
    await db.exec('rollback to savepoint supabase_shim;');
    await db.exec('release savepoint supabase_shim;');
    return { data: null, error: toError(error) };
  }
}

/** Quotes an identifier so a table or column name cannot be interpolated raw. */
function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return `"${name}"`;
}

/** A `select('a, b, c')` list, or `*`. Anything cleverer is refused. */
function columnList(columns: string): string {
  const trimmed = columns.trim();
  if (trimmed === '*') return '*';
  if (/[()!:]/.test(trimmed)) {
    throw new Error(
      `supabaseOverPglite does not support embedded selects, got: ${columns}`,
    );
  }
  return trimmed.split(',').map((c) => ident(c.trim())).join(', ');
}

type Filter =
  | { kind: 'eq' | 'neq'; column: string; value: unknown }
  | { kind: 'is'; column: string; value: null }
  | { kind: 'notIs'; column: string; value: null }
  | { kind: 'in'; column: string; values: unknown[] }
  | { kind: 'gte' | 'lte'; column: string; value: unknown };

/** Builds a WHERE clause and its parameters from the filters applied. */
function whereOf(filters: Filter[]): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const clauses = filters.map((filter) => {
    switch (filter.kind) {
      case 'is': return `${ident(filter.column)} is null`;
      case 'notIs': return `${ident(filter.column)} is not null`;
      case 'in': {
        if (filter.values.length === 0) return 'false';
        const placeholders = filter.values.map((value) => {
          params.push(value);
          return `$${params.length}`;
        });
        return `${ident(filter.column)} in (${placeholders.join(', ')})`;
      }
      default: {
        params.push(filter.value);
        const op = filter.kind === 'eq' ? '=' : filter.kind === 'neq' ? '<>'
          : filter.kind === 'gte' ? '>=' : '<=';
        return `${ident(filter.column)} ${op} $${params.length}`;
      }
    }
  });
  return {
    sql: clauses.length > 0 ? ` where ${clauses.join(' and ')}` : '',
    params,
  };
}

/** Shared filter/ordering surface, so every builder accepts the same calls. */
abstract class Filterable<T> implements PromiseLike<Result<T>> {
  protected readonly filters: Filter[] = [];
  protected orderBy: { column: string; ascending: boolean; nullsFirst?: boolean }[] = [];
  protected rowLimit: number | null = null;
  protected mode: 'many' | 'single' | 'maybeSingle' = 'many';

  eq(column: string, value: unknown): this {
    this.filters.push({ kind: 'eq', column, value });
    return this;
  }

  neq(column: string, value: unknown): this {
    this.filters.push({ kind: 'neq', column, value });
    return this;
  }

  is(column: string, value: null): this {
    this.filters.push({ kind: 'is', column, value });
    return this;
  }

  /** Only `not(col, 'is', null)` is used, and only that is supported. */
  not(column: string, operator: string, value: unknown): this {
    if (operator !== 'is' || value !== null) {
      throw new Error(`supabaseOverPglite supports not(col, 'is', null) only`);
    }
    this.filters.push({ kind: 'notIs', column, value: null });
    return this;
  }

  in(column: string, values: unknown[]): this {
    this.filters.push({ kind: 'in', column, values });
    return this;
  }

  gte(column: string, value: unknown): this {
    this.filters.push({ kind: 'gte', column, value });
    return this;
  }

  lte(column: string, value: unknown): this {
    this.filters.push({ kind: 'lte', column, value });
    return this;
  }

  /**
   * Accumulates, as supabase-js does. It used to overwrite, so a query asking
   * for `local_date desc, start_time desc` was silently answered by start_time
   * alone - the harness quietly disagreeing with production about ordering,
   * which is the kind of difference a test exists to catch rather than create.
   */
  order(
    column: string,
    options: { ascending: boolean; nullsFirst?: boolean },
  ): this {
    this.orderBy.push({
      column,
      ascending: options.ascending,
      nullsFirst: options.nullsFirst,
    });
    return this;
  }

  limit(count: number): this {
    this.rowLimit = count;
    return this;
  }

  single(): this {
    this.mode = 'single';
    return this;
  }

  maybeSingle(): this {
    this.mode = 'maybeSingle';
    return this;
  }

  protected suffix(): string {
    const order = this.orderBy.length
      ? ` order by ${this.orderBy
          .map((term) => {
            const direction = term.ascending ? 'asc' : 'desc';
            // Left unstated, Postgres puts nulls last when ascending and first
            // when descending. Only spell it out when the caller did.
            const nulls =
              term.nullsFirst === undefined
                ? ''
                : ` nulls ${term.nullsFirst ? 'first' : 'last'}`;
            return `${ident(term.column)} ${direction}${nulls}`;
          })
          .join(', ')}`
      : '';
    const limit = this.rowLimit === null ? '' : ` limit ${Number(this.rowLimit)}`;
    return `${order}${limit}`;
  }

  /** Applies single/maybeSingle, which change the SHAPE of `data`. */
  protected shape(rows: Row[]): Result<T> {
    if (this.mode === 'many') return { data: rows as unknown as T, error: null };
    if (rows.length === 0) {
      return this.mode === 'maybeSingle'
        ? { data: null, error: null }
        : { data: null, error: { message: 'no rows returned' } };
    }
    return { data: rows[0] as unknown as T, error: null };
  }

  protected abstract run(): Promise<Result<T>>;

  then<A, B = never>(
    onfulfilled?: ((value: Result<T>) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.run().then(onfulfilled, onrejected);
  }
}

class SelectBuilder extends Filterable<Row[] | Row> {
  constructor(
    private readonly db: PGlite,
    private readonly table: string,
    private readonly columns: string,
  ) { super(); }

  protected async run(): Promise<Result<Row[] | Row>> {
    const { sql: where, params } = whereOf(this.filters);
    const sql = `select ${columnList(this.columns)} from ${ident(this.table)}`
      + `${where}${this.suffix()}`;
    const result = await statement(this.db, async () => {
      const { rows } = await this.db.query<Row>(sql, params);
      return rows;
    });
    if (result.error) return { data: null, error: result.error };
    return this.shape(result.data);
  }
}

/**
 * insert / update, optionally with `.select(...)` chained after.
 *
 * supabase-js returns the written rows only when select() is called, and code
 * under test branches on that - writeWorkout needs the new session's id and
 * must not silently get undefined - so the distinction is reproduced.
 */
class WriteBuilder extends Filterable<Row[] | Row | null> {
  private returning: string | null = null;

  constructor(
    private readonly db: PGlite,
    private readonly table: string,
    private readonly kind: 'insert' | 'update',
    private readonly rows: Row[],
  ) { super(); }

  select(columns: string): this {
    this.returning = columns;
    return this;
  }

  private insertSql(): { sql: string; params: unknown[] } {
    const columns = [...new Set(this.rows.flatMap((row) => Object.keys(row)))];
    const params: unknown[] = [];
    const tuples = this.rows.map((row) => {
      const placeholders = columns.map((column) => {
        params.push(normaliseFor(column, row[column] ?? null));
        return `$${params.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    return {
      sql: `insert into ${ident(this.table)} (${columns.map(ident).join(', ')}) `
        + `values ${tuples.join(', ')}`,
      params,
    };
  }

  private updateSql(): { sql: string; params: unknown[] } {
    const row = this.rows[0]!;
    const params: unknown[] = [];
    const assignments = Object.keys(row).map((column) => {
      params.push(normaliseFor(column, row[column]));
      return `${ident(column)} = $${params.length}`;
    });
    const where = whereOf(this.filters);
    // The filters' placeholders continue the same numbering as the SET clause.
    const shifted = where.sql.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + params.length}`);
    return {
      sql: `update ${ident(this.table)} set ${assignments.join(', ')}${shifted}`,
      params: [...params, ...where.params],
    };
  }

  protected async run(): Promise<Result<Row[] | Row | null>> {
    const { sql, params } = this.kind === 'insert' ? this.insertSql() : this.updateSql();
    const returning = this.returning === null
      ? ''
      : ` returning ${columnList(this.returning)}`;
    const result = await statement(this.db, async () => {
      const { rows } = await this.db.query<Row>(`${sql}${returning}`, params);
      return rows;
    });
    if (result.error) return { data: null, error: result.error };
    if (this.returning === null) return { data: null, error: null };
    return this.shape(result.data);
  }
}

class UpsertBuilder implements PromiseLike<Result<null>> {
  constructor(
    private readonly db: PGlite,
    private readonly table: string,
    private readonly row: Row,
    private readonly onConflict: string,
  ) {}

  private async run(): Promise<Result<null>> {
    const columns = Object.keys(this.row);
    const conflict = this.onConflict.split(',').map((c) => c.trim());
    // Every column except the conflict key is overwritten, which is what upsert
    // means and what makes a rebuild idempotent: re-resolving a day must be
    // able to REPLACE a stale value, including replacing it with null.
    const updates = columns
      .filter((c) => !conflict.includes(c))
      .map((c) => `${ident(c)} = excluded.${ident(c)}`)
      .join(', ');

    const sql =
      `insert into ${ident(this.table)} (${columns.map(ident).join(', ')}) ` +
      `values (${columns.map((_, i) => `$${i + 1}`).join(', ')}) ` +
      `on conflict (${conflict.map(ident).join(', ')}) do update set ${updates}`;

    const result = await statement(this.db, () =>
      this.db.query(sql, columns.map((c) => normaliseFor(c, this.row[c]))));
    return result.error ? { data: null, error: result.error } : { data: null, error: null };
  }

  then<A, B = never>(
    onfulfilled?: ((value: Result<null>) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.run().then(onfulfilled, onrejected);
  }
}

/**
 * The jsonb columns in supabase/migrations, by name.
 *
 * An ARRAY has to be handed to Postgres differently depending on the column it
 * is going into - `["a"]` for jsonb, `{"a"}` for text[] - and a parameter
 * carries no type with it. supabase-js does not face this: it posts JSON and
 * PostgREST consults the schema. Here the schema has to be stated, so it is,
 * explicitly and in one place. A column missing from this list fails loudly on
 * the first write rather than storing something subtly wrong.
 */
const JSONB_COLUMNS = new Set([
  'confirmed', 'data_quality_components', 'detail', 'evidence', 'metrics',
  'nutrition_components', 'parameters', 'parsed', 'provenance', 'warnings',
]);

/** A Postgres array literal: {"a","b"}. Quoted so a comma cannot split a value. */
function arrayLiteral(values: unknown[]): string {
  const escaped = values.map((value) => {
    if (value === null) return 'NULL';
    return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  });
  return `{${escaped.join(',')}}`;
}

/** A value as this column wants to receive it. */
function normaliseFor(column: string, value: unknown): unknown {
  if (Array.isArray(value)) {
    return JSONB_COLUMNS.has(column) ? JSON.stringify(value) : arrayLiteral(value);
  }
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    return JSON.stringify(value);
  }
  return value;
}

/**
 * A PostgreSQL error as supabase-js reports one.
 *
 * `code` matters: the write path branches on 23505 (unique_violation) to tell
 * "this exact version is already stored" from a real failure, and a harness
 * that dropped the code would make that branch untestable.
 */
function toError(error: unknown): { message: string; code?: string } {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string })?.code;
  // PGlite surfaces the SQLSTATE on the error; when it does not, recover the
  // one branch that depends on it from the message.
  if (code) return { message, code };
  if (/duplicate key value violates unique constraint/i.test(message)) {
    return { message, code: '23505' };
  }
  return { message };
}

/**
 * Returns a client accepted by rebuildDailyMetrics and by the Hevy write path.
 * Run it inside withUser() so the `authenticated` role and auth.uid() are bound
 * and RLS is actually in force - the same policies the deployed app runs under.
 */
export function supabaseOverPglite(db: PGlite) {
  return {
    from(table: string) {
      return {
        select(columns: string) {
          return new SelectBuilder(db, table, columns);
        },
        insert(rows: Row | Row[]) {
          return new WriteBuilder(db, table, 'insert', Array.isArray(rows) ? rows : [rows]);
        },
        update(row: Row) {
          return new WriteBuilder(db, table, 'update', [row]);
        },
        upsert(row: Row, options: { onConflict: string }) {
          return new UpsertBuilder(db, table, row, options.onConflict);
        },
      };
    },
  };
}
