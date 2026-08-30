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
 *   active_calories         two forms named Recovery as its destination while
 *                           Recovery did not show it
 *
 * Each was found by a person noticing their data was missing. That is the wrong
 * detector. A canonical field is a promise that a number will come back out
 * again, and this test makes the promise enforceable.
 *
 * HOW IT WORKS. The map below is exhaustive over keyof DailyMetrics, so
 * TypeScript itself fails the build when a field is added without an entry.
 * The runtime half then checks the named file actually mentions the field, so
 * an entry cannot be a comforting lie.
 *
 * AND THE CONTEXT PACK DOES NOT COUNT AS A SCREEN. active_calories passed this
 * test for as long as it was broken, because lib/context/generate.ts read it
 * and one reader was enough. The Context Pack is a real output and a real
 * reader, but it is not something the user can look at to answer "where did my
 * number go?". So a field readable ONLY from there has to say so out loud, in
 * CONTEXT_PACK_ONLY below, with the reason - which is the same rule the UI
 * follows for a value it stores but does not display.
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
  activeCalories: ['lib/analytics/recovery.ts', 'lib/context/generate.ts'],
  totalCaloriesBurned: ['lib/analytics/recovery.ts', 'lib/context/generate.ts'],

  workoutMinutes: ['lib/context/generate.ts'],
  cardioMinutes: ['lib/analytics/adherence.ts', 'lib/context/generate.ts'],
  zone2Minutes: ['lib/analytics/recovery.ts', 'lib/context/generate.ts'],

  restingHeartRate: ['lib/analytics/recovery.ts', 'lib/context/generate.ts'],
  hrvMs: ['lib/analytics/recovery.ts', 'lib/context/generate.ts'],
  sleepDurationMinutes: ['lib/analytics/recovery.ts', 'lib/context/generate.ts'],
  sleepScore: ['lib/analytics/recovery.ts'],

  /*
   * From migration 0016. Every one arrives from a connected wearable, and every
   * one has to be read somewhere or it is a column that is stored, confirmed
   * and invisible - which is the entire failure this file exists to catch.
   */
  bodyFatPct: ['lib/context/generate.ts', 'app/(app)/progress/page.tsx'],
  vo2Max: ['lib/context/generate.ts', 'app/(app)/progress/page.tsx'],
  distanceKm: ['lib/context/generate.ts'],
  floors: ['lib/context/generate.ts'],
  activeMinutes: ['lib/context/generate.ts'],
  activeZoneMinutes: ['lib/analytics/recovery.ts', 'lib/context/generate.ts'],
  respiratoryRate: ['lib/analytics/recovery.ts', 'lib/context/generate.ts'],
  oxygenSaturationPct: ['lib/analytics/recovery.ts', 'lib/context/generate.ts'],
  remMinutes: ['lib/analytics/recovery.ts', 'lib/context/generate.ts'],
  deepMinutes: ['lib/analytics/recovery.ts', 'lib/context/generate.ts'],
  lightMinutes: ['lib/analytics/recovery.ts', 'lib/context/generate.ts'],
  awakeMinutes: ['lib/analytics/recovery.ts', 'lib/context/generate.ts'],
  sleepTemperatureDeltaC: ['lib/analytics/recovery.ts', 'lib/context/generate.ts'],

  caloriesConsumed: ['app/(app)/nutrition/page.tsx', 'lib/context/generate.ts'],
  proteinG: ['app/(app)/nutrition/page.tsx', 'lib/context/generate.ts'],
  carbsG: ['app/(app)/nutrition/page.tsx', 'lib/context/generate.ts'],
  fatG: ['app/(app)/nutrition/page.tsx', 'lib/context/generate.ts'],
  fiberG: ['app/(app)/nutrition/page.tsx', 'lib/context/generate.ts'],
  fruitVegServings: ['app/(app)/nutrition/page.tsx', 'lib/analytics/scores.ts'],

  trainingSessions: ['lib/analytics/adherence.ts', 'lib/context/generate.ts'],
};

/** Readers that produce an export rather than a screen. */
const CONTEXT_PACK_PATHS = ['lib/context/generate.ts'];

/**
 * Canonical fields the user cannot see on any page, and why that is correct.
 *
 * Adding to this list is a decision, not a formality: it means a measurement is
 * stored, resolved and reachable only through the Context Pack. Every entry
 * needs a reason that survives being read back in six months.
 */
const CONTEXT_PACK_ONLY: Partial<Record<keyof DailyMetrics, string>> = {
  // The day's key, not a measurement.
  localDate: 'The date itself. Every page reads it; none displays it as a figure.',
  // The MEASUREMENT is on Training - the page sums the live workout_sessions
  // rows themselves, which is the honest source for "sessions and their
  // minutes" and works whether or not a day was canonicalised. The canonical
  // column is a rollup of those same rows for the Context Pack's benefit.
  workoutMinutes:
    'Training sums the session rows directly (getWorkoutSessions), so the '
    + 'measurement is on screen; this column is the rolled-up copy the Context '
    + 'Pack averages.',
  // Three activity metrics that a wearable reports and that CUT OS has no
  // decision to make about. Putting each on the Dashboard would be three more
  // cards competing with weight, nutrition and training for the same attention,
  // and the app's whole premise is that those three are what matter. They are
  // measured, resolved, and available to the Context Pack - which is where a
  // question like "was I less active the week the weight stalled?" gets asked.
  distanceKm:
    'Daily distance. Reported in the Context Pack; no screen shows it, because '
    + 'steps already answers "how much did I move today" on the Dashboard.',
  floors:
    'Floors climbed. Context Pack only - a supporting detail for an activity '
    + 'question, not a figure worth its own card.',
  activeMinutes:
    'Active minutes. Context Pack only, for the same reason as distance: the '
    + 'Dashboard reports activity through steps and calories.',
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
    // Only rowToDailyMetrics: the other mappers in this file map different
    // shapes - a profile, a training session, an exercise - whose fields are
    // not canonical day metrics. The slice is bounded at the NEXT top-level
    // export rather than at the end of the file, which is what it used to be:
    // that read every mapper added below it as though its fields were columns
    // of daily_metrics, so adding one made this test demand readers for
    // `durationMinutes` and `averageHeartRate`.
    const from = mapper.indexOf('export function rowToDailyMetrics');
    const rest = mapper.slice(from);
    const next = rest.indexOf('\nexport ', 1);
    const body = next === -1 ? rest : rest.slice(0, next);
    const mapped = [...body.matchAll(/^\s{4}(\w+): toNumber\(/gm)].map((m) => m[1]!);

    expect(mapped.length).toBeGreaterThan(0);
    for (const field of mapped) {
      expect(
        Object.prototype.hasOwnProperty.call(READERS, field),
        `${field} is mapped into DailyMetrics but has no reader listed`,
      ).toBe(true);
    }
  });

  it.each(Object.entries(READERS))('%s is readable somewhere the user looks', (field, files) => {
    if (Object.prototype.hasOwnProperty.call(CONTEXT_PACK_ONLY, field)) {
      // Declared as export-only. The declaration must carry a reason.
      const reason = CONTEXT_PACK_ONLY[field as keyof DailyMetrics];
      expect(reason, `${field}: CONTEXT_PACK_ONLY needs a reason`).toBeTruthy();
      return;
    }
    const onScreen = files.filter((file) => !CONTEXT_PACK_PATHS.includes(file));
    expect(
      onScreen,
      `${field} is only read by the Context Pack. Either display it, or add it `
        + 'to CONTEXT_PACK_ONLY with the reason.',
    ).not.toHaveLength(0);
  });

  it('does not exempt a field that is in fact displayed', () => {
    // A stale exemption is worse than none: it silently withdraws the check
    // from a field somebody has since put on a page.
    for (const field of Object.keys(CONTEXT_PACK_ONLY) as (keyof DailyMetrics)[]) {
      const readers = READERS[field] ?? [];
      const onScreen = readers.filter((file) => !CONTEXT_PACK_PATHS.includes(file));
      // localDate is read by series.ts, which is machinery rather than a
      // screen; anything else claiming an exemption must have no other reader.
      if (field === 'localDate') continue;
      expect(onScreen, `${field} has an on-screen reader; drop its exemption`).toHaveLength(0);
    }
  });
});
