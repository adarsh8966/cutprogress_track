/**
 * The scheduled sync runs at most once a day.
 *
 * WHY THIS EXISTS. vercel.json asked for an hourly sync, and the deployment was
 * refused: "Hobby accounts are limited to cron jobs that run once per day." The
 * whole application went undeployed over a schedule that was never load-bearing.
 *
 * What made that possible is that the constraint is invisible to every gate this
 * repository runs. `npm run verify` typechecks, lints, runs the tests and builds
 * for production, and not one of those parses vercel.json - so an over-frequent
 * schedule was discoverable only by pushing it and being told no.
 *
 * So it becomes a test, in the same spirit as the other structural guards here:
 * admin-client-containment.test.ts fails the build on a second importer of the
 * service-role client, hevy-boundary.test.ts on a health table named inside the
 * Hevy integration. A rule nobody can check locally is a rule that gets broken.
 *
 * WHAT DAILY COSTS, WHICH IS NEARLY NOTHING. The sync is incremental - it asks
 * Hevy only what changed since the last clean cursor - and idempotent, since an
 * unchanged workout is refused by a unique constraint before any work happens.
 * So cadence is a preference about freshness, not a correctness property, and
 * the Sync button on /import covers "I finished training and want it now".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

interface CronEntry { path: string; schedule: string }

const config = JSON.parse(readFileSync(`${ROOT}vercel.json`, 'utf8')) as {
  crons?: CronEntry[];
};

/**
 * A single literal value: "9", and not a wildcard, a step, a list or a range.
 *
 * A cron field runs its job once per period only when it names ONE value. Every
 * other form fires more than once, and in the minute or hour position that is
 * exactly the family Vercel refuses on the Hobby plan. The rejected forms are
 * spelled out as whole expressions in the tests below rather than in this
 * comment, because a step expression contains the characters that end a block
 * comment and would truncate this one.
 */
function isSingleValue(field: string): boolean {
  return /^\d+$/.test(field);
}

/** True when a 5-field cron expression fires at most once in any 24 hours. */
export function isAtMostDaily(schedule: string): boolean {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minute, hour] = fields;
  // Only the minute and hour decide how often it runs WITHIN a day. Day, month
  // and weekday can be anything: pinning them makes it rarer, never more often.
  return isSingleValue(minute!) && isSingleValue(hour!);
}

describe('the Vercel cron schedule', () => {
  it('declares at least one cron, so this guard is checking something real', () => {
    // A guard that silently checks nothing is worse than no guard.
    expect(config.crons).toBeDefined();
    expect(config.crons!.length).toBeGreaterThan(0);
  });

  it.each(config.crons ?? [])(
    '$path runs at most once per day, as the Hobby plan requires',
    ({ path, schedule }) => {
      expect(
        isAtMostDaily(schedule),
        `"${schedule}" for ${path} fires more than once a day. Vercel refuses to `
        + 'deploy that on the Hobby plan - "Hobby accounts are limited to cron jobs '
        + 'that run once per day" - and the whole app goes undeployed with it. Both '
        + 'the minute and the hour must name a single value (e.g. "0 9 * * *"). '
        + 'The sync is incremental and idempotent, so a daily run loses nothing '
        + 'that the Sync button on /import cannot recover immediately.',
      ).toBe(true);
    },
  );

  it.each(config.crons ?? [])('$path points at a route that exists', ({ path }) => {
    // Catches a renamed or moved route handler, which Vercel would accept and
    // then call into nothing - a schedule that silently never syncs.
    const route = `${ROOT}app${path}/route.ts`;
    expect(existsSync(route), `${path} has no handler at app${path}/route.ts`).toBe(true);
  });

  it('recognises the schedules that broke the deployment', () => {
    // The exact expression Vercel refused, and its neighbours.
    expect(isAtMostDaily('0 * * * *')).toBe(false);   // hourly - the one that failed
    expect(isAtMostDaily('*/15 * * * *')).toBe(false); // every 15 minutes
    expect(isAtMostDaily('0 */6 * * *')).toBe(false);  // every 6 hours
    expect(isAtMostDaily('0 9,21 * * *')).toBe(false); // twice a day
    expect(isAtMostDaily('0 9-17 * * *')).toBe(false); // hourly through the day
    expect(isAtMostDaily('* * * * *')).toBe(false);    // every minute
  });

  it('accepts a daily schedule, and anything rarer', () => {
    expect(isAtMostDaily('0 9 * * *')).toBe(true);   // daily
    expect(isAtMostDaily('30 2 * * *')).toBe(true);  // daily, another hour
    expect(isAtMostDaily('0 9 * * 1')).toBe(true);   // weekly
    expect(isAtMostDaily('0 9 1 * *')).toBe(true);   // monthly
  });

  it('refuses an expression that is not a 5-field schedule at all', () => {
    expect(isAtMostDaily('0 9 * *')).toBe(false);
    expect(isAtMostDaily('@daily')).toBe(false);
    expect(isAtMostDaily('')).toBe(false);
  });
});
