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
 * This closes that gap by giving rebuildDailyMetrics a client it accepts, over
 * real PostgreSQL with the real migrations and the real RLS policies. It
 * implements only the two shapes that function uses:
 *
 *   from(t).select('*').eq(col, value)
 *   from(t).upsert(row, { onConflict })
 *
 * Deliberately not a general Supabase emulator. Anything it does not support
 * throws loudly rather than quietly returning an empty result, because a silent
 * empty result is precisely the failure mode under test.
 *
 * NUMERIC STRINGS ARE THE POINT, NOT AN ARTEFACT. PGlite returns `numeric`
 * columns as strings, exactly as PostgREST does in some configurations, so this
 * harness exercises the coercion that lib/normalization/numbers.ts performs.
 */
import type { PGlite } from '@electric-sql/pglite';

type Row = Record<string, unknown>;
interface Result<T> { data: T | null; error: { message: string } | null }

/** Quotes an identifier so a table or column name cannot be interpolated raw. */
function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return `"${name}"`;
}

class SelectBuilder implements PromiseLike<Result<Row[]>> {
  private readonly filters: { column: string; value: unknown }[] = [];

  constructor(private readonly db: PGlite, private readonly table: string) {}

  eq(column: string, value: unknown): this {
    this.filters.push({ column, value });
    return this;
  }

  private async run(): Promise<Result<Row[]>> {
    const where = this.filters
      .map(({ column }, i) => `${ident(column)} = $${i + 1}`)
      .join(' and ');
    const sql =
      `select * from ${ident(this.table)}${where ? ` where ${where}` : ''}`;
    try {
      const { rows } = await this.db.query<Row>(
        sql,
        this.filters.map((f) => f.value),
      );
      return { data: rows, error: null };
    } catch (error) {
      return { data: null, error: { message: message(error) } };
    }
  }

  then<A, B = never>(
    onfulfilled?: ((value: Result<Row[]>) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.run().then(onfulfilled, onrejected);
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

    try {
      await this.db.query(sql, columns.map((c) => normalise(this.row[c])));
      return { data: null, error: null };
    } catch (error) {
      return { data: null, error: { message: message(error) } };
    }
  }

  then<A, B = never>(
    onfulfilled?: ((value: Result<null>) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.run().then(onfulfilled, onrejected);
  }
}

/** jsonb columns arrive as objects and have to be handed over as JSON text. */
function normalise(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    return JSON.stringify(value);
  }
  return value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Returns a client accepted by rebuildDailyMetrics. Run it inside withUser() so
 * the `authenticated` role and auth.uid() are bound and RLS is actually in
 * force - the same policies the deployed app runs under.
 */
export function supabaseOverPglite(db: PGlite) {
  return {
    from(table: string) {
      return {
        select(columns: string) {
          if (columns !== '*') {
            throw new Error(`supabaseOverPglite supports select('*') only, got ${columns}`);
          }
          return new SelectBuilder(db, table);
        },
        upsert(row: Row, options: { onConflict: string }) {
          return new UpsertBuilder(db, table, row, options.onConflict);
        },
      };
    },
  };
}
