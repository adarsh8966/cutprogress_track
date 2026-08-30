import 'server-only';

/**
 * One synchronisation run: Hevy's change feed -> CUT OS's write path.
 *
 * CLIENT-AGNOSTIC AND USER-SCOPED. This function constructs no Supabase client.
 * It takes the one its caller is entitled to use - today only the Sync button's,
 * which is the signed-in user's and runs under RLS - plus a userId that every
 * read and write is filtered by regardless. RLS is the boundary; the explicit
 * filter is a second belt, free to keep and the half that would be missing if a
 * caller without a session ever returned. This file constructs no client, so it
 * cannot be the route by which a privileged one arrives (asserted in
 * tests/unit/service-role-absence.test.ts).
 *
 * WHY THE EVENTS FEED AND NOT /v1/workouts. Pressing Sync must not re-download
 * a training history to discover that nothing changed. The feed answers "what
 * changed since?" in one request, reports DELETIONS as well as updates, and
 * carries the full workout on an update - so a page of ten workouts is one
 * request, not eleven.
 *
 * ORDERING. Events come newest first. A workout edited and then deleted appears
 * twice, and applying them in the order they arrive would delete it and then
 * resurrect it. So every page is collected first and only the FIRST event seen
 * per workout id - the newest - is applied. Position in the stream decides that
 * rather than a timestamp, because a deletion's deleted_at is optional.
 *
 * THE CURSOR ADVANCES ONLY ON A CLEAN RUN. A failed or partial run leaves it
 * alone and the next run re-reads the same window. That is free: every write is
 * keyed, so replaying an event rewrites the same rows rather than adding to
 * them, and an unchanged workout is refused by health_imports before any work
 * happens at all.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, SyncRunRow } from '@/lib/supabase/types';
import type { LocalDate } from '@/lib/types';
import { rebuildRange } from '@/lib/data/canonicalise';
import { HevyError, type HevyClient } from './client';
import { mapWorkout } from './mapper';
import { createExerciseResolver } from './exerciseResolver';
import { writeWorkout, withdrawWorkout } from './writer';
import type { HevyWorkout } from './types';

type Client = SupabaseClient<Database>;

export const HEVY_PROVIDER = 'hevy';

/** Where a first sync starts: everything the account has ever recorded. */
export const EPOCH = '1970-01-01T00:00:00Z';

/**
 * How far back before the last cursor to re-read.
 *
 * Clocks differ, and an event written a second before the previous run's
 * cursor would otherwise never be seen. Re-reading five minutes costs nothing -
 * an unchanged workout is a single refused insert - and missing an edit costs
 * the user a workout that never updates.
 */
export const CURSOR_OVERLAP_MS = 5 * 60 * 1000;

/** A stop, not a throttle: a personal account never approaches it. */
const MAX_PAGES = 200;

export interface SyncSummary {
  ok: boolean;
  status: SyncRunRow['status'];
  message: string;
  runId: string | null;
  eventsFound: number;
  workoutsCreated: number;
  workoutsUpdated: number;
  workoutsUnchanged: number;
  workoutsDeleted: number;
  exercisesCreated: number;
  exercisesMatched: number;
  recordsFailed: number;
  warnings: string[];
  /** Distinct Set.type values seen, so the vocabulary can be reported. */
  setTypes: string[];
  cursorBefore: string | null;
  cursorAfter: string | null;
}

function summary(partial: Partial<SyncSummary>): SyncSummary {
  return {
    ok: false,
    status: 'FAILED',
    message: '',
    runId: null,
    eventsFound: 0,
    workoutsCreated: 0,
    workoutsUpdated: 0,
    workoutsUnchanged: 0,
    workoutsDeleted: 0,
    exercisesCreated: 0,
    exercisesMatched: 0,
    recordsFailed: 0,
    warnings: [],
    setTypes: [],
    cursorBefore: null,
    cursorAfter: null,
    ...partial,
  };
}

/** The instant to ask Hevy about, given where the last clean run finished. */
export function sinceFor(cursor: string | null): string {
  if (cursor === null) return EPOCH;
  const at = Date.parse(cursor);
  if (Number.isNaN(at)) return EPOCH;
  return new Date(at - CURSOR_OVERLAP_MS).toISOString();
}

/**
 * The untouched workout bodies in a raw events page, by id.
 *
 * Walks the response defensively rather than trusting its shape: it has already
 * been validated in parsed form, and this pass exists only to recover the
 * bytes, so anything it cannot recognise is skipped and the parsed workout is
 * stored instead. A payload that cannot be read verbatim is a worse record than
 * one read through the schema, but it is not a reason to lose the workout.
 */
function rawWorkoutsById(raw: unknown): Map<string, unknown> {
  const found = new Map<string, unknown>();
  if (typeof raw !== 'object' || raw === null) return found;
  const events = (raw as { events?: unknown }).events;
  if (!Array.isArray(events)) return found;
  for (const event of events) {
    if (typeof event !== 'object' || event === null) continue;
    const workout = (event as { workout?: unknown }).workout;
    if (typeof workout !== 'object' || workout === null) continue;
    const id = (workout as { id?: unknown }).id;
    if (typeof id === 'string') found.set(id, workout);
  }
  return found;
}

/** The later of two timestamps, tolerating an unparseable one. */
function laterOf(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

export async function runHevySync(
  supabase: Client,
  userId: string,
  options: {
    api: HevyClient;
    trigger: 'MANUAL' | 'SCHEDULED';
    /** Injected in tests so a run is deterministic. */
    now?: () => Date;
  },
): Promise<SyncSummary> {
  const now = options.now ?? (() => new Date());

  // The profile's timezone decides which calendar day a workout lands on (§40).
  // Read through the caller's client rather than getProfile(), which reaches for
  // a cookie session of its own - this function is handed its client and should
  // not go looking for a different one.
  const profile = await supabase
    .from('profiles')
    .select('timezone')
    .eq('id', userId)
    .maybeSingle();
  if (profile.error) {
    return summary({ message: `Could not read your profile: ${profile.error.message}` });
  }
  const timezone = profile.data?.timezone ?? 'UTC';

  // Where the last CLEAN run finished. A failed run left this alone on purpose.
  const lastClean = await supabase
    .from('sync_runs')
    .select('cursor_after')
    .eq('user_id', userId)
    .eq('provider', HEVY_PROVIDER)
    .eq('status', 'SUCCEEDED')
    .not('cursor_after', 'is', null)
    .order('started_at', { ascending: false })
    .limit(1);
  if (lastClean.error) {
    return summary({ message: `Could not read the last sync: ${lastClean.error.message}` });
  }
  const cursorBefore = lastClean.data?.[0]?.cursor_after ?? null;

  // Opening the run is also the lock: a partial unique index refuses a second
  // RUNNING row, so a second press - another tab, an impatient double click -
  // is turned away by the database rather than racing the first.
  const opened = await supabase
    .from('sync_runs')
    .insert({
      user_id: userId,
      provider: HEVY_PROVIDER,
      triggered_by: options.trigger,
      cursor_before: cursorBefore,
    })
    .select('id')
    .single();
  if (opened.error || !opened.data) {
    return summary({
      message: opened.error?.code === '23505'
        ? 'A Hevy sync is already running. Nothing was started.'
        : `Could not start the sync: ${opened.error?.message ?? 'unknown error'}`,
    });
  }
  const runId = opened.data.id;

  const state = summary({ runId, cursorBefore });
  const warnings: string[] = [];
  const setTypes = new Set<string>();
  const touched = new Set<LocalDate>();

  /** Writes the run's outcome. Called on every exit path, including failure. */
  const close = async (
    status: SyncRunRow['status'],
    message: string,
    cursorAfter: string | null,
    error: string | null = null,
  ): Promise<SyncSummary> => {
    const result: SyncSummary = {
      ...state,
      ok: status === 'SUCCEEDED',
      status,
      message,
      warnings,
      setTypes: [...setTypes].sort(),
      cursorAfter,
    };
    await supabase
      .from('sync_runs')
      .update({
        status,
        finished_at: now().toISOString(),
        events_found: result.eventsFound,
        workouts_created: result.workoutsCreated,
        workouts_updated: result.workoutsUpdated,
        workouts_unchanged: result.workoutsUnchanged,
        workouts_deleted: result.workoutsDeleted,
        exercises_created: result.exercisesCreated,
        exercises_matched: result.exercisesMatched,
        records_failed: result.recordsFailed,
        warnings: result.warnings,
        error,
        // Only a clean run moves the cursor. A partial one re-reads its window,
        // which is free because every write below is keyed.
        cursor_after: status === 'SUCCEEDED' ? cursorAfter : null,
      })
      .eq('id', runId)
      .eq('user_id', userId);
    return result;
  };

  // ----------------------------------------------------------- read the feed
  const since = sinceFor(cursorBefore);
  /**
   * First event wins per workout: the feed is newest-first.
   *
   * `raw` is the workout as Hevy sent it, before parsing dropped anything it
   * did not model. It is what gets stored (§17); `workout` is what gets mapped.
   */
  const newest = new Map<string, { kind: 'updated'; workout: HevyWorkout; raw: unknown }
    | { kind: 'deleted'; id: string; deletedAt: string | null }>();
  let latestSeen: string | null = null;
  let page = 1;
  let pageCount = 1;
  let truncated = false;

  try {
    do {
      const result = await options.api.listWorkoutEvents({ since, page, pageSize: 10 });
      pageCount = result.page_count;
      state.eventsFound += result.events.length;

      // The untouched bodies from this page, by workout id, so each workout can
      // be stored exactly as Hevy sent it.
      const rawById = rawWorkoutsById(result.raw);

      for (const event of result.events) {
        if (event.type === 'updated') {
          latestSeen = laterOf(latestSeen, event.workout.updated_at);
          if (!newest.has(event.workout.id)) {
            newest.set(event.workout.id, {
              kind: 'updated',
              workout: event.workout,
              raw: rawById.get(event.workout.id) ?? event.workout,
            });
          }
        } else {
          latestSeen = laterOf(latestSeen, event.deleted_at);
          if (!newest.has(event.id)) {
            newest.set(event.id, {
              kind: 'deleted', id: event.id, deletedAt: event.deleted_at,
            });
          }
        }
      }

      if (page >= MAX_PAGES && page < pageCount) {
        truncated = true;
        break;
      }
      page += 1;
    } while (page <= pageCount);
  } catch (error) {
    const message = error instanceof HevyError
      ? error.userMessage
      : `Could not read from Hevy: ${error instanceof Error ? error.message : String(error)}`;
    // Nothing has been written at this point. The run is recorded as failed so
    // it is visible, and the cursor is untouched so the next run tries again.
    return close('FAILED', message, null, message);
  }

  if (newest.size === 0) {
    return close(
      'SUCCEEDED',
      cursorBefore === null
        ? 'Connected to Hevy. There were no workouts to import.'
        : 'Already up to date. Nothing has changed in Hevy since the last sync.',
      // Nothing changed, so there is nothing newer to point at: keep the cursor
      // where it was rather than advancing it to a time we did not verify.
      cursorBefore,
    );
  }

  // ------------------------------------------------------------- write them
  const resolver = await createExerciseResolver(supabase, options.api);
  if ('error' in resolver) {
    const message = `Could not read the exercise library: ${resolver.error}`;
    return close('FAILED', message, null, message);
  }

  const failures: string[] = [];

  for (const event of newest.values()) {
    if (event.kind === 'deleted') {
      const result = await withdrawWorkout(supabase, userId, event.id, event.deletedAt);
      if (result.message !== null) {
        state.recordsFailed += 1;
        failures.push(`A deleted workout could not be withdrawn: ${result.message}`);
        continue;
      }
      if (result.withdrawn) {
        state.workoutsDeleted += 1;
        if (result.localDate) touched.add(result.localDate);
      }
      continue;
    }

    const mapped = mapWorkout(event.workout, { timezone });
    for (const type of mapped.setTypes) setTypes.add(type);

    const written = await writeWorkout(
      supabase, userId, mapped, event.raw, resolver,
    );
    warnings.push(...written.warnings);

    switch (written.outcome) {
      case 'CREATED': state.workoutsCreated += 1; break;
      case 'UPDATED': state.workoutsUpdated += 1; break;
      case 'UNCHANGED': state.workoutsUnchanged += 1; break;
      case 'FAILED':
        state.recordsFailed += 1;
        failures.push(`"${event.workout.title}": ${written.message}`);
        break;
    }
    if (written.localDate) touched.add(written.localDate);
    // A workout that moved day leaves the day it LEFT holding a rollup that
    // still counts it, so that day needs rebuilding too. Read from a field
    // rather than parsed back out of the message: the totals' correctness must
    // not depend on the wording of a sentence.
    if (written.previousLocalDate) touched.add(written.previousLocalDate);
    if (written.message !== null && written.outcome !== 'FAILED') {
      warnings.push(written.message);
    }
  }

  state.exercisesCreated = resolver.created;
  state.exercisesMatched = resolver.matched;

  // -------------------------------------------------------- rebuild the days
  // daily_metrics is a pure function of the raw layer, so a write that is not
  // followed by a rebuild is a write no page can see (§16).
  if (touched.size > 0) {
    const { failed } = await rebuildRange(supabase, userId, [...touched]);
    for (const failure of failed) {
      warnings.push(
        `The daily summary for ${failure.date} could not be rebuilt (${failure.message}). `
        + 'The training is safe and will be recomputed on the next write.',
      );
    }
  }

  // ------------------------------------------------------------------ report
  const parts: string[] = [];
  if (state.workoutsCreated > 0) parts.push(`${state.workoutsCreated} imported`);
  if (state.workoutsUpdated > 0) parts.push(`${state.workoutsUpdated} updated`);
  if (state.workoutsDeleted > 0) parts.push(`${state.workoutsDeleted} withdrawn`);
  if (state.workoutsUnchanged > 0) parts.push(`${state.workoutsUnchanged} unchanged`);
  if (state.exercisesCreated > 0) {
    parts.push(`${state.exercisesCreated} new exercise${state.exercisesCreated === 1 ? '' : 's'}`);
  }
  if (state.recordsFailed > 0) parts.push(`${state.recordsFailed} could not be saved`);

  const headline = parts.length > 0
    ? `${parts.join(', ')}.`
    : 'Nothing changed.';

  if (resolver.createdNames.length > 0) {
    // Named rather than counted. The matcher splits rather than guessing, so a
    // duplicate of something already in the library is possible - and it is far
    // cheaper to notice here, on the first sync, than in a progression chart
    // months later.
    warnings.push(
      `Added ${resolver.createdNames.length} exercise`
      + `${resolver.createdNames.length === 1 ? '' : 's'}: `
      + `${resolver.createdNames.join(', ')}. If any of these duplicates one you `
      + 'already had, they were not merged - matching is by Hevy id or exact name only.',
    );
  }

  if (truncated) {
    warnings.push(
      `Stopped after ${MAX_PAGES} pages of changes. The rest will be read on the `
      + 'next sync; nothing was lost.',
    );
  }

  if (failures.length > 0 || truncated) {
    return close(
      'PARTIAL',
      `${headline} ${failures.join(' ')}`.trim(),
      // Deliberately not advanced: the next run re-reads this window and picks
      // up what failed. Replaying is free.
      null,
      failures.join(' ') || 'The change feed was longer than one run reads.',
    );
  }

  return close('SUCCEEDED', headline, laterOf(latestSeen, cursorBefore));
}
