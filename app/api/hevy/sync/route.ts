/**
 * The scheduled Hevy sync.
 *
 * THE ONLY FILE THAT MAY IMPORT lib/supabase/admin.ts. That client bypasses
 * row-level security, so it lives behind this one door and a test fails the
 * build if a second file opens it. Everything downstream - runHevySync, the
 * writer - takes whichever client it is handed and filters by an explicit
 * user id, because RLS is not there to catch a mistake on this path.
 *
 * THREE GATES, IN ORDER, AND ALL OF THEM FAIL CLOSED:
 *
 *   1. CRON_SECRET must match, compared in constant time. Vercel sends it as
 *      `Authorization: Bearer $CRON_SECRET` when the variable is set. A
 *      mismatch is 401 and nothing else happens.
 *   2. The service-role key and owner id must both be present, or this is 503.
 *      Not an error to fix - a feature that was never turned on. The Sync
 *      button works without either.
 *   3. Hevy must be configured, or 503 again, for the same reason.
 *
 * The response body is the same summary the button gets, so a scheduled run is
 * debuggable from the platform's own logs, and the run itself is recorded in
 * sync_runs either way.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { createAdminContext, isScheduledSyncConfigured } from '@/lib/supabase/admin';
import { createHevyClient } from '@/lib/integrations/hevy/client';
import { readHevyEnv, isHevyConfigured } from '@/lib/integrations/hevy/env';
import { runHevySync } from '@/lib/integrations/hevy/sync';

export const dynamic = 'force-dynamic';

/**
 * Constant-time comparison, so a wrong secret cannot be discovered a character
 * at a time by measuring how long the answer took.
 */
function secretMatches(provided: string | null, expected: string): boolean {
  if (provided === null) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length, so the lengths are compared first and the buffers only when equal.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json(
      {
        ok: false,
        message:
          'Scheduled sync is not enabled. Set CRON_SECRET to turn it on; the '
          + 'Sync button on /import does not need it.',
      },
      { status: 503 },
    );
  }

  const header = request.headers.get('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  if (!secretMatches(token, expected)) {
    // Deliberately says nothing about why.
    return NextResponse.json({ ok: false, message: 'Unauthorised.' }, { status: 401 });
  }

  if (!isScheduledSyncConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        message:
          'Scheduled sync needs SUPABASE_SERVICE_ROLE_KEY and CUT_OS_OWNER_USER_ID. '
          + 'Nothing was changed.',
      },
      { status: 503 },
    );
  }

  if (!isHevyConfigured()) {
    return NextResponse.json(
      { ok: false, message: 'HEVY_API_KEY is not set. Nothing was changed.' },
      { status: 503 },
    );
  }

  const { supabase, userId } = createAdminContext();
  const { apiKey, baseUrl } = readHevyEnv();

  const result = await runHevySync(supabase, userId, {
    api: createHevyClient({ apiKey, baseUrl }),
    trigger: 'SCHEDULED',
  });

  // 200 even for a partial or failed run: the REQUEST was handled, and the run
  // recorded its own outcome in sync_runs. A 500 here would tell the scheduler
  // to retry a sync that already knows what went wrong and would only repeat
  // it - and would hide the summary that says what did land.
  return NextResponse.json(result, { status: 200 });
}
