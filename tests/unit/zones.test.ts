/**
 * Heart-rate zones, and the claim "you did 22 minutes of Zone 2".
 *
 * The failure this file guards against is a plausible number with nothing
 * behind it. Every case below is either a real measurement or an honest
 * refusal, and the one thing that must never appear is a zero standing in for
 * "we do not know".
 */
import { describe, it, expect } from 'vitest';
import {
  zonesFromMax, estimatedMaxHeartRate, zoneOf, zoneBreakdownFromSamples,
  zoneBreakdownFromProvider, hadMeaningfulZone2, ZONE_BOUNDS,
  MAX_SAMPLE_GAP_MS, type HeartRateSample,
} from '@/lib/analytics/zones';
import { stateOf } from '@/lib/types';

const MODEL = zonesFromMax(190, 'MEASURED_MAX', 'a measured maximum of 190 bpm');

const at = (iso: string) => Date.parse(iso);

/** Samples every minute across a window, at a constant or varying rate. */
function samples(from: string, count: number, bpm: (i: number) => number): HeartRateSample[] {
  const start = at(from);
  return Array.from({ length: count }, (_, i) => ({
    at: start + i * 60_000,
    bpm: bpm(i),
  }));
}

describe('zone definitions', () => {
  it('builds five zones from a maximum', () => {
    expect(MODEL.definitions).toHaveLength(5);
    // Zone 2 is 60-70% of maximum, which is what the training literature means
    // by the aerobic base zone.
    expect(MODEL.definitions[1]!.lowerBpm).toBe(114);
    expect(MODEL.definitions[1]!.upperBpm).toBe(133);
    // The top zone has no ceiling.
    expect(MODEL.definitions[4]!.upperBpm).toBeNull();
  });

  it('states the percentage bounds as data rather than as arithmetic', () => {
    expect(ZONE_BOUNDS[2]).toEqual({ from: 0.60, to: 0.70 });
  });

  it('predicts a maximum from age, and says that is what it did', () => {
    expect(estimatedMaxHeartRate(37)).toBe(183);
    const estimated = zonesFromMax(183, 'ESTIMATED_MAX', '220 - age (37)');
    expect(estimated.method).toBe('ESTIMATED_MAX');
  });

  it('puts a rate on a shared boundary in the higher zone', () => {
    // Zone 2 ends at 133 and Zone 3 begins at 133, so 133 itself has to belong
    // to one of them by a stated rule rather than by whichever definition the
    // loop happened to reach first. The rule is: the higher zone.
    expect(zoneOf(132.9, MODEL.definitions)).toBe(2);
    expect(zoneOf(133, MODEL.definitions)).toBe(3);
    expect(zoneOf(114, MODEL.definitions)).toBe(2);
  });

  it('returns null below zone 1 rather than forcing a zone', () => {
    expect(zoneOf(80, MODEL.definitions)).toBeNull();
  });
});

describe('zone minutes from measured samples', () => {
  const window = {
    startMs: at('2026-08-29T10:00:00Z'),
    endMs: at('2026-08-29T11:00:00Z'),
  };

  it('reports nothing at all when there is no heart-rate data', () => {
    // NOT zero minutes of Zone 2. A workout nobody measured did not contain
    // zero Zone 2; nobody knows what it contained.
    const result = zoneBreakdownFromSamples([], MODEL, window);
    expect(result.value).toBeNull();
    expect(stateOf(result)).toBe('UNAVAILABLE');
    expect(result.notes[0]).toMatch(/No heart-rate data/);
  });

  it('refuses to attribute time from a single reading', () => {
    const result = zoneBreakdownFromSamples(
      samples('2026-08-29T10:00:00Z', 1, () => 120), MODEL, window,
    );
    expect(result.value).toBeNull();
    expect(result.notes[0]).toMatch(/one heart-rate reading/);
  });

  it('reports a confident zero for a session measured entirely in zone 1', () => {
    // The distinction that matters: this IS a measurement. Sixty minutes were
    // recorded and none of them were Zone 2, which is a different statement
    // from having no data.
    const result = zoneBreakdownFromSamples(
      samples('2026-08-29T10:00:00Z', 61, () => 100), MODEL, window,
    );
    expect(result.value!.zone2Minutes).toBe(0);
    expect(result.value!.minutes[1]).toBeGreaterThan(55);
    expect(stateOf(result)).toBe('PRESENT');
    expect(result.confidence).toBe('HIGH');
  });

  it('counts the minutes actually spent in zone 2', () => {
    // 22 minutes at 120 bpm (zone 2), the rest at 100 (zone 1) - the brief's
    // own shape of answer.
    const result = zoneBreakdownFromSamples(
      samples('2026-08-29T10:00:00Z', 61, (i) => (i < 22 ? 120 : 100)), MODEL, window,
    );
    expect(result.value!.zone2Minutes).toBe(22);
    expect(result.value!.minutes[1]).toBe(38);
  });

  it('handles zone 2 in several separate intervals', () => {
    // 10 minutes, then 12 minutes, with zone 1 between and after.
    const result = zoneBreakdownFromSamples(
      samples('2026-08-29T10:00:00Z', 61, (i) =>
        ((i < 10) || (i >= 20 && i < 32) ? 120 : 100)), MODEL, window,
    );
    expect(result.value!.zone2Minutes).toBe(22);
  });

  it('reports a mixed session across every zone it touched', () => {
    const result = zoneBreakdownFromSamples(
      samples('2026-08-29T10:00:00Z', 61, (i) => {
        if (i < 15) return 100;   // zone 1
        if (i < 37) return 120;   // zone 2
        return 140;               // zone 3
      }), MODEL, window,
    );
    expect(result.value!.minutes[1]).toBe(15);
    expect(result.value!.minutes[2]).toBe(22);
    expect(result.value!.minutes[3]).toBe(23);
  });

  it('does not credit a long gap to the zone either side of it', () => {
    // A device that goes off-wrist leaves a hole. Integrating across it would
    // report more Zone 2 than the workout was long.
    const start = at('2026-08-29T10:00:00Z');
    const withGap: HeartRateSample[] = [
      { at: start, bpm: 120 },
      { at: start + 60_000, bpm: 120 },
      // Forty minutes of nothing.
      { at: start + 41 * 60_000, bpm: 120 },
      { at: start + 42 * 60_000, bpm: 120 },
    ];
    const result = zoneBreakdownFromSamples(withGap, MODEL, window);
    expect(result.value!.zone2Minutes).toBe(2);
    expect(result.notes.join(' ')).toMatch(/gap/);
    // And the coverage says how much of the session that actually was.
    expect(result.value!.coverage).toBeLessThan(0.1);
  });

  it('reports coverage, and caveats a poorly covered session', () => {
    const result = zoneBreakdownFromSamples(
      samples('2026-08-29T10:00:00Z', 11, () => 120), MODEL, window,
    );
    expect(result.value!.coverage).toBeCloseTo(10 / 60, 2);
    expect(result.confidence).toBe('LOW');
    expect(result.notes.join(' ')).toMatch(/floor rather than a total/);
  });

  it('computes a time-weighted average, minimum and maximum', () => {
    const result = zoneBreakdownFromSamples(
      samples('2026-08-29T10:00:00Z', 61, (i) => (i < 30 ? 110 : 130)), MODEL, window,
    );
    expect(result.value!.minBpm).toBe(110);
    expect(result.value!.maxBpm).toBe(130);
    expect(result.value!.averageBpm).toBeCloseTo(120, 0);
  });

  it('never claims HIGH confidence on age-estimated boundaries', () => {
    const estimated = zonesFromMax(183, 'ESTIMATED_MAX', '220 - age (37)');
    const result = zoneBreakdownFromSamples(
      samples('2026-08-29T10:00:00Z', 61, () => 120), estimated, window,
    );
    expect(result.confidence).not.toBe('HIGH');
    expect(result.notes.join(' ')).toMatch(/estimated maximum/);
  });

  it('states the gap ceiling as a constant', () => {
    expect(MAX_SAMPLE_GAP_MS).toBe(3 * 60_000);
  });
});

describe('zone minutes from the provider’s own bands', () => {
  it('maps Fat Burn onto Zone 2 and says the boundaries are not yours', () => {
    const result = zoneBreakdownFromProvider({ lightTime: 900, fatBurnTime: 1320 });
    expect(result.value!.zone2Minutes).toBe(22);
    expect(result.value!.minutes[1]).toBe(15);
    // Never HIGH: these are Google's three bands, not the user's five zones.
    expect(result.confidence).toBe('MODERATE');
    expect(result.notes.join(' ')).toMatch(/not from your zone settings/);
  });

  it('reports no individual readings, because there were none', () => {
    const result = zoneBreakdownFromProvider({ fatBurnTime: 600 });
    expect(result.value!.averageBpm).toBeNull();
    expect(result.value!.sampleCount).toBe(0);
  });

  it('keeps an unrecognised band without counting it', () => {
    // A band name this app has not met is preserved and named, not silently
    // folded into a zone it might not belong to.
    const result = zoneBreakdownFromProvider({ fatBurnTime: 600, somethingNew: 300 });
    expect(result.value!.zone2Minutes).toBe(10);
    expect(result.notes.join(' ')).toMatch(/somethingNew/);
  });

  it('reports nothing when no band is recognised', () => {
    const result = zoneBreakdownFromProvider({ mysteryZone: 300 });
    expect(result.value).toBeNull();
    expect(stateOf(result)).toBe('UNAVAILABLE');
  });

  it('reports nothing for an empty summary', () => {
    const result = zoneBreakdownFromProvider({});
    expect(result.value).toBeNull();
  });
});

describe('whether a session contained meaningful zone 2 work', () => {
  const window = {
    startMs: at('2026-08-29T10:00:00Z'),
    endMs: at('2026-08-29T11:00:00Z'),
  };

  it('is true for a real block of it', () => {
    const breakdown = zoneBreakdownFromSamples(
      samples('2026-08-29T10:00:00Z', 61, (i) => (i < 22 ? 120 : 100)), MODEL, window,
    );
    const verdict = hadMeaningfulZone2(breakdown);
    expect(verdict.value).toBe(true);
    expect(verdict.inputs.zone2Minutes).toBe(22);
  });

  it('is false for a session that only passed through zone 2', () => {
    // Three minutes on the way to zone 4 is not zone 2 training, and calling it
    // that would make the flag useless.
    const breakdown = zoneBreakdownFromSamples(
      samples('2026-08-29T10:00:00Z', 61, (i) => (i < 3 ? 120 : 160)), MODEL, window,
    );
    expect(hadMeaningfulZone2(breakdown).value).toBe(false);
  });

  it('is unavailable, not false, when there is no heart-rate data', () => {
    const verdict = hadMeaningfulZone2(zoneBreakdownFromSamples([], MODEL, window));
    expect(verdict.value).toBeNull();
    expect(stateOf(verdict)).toBe('UNAVAILABLE');
  });
});
