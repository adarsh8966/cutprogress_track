'use server';

/**
 * Correcting and withdrawing what is already recorded (spec §6, §41, §48).
 *
 * NOTHING HERE DELETES ANYTHING. The observation tables have no delete policy
 * and never will; migrations 0011 and 0012 give every one of them a pair of
 * supersession columns and an update privilege scoped to those two columns
 * alone. So "remove this" means "mark it superseded": the row keeps every
 * measurement it recorded, stops counting towards the day, and stays traceable.
 *
 * There are two shapes of correction, and which applies depends on how the
 * canonical layer reads the table - not on which screen the user is looking at.
 *
 *   RESOLVED fields (weight, waist, nutrition, steps, RHR, HRV, sleep) are
 *   resolved by lib/normalization/canonical.ts, newest observation first. So
 *   correcting one is simply recording the right value again; the older
 *   observation loses on recency and needs no marking. What recording cannot
 *   express is "this should not count at all" - there is no number meaning "I
 *   did not weigh myself", and writing 0 would fabricate a measurement. That
 *   is what withdrawObservation is for.
 *
 *   SUMMED tables (workout_sessions, cardio_sessions) total the day's rows, so
 *   recording a correction ADDS to the day: a 30-minute walk fixed to 35
 *   minutes would read as 65. Those corrections must write the new row AND
 *   supersede the old one, which is what correctCardioSession does and what
 *   the importer's REPLACE has always done.
 *
 * Every path here rebuilds the day afterwards. daily_metrics is a pure function
 * of the raw layer, so a correction that does not rebuild is a correction the
 * user cannot see.
 */
import { revalidatePath } from 'next/cache';
import { createActionClient } from '@/lib/supabase/server';
import { rebuildDailyMetrics } from '@/lib/data/canonicalise';
import { logCardio, type ActionResult } from '@/app/actions/log';
// The vocabulary lives in lib/health/corrections.ts: every export of a
// 'use server' module must be an async server action, so a plain object and a
// type guard cannot be declared here.
import { WITHDRAWABLE, isWithdrawableTable } from '@/lib/health/corrections';
import { clearFieldPin, isPinnableField, PINNABLE_FIELDS } from '@/lib/data/pins';
import { isLocalDate } from '@/lib/normalization/dates';
import type { LocalDate } from '@/lib/types';

function revalidateDay(date: LocalDate) {
  for (const path of [
    '/dashboard', '/progress', '/nutrition', '/training', '/recovery', '/context',
  ]) {
    revalidatePath(path);
  }
  revalidatePath(`/day/${date}`);
}

async function requireUser() {
  const supabase = await createActionClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return { supabase, userId: data.user.id };
}

/**
 * Takes one observation out of the day without destroying it.
 *
 * The row stays on disk with everything it measured. It stops being resolved
 * or summed, the day is rebuilt, and the audit log records what changed and
 * why (spec §41). It can be put back - see restoreObservation - which is what
 * makes this safe to offer at all.
 */
export async function withdrawObservation(input: {
  table: string;
  id: string;
}): Promise<ActionResult> {
  if (!isWithdrawableTable(input.table)) {
    return { ok: false, message: 'That is not a record this can withdraw.' };
  }
  const table = input.table;

  const session = await requireUser();
  if (!session) return { ok: false, message: 'Not signed in.' };
  const { supabase, userId } = session;

  const { data: existing, error: readError } = await supabase
    .from(table)
    .select('id, local_date, superseded_at')
    .eq('id', input.id)
    .maybeSingle();
  if (readError) return { ok: false, message: readError.message };
  if (!existing) return { ok: false, message: 'That record no longer exists.' };
  if (existing.superseded_at !== null) {
    return {
      ok: false,
      message: 'That record has already been withdrawn or replaced.',
    };
  }

  const { error } = await supabase
    .from(table)
    .update({ superseded_at: new Date().toISOString(), superseded_by: null })
    .eq('id', input.id);
  if (error) return { ok: false, message: error.message };

  const date = existing.local_date as LocalDate;
  // The day's figures are derived from the rows that just changed, so this is
  // not optional: without it the withdrawn value stays on every page.
  try {
    await rebuildDailyMetrics(supabase, userId, date);
  } catch (rebuildError) {
    const message =
      rebuildError instanceof Error ? rebuildError.message : String(rebuildError);
    return {
      ok: false,
      message:
        `The record was withdrawn but the day's totals could not be recomputed `
        + `(${message}). The record itself is safe; rebuild the daily summary from `
        + 'Settings, or make any other entry for this day.',
    };
  }

  await supabase.from('system_events').insert({
    user_id: userId,
    kind: 'OBSERVATION_SUPERSEDED',
    summary: `Withdrew a ${WITHDRAWABLE[table]} recorded for ${date}.`,
    detail: { table, id: input.id, localDate: date },
    previous_value: null,
    new_value: null,
    reason: 'User withdrew a record from the day it was counted in.',
    status: 'RECORDED',
  });

  revalidateDay(date);
  return {
    ok: true,
    message: `Withdrawn. The ${WITHDRAWABLE[table]} is kept on record and no longer counts.`,
  };
}

/**
 * Puts a withdrawn observation back.
 *
 * Only a WITHDRAWAL can be restored, never a replacement. A row superseded by a
 * correction has a successor still in place: restoring it would put two
 * readings of one session back into a summed day, which is the doubling that
 * migration 0011 exists to prevent. `superseded_by is null` is exactly the
 * difference between the two, so it is what this checks.
 */
export async function restoreObservation(input: {
  table: string;
  id: string;
}): Promise<ActionResult> {
  if (!isWithdrawableTable(input.table)) {
    return { ok: false, message: 'That is not a record this can restore.' };
  }
  const table = input.table;

  const session = await requireUser();
  if (!session) return { ok: false, message: 'Not signed in.' };
  const { supabase, userId } = session;

  const { data: existing, error: readError } = await supabase
    .from(table)
    .select('id, local_date, superseded_at, superseded_by')
    .eq('id', input.id)
    .maybeSingle();
  if (readError) return { ok: false, message: readError.message };
  if (!existing) return { ok: false, message: 'That record no longer exists.' };
  if (existing.superseded_at === null) {
    return { ok: false, message: 'That record is already counting towards its day.' };
  }
  if (existing.superseded_by !== null) {
    return {
      ok: false,
      message:
        'That record was replaced by a correction rather than withdrawn, and the '
        + 'correction is still in place. Restoring it would count the same thing '
        + 'twice. Withdraw the correction instead if it is the wrong one.',
    };
  }

  const { error } = await supabase
    .from(table)
    .update({ superseded_at: null, superseded_by: null })
    .eq('id', input.id);
  if (error) return { ok: false, message: error.message };

  const date = existing.local_date as LocalDate;
  try {
    await rebuildDailyMetrics(supabase, userId, date);
  } catch (rebuildError) {
    const message =
      rebuildError instanceof Error ? rebuildError.message : String(rebuildError);
    return {
      ok: false,
      message:
        `The record was restored but the day's totals could not be recomputed `
        + `(${message}). Rebuild the daily summary from Settings.`,
    };
  }

  await supabase.from('system_events').insert({
    user_id: userId,
    kind: 'OBSERVATION_RESTORED',
    summary: `Restored a ${WITHDRAWABLE[table]} recorded for ${date}.`,
    detail: { table, id: input.id, localDate: date },
    previous_value: null,
    new_value: null,
    reason: 'User restored a record they had withdrawn.',
    status: 'RECORDED',
  });

  revalidateDay(date);
  return { ok: true, message: `Restored. The ${WITHDRAWABLE[table]} counts again.` };
}

/**
 * Corrects a cardio session: writes the corrected one, supersedes the old.
 *
 * cardio_sessions is a closed observation - 0008_rls.sql grants no update on
 * its measurements and 0012 keeps it that way - and daily_metrics SUMS the
 * day's sessions. So a correction cannot be an edit in place, and it cannot be
 * a bare re-log either: recording a 30-minute walk again as 35 minutes gives
 * the day 65. It has to be both writes, in this order.
 *
 * The insert runs FIRST, matching the importer's REPLACE and migration 0011's
 * reasoning: the replacement exists before anything points at it, so a failure
 * leaves a real new row rather than a dangling reference. If the supersession
 * then fails the day is briefly doubled, and that is reported rather than
 * reported as success - the day page shows both rows and either can be
 * withdrawn by hand.
 *
 * Validation, unit conversion and the canonical rebuild all come from
 * logCardio. There is one definition of what recording a cardio session means.
 */
export async function correctCardioSession(formData: FormData): Promise<ActionResult> {
  const supersedes = String(formData.get('supersedes') ?? '').trim();
  if (supersedes === '') {
    return { ok: false, message: 'A correction has to say which session it replaces.' };
  }

  const session = await requireUser();
  if (!session) return { ok: false, message: 'Not signed in.' };
  const { supabase, userId } = session;

  const { data: existing, error: readError } = await supabase
    .from('cardio_sessions')
    .select('id, local_date, superseded_at')
    .eq('id', supersedes)
    .maybeSingle();
  if (readError) return { ok: false, message: readError.message };
  if (!existing) return { ok: false, message: 'That session no longer exists.' };
  if (existing.superseded_at !== null) {
    return {
      ok: false,
      message:
        'That session has already been replaced or withdrawn. Correct the one that '
        + 'replaced it instead.',
    };
  }

  // logCardio validates, converts to canonical units, writes and rebuilds.
  const written = await logCardio(formData);
  if (!written.ok || !written.sessionId) return written;

  const { error } = await supabase
    .from('cardio_sessions')
    .update({ superseded_at: new Date().toISOString(), superseded_by: written.sessionId })
    .eq('id', supersedes);
  if (error) {
    return {
      ok: false,
      message:
        `The corrected session was saved, but the one it replaces could not be `
        + `marked as superseded (${error.message}). This day currently counts both. `
        + 'Withdraw the old session from the day view to fix it.',
    };
  }

  const oldDate = existing.local_date as LocalDate;
  const newDate = String(formData.get('date') ?? oldDate) as LocalDate;

  // A correction may move the session to another day, which leaves the day it
  // came from holding a total for a session no longer in it. logCardio rebuilt
  // the new day; this rebuilds the one it left.
  if (oldDate !== newDate) {
    try {
      await rebuildDailyMetrics(supabase, userId, oldDate);
    } catch (rebuildError) {
      const message =
        rebuildError instanceof Error ? rebuildError.message : String(rebuildError);
      return {
        ok: false,
        message:
          `The correction was saved, but ${oldDate} could not be recomputed `
          + `(${message}). Rebuild the daily summary from Settings.`,
      };
    }
  }

  await supabase.from('system_events').insert({
    user_id: userId,
    kind: 'OBSERVATION_SUPERSEDED',
    summary: `Corrected a cardio session recorded for ${oldDate}.`,
    detail: { table: 'cardio_sessions', replaced: supersedes, replacement: written.sessionId },
    previous_value: null,
    new_value: null,
    reason: 'User corrected a cardio session; the original is kept and no longer counts.',
    status: 'RECORDED',
  });

  revalidateDay(newDate);
  if (oldDate !== newDate) revalidateDay(oldDate);
  return {
    ok: true,
    message: 'Corrected. The session it replaces is kept on record and no longer counts.',
  };
}

/**
 * Lifts the pin on a field the user authored by hand.
 *
 * A pin keeps an imported reading from becoming the day's canonical value
 * (lib/data/pins.ts). Lifting it lets recency decide again, which is the normal
 * rule everywhere else - so this is how a user says "actually, trust the watch
 * for this one after all".
 *
 * The pin is CLEARED, not deleted, and the audit log records it: a number that
 * changes on a day the user has long since forgotten about deserves a trail
 * back to the moment they asked for it to.
 */
export async function clearCanonicalFieldPin(input: {
  date: string;
  field: string;
}): Promise<ActionResult> {
  const session = await requireUser();
  if (session === null) return { ok: false, message: 'Not signed in.' };
  const { supabase, userId } = session;

  if (!isLocalDate(input.date)) return { ok: false, message: 'That is not a date.' };
  if (!isPinnableField(input.field)) {
    return { ok: false, message: 'That is not a field that can be pinned.' };
  }

  const cleared = await clearFieldPin(supabase, userId, input.date, input.field);
  if (!cleared.ok) return cleared;

  await supabase.from('system_events').insert({
    user_id: userId,
    kind: 'CANONICAL_FIELD_UNPINNED',
    summary: `${PINNABLE_FIELDS[input.field]} on ${input.date} is no longer pinned `
      + 'to your own entry.',
    detail: { date: input.date, field: input.field },
    previous_value: null,
    new_value: null,
    reason: 'You lifted the pin, so imported readings can resolve this field again.',
    status: 'RECORDED',
  });

  // The pin changed which observation is canonical, so the day has to be
  // resolved again - otherwise the change is stored and invisible.
  await rebuildDailyMetrics(supabase, userId, input.date);
  revalidateDay(input.date);
  return { ok: true, message: cleared.message };
}
