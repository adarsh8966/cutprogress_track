import 'server-only';

/**
 * Server-side Supabase clients (spec §34).
 *
 * Session lives in cookies via @supabase/ssr, so Server Components, Route
 * Handlers and Server Actions all act as the signed-in user and every query
 * runs under that user's RLS policies. The anon key is the only key used here.
 */
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { readPublicEnv } from './env';
import type { Database } from './types';

/**
 * For Server Components. Cookie writes are swallowed because a Server Component
 * cannot set them; the middleware refreshes the session instead.
 */
export async function createServerComponentClient() {
  const { url, anonKey } = readPublicEnv();
  const cookieStore = await cookies();

  return createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component, where cookies are read-only.
          // middleware.ts handles session refresh, so this is safe to ignore.
        }
      },
    },
  });
}

/** For Server Actions and Route Handlers, where cookies are writable. */
export async function createActionClient() {
  const { url, anonKey } = readPublicEnv();
  const cookieStore = await cookies();

  return createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value, options } of cookiesToSet) {
          cookieStore.set(name, value, options);
        }
      },
    },
  });
}

/** The signed-in user, or null. Never throws on an absent session. */
export async function getCurrentUser() {
  const supabase = await createServerComponentClient();
  const { data, error } = await supabase.auth.getUser();
  if (error) return null;
  return data.user;
}
