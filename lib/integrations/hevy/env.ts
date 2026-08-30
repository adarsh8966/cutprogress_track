import 'server-only';

/**
 * Hevy credentials (spec §34, §37).
 *
 * Read LAZILY and at request time, never at module scope - the rule
 * lib/supabase/env.ts already sets, and for the same two reasons: `next build`
 * has to succeed on a machine with no credentials, and a missing variable has
 * to surface as a sentence someone can act on rather than a stack trace during
 * static generation.
 *
 * THE KEY IS SERVER-SIDE AND STAYS THERE. `server-only` at the top of this file
 * means a client component that imports it fails the build rather than shipping
 * the key to a browser. It is never prefixed NEXT_PUBLIC_ (anything so prefixed
 * is inlined into the browser bundle by Next), never returned from a server
 * action, never written into a sync_runs row, a system_events detail, or an
 * error message the user reads.
 *
 * WHY AN ENVIRONMENT VARIABLE AND NOT A TABLE. README says this system stores
 * no third-party credentials, and spec §37 forbids storing them for Bevel,
 * whose data has to be scraped. Hevy publishes an official API with a key
 * issued for it, so using it is not scraping - but keeping the key out of the
 * database keeps the promise that matters: nothing in Supabase is a credential
 * for somewhere else, and a database backup carries no key to anyone's account.
 */

export interface HevyEnv {
  apiKey: string;
  baseUrl: string;
}

/**
 * The API host.
 *
 * NOT STATED IN THE SUPPLIED DOCUMENTATION, which gives paths (`/v1/workouts`)
 * and not an origin. This is Hevy's published host and is overridable precisely
 * because it was inferred rather than read: if it is wrong, the connection test
 * on /import says so on the first attempt, and HEVY_API_BASE_URL corrects it
 * without a code change.
 */
export const DEFAULT_HEVY_BASE_URL = 'https://api.hevyapp.com';

export class MissingHevyConfigError extends Error {
  constructor() {
    super(
      'Hevy is not configured. Set HEVY_API_KEY to the key from '
      + 'hevy.com/settings?developer (Hevy Pro is required) in .env.local, and '
      + 'in your deployment’s environment variables. It must NOT be prefixed '
      + 'NEXT_PUBLIC_: anything so prefixed is inlined into the browser bundle.',
    );
    this.name = 'MissingHevyConfigError';
  }
}

export function readHevyEnv(): HevyEnv {
  const apiKey = process.env.HEVY_API_KEY;
  if (!apiKey) throw new MissingHevyConfigError();
  return {
    apiKey,
    baseUrl: process.env.HEVY_API_BASE_URL || DEFAULT_HEVY_BASE_URL,
  };
}

/**
 * Whether a sync could run at all.
 *
 * Used to decide what the Import page says, so that "not connected" and "the
 * sync failed" stay different claims. It reads the variable's presence and
 * never its value, so nothing about the key reaches a caller.
 */
export function isHevyConfigured(): boolean {
  return Boolean(process.env.HEVY_API_KEY);
}
