'use server';

/**
 * Canonical layer maintenance (spec §16, §17, §41).
 *
 * daily_metrics is a CACHE: a pure function of the append-only raw layer,
 * recomputed by rebuildDailyMetrics after every write. That design has a
 * consequence worth naming - if a rebuild is ever missed, the observation is
 * still safe on disk but invisible to every page that reads the canonical
 * layer, and the importer will not rebuild it again because a repeated paste is
 * refused as a duplicate (§38). There has been no way back from that.
 *
 * This is the way back. It recomputes daily_metrics from the raw rows for every
 * date the raw layer knows about. Nothing raw is read destructively, nothing is
 * overwritten that is not itself derived, and running it twice produces the
 * same answer - so it is always safe to run and never a data-loss risk.
 *
 * 0008_rls.sql grants daily_metrics full CRUD for exactly this reason, while
 * the observation tables have no delete policy at all.
 */
import { revalidatePath } from 'next/cache';
import { createActionClient } from '@/lib/supabase/server';
import { rebuildRange } from '@/lib/data/canonicalise';
import type { LocalDate } from '@/lib/types';

export interface RebuildResult {
  ok: boolean;
  message: string;
  daysRebuilt: number;
  from: LocalDate | null;
  to: LocalDate | null;
  /** Days that could not be recomputed, reported rather than swallowed. */
  failures: { date: LocalDate; message: string }[];
}

/** Every table whose rows give a day something to canonicalise. */
const RAW_TABLES = [
  'body_measurements',
  'metric_observations',
  'nutrition_logs',
  'sleep_records',
  'cardio_sessions',
  'workout_sessions',
] as const;

export async function rebuildCanonicalLayer(): Promise<RebuildResult> {
  const empty = { daysRebuilt: 0, from: null, to: null, failures: [] };

  const supabase = await createActionClient();
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError || !auth.user) {
    return { ok: false, message: 'Not signed in.', ...empty };
  }
  const userId = auth.user.id;

  // RLS scopes each read to this user, so the date set is theirs by
  // construction rather than by a filter that could be forgotten.
  const dates = new Set<LocalDate>();
  for (const table of RAW_TABLES) {
    const { data, error } = await supabase.from(table).select('local_date');
    // A table that could not be read means days may be missing from the
    // rebuild. Saying "done" then would be the same false reassurance that
    // made this action necessary, so it is reported as a failure instead.
    if (error) {
      return {
        ok: false,
        message: `Could not read ${table} (${error.message}). Nothing was rebuilt.`,
        ...empty,
      };
    }
    for (const row of data ?? []) {
      if (row.local_date) dates.add(row.local_date as LocalDate);
    }
  }

  if (dates.size === 0) {
    return {
      ok: true,
      message: 'There are no observations to rebuild from yet.',
      ...empty,
    };
  }

  const ordered = [...dates].sort();
  const from = ordered[0]!;
  const to = ordered[ordered.length - 1]!;

  const { failed } = await rebuildRange(supabase, userId, ordered);
  const rebuilt = ordered.length - failed.length;

  // Spec §41: a change to what the app reports appears in the audit log.
  await supabase.from('system_events').insert({
    user_id: userId,
    kind: 'CANONICAL_RESOLVED',
    summary:
      `Rebuilt the daily summary for ${rebuilt} day${rebuilt === 1 ? '' : 's'} `
      + `(${from} to ${to}).`
      + (failed.length === 0 ? '' : ` ${failed.length} day(s) could not be recomputed.`),
    detail: { from, to, requested: ordered.length, rebuilt, failed },
    previous_value: null,
    new_value: null,
    reason: 'User requested a rebuild of the canonical layer from raw observations.',
    // The event enum has no failure state; the failed days are named in
    // `detail` and in the summary rather than being flattened out of the log.
    status: 'RECORDED',
  });

  for (const path of ['/dashboard', '/progress', '/nutrition', '/recovery', '/training', '/context']) {
    revalidatePath(path);
  }
  revalidatePath('/settings');

  return {
    ok: failed.length === 0,
    message:
      failed.length === 0
        ? `Rebuilt ${rebuilt} day${rebuilt === 1 ? '' : 's'} (${from} to ${to}).`
        : `Rebuilt ${rebuilt} of ${ordered.length} days. `
          + `${failed.length} could not be recomputed: `
          + `${failed.map((f) => `${f.date}: ${f.message}`).join('; ')}. `
          + 'The raw observations are unaffected.',
    daysRebuilt: rebuilt,
    from,
    to,
    failures: failed,
  };
}
