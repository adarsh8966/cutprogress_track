import { describe, it, expect } from 'vitest';
import {
  presentValues, mean, sum, standardDeviation, coefficientOfVariation,
  median, densify, latestPresent, trailingWindow, coverageOf,
} from '@/lib/analytics/series';
import { trailingAverage, MIN_COVERAGE } from '@/lib/analytics/movingAverage';

describe('missing data is never zero (spec §7, §33)', () => {
  it('drops nulls without turning them into zeros', () => {
    expect(presentValues([1, null, 3])).toEqual([1, 3]);
    // The mean of [1, null, 3] is 2, not 1.33. If nulls became zeros this
    // would be 1.33 and every downstream average would be wrong.
    expect(mean(presentValues([1, null, 3]))).toBe(2);
  });

  it('keeps a genuine measured zero', () => {
    // Zero cardio minutes on a rest day is a real measurement, not a gap.
    expect(presentValues([0, null, 10])).toEqual([0, 10]);
    expect(mean(presentValues([0, null, 10]))).toBe(5);
  });

  it('returns null rather than zero for an empty series', () => {
    expect(mean([])).toBeNull();
    expect(sum([])).toBeNull();
    expect(median([])).toBeNull();
    expect(standardDeviation([1])).toBeNull();
  });

  it('discards non-finite values', () => {
    expect(presentValues([1, NaN, Infinity, 2])).toEqual([1, 2]);
  });

  it('measures coverage against the whole window, not the present values', () => {
    expect(coverageOf([1, null, null, 4])).toEqual({
      window: 4, present: 2, ratio: 0.5,
    });
  });
});

describe('series statistics', () => {
  it('computes a sample standard deviation', () => {
    expect(standardDeviation([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
  });

  it('computes a scale-free coefficient of variation', () => {
    const cv = coefficientOfVariation([1900, 2000, 2100]);
    expect(cv).toBeCloseTo(100 / 2000, 6);
    // Scaling every value leaves the CV unchanged, which is the property
    // plateau detection relies on.
    expect(coefficientOfVariation([19, 20, 21])).toBeCloseTo(cv!, 10);
  });

  it('returns null CV when the mean is zero', () => {
    expect(coefficientOfVariation([-1, 0, 1])).toBeNull();
  });

  it('takes the median of an even-length series', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe('densify and windows', () => {
  it('fills gaps with explicit nulls rather than omitting days', () => {
    const result = densify(
      [
        { date: '2026-08-26', value: 92 },
        { date: '2026-08-28', value: 91 },
      ],
      '2026-08-26',
      '2026-08-28',
    );
    expect(result).toEqual([
      { date: '2026-08-26', value: 92 },
      { date: '2026-08-27', value: null },
      { date: '2026-08-28', value: 91 },
    ]);
  });

  it('finds the most recent day that actually has a value', () => {
    const latest = latestPresent([
      { date: '2026-08-26', value: 92 },
      { date: '2026-08-28', value: null },
    ]);
    expect(latest).toEqual({ date: '2026-08-26', value: 92 });
  });

  it('builds a trailing window of calendar days', () => {
    const window = trailingWindow([{ date: '2026-08-28', value: 5 }], '2026-08-28', 3);
    expect(window.map((p) => p.date)).toEqual([
      '2026-08-26', '2026-08-27', '2026-08-28',
    ]);
  });
});

describe('moving averages refuse thin windows (spec §18)', () => {
  const sparse = [
    { date: '2026-08-27', value: 92.0 },
    { date: '2026-08-28', value: 91.8 },
  ];

  it('returns null with a reason when coverage is too low', () => {
    const result = trailingAverage(sparse, '2026-08-28', 7);
    expect(result.value).toBeNull();
    expect(result.confidence).toBe('INSUFFICIENT');
    expect(result.notes[0]).toMatch(/2 of 7 days/);
  });

  it('computes when coverage clears the gate', () => {
    const dense = Array.from({ length: 7 }, (_, i) => ({
      date: `2026-08-${22 + i}`,
      value: 93 - i * 0.1,
    }));
    const result = trailingAverage(dense, '2026-08-28', 7);
    expect(result.value).toBeCloseTo(92.7, 6);
    expect(result.confidence).toBe('HIGH');
  });

  it('downgrades confidence on a barely-passing window', () => {
    const partial = [
      { date: '2026-08-24', value: 93 },
      { date: '2026-08-26', value: 92.6 },
      { date: '2026-08-27', value: 92.4 },
      { date: '2026-08-28', value: 92.2 },
    ];
    const result = trailingAverage(partial, '2026-08-28', 7);
    expect(result.value).not.toBeNull();
    expect(result.confidence).toBe('LOW');
    expect(result.notes[0]).toMatch(/4 of 7 days/);
  });

  it('carries the evidence needed to answer "why?" (spec §57)', () => {
    const result = trailingAverage(sparse, '2026-08-28', 7);
    expect(result.method).toContain('average');
    expect(result.inputs).toMatchObject({
      windowDays: 7,
      endDate: '2026-08-28',
      daysWithData: 2,
      minCoverage: MIN_COVERAGE,
    });
  });
});
