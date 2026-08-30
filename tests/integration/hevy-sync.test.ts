/**
 * The Hevy sync, end to end, against real PostgreSQL.
 *
 * Every layer between Hevy and the database is the real one: the real client
 * over an injected fetch, the real mapper, the real exercise resolver, the real
 * writer, the real rebuildDailyMetrics, the real migrations and the real RLS
 * policies. The only thing standing in for anything is Hevy itself.
 *
 * That matters because the guarantees under test are not properties of any one
 * layer. "Syncing twice produces one workout" is a claim about a unique index,
 * a key derived in one file and a branch taken in another; asserting it on a
 * mock asserts the mock.
 *
 * SCOPE, as everywhere else: PGlite is real PostgreSQL and this exercises the
 * schema, the constraints, the policies and the code. It is not proof that a
 * hosted Supabase project behaves the same.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, createUser, withUser, type TestDb } from '../helpers/pglite';

// The sync path is server-only by design; the marker package has no runtime
// behaviour, so stubbing it lets the real functions run here.
vi.mock('server-only', () => ({}));

import { supabaseOverPglite } from '../helpers/supabaseOverPglite';
import { fakeHevy, hevyWorkout, type HevyEvent } from '../helpers/hevyFixtures';
import { createHevyClient } from '@/lib/integrations/hevy/client';
import { runHevySync } from '@/lib/integrations/hevy/sync';
import { toLocalDate } from '@/lib/data/rows';

const TZ = 'America/New_York';
/** 22:00 UTC on the 29th is 18:00 in New York: the workout's own day. */
const DAY = '2026-08-29';

describe('Hevy sync', () => {
  let db: TestDb;
  let alice: string;

  beforeEach(async () => {
    db = await createTestDb();
    alice = await createUser(db, 'alice@example.com');
    await db.query(
      `insert into profiles (id, timezone) values ($1, $2)`, [alice, TZ],
    );
  });

  afterEach(async () => {
    await db?.close();
  });

  /** Runs the REAL sync, as the signed-in user, with RLS in force. */
  async function sync(
    events: HevyEvent[],
    options: { failTemplates?: boolean; onRequest?: (url: string) => void } = {},
  ) {
    return withUser(db, alice, async (tx) => {
      const api = createHevyClient({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.test',
        fetch: fakeHevy({ events, ...options }),
        sleep: async () => {},
      });
      return runHevySync(supabaseOverPglite(tx) as never, alice, {
        api, trigger: 'MANUAL',
      });
    });
  }

  const rows = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    withUser(db, alice, (tx) => tx.query<T>(sql, params)).then((r) => r.rows);

  /**
   * `local_date` is normalised through the same helper the read path uses: what
   * a driver returns for a `date` column is not guaranteed to be a string, and
   * PGlite returns a Date - which is exactly the hazard lib/data/rows.ts exists
   * to absorb, so the test absorbs it the same way rather than around it.
   */
  const sessions = async () => (await rows<{
    id: string; title: string | null; notes: string | null; local_date: unknown;
    duration_minutes: string | null; session_type: string; source: string;
    external_id: string | null; superseded_at: string | null;
  }>(`select * from workout_sessions order by local_date, title`))
    .map((row) => ({ ...row, local_date: toLocalDate(row.local_date) }));

  const sets = () => rows<{
    exercise_id: string; set_number: number; weight_kg: string | null;
    reps: number | null; rpe: string | null; warmup: boolean; set_type: string | null;
    exercise_index: number | null; exercise_notes: string | null;
    superseded_at: string | null;
  }>(`select * from workout_sets order by exercise_index, set_number`);

  // -------------------------------------------------------------------------

  it('imports a workout with its name, note, timing and every set', async () => {
    const result = await sync([{ type: 'updated', workout: hevyWorkout() }]);

    expect(result.ok).toBe(true);
    expect(result.workoutsCreated).toBe(1);

    const [session] = await sessions();
    expect(session).toMatchObject({
      title: 'Push Day',
      // The workout NOTE, which the brief singled out.
      notes: 'Felt really strong today. Increased incline DB press.',
      local_date: DAY,
      session_type: 'PUSH',
      source: 'HEVY',
      external_id: 'workout-push-1',
    });
    expect(Number(session!.duration_minutes)).toBe(64);

    const written = await sets();
    expect(written).toHaveLength(5);
    expect(written.map((s) => [s.exercise_index, s.set_number])).toEqual([
      [0, 1], [0, 2], [0, 3], [1, 1], [1, 2],
    ]);
    // Load, reps and RPE, per set.
    expect(written.slice(0, 3).map((s) => [Number(s.weight_kg), s.reps, Number(s.rpe)]))
      .toEqual([[31.75, 10, 7], [34, 9, 8], [34, 8, 9]]);
    // The exercise note is carried on each set of its exercise.
    expect(written[0]!.exercise_notes).toBe('Went up 5 lb and it moved well.');
    // The warm-up is marked, so it stays out of volume.
    expect(written[3]).toMatchObject({ set_type: 'warmup', warmup: true });
    expect(written[4]).toMatchObject({ set_type: 'normal', warmup: false });
  });

  it('creates what it has never seen and adopts what it has, against the real seed', async () => {
    // Against the SEEDED catalog, not an empty table, because that is the case
    // that actually happens and it exercises both halves of the rule at once:
    //
    //   "Cable Lateral Raise"    is in the catalog, spelled identically -> ADOPT
    //   "Incline Dumbbell Press" is not: the catalog says "Dumbbell Incline
    //                            Press", which is the same words in a different
    //                            order, so the matcher refuses it -> CREATE
    //
    // The second is the conservative rule costing a near-duplicate, on purpose.
    // Merging the two would fuse the histories of a movement the user does with
    // dumbbells on an incline with whatever else that catalog row is used for,
    // permanently and unrecoverably. The split is visible, named in the run's
    // summary, and can be joined by hand.
    const result = await sync([{ type: 'updated', workout: hevyWorkout() }]);

    expect(result.exercisesCreated).toBe(1);
    expect(result.exercisesMatched).toBe(1);

    const linked = await rows<{
      exercise_id: string; name: string; primary_muscle_group: string;
      equipment: string; external_id: string;
      apartment_gym: boolean; nippard_tier: string | null;
    }>(`select * from exercises where external_source = 'HEVY' order by exercise_id`);

    expect(linked.map((e) => [e.exercise_id, e.external_id])).toEqual([
      // Adopted: the seeded row, now linked. Its name is untouched.
      ['cable-lateral-raise', 'TPL-CABLE-LAT-RAISE'],
      // Created, with the muscle group and equipment Hevy reported.
      ['incline-dumbbell-press', 'TPL-INCLINE-DB'],
    ]);
    const created = linked.find((e) => e.exercise_id === 'incline-dumbbell-press')!;
    expect(created).toMatchObject({
      name: 'Incline Dumbbell Press',
      primary_muscle_group: 'Chest',
      equipment: 'Dumbbell',
      // Performable, because the user demonstrably performed it.
      apartment_gym: true,
      // Never guessed.
      nippard_tier: null,
    });

    // The split is reported by name, so it is noticed on the first sync rather
    // than in a progression chart months later.
    expect(result.warnings.join(' ')).toMatch(/Added 1 exercise: Incline Dumbbell Press/);
  });

  it('reuses an exercise on the next sync instead of duplicating it', async () => {
    const before = (await rows(`select exercise_id from exercises`)).length;
    await sync([{ type: 'updated', workout: hevyWorkout() }]);
    const second = await sync([{
      type: 'updated',
      workout: hevyWorkout({ id: 'workout-push-2', updated_at: '2026-08-31T10:00:00Z',
        start_time: '2026-08-31T22:00:00Z', end_time: '2026-08-31T23:00:00Z' }),
    }]);

    // Everything is linked by Hevy id by now, so the second run creates nothing
    // and matches both by the exact rule that runs in the steady state.
    expect(second.exercisesCreated).toBe(0);
    expect(second.exercisesMatched).toBe(2);
    expect(await rows(`select exercise_id from exercises`)).toHaveLength(before + 1);
  });

  it('does NOT adopt a near-named exercise: it splits rather than guessing', async () => {
    // The seed already holds "Machine Chest Press". A Hevy exercise called
    // "Chest Press" is not it - deciding otherwise would attribute sets of one
    // movement to another, permanently.
    const before = (await rows(`select exercise_id from exercises`)).length;

    const result = await sync([{
      type: 'updated',
      workout: hevyWorkout({
        exercises: [{
          index: 0, title: 'Chest Press', exercise_template_id: 'TPL-CHEST-PRESS',
          sets: [{ index: 0, type: 'normal', weight_kg: 60, reps: 10 }],
        }],
      }),
    }]);

    expect(result.exercisesCreated).toBe(1);
    expect(await rows(`select exercise_id from exercises`)).toHaveLength(before + 1);

    const both = await rows<{ exercise_id: string; external_id: string | null }>(
      `select exercise_id, external_id from exercises
       where exercise_id in ('chest-press', 'machine-chest-press') order by exercise_id`,
    );
    expect(both.map((e) => e.exercise_id)).toEqual(['chest-press', 'machine-chest-press']);
    // The seeded exercise was left completely alone.
    expect(both.find((e) => e.exercise_id === 'machine-chest-press')!.external_id).toBeNull();
    expect(result.warnings.join(' ')).toMatch(/Added 1 exercise: Chest Press/);
  });

  // --------------------------------------------------------------- idempotency

  it('syncing the same workout three times produces exactly one workout', async () => {
    const event: HevyEvent = { type: 'updated', workout: hevyWorkout() };
    const first = await sync([event]);
    const second = await sync([event]);
    const third = await sync([event]);

    expect([first.workoutsCreated, second.workoutsCreated, third.workoutsCreated])
      .toEqual([1, 0, 0]);
    expect([second.workoutsUnchanged, third.workoutsUnchanged]).toEqual([1, 1]);

    expect(await sessions()).toHaveLength(1);
    expect(await sets()).toHaveLength(5);
    // And the day's rollup counts one session, not three.
    const day = await rows<{ training_sessions: number; workout_minutes: string }>(
      `select training_sessions, workout_minutes from daily_metrics where local_date = $1`,
      [DAY],
    );
    expect(day[0]!.training_sessions).toBe(1);
    expect(Number(day[0]!.workout_minutes)).toBe(64);
  });

  it('updates the existing workout when it is edited in Hevy', async () => {
    await sync([{ type: 'updated', workout: hevyWorkout() }]);
    const [before] = await sessions();

    // The brief's exact scenario: another set, a changed RPE, changed reps, a
    // new note, and another exercise.
    const edited = hevyWorkout({
      updated_at: '2026-08-30T09:00:00Z',
      description: 'Even better second time. Added a drop set.',
      exercises: [
        {
          index: 0,
          title: 'Incline Dumbbell Press',
          notes: 'Went up 5 lb and it moved well.',
          exercise_template_id: 'TPL-INCLINE-DB',
          sets: [
            { index: 0, type: 'normal', weight_kg: 31.75, reps: 10, rpe: 7 },
            { index: 1, type: 'normal', weight_kg: 34, reps: 10, rpe: 8 },
            { index: 2, type: 'normal', weight_kg: 34, reps: 8, rpe: 9.5 },
            { index: 3, type: 'normal', weight_kg: 34, reps: 6, rpe: 10 },
          ],
        },
        {
          index: 1,
          title: 'Cable Lateral Raise',
          exercise_template_id: 'TPL-CABLE-LAT-RAISE',
          sets: [
            { index: 0, type: 'warmup', weight_kg: 5, reps: 15 },
            { index: 1, type: 'normal', weight_kg: 9, reps: 15, rpe: 8 },
          ],
        },
        {
          index: 2,
          title: 'Triceps Pushdown',
          exercise_template_id: 'TPL-PUSHDOWN',
          sets: [{ index: 0, type: 'normal', weight_kg: 25, reps: 12, rpe: 8 }],
        },
      ],
    });

    const result = await sync([{ type: 'updated', workout: edited }]);

    expect(result.workoutsUpdated).toBe(1);
    expect(result.workoutsCreated).toBe(0);

    const after = await sessions();
    expect(after).toHaveLength(1);
    // The SAME row: its id is the /training/<id> URL, and it must not change.
    expect(after[0]!.id).toBe(before!.id);
    expect(after[0]!.notes).toBe('Even better second time. Added a drop set.');

    const written = await sets();
    expect(written.filter((s) => s.superseded_at === null)).toHaveLength(7);
    // The changed reps and RPE landed on the rows that were already there.
    const second = written.find((s) => s.exercise_index === 0 && s.set_number === 2)!;
    expect([second.reps, Number(second.rpe)]).toEqual([10, 8]);
    const third = written.find((s) => s.exercise_index === 0 && s.set_number === 3)!;
    expect(Number(third.rpe)).toBe(9.5);
    // And the new exercise came with it.
    expect(written.some((s) => s.exercise_id === 'triceps-pushdown')).toBe(true);
  });

  it('withdraws a set removed in Hevy without deleting it', async () => {
    await sync([{ type: 'updated', workout: hevyWorkout() }]);

    const trimmed = hevyWorkout({
      updated_at: '2026-08-30T09:00:00Z',
      exercises: [{
        index: 0,
        title: 'Incline Dumbbell Press',
        exercise_template_id: 'TPL-INCLINE-DB',
        sets: [{ index: 0, type: 'normal', weight_kg: 31.75, reps: 10, rpe: 7 }],
      }],
    });
    await sync([{ type: 'updated', workout: trimmed }]);

    const written = await sets();
    // Every set is still on disk with everything it recorded (§48).
    expect(written).toHaveLength(5);
    expect(written.filter((s) => s.superseded_at === null)).toHaveLength(1);
    const removed = written.find((s) => s.set_number === 2 && s.exercise_index === 0)!;
    expect(removed.superseded_at).not.toBeNull();
    expect(Number(removed.weight_kg)).toBe(34);
  });

  it('restores a set that comes back rather than duplicating it', async () => {
    const full: HevyEvent = { type: 'updated', workout: hevyWorkout() };
    await sync([full]);
    await sync([{
      type: 'updated',
      workout: hevyWorkout({
        updated_at: '2026-08-30T09:00:00Z',
        exercises: [{
          index: 0, title: 'Incline Dumbbell Press',
          exercise_template_id: 'TPL-INCLINE-DB',
          sets: [{ index: 0, type: 'normal', weight_kg: 31.75, reps: 10, rpe: 7 }],
        }],
      }),
    }]);
    await sync([{
      type: 'updated', workout: hevyWorkout({ updated_at: '2026-08-30T11:00:00Z' }),
    }]);

    const written = await sets();
    expect(written).toHaveLength(5);
    expect(written.every((s) => s.superseded_at === null)).toBe(true);
  });

  // ----------------------------------------------------------------- deletions

  it('withdraws a workout deleted in Hevy and keeps every value it held', async () => {
    await sync([{ type: 'updated', workout: hevyWorkout() }]);

    const result = await sync([
      { type: 'deleted', id: 'workout-push-1', deleted_at: '2026-08-31T08:00:00Z' },
    ]);
    expect(result.workoutsDeleted).toBe(1);

    const [session] = await sessions();
    // Still there, still holding its name, its note and its duration.
    expect(session!.superseded_at).not.toBeNull();
    expect(session!.title).toBe('Push Day');
    expect(Number(session!.duration_minutes)).toBe(64);
    expect(await sets()).toHaveLength(5);

    // And it stops counting. NULL, not 0: with the only session withdrawn the
    // day has no training record at all, and "not logged" is what that is.
    // A 0 would claim the user was measured as having trained zero times, which
    // is a different statement and not one anything here can make (§33).
    const day = await rows<{ training_sessions: number | null; workout_minutes: string | null }>(
      `select training_sessions, workout_minutes from daily_metrics where local_date = $1`,
      [DAY],
    );
    expect(day[0]!.training_sessions).toBeNull();
    expect(day[0]!.workout_minutes).toBeNull();

    // A withdrawal is worth an audit entry: it takes data out of a day.
    const events = await rows<{ kind: string; summary: string }>(
      `select kind, summary from system_events`,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('OBSERVATION_SUPERSEDED');
    expect(events[0]!.summary).toMatch(/deleted in Hevy/);
  });

  it('ignores a deletion for a workout that never reached CUT OS', async () => {
    const result = await sync([{ type: 'deleted', id: 'never-seen', deleted_at: null }]);
    expect(result.ok).toBe(true);
    expect(result.workoutsDeleted).toBe(0);
    expect(result.recordsFailed).toBe(0);
  });

  it('applies only the newest event when a workout is edited then deleted', async () => {
    await sync([{ type: 'updated', workout: hevyWorkout() }]);

    // Newest first, as the API documents: the deletion is the current truth.
    const result = await sync([
      { type: 'deleted', id: 'workout-push-1', deleted_at: '2026-08-31T09:00:00Z' },
      { type: 'updated', workout: hevyWorkout({ updated_at: '2026-08-31T08:00:00Z' }) },
    ]);

    expect(result.workoutsDeleted).toBe(1);
    expect(result.workoutsUpdated).toBe(0);
    const [session] = await sessions();
    expect(session!.superseded_at).not.toBeNull();
  });

  // --------------------------------------------------------- runs and cursors

  it('records the run, and only advances the cursor on a clean one', async () => {
    await sync([{ type: 'updated', workout: hevyWorkout() }]);

    const runs = await rows<{
      status: string; workouts_created: number; exercises_created: number;
      cursor_before: string | null; cursor_after: string | null; triggered_by: string;
    }>(`select * from sync_runs order by started_at`);

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: 'SUCCEEDED', workouts_created: 1, exercises_created: 1,
      triggered_by: 'MANUAL', cursor_before: null,
    });
    expect(runs[0]!.cursor_after).not.toBeNull();
  });

  it('asks Hevy only for what changed after the first run', async () => {
    const asked: string[] = [];
    await sync([{ type: 'updated', workout: hevyWorkout() }]);
    await sync([{ type: 'updated', workout: hevyWorkout() }], {
      onRequest: (url) => asked.push(url),
    });

    const feed = asked.find((url) => url.startsWith('/v1/workouts/events'))!;
    // Not the epoch: the second run reads from where the first finished, less
    // the overlap that covers clock skew.
    expect(feed).not.toContain('since=1970');
    expect(feed).toContain('since=2026-08-29');
  });

  it('reports being up to date without touching anything', async () => {
    await sync([{ type: 'updated', workout: hevyWorkout() }]);
    const result = await sync([]);

    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/up to date/i);
    expect(await sessions()).toHaveLength(1);
  });

  it('refuses a second run while one is still going', async () => {
    await db.query(
      `insert into sync_runs (user_id, provider) values ($1, 'hevy')`, [alice],
    );
    const result = await sync([{ type: 'updated', workout: hevyWorkout() }]);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/already running/i);
    expect(await sessions()).toHaveLength(0);
  });

  it('leaves the cursor alone when Hevy fails, so the next run retries', async () => {
    const failing = withUser(db, alice, async (tx) => {
      const api = createHevyClient({
        apiKey: 'k',
        baseUrl: 'https://api.example.test',
        fetch: (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch,
        sleep: async () => {},
      });
      return runHevySync(supabaseOverPglite(tx) as never, alice, {
        api, trigger: 'MANUAL',
      });
    });

    const result = await failing;
    expect(result.ok).toBe(false);
    expect(result.status).toBe('FAILED');
    // Nothing was written, and the failure is visible rather than swallowed.
    expect(await sessions()).toHaveLength(0);
    const runs = await rows<{ status: string; error: string | null; cursor_after: string | null }>(
      `select status, error, cursor_after from sync_runs`,
    );
    expect(runs[0]!.status).toBe('FAILED');
    expect(runs[0]!.error).toBeTruthy();
    expect(runs[0]!.cursor_after).toBeNull();
  });

  it('still records the training when the template lookup fails', async () => {
    // Losing a whole workout because a lookup endpoint was down is the worse
    // failure. The exercise is created with its name and an explicit
    // "Unspecified" - the absence of a muscle group, not a guessed one.
    const result = await sync([{ type: 'updated', workout: hevyWorkout() }], {
      failTemplates: true,
    });

    expect(result.ok).toBe(true);
    // The training landed in full: five sets, nothing lost.
    expect(await sets()).toHaveLength(5);

    const created = await rows<{ name: string; primary_muscle_group: string }>(
      `select name, primary_muscle_group from exercises
       where exercise_id = 'incline-dumbbell-press'`,
    );
    expect(created[0]!.primary_muscle_group).toBe('Unspecified');
    expect(result.warnings.join(' ')).toMatch(/unspecified muscle group/i);

    // The adopted catalog row keeps what the seed said. A failed lookup must
    // never overwrite a known value with "Unspecified".
    const adopted = await rows<{ primary_muscle_group: string }>(
      `select primary_muscle_group from exercises where exercise_id = 'cable-lateral-raise'`,
    );
    expect(adopted[0]!.primary_muscle_group).toBe('Shoulders');
  });

  it('pages through a feed longer than one page', async () => {
    const events: HevyEvent[] = Array.from({ length: 23 }, (_, i) => ({
      type: 'updated' as const,
      workout: hevyWorkout({
        id: `workout-${i}`,
        // Newest first, as the feed orders them.
        updated_at: `2026-08-${String(28 - (i % 20)).padStart(2, '0')}T10:00:00Z`,
        start_time: `2026-08-${String(28 - (i % 20)).padStart(2, '0')}T22:00:00Z`,
        end_time: `2026-08-${String(28 - (i % 20)).padStart(2, '0')}T23:00:00Z`,
      }),
    }));

    const asked: string[] = [];
    const result = await sync(events, { onRequest: (url) => asked.push(url) });

    expect(result.eventsFound).toBe(23);
    expect(result.workoutsCreated).toBe(23);
    // 23 events at the documented ceiling of 10 per page is three pages.
    expect(asked.filter((u) => u.startsWith('/v1/workouts/events'))).toHaveLength(3);
  });

  it('reports the set types it saw, since the docs do not list them', async () => {
    const result = await sync([{
      type: 'updated',
      workout: hevyWorkout({
        exercises: [{
          index: 0, title: 'Bench', exercise_template_id: 'TPL-INCLINE-DB',
          sets: [
            { index: 0, type: 'warmup' },
            { index: 1, type: 'normal' },
            { index: 2, type: 'dropset' },
          ],
        }],
      }),
    }]);
    expect(result.setTypes).toEqual(['dropset', 'normal', 'warmup']);
  });

  it('moves a workout that changed day, and rebuilds both days', async () => {
    await sync([{ type: 'updated', workout: hevyWorkout() }]);
    await sync([{
      type: 'updated',
      workout: hevyWorkout({
        updated_at: '2026-09-01T10:00:00Z',
        start_time: '2026-09-01T22:00:00Z',
        end_time: '2026-09-01T23:00:00Z',
      }),
    }]);

    expect(await sessions()).toHaveLength(1);
    const days = (await rows<{ local_date: unknown; training_sessions: number | null }>(
      `select local_date, training_sessions from daily_metrics order by local_date`,
    )).map((row) => ({ ...row, local_date: toLocalDate(row.local_date) }));
    // The day it left no longer counts it; the day it moved to does. The day
    // it left reads NULL rather than 0 - nothing is recorded against it any
    // more, which is not the same claim as "trained zero times" (§33).
    expect(days).toEqual([
      { local_date: '2026-08-29', training_sessions: null },
      { local_date: '2026-09-01', training_sessions: 1 },
    ]);
  });
});
