/**
 * Supabase environment access (spec §34).
 *
 * Read lazily and at request time, never at module scope, so that `next build`
 * succeeds on a machine with no credentials and a missing variable surfaces as
 * a clear message rather than a stack trace during static generation.
 *
 * THE SERVICE ROLE KEY IS NEVER READ HERE. It is confined to
 * lib/supabase/admin.ts, which is server-only, and it must never appear in a
 * NEXT_PUBLIC_ variable - anything so prefixed is inlined into the browser
 * bundle by Next.
 */

export interface PublicSupabaseEnv {
  url: string;
  anonKey: string;
}

export class MissingSupabaseConfigError extends Error {
  constructor(missing: string[]) {
    super(
      `Supabase is not configured. Missing: ${missing.join(', ')}. ` +
        'Copy .env.example to .env.local and fill in the values from your ' +
        'Supabase project settings (API section).',
    );
    this.name = 'MissingSupabaseConfigError';
  }
}

export function readPublicEnv(): PublicSupabaseEnv {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  const missing: string[] = [];
  if (!url) missing.push('NEXT_PUBLIC_SUPABASE_URL');
  if (!anonKey) missing.push('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  if (missing.length > 0) throw new MissingSupabaseConfigError(missing);

  return { url: url!, anonKey: anonKey! };
}

/** True when the app has enough configuration to talk to Supabase at all. */
export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}
