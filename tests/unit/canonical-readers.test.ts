/**
 * Every canonical field must have a reader (spec §33, §57).
 *
 * WHY THIS TEST EXISTS. Three times now a measurement has been written,
 * resolved into daily_metrics, mapped into DailyMetrics - and read by nothing,
 * so it was stored perfectly and invisible everywhere:
 *
 *   fruit_veg_servings      resolved, scored, and never displayed
 *   resting_heart_rate      displayed only through a gated 30-day average
 *   total_calories_burned   written by two forms and read by no page at all
 *
 * Each was found by a person noticing their data was missing. That is the wrong
 * detector. A canonical field is a promise that a number will come back out
 * again, and this test makes the promise enforceable.
 *
 * HOW IT WORKS. The map below is exhaustive over keyof DailyMetrics, so
 * TypeScript itself fails the build when a field is added without an entry.
 * The runtime half then checks the named file actually mentions the field, so
 * an entry cannot be a comforting lie.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DailyMetrics } from '@/lib/types';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Where each canonical field is READ - a page, a chart or the Context Pack.
 *
 * A writer does not count. The whole class of bug is a field that is written
 * faithfully and never read back.
 */
const READERS: Record<keyof DailyMetrics, string[]> = {
  localDate: ['lib/analytics/series.ts'],

  weightKg: ['app/(app)/dashboard/page.tsx', 'lib/context/generate.ts'],
  waistCm: ['app/(app)/dashboard/page.tsx', 'lib/context/generate.ts'],

  steps: ['lib/analytics/recovery.ts', 'lib/context/generate.ts'],
  activeCalories: ['lib/context/generate.ts'],
  totalCaloriesBurned: ['lib/analytics/recovery.ts', 'lib/context/generate.ts'],

  workoutMinutes: ['lib/context/generate.ts'],
  cardioMinutes: ['lib/analytics/adherence.ts', 'lib/context/generate.ts'],
  zone2Minutes: ['lib/analytics/recovery.ts', 'lib/context/generate.ts'],

  restingHeartRate: ['lib/analytics/recovery.ts', 'lib/context/generate.ts'],
  hrvMs: ['lib/analytics/recovery.ts', 'lib/context/generate.ts'],
  sleepDurationMinutes: ['lib/analytics/recovery.ts', 'lib/context/generate.ts'],
  sleepScore: ['lib/analytics/recovery.ts'],

  caloriesConsumed: ['app/(app)/nutrition/page.tsx', 'lib/context/generate.ts'],
  proteinG: ['app/(app)/nutrition/page.tsx', 'lib/context/generate.ts'],
  carbsG: ['app/(app)/nutrition/page.tsx', 'lib/context/generate.ts'],
  fatG: ['app/(app)/nutrition/page.tsx', 'lib/context/generate.ts'],
  fiberG: ['app/(app)/nutrition/page.tsx', 'lib/context/generate.ts'],
  fruitVegServings: ['app/(app)/nutrition/page.tsx', 'lib/analytics/scores.ts'],

  trainingSessions: ['lib/analytics/adherence.ts', 'lib/context/generate.ts'],
};

describe('every canonical field is read by something', () => {
  it.each(Object.entries(READERS))('%s is read', (field, files) => {
    expect(files.length).toBeGreaterThan(0);
    const found = files.filter((file) =>
      readFileSync(`${ROOT}${file}`, 'utf8').includes(field),
    );
    // A named reader that does not mention the field is a stale entry, and a
    // stale entry is how this test would quietly stop protecting anything.
    expect(found, `${field}: no listed reader mentions it`).not.toHaveLength(0);
  });

  it('covers the fields the row mapper produces, with nothing left over', () => {
    // rows.ts is the one place every canonical column becomes a domain field,
    // so it is the authority on what the map has to cover.
    const mapper = readFileSync(`${ROOT}lib/data/rows.ts`, 'utf8');
    // Only rowToDailyMetrics: rowToProfile lives in the same file and maps a
    // different shape, whose fields are not canonical day metrics.
    const body = mapper.slice(mapper.indexOf('export function rowToDailyMetrics'));
    const mapped = [...body.matchAll(/^\s{4}(\w+): toNumber\(/gm)].map((m) => m[1]!);

    expect(mapped.length).toBeGreaterThan(0);
    for (const field of mapped) {
      expect(
        Object.prototype.hasOwnProperty.call(READERS, field),
        `${field} is mapped into DailyMetrics but has no reader listed`,
      ).toBe(true);
    }
  });
});
