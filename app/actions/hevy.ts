'use server';

/**
 * The Hevy integration's actions (spec §34, §38, §41).
 *
 * TWO, AND ONLY TWO. `testHevyConnection` asks Hevy who the key belongs to and
 * writes nothing - "is this configured?" and "did the last sync work?" are
 * different questions and the Import page must be able to answer them
 * separately. `syncHevy` runs the import.
 *
 * THE ORDINARY AUTHENTICATED CLIENT, DELIBERATELY. This runs as the signed-in
 * user through createActionClient(), so every read and write goes through that
 * user's own RLS policies - the same boundary every other action in this app
 * relies on. It does not import lib/supabase/admin.ts and must not: the
 * service-role key belongs to the scheduled path alone, behind one door, and a
 * test enforces that.
 *
 * The Hevy key is read here and never leaves: what comes back to the browser is
 * a SyncSummary of counts, timestamps and warnings.
 */
import { revalidatePath } from 'next/cache';
import { createActionClient } from '@/lib/supabase/server';
import { createHevyClient, HevyError } from '@/lib/integrations/hevy/client';
import {
  readHevyEnv, isHevyConfigured, MissingHevyConfigError,
} from '@/lib/integrations/hevy/env';
import { runHevySync, type SyncSummary } from '@/lib/integrations/hevy/sync';

export interface ConnectionResult {
  ok: boolean;
  /** Null when the key is not configured or the check failed. */
  name: string | null;
  workoutCount: number | null;
  message: string;
}

export async function testHevyConnection(): Promise<ConnectionResult> {
  if (!isHevyConfigured()) {
    return {
      ok: false,
      name: null,
      workoutCount: null,
      message: new MissingHevyConfigError().message,
    };
  }

  try {
    const { apiKey, baseUrl } = readHevyEnv();
    const api = createHevyClient({ apiKey, baseUrl });
    const [user, workoutCount] = await Promise.all([
      api.getUserInfo(),
      // Not required, and a useful sanity line against a first backfill: "Hevy
      // says 312 workouts" is how you notice an import that stopped at 40.
      api.getWorkoutCount().catch(() => null),
    ]);
    return {
      ok: true,
      name: user.name ?? user.id,
      workoutCount,
      message: 'Connected to Hevy.',
    };
  } catch (error) {
    return {
      ok: false,
      name: null,
      workoutCount: null,
      // userMessage never carries the key.
      message: error instanceof HevyError
        ? error.userMessage
        : `Could not reach Hevy: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Imports everything that has changed in Hevy since the last clean sync.
 *
 * Returns a summary rather than throwing, because a partial result is a real
 * outcome worth showing: three workouts imported and one that could not be
 * saved is not the same as a failure, and the user needs to see both halves.
 */
export async function syncHevy(): Promise<SyncSummary> {
  const empty = {
    ok: false as const,
    status: 'FAILED' as const,
    runId: null,
    eventsFound: 0,
    workoutsCreated: 0,
    workoutsUpdated: 0,
    workoutsUnchanged: 0,
    workoutsDeleted: 0,
    exercisesCreated: 0,
    exercisesMatched: 0,
    recordsFailed: 0,
    warnings: [] as string[],
    setTypes: [] as string[],
    cursorBefore: null,
    cursorAfter: null,
  };

  if (!isHevyConfigured()) {
    return { ...empty, message: new MissingHevyConfigError().message };
  }

  const supabase = await createActionClient();
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError || !auth.user) return { ...empty, message: 'Not signed in.' };

  const { apiKey, baseUrl } = readHevyEnv();
  const api = createHevyClient({ apiKey, baseUrl });

  const result = await runHevySync(supabase, auth.user.id, {
    api,
    trigger: 'MANUAL',
  });

  // Training reaches the Dashboard, the Training page, the day view and the
  // Context Pack through daily_metrics, which the sync has already rebuilt.
  // Without this the write is real and the screen still shows the old day -
  // stored, confirmed and invisible, which is the failure this app exists to
  // prevent.
  for (const path of ['/import', '/training', '/dashboard', '/progress', '/context']) {
    revalidatePath(path);
  }

  return result;
}
