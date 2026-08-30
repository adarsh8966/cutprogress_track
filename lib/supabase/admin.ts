import 'server-only';

/**
 * The service-role client. ONE CALLER, BY DESIGN.
 *
 * lib/supabase/env.ts has named this module as the only home for the
 * service-role key since before it existed. This is that module, with a second
 * rule the scheduled sync adds:
 *
 *   THE ONLY FILE PERMITTED TO IMPORT THIS IS app/api/hevy/sync/route.ts.
 *
 * tests/unit/admin-client-containment.test.ts enumerates the importers and
 * fails the build on a second one. That is not ceremony. This key BYPASSES
 * ROW LEVEL SECURITY - the boundary every other query in this application
 * relies on - so the difference between "a privileged client exists behind one
 * locked door" and "a privileged client is available to anything that imports
 * it" is the difference between a narrow, reviewable risk and a general one.
 * Neither lib/integrations/hevy/sync.ts nor writer.ts constructs a client at
 * all; they take whichever one the caller is entitled to use, which is what
 * lets one sync engine serve both the RLS-backed button and this path.
 *
 * WHY IT IS NEEDED AT ALL. A scheduled request carries no cookie session, so
 * there is no signed-in user for RLS to key on. The alternatives are worse:
 * storing the account password, or holding a refresh token that expires
 * silently. So the route authenticates itself with CRON_SECRET, names the
 * account with CUT_OS_OWNER_USER_ID, and every read and write downstream is
 * filtered by that id explicitly - because RLS is not there to catch a mistake.
 *
 * ALL OF THIS IS OPT-IN. With the variables unset the route answers 503 and
 * changes nothing, and the Sync button on /import works exactly as before
 * without ever touching this file.
 */
import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';

export class MissingAdminConfigError extends Error {
  constructor(missing: string[]) {
    super(
      `Scheduled sync is not configured. Missing: ${missing.join(', ')}. `
      + 'Set SUPABASE_SERVICE_ROLE_KEY (server-side only - NEVER prefixed '
      + 'NEXT_PUBLIC_, it bypasses every row-level-security policy) and '
      + 'CUT_OS_OWNER_USER_ID (the auth.users id the schedule syncs for). '
      + 'The Sync button on /import does not need either.',
    );
    this.name = 'MissingAdminConfigError';
  }
}

/** True when a scheduled run could authenticate itself and act for someone. */
export function isScheduledSyncConfigured(): boolean {
  return Boolean(
    process.env.SUPABASE_SERVICE_ROLE_KEY
    && process.env.CUT_OS_OWNER_USER_ID
    && process.env.NEXT_PUBLIC_SUPABASE_URL,
  );
}

export interface AdminContext {
  supabase: ReturnType<typeof createClient<Database>>;
  /** The account a scheduled run acts for. Every query is filtered by it. */
  userId: string;
}

/**
 * Read lazily at request time, as everything else in this codebase is, so a
 * missing variable is a sentence rather than a stack trace during a build.
 */
export function createAdminContext(): AdminContext {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const userId = process.env.CUT_OS_OWNER_USER_ID;

  const missing: string[] = [];
  if (!url) missing.push('NEXT_PUBLIC_SUPABASE_URL');
  if (!key) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!userId) missing.push('CUT_OS_OWNER_USER_ID');
  if (missing.length > 0) throw new MissingAdminConfigError(missing);

  return {
    supabase: createClient<Database>(url!, key!, {
      // No session to persist and none to refresh: this client is not a user.
      auth: { persistSession: false, autoRefreshToken: false },
    }),
    userId: userId!,
  };
}
