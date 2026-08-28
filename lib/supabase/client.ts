'use client';

/** Browser Supabase client. Uses the anon key only; RLS does the rest. */
import { createBrowserClient } from '@supabase/ssr';
import { readPublicEnv } from './env';
import type { Database } from './types';

export function createClient() {
  const { url, anonKey } = readPublicEnv();
  return createBrowserClient<Database>(url, anonKey);
}
