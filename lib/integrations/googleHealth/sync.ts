import 'server-only';

/**
 * One synchronisation run: Google Health -> CUT OS's write path.
 *
 * CLIENT-AGNOSTIC AND USER-SCOPED, exactly as ../hevy/sync.ts is. This function
 * constructs no Supabase client. It takes the one its caller is entitled to use
 * - today only the Sync button's, which is the signed-in user's and runs under
 * RLS - plus a userId that every read and write is filtered by regardless. It
 * cannot be the route by which a privileged client arrives (asserted in
 * tests/unit/service-role-absence.test.ts).
 *
 * WHY WINDOWS AND NOT A CHANGE FEED. Hevy publishes "what changed since?" in one
 * request. Google Health does not: its filters range over WHEN A MEASUREMENT WAS
 * TAKEN, not when it was written, so there is no way to ask for edits. What
 * makes that survivable is that every write on this path is keyed - the unique
 * index on external_observations refuses an unchanged record outright - so
 * re-reading a window is nearly free, and the design leans on that instead:
 *
 *   a first run  backfills, chunked and checkpointed, oldest windows last
 *   a later run  re-reads a short recent window, because a device that has not
 *                synced for two days delivers two days of history at once
 *
 * THE CURSOR ADVANCES ONLY ON A CLEAN RUN, and a partial one leaves it alone so
 * the next run re-reads the same window. Same bargain as the Hevy sync, and free
 * for the same reason.
 *
 * NOTHING BLOCKS ON ONE FAILURE, AND THAT NOW GOES DOWN TO THE RECORD.
 * Twenty-odd data types are read independently: one that 403s for a scope the
 * user declined, or 400s on a filter this code got wrong, loses that data type
 * and nothing else. Inside a data type the same rule holds one level further
 * down - a data point this code cannot read costs that point, not the window it
 * arrived in and not the rest of the type. The first real sync failed at the
 * window, which is how one optional field discarded most of a year.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, SyncRunRow } from '@/lib/supabase/types';
import type { LocalDate } from '@/lib/types';
import { rebuildRange } from '@/lib/data/canonicalise';
import { addDays, localToday } from '@/lib/normalization/dates';
import { GoogleHealthError, type GoogleHealthClient } from './client';
import type { GoogleDataPoint, GoogleDataPointPage, RejectedDataPoint } from './types';
import { SyncWarnings } from './warnings';
import { windowFilter } from './filters';
import {
  DATA_TYPE_BY_ID, dataTypesForScopes, windowDaysFor, type DataTypeSpec,
} from './registry';
import {
  mapDataPoint, mapSleepSession, mapExerciseSession, mapHeartRateSamples,
  type NormalisedExercise, type HeartRateSample,
} from './mapper';
import type { IdentitySource } from './identity';
import {
  writeObservation, writeSleep, writeExerciseSession, recordCorrelatedExercise,
  recordUnmapped, GOOGLE_HEALTH_PROVIDER,
} from './writer';
import { matchSessions, explainMatch, type MatchCandidate } from './correlate';
import { resolveZoneModel, writeSessionTelemetry, type TrainingInterval } from './telemetry';

type Client = SupabaseClient<Database>;

export { GOOGLE_HEALTH_PROVIDER };

/** How far back a first connection reaches. A year of history, by default. */
export const DEFAULT_BACKFILL_DAYS = 365;

/**
 * How much recent history every run re-reads.
 *
 * Three days. A watch that has been off the charger, or a phone that has not
 * opened the Fitbit app, delivers its backlog when it finally syncs - and that
 * backlog is dated to when it was MEASURED, so a cursor over measurement time
 * would step straight past it. Re-reading three days catches that, and costs
 * nothing because an unchanged record is refused by an index.
 */
export const RECENT_WINDOW_DAYS = 3;

/** A stop, not a throttle. A personal account never approaches it. */
const MAX_PAGES_PER_WINDOW = 50;

/** Per-run ceiling on windows, so one press cannot run for an hour. */
const MAX_WINDOWS_PER_RUN = 60;

export interface DataTypeOutcome {
  dataType: string;
  label: string;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  failed: number;
  /** The oldest date this data type has been read back to. */
  backfilledTo: string | null;
  error: string | null;
}

export interface GoogleHealthSyncSummary {
  ok: boolean;
  status: SyncRunRow['status'];
  message: string;
  runId: string | null;
  recordsFound: number;
  recordsCreated: number;
  recordsUpdated: number;
  recordsUnchanged: number;
  recordsWithdrawn: number;
  recordsFailed: number;
  sessionsCorrelated: number;
  warnings: string[];
  byDataType: DataTypeOutcome[];
  /** Data types that arrived with no canonical destination. */
  unmappedTypes: string[];
  cursorBefore: string | null;
  cursorAfter: string | null;
  backfillComplete: boolean;
}

function summary(partial: Partial<GoogleHealthSyncSummary>): GoogleHealthSyncSummary {
  return {
    ok: false,
    status: 'FAILED',
    message: '',
    runId: null,
    recordsFound: 0,
    recordsCreated: 0,
    recordsUpdated: 0,
    recordsUnchanged: 0,
    recordsWithdrawn: 0,
    recordsFailed: 0,
    sessionsCorrelated: 0,
    warnings: [],
    byDataType: [],
    unmappedTypes: [],
    cursorBefore: null,
    cursorAfter: null,
    backfillComplete: false,
    ...partial,
  };
}

/**
 * The windows to read for one data type, newest first.
 *
 * NEWEST FIRST IS THE WHOLE POINT. The guidance asks for a "hot" load of the
 * most recent week or two before anything else, so the dashboard fills while
 * the rest is still arriving. It also means an interrupted backfill has always
 * done the useful part: stopping halfway through a year leaves the recent
 * months present and the distant ones missing, rather than the reverse.
 *
 * Each window is at most the type's documented ceiling - 14 days for the four
 * short-range types, 90 for the rest - because exceeding it is a 400 rather
 * than a truncated answer.
 */
export function windowsFor(
  spec: DataTypeSpec,
  from: LocalDate,
  to: LocalDate,
): { from: LocalDate; to: LocalDate }[] {
  const size = windowDaysFor(spec);
  const windows: { from: LocalDate; to: LocalDate }[] = [];
  let end = to;
  while (end > from) {
    const start = addDays(end, -size);
    windows.push({ from: start < from ? from : start, to: end });
    end = start < from ? from : start;
    if (windows.length > 400) break;
  }
  return windows;
}

/** The oldest date each data type has already been read back to. */
type Checkpoints = Record<string, string>;

function readCheckpoints(detail: unknown): Checkpoints {
  if (typeof detail !== 'object' || detail === null) return {};
  const backfill = (detail as { backfilledTo?: unknown }).backfilledTo;
  if (typeof backfill !== 'object' || backfill === null) return {};
  const out: Checkpoints = {};
  for (const [key, value] of Object.entries(backfill)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

export interface RunOptions {
  api: GoogleHealthClient;
  trigger: 'MANUAL' | 'SCHEDULED';
  /** What the user actually consented to. */
  grantedScopes: readonly string[];
  /** How far back a first run reaches. */
  backfillDays?: number;
  /**
   * Explicit windows to read, per data type. The seam a webhook handler would
   * use: a notification names the data type and the interval it changed, and
   * this function reads exactly that instead of a rolling window. Nothing else
   * about the run differs.
   */
  windows?: { dataType: string; from: LocalDate; to: LocalDate }[];
  now?: () => Date;
}

export async function runGoogleHealthSync(
  supabase: Client,
  userId: string,
  options: RunOptions,
): Promise<GoogleHealthSyncSummary> {
  const now = options.now ?? (() => new Date());

  // The profile's timezone decides which calendar day a measurement lands on
  // (§40). Read through the caller's client rather than getProfile(), which
  // reaches for a cookie session of its own.
  const profile = await supabase
    .from('profiles').select('timezone').eq('id', userId).maybeSingle();
  if (profile.error) {
    return summary({ message: `Could not read your profile: ${profile.error.message}` });
  }
  const timezone = profile.data?.timezone ?? 'UTC';
  const today = localToday(timezone, now());

  const lastClean = await supabase
    .from('sync_runs')
    .select('cursor_after, detail')
    .eq('user_id', userId)
    .eq('provider', GOOGLE_HEALTH_PROVIDER)
    .eq('status', 'SUCCEEDED')
    .order('started_at', { ascending: false })
    .limit(1);
  if (lastClean.error) {
    return summary({ message: `Could not read the last sync: ${lastClean.error.message}` });
  }

  const previous = lastClean.data?.[0];
  const cursorBefore = previous?.cursor_after ?? null;
  // Checkpoints survive a failed run too: a backfill that died halfway must
  // resume, not restart. So they are read from the newest run of any status.
  const lastAny = await supabase
    .from('sync_runs')
    .select('detail')
    .eq('user_id', userId)
    .eq('provider', GOOGLE_HEALTH_PROVIDER)
    .order('started_at', { ascending: false })
    .limit(1);
  const checkpoints = readCheckpoints(lastAny.data?.[0]?.detail ?? previous?.detail);

  // Opening the run is also the lock: a partial unique index refuses a second
  // RUNNING row, so a second press is turned away by the database rather than
  // racing the first.
  const opened = await supabase
    .from('sync_runs')
    .insert({
      user_id: userId,
      provider: GOOGLE_HEALTH_PROVIDER,
      triggered_by: options.trigger,
      cursor_before: cursorBefore,
    })
    .select('id')
    .single();
  if (opened.error || !opened.data) {
    return summary({
      message: opened.error?.code === '23505'
        ? 'A Google Health sync is already running. Nothing was started.'
        : `Could not start the sync: ${opened.error?.message ?? 'unknown error'}`,
    });
  }
  const runId = opened.data.id;

  const state = summary({ runId, cursorBefore });
  const warnings = new SyncWarnings();
  const touched = new Set<LocalDate>();
  const outcomes = new Map<string, DataTypeOutcome>();
  const nextCheckpoints: Checkpoints = { ...checkpoints };

  const close = async (
    status: SyncRunRow['status'],
    message: string,
    cursorAfter: string | null,
    error: string | null = null,
  ): Promise<GoogleHealthSyncSummary> => {
    const byDataType = [...outcomes.values()];
    const result: GoogleHealthSyncSummary = {
      ...state,
      ok: status === 'SUCCEEDED',
      status,
      message,
      warnings: warnings.list(),
      byDataType,
      unmappedTypes: byDataType
        .filter((o) => DATA_TYPE_BY_ID[o.dataType]?.destination.kind === 'UNMAPPED'
          && o.created + o.unchanged > 0)
        .map((o) => o.dataType),
      cursorAfter,
      backfillComplete: byDataType.length > 0 && byDataType.every(
        (o) => o.backfilledTo !== null && o.backfilledTo <= backfillFloor,
      ),
    };
    await supabase
      .from('sync_runs')
      .update({
        status,
        finished_at: now().toISOString(),
        events_found: result.recordsFound,
        records_created: result.recordsCreated,
        records_updated: result.recordsUpdated,
        records_unchanged: result.recordsUnchanged,
        records_withdrawn: result.recordsWithdrawn,
        records_failed: result.recordsFailed,
        warnings: result.warnings,
        error,
        detail: {
          backfilledTo: nextCheckpoints,
          byDataType: result.byDataType,
          sessionsCorrelated: result.sessionsCorrelated,
        },
        cursor_after: status === 'SUCCEEDED' ? cursorAfter : null,
      })
      .eq('id', runId)
      .eq('user_id', userId);
    return result;
  };

  const backfillDays = options.backfillDays ?? DEFAULT_BACKFILL_DAYS;
  const backfillFloor = addDays(today, -backfillDays);

  const available = dataTypesForScopes(options.grantedScopes);
  if (available.length === 0) {
    const message = 'No Google Health permissions have been granted, so there is '
      + 'nothing to read. Reconnect and accept at least one.';
    return close('FAILED', message, null, message);
  }

  const outcomeFor = (spec: DataTypeSpec): DataTypeOutcome => {
    const existing = outcomes.get(spec.dataType);
    if (existing !== undefined) return existing;
    const fresh: DataTypeOutcome = {
      dataType: spec.dataType,
      label: spec.label,
      created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0,
      backfilledTo: checkpoints[spec.dataType] ?? null,
      error: null,
    };
    outcomes.set(spec.dataType, fresh);
    return fresh;
  };

  /**
   * Reads every page of one window, honouring the page-size ceiling.
   *
   * Points that could not be validated come back BESIDE the ones that could,
   * rather than as an exception. That is the difference between losing a
   * measurement and losing a year: the client used to throw on the whole page
   * if any element of it failed to parse, and the loop below then abandoned the
   * data type.
   */
  const readWindow = async (
    spec: DataTypeSpec,
    from: LocalDate,
    to: LocalDate,
  ): Promise<
    { points: GoogleDataPoint[]; rejected: RejectedDataPoint[] }
    | { error: GoogleHealthError }
  > => {
    const points: GoogleDataPoint[] = [];
    const rejected: RejectedDataPoint[] = [];
    let pageToken: string | null = null;
    let pages = 0;
    try {
      do {
        const page: GoogleDataPointPage = spec.read === 'DAILY_ROLLUP'
          ? await options.api.dailyRollUp(spec.dataType, from, to, pageToken)
          : await options.api.list({
            dataType: spec.dataType,
            filter: windowFilter(spec, from, to),
            pageSize: spec.pageSize,
            pageToken,
          });
        points.push(...page.dataPoints);
        rejected.push(...page.rejected);
        pageToken = page.nextPageToken;
        pages += 1;
      } while (pageToken !== null && pages < MAX_PAGES_PER_WINDOW);
      if (pageToken !== null) {
        warnings.add({
          dataType: spec.dataType,
          label: spec.label,
          kind: 'page-limit',
          message: `stopped after ${MAX_PAGES_PER_WINDOW} pages for ${from} to ${to}. `
            + 'The rest is read on the next sync; nothing was lost.',
        });
      }
      return { points, rejected };
    } catch (error) {
      if (error instanceof GoogleHealthError) return { error };
      return {
        error: new GoogleHealthError(
          'NETWORK', error instanceof Error ? error.message : String(error),
          null, spec.dataType,
        ),
      };
    }
  };

  /** The exercise sessions read this run, kept for correlation afterwards. */
  const exercises: NormalisedExercise[] = [];
  /** Heart-rate samples read this run, for the same reason. */
  const heartRateSamples: HeartRateSample[] = [];
  /**
   * Sleep-adjacent daily values, applied to the night they describe.
   *
   * ORDER MATTERS AND IS NOT LEFT TO CHANCE. Skin temperature arrives under the
   * health-metrics scope and sleep under the sleep scope, and the registry
   * lists them in that order - so the temperature is collected before the night
   * it belongs to is written. The sort below makes that a guarantee rather than
   * a coincidence of how the catalogue happens to be ordered.
   */
  const sleepExtras = new Map<string, {
    temperatureDeltaC?: number; respiratoryRate?: number; oxygenSaturationPct?: number;
  }>();

  let fatal: GoogleHealthError | null = null;
  let windowsRead = 0;

  /**
   * Derived identities minted this run, so a collision cannot pass unnoticed.
   *
   * An id that CUT OS mints is only as unique as the fields it is built from,
   * and if a data type turns out to return two genuinely different points that
   * share a time and a source, they mint the same id - and the second is then
   * refused by the idempotency index, which is indistinguishable from "already
   * imported". Silently. That is exactly the class of loss this system is not
   * allowed to have, so the run keeps what it has minted and says so when two
   * different records land on one identity. The fix for a real collision is a
   * discriminator on the registry entry; this is what makes the need visible.
   *
   * ONLY DERIVED IDS ARE TRACKED. A provider name repeating within a run means
   * Google sent two versions of one record, which is a correction and is
   * handled correctly downstream. A minted id repeating means this code cannot
   * tell two records apart, which is a different thing entirely - and the only
   * one of the two that needs saying out loud.
   */
  const mintedIds = new Map<string, string>();
  const noteIdentity = (
    spec: DataTypeSpec,
    identitySource: IdentitySource,
    externalId: string,
    contentVersion: string,
  ): void => {
    if (identitySource !== 'DERIVED') return;
    const seen = mintedIds.get(externalId);
    if (seen === undefined) {
      mintedIds.set(externalId, contentVersion);
      return;
    }
    if (seen === contentVersion) return;
    warnings.add({
      dataType: spec.dataType,
      label: spec.label,
      kind: 'identity-collision',
      message: 'two different records arrived that this app cannot tell apart '
        + `(${externalId}). Both were kept in the raw layer; only one can be `
        + 'resolved into the day until a discriminator is added for this data type.',
    });
  };

  /**
   * Sleep last.
   *
   * A sleep session carries the stage breakdown; the skin temperature that
   * describes the same night arrives as a separate daily record. Writing the
   * night before that record has been read would store it without the
   * temperature, and nothing would go back for it - the night is unchanged on
   * the next sync, so the idempotency index refuses it and the value is stored,
   * confirmed and never resolved.
   */
  const ordered = [...available].sort((a, b) =>
    Number(a.dataType === 'sleep') - Number(b.dataType === 'sleep'));

  for (const spec of ordered) {
    if (fatal !== null) break;
    const outcome = outcomeFor(spec);

    // Where this data type has already been read back to. A first run starts at
    // today and walks backwards; a later run re-reads the recent window and
    // then continues the backfill from wherever it stopped.
    const alreadyTo = checkpoints[spec.dataType] ?? null;
    const explicit = options.windows?.filter((w) => w.dataType === spec.dataType) ?? [];

    const planned = explicit.length > 0
      ? explicit.map((w) => ({ from: w.from, to: w.to }))
      : [
        // Recent first, always.
        { from: addDays(today, -RECENT_WINDOW_DAYS), to: addDays(today, 1) },
        // Then whatever backfill is left.
        ...(alreadyTo === null
          ? windowsFor(spec, backfillFloor, addDays(today, -RECENT_WINDOW_DAYS))
          : alreadyTo > backfillFloor
            ? windowsFor(spec, backfillFloor, alreadyTo as LocalDate)
            : []),
      ];

    for (const window of planned) {
      if (windowsRead >= MAX_WINDOWS_PER_RUN) {
        warnings.add({
          kind: 'window-limit',
          message: 'This run reached its window limit. The backfill continues on '
            + 'the next sync from where it stopped; nothing was lost.',
        });
        break;
      }
      windowsRead += 1;

      const read = await readWindow(spec, window.from, window.to);
      if ('error' in read) {
        // A refused credential is fatal: the remaining data types would all fail
        // the same way and twenty identical errors help nobody.
        if (!read.error.isolated) {
          fatal = read.error;
          break;
        }
        outcome.failed += 1;
        outcome.error = read.error.userMessage;
        warnings.add({
          dataType: spec.dataType,
          label: spec.label,
          kind: `read-${read.error.kind}`,
          message: read.error.userMessage,
        });
        break;
      }

      state.recordsFound += read.points.length + read.rejected.length;

      /**
       * A point that did not parse is counted and named ONCE per kind.
       *
       * It is a failure - the measurement did not arrive - so it is not
       * swallowed. But the reason is a property of the response shape, not of
       * the individual record, so a thousand of them is one sentence and a
       * count rather than a thousand copies of the same validation dump.
       */
      for (const bad of read.rejected) {
        outcome.failed += 1;
        state.recordsFailed += 1;
        warnings.add({
          dataType: spec.dataType,
          label: spec.label,
          kind: `parse-${bad.reason}`,
          message: `a data point could not be read (${bad.reason}). `
            + 'It was not imported; everything else in this window was.',
        });
      }

      for (const point of read.points) {
        /* -------------------------------------------------- sessions */
        if (spec.dataType === 'sleep') {
          const sleep = mapSleepSession(point, { timezone });
          if (sleep === null) {
            outcome.failed += 1;
            warnings.add({
              dataType: spec.dataType,
              label: spec.label,
              kind: 'no-interval',
              message: 'a sleep session arrived with no start or end time and '
                + 'could not be placed on a night.',
            });
            continue;
          }
          noteIdentity(spec, sleep.identitySource, sleep.externalId, sleep.contentVersion);
          // The physiology measured during this night, gathered from the daily
          // records that describe it, written onto the night itself.
          const written = await writeSleep(
            supabase, userId, sleep, sleepExtras.get(sleep.localDate) ?? {}, { now },
          );
          warnings.addAll(written.warnings, { dataType: spec.dataType, label: spec.label });
          if (written.outcome === 'CREATED') { outcome.created += 1; state.recordsCreated += 1; }
          else if (written.outcome === 'UPDATED') { outcome.updated += 1; state.recordsUpdated += 1; }
          else if (written.outcome === 'UNCHANGED') {
            outcome.unchanged += 1; state.recordsUnchanged += 1;
          } else if (written.outcome === 'FAILED') {
            outcome.failed += 1; state.recordsFailed += 1;
            if (written.message) {
              warnings.add({
                dataType: spec.dataType, label: spec.label,
                kind: 'write-failed', message: written.message,
              });
            }
          }
          if (written.localDate) touched.add(written.localDate);
          if (written.previousLocalDate) touched.add(written.previousLocalDate);
          continue;
        }

        if (spec.dataType === 'exercise') {
          const exercise = mapExerciseSession(point, { timezone });
          if (exercise === null) {
            outcome.failed += 1;
            warnings.add({
              dataType: spec.dataType,
              label: spec.label,
              kind: 'no-start',
              message: 'a workout arrived with no start time and could not be '
                + 'placed on a timeline.',
            });
            continue;
          }
          noteIdentity(spec, exercise.identitySource, exercise.externalId, exercise.contentVersion);
          exercises.push(exercise);
          continue;
        }

        if (spec.dataType === 'heart-rate') {
          // Samples need no identity: they are never written as records of
          // their own, only summed into a session's telemetry.
          heartRateSamples.push(...mapHeartRateSamples([point]));
          outcome.unchanged += 1;
          continue;
        }

        /* --------------------------------------------------- scalars */
        const observation = mapDataPoint(point, spec, { timezone });
        if (observation === null) {
          outcome.failed += 1;
          warnings.add({
            dataType: spec.dataType,
            label: spec.label,
            kind: 'no-time',
            message: 'a record arrived that could not say when it was measured, '
              + 'so it was not stored. Filing it under today would invent a '
              + 'timestamp nobody recorded.',
          });
          continue;
        }
        warnings.addAll(observation.warnings, {
          dataType: spec.dataType, label: spec.label, kind: 'implausible-value',
        });
        noteIdentity(spec, observation.identitySource, observation.externalId, observation.contentVersion);

        // A sleep-derived daily value belongs on the night it describes rather
        // than in a metric of its own.
        if (spec.dataType === 'daily-sleep-temperature-derivations') {
          if (observation.value !== null) {
            const key = observation.timing.localDate;
            sleepExtras.set(key, {
              ...sleepExtras.get(key), temperatureDeltaC: observation.value,
            });
          }
          const kept = await recordUnmapped(supabase, userId, observation);
          if (kept !== null) {
            warnings.add({
              dataType: spec.dataType, label: spec.label,
              kind: 'record-failed', message: kept,
            });
          } else { outcome.created += 1; state.recordsCreated += 1; }
          touched.add(observation.timing.localDate);
          continue;
        }

        if (spec.destination.kind === 'UNMAPPED' || spec.destination.kind === 'TELEMETRY') {
          const kept = await recordUnmapped(supabase, userId, observation);
          if (kept !== null) {
            outcome.failed += 1;
            warnings.add({
              dataType: spec.dataType, label: spec.label,
              kind: 'record-failed', message: kept,
            });
          } else { outcome.skipped += 1; }
          continue;
        }

        const written = await writeObservation(supabase, userId, observation, spec, { now });
        warnings.addAll(written.warnings, { dataType: spec.dataType, label: spec.label });
        if (written.outcome === 'CREATED') { outcome.created += 1; state.recordsCreated += 1; }
        else if (written.outcome === 'UPDATED') { outcome.updated += 1; state.recordsUpdated += 1; }
        else if (written.outcome === 'UNCHANGED') {
          outcome.unchanged += 1; state.recordsUnchanged += 1;
        } else if (written.outcome === 'SKIPPED') { outcome.skipped += 1; }
        else {
          outcome.failed += 1; state.recordsFailed += 1;
          if (written.message) {
            warnings.add({
              dataType: spec.dataType, label: spec.label,
              kind: 'write-failed', message: written.message,
            });
          }
        }
        if (written.localDate) touched.add(written.localDate);
      }

      // The checkpoint only moves backwards, and only on a window that was
      // actually read. A failed window leaves it where it was so the next run
      // tries the same one again.
      const reached = window.from;
      const current = nextCheckpoints[spec.dataType];
      if (current === undefined || reached < current) nextCheckpoints[spec.dataType] = reached;
    }
  }

  if (fatal !== null) {
    return close('FAILED', fatal.userMessage, null, fatal.message);
  }

  /* ------------------------------------------------------- correlation */
  const correlationWarnings = await correlateSessions(
    supabase, userId, { exercises, heartRateSamples, today, timezone, now, touched, state },
  );
  // No shared kind: these are distinct facts about distinct sessions, and
  // folding them into one count would hide which session went unmatched.
  warnings.addAll(correlationWarnings);

  /* ----------------------------------------------------------- rebuild */
  if (touched.size > 0) {
    const { failed } = await rebuildRange(supabase, userId, [...touched]);
    for (const failure of failed) {
      warnings.add({
        kind: 'rebuild-failed',
        message: `The daily summary for ${failure.date} could not be rebuilt `
          + `(${failure.message}). The measurements are safe and will be `
          + 'recomputed on the next write.',
      });
    }
  }

  /* ------------------------------------------------------------ report */
  const parts: string[] = [];
  if (state.recordsCreated > 0) parts.push(`${state.recordsCreated} imported`);
  if (state.recordsUpdated > 0) parts.push(`${state.recordsUpdated} updated`);
  if (state.recordsUnchanged > 0) parts.push(`${state.recordsUnchanged} unchanged`);
  if (state.sessionsCorrelated > 0) {
    parts.push(
      `${state.sessionsCorrelated} workout${state.sessionsCorrelated === 1 ? '' : 's'} matched`,
    );
  }
  if (state.recordsFailed > 0) parts.push(`${state.recordsFailed} could not be saved`);

  const headline = parts.length > 0 ? `${parts.join(', ')}.` : 'Nothing changed.';
  const anyFailed = [...outcomes.values()].some((o) => o.failed > 0 || o.error !== null);

  if (anyFailed) {
    return close(
      'PARTIAL',
      headline,
      // Deliberately not advanced: the next run re-reads this window and picks
      // up what failed. Replaying is free - every write here is keyed.
      null,
      // One line, aggregated. This column is rendered beside a date in the run
      // history, and it used to hold every data type's error joined end to end
      // - which for a systematic failure meant the same validation dump twenty
      // times over, in a space one sentence wide.
      warnings.summary() || 'Some records could not be saved.',
    );
  }

  return close('SUCCEEDED', headline, now().toISOString());
}

/**
 * Attaches the run's heart rate and exercise sessions to the training already
 * recorded, then writes what is left over as sessions of its own.
 *
 * Split out because it is the part with the interesting behaviour and it reads
 * better on its own than inlined into a 400-line function.
 */
async function correlateSessions(
  supabase: Client,
  userId: string,
  ctx: {
    exercises: NormalisedExercise[];
    heartRateSamples: HeartRateSample[];
    today: LocalDate;
    timezone: string;
    now: () => Date;
    touched: Set<LocalDate>;
    state: GoogleHealthSyncSummary;
  },
): Promise<string[]> {
  const warnings: string[] = [];
  const { exercises, heartRateSamples, touched, state, now } = ctx;

  /**
   * Which days to look at for correlation.
   *
   * The days this run touched, the days its exercise sessions fall on, AND the
   * days its heart-rate samples fall on. That last one is not redundant: a
   * lifting session is frequently not recorded as an exercise by the watch, so
   * the only Google data for it is the heart rate - and heart-rate samples are
   * not written to a domain table, so they never reach `touched`. Without them
   * here, exactly the sessions that most need telemetry get none.
   */
  const sampleDays = heartRateSamples.map(
    (s) => new Date(s.at).toISOString().slice(0, 10),
  );
  const days = new Set<string>([
    ...touched,
    ...exercises.map((e) => e.localDate),
    ...sampleDays,
  ]);
  if (days.size === 0) return warnings;

  const dates = [...days].sort();
  const sessions = await supabase
    .from('workout_sessions')
    .select('id, local_date, start_time, end_time, session_type')
    .eq('user_id', userId)
    .gte('local_date', dates[0]!)
    .lte('local_date', dates[dates.length - 1]!)
    .is('superseded_at', null);

  if (sessions.error) {
    warnings.push(
      `Workouts could not be read for matching: ${sessions.error.message}. `
      + 'The measurements are safe; matching runs again on the next sync.',
    );
    return warnings;
  }

  /**
   * Only sessions with a real interval can be matched. A pasted summary records
   * a day and nothing finer, and there is no honest way to decide whether an
   * afternoon's heart rate belongs to it.
   */
  const trainable: TrainingInterval[] = (sessions.data ?? [])
    .filter((row) => row.start_time !== null && row.end_time !== null)
    .map((row) => ({
      id: row.id,
      startMs: Date.parse(String(row.start_time)),
      endMs: Date.parse(String(row.end_time)),
      localDate: String(row.local_date).slice(0, 10),
      sessionType: row.session_type,
    }))
    .filter((s) => Number.isFinite(s.startMs) && Number.isFinite(s.endMs as number));

  const candidates: (MatchCandidate & { exercise: NormalisedExercise })[] = exercises
    .filter((e) => e.endTime !== null)
    .map((e) => ({
      id: e.externalId,
      startMs: Date.parse(e.startTime),
      endMs: Date.parse(e.endTime!),
      activityType: e.exerciseType,
      exercise: e,
    }));

  const { matched, unmatchedRight } = matchSessions(trainable, candidates);
  const matchedBySession = new Map(matched.map((m) => [m.left.id, m]));

  const observedMax = heartRateSamples.length > 0
    ? Math.max(...heartRateSamples.map((s) => s.bpm))
    : null;
  const zoneModel = await resolveZoneModel(supabase, userId, observedMax);

  for (const session of trainable) {
    const match = matchedBySession.get(session.id);
    const exercise = match?.right.exercise ?? null;

    const outcome = await writeSessionTelemetry(supabase, userId, session, {
      samples: heartRateSamples,
      exercise,
      matchConfidence: match ? Math.round(match.score.score * 1000) / 1000 : null,
      overlapSeconds: match?.score.overlapSeconds ?? null,
      matchExplanation: match ? explainMatch(match.score) : null,
      zoneModel,
    }, { now });

    warnings.push(...outcome.warnings);
    if (outcome.matched) state.sessionsCorrelated += 1;
    touched.add(session.localDate as LocalDate);

    if (exercise !== null) {
      const kept = await recordCorrelatedExercise(supabase, userId, exercise, session.id);
      if (kept !== null) warnings.push(`A matched workout's source data was not kept: ${kept}`);
    }
  }

  /**
   * An exercise session nothing claimed becomes a session of its own - a walk,
   * a run, a bike ride that was never in Hevy. This is the branch that stops a
   * cardio session recorded only on the watch from being invisible.
   */
  for (const leftover of unmatchedRight) {
    const written = await writeExerciseSession(supabase, userId, leftover.exercise, { now });
    warnings.push(...written.warnings);
    if (written.outcome === 'CREATED') state.recordsCreated += 1;
    else if (written.outcome === 'UPDATED') state.recordsUpdated += 1;
    else if (written.outcome === 'UNCHANGED') state.recordsUnchanged += 1;
    else if (written.outcome === 'FAILED') {
      state.recordsFailed += 1;
      if (written.message) warnings.push(written.message);
    }
    if (written.localDate) touched.add(written.localDate);
    if (written.previousLocalDate) touched.add(written.previousLocalDate);
  }

  return warnings;
}
