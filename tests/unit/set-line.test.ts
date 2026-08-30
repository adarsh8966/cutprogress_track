/**
 * How a set is written on screen.
 *
 * Every case here is a way of NOT saying something the data does not say. The
 * temptations this pins down:
 *
 *  - `120 × —` for a set with no rep count. A dash beside a number reads as
 *    zero, on the one page where zero reps is a meaningful thing to record.
 *  - `—` for a zero load. Bodyweight movements legitimately add 0 kg, which
 *    migration 0004 says in as many words. Zero is a measurement; null is not.
 *  - `@ 2` for two reps in reserve. `@` is RPE. RPE 2 and RIR 2 are opposite
 *    ends of the same scale, and the one thing worse than not showing a figure
 *    is showing it as its inverse.
 */
import { describe, it, expect } from 'vitest';
import { blockLoadUnit, formatSetDuration, setLine } from '@/components/training/setLine';
import { groupByExercise, type LoggedSet } from '@/lib/analytics/training';
import type { DisplayUnits } from '@/lib/normalization/units';

const METRIC: DisplayUnits = { weight: 'KG', length: 'CM', distance: 'KM' };
const IMPERIAL: DisplayUnits = { weight: 'LB', length: 'IN', distance: 'MI' };

function set(overrides: Partial<LoggedSet> = {}): LoggedSet {
  return {
    date: '2026-08-29',
    sessionId: 'session-1',
    exerciseId: 'lat-pulldown',
    exerciseName: 'Lat Pulldown',
    primaryMuscleGroup: 'Back',
    weightKg: 120,
    reps: 12,
    rir: null,
    rpe: 7,
    warmup: false,
    setNumber: 1,
    exerciseIndex: 0,
    exerciseNotes: null,
    setType: null,
    supersetId: null,
    distanceKm: null,
    durationSeconds: null,
    ...overrides,
  };
}

describe('setLine: load, reps and intensity', () => {
  it('writes a full set as "120 × 12 @ 7"', () => {
    expect(setLine(set(), METRIC).text).toBe('120 × 12 @ 7');
  });

  it('keeps one decimal place on a fractional load and RPE', () => {
    expect(setLine(set({ weightKg: 32.5, rpe: 7.5 }), METRIC).text)
      .toBe('32.5 × 12 @ 7.5');
  });

  it('omits the rep count rather than printing a dash for it', () => {
    expect(setLine(set({ reps: null }), METRIC).text).toBe('120 @ 7');
  });

  it('names reps in words when there was no load to put them against', () => {
    // A bare "12" under a column of loads reads as a weight.
    expect(setLine(set({ weightKg: null }), METRIC).text).toBe('12 reps @ 7');
  });

  it('prints a measured zero load as zero', () => {
    const text = setLine(set({ weightKg: 0 }), METRIC).text;

    expect(text).toBe('0 × 12 @ 7');
    // Not "bodyweight" - that is an inference. Not "—" - that destroys a
    // measurement the source took the trouble to record.
    expect(text).not.toContain('bodyweight');
    expect(text).not.toContain('—');
  });

  it('says nothing at all for a set that recorded nothing', () => {
    const line = setLine(
      set({ weightKg: null, reps: null, rpe: null, rir: null }),
      METRIC,
    );

    // The caller says "nothing recorded for this set". A row of dashes would
    // be four claims about values that were never taken.
    expect(line.text).toBeNull();
  });
});

describe('setLine: RPE and RIR are never conflated', () => {
  it('marks RPE with @', () => {
    expect(setLine(set({ rpe: 8, rir: null }), METRIC).text).toBe('120 × 12 @ 8');
  });

  it('spells RIR out and never gives it the RPE glyph', () => {
    const text = setLine(set({ rpe: null, rir: 2 }), METRIC).text!;

    expect(text).toContain('RIR 2');
    expect(text).not.toContain('@');
  });

  it('shows both when both were recorded', () => {
    expect(setLine(set({ rpe: 8, rir: 2 }), METRIC).text).toBe('120 × 12 @ 8 · RIR 2');
  });

  it('shows neither when neither was recorded', () => {
    expect(setLine(set({ rpe: null, rir: null }), METRIC).text).toBe('120 × 12');
  });
});

describe('setLine: the user’s own units', () => {
  it('converts the load into the unit the user reads in', () => {
    expect(setLine(set({ weightKg: 100 }), IMPERIAL).text).toBe('220.5 × 12 @ 7');
  });

  it('converts a set’s distance too', () => {
    const metric = setLine(
      set({ weightKg: null, reps: null, rpe: null, distanceKm: 3.4 }),
      METRIC,
    ).text;
    const imperial = setLine(
      set({ weightKg: null, reps: null, rpe: null, distanceKm: 3.4 }),
      IMPERIAL,
    ).text;

    expect(metric).toBe('3.4 km');
    expect(imperial).toBe('2.1 mi');
  });

  it('keeps a set’s duration, which belongs to the set and not to cardio', () => {
    const line = setLine(
      set({ weightKg: null, reps: null, rpe: null, durationSeconds: 750 }),
      METRIC,
    );
    expect(line.text).toBe('12:30');
  });
});

describe('formatSetDuration', () => {
  it('writes under an hour as m:ss', () => {
    expect(formatSetDuration(45)).toBe('0:45');
    expect(formatSetDuration(90)).toBe('1:30');
  });

  it('writes an hour and over as h:mm:ss', () => {
    expect(formatSetDuration(3661)).toBe('1:01:01');
  });
});

describe('setLine: qualifiers', () => {
  it('marks a warm-up', () => {
    expect(setLine(set({ warmup: true }), METRIC).qualifier).toBe('warm-up');
  });

  it('says nothing for the source’s ordinary set type', () => {
    expect(setLine(set({ setType: 'normal' }), METRIC).qualifier).toBeNull();
    expect(setLine(set({ setType: null }), METRIC).qualifier).toBeNull();
  });

  it('passes an unrecognised set type through verbatim', () => {
    // Hevy's set-type vocabulary is not published. A type this app does not
    // interpret is still shown, exactly as it was recorded.
    expect(setLine(set({ setType: 'dropset' }), METRIC).qualifier).toBe('dropset');
    expect(setLine(set({ setType: 'failure' }), METRIC).qualifier).toBe('failure');
  });
});

describe('blockLoadUnit', () => {
  it('names the unit once for a block that recorded a load', () => {
    const blocks = groupByExercise([set(), set({ setNumber: 2 })]);
    expect(blockLoadUnit(blocks[0]!, METRIC)).toBe('kg');
    expect(blockLoadUnit(blocks[0]!, IMPERIAL)).toBe('lb');
  });

  it('names no unit for a block that recorded no load at all', () => {
    const blocks = groupByExercise([set({ weightKg: null })]);
    expect(blockLoadUnit(blocks[0]!, METRIC)).toBeNull();
  });

  it('names the unit for a block where a zero load was measured', () => {
    // Zero is a load. A pull-up block should still say what unit it is in.
    const blocks = groupByExercise([set({ weightKg: 0 })]);
    expect(blockLoadUnit(blocks[0]!, METRIC)).toBe('kg');
  });
});
