/**
 * latestReading: what was last actually recorded (spec §32, §33).
 *
 * This is the reader that a coverage gate cannot silence. Its whole reason for
 * existing is that a metric with only a gated average as its reader disappears
 * from the app until half the window fills up, which is how four days of
 * imported resting heart rate came to be displayed as "not logged".
 */
import { describe, it, expect } from 'vitest';
import { latestReading } from '@/lib/analytics/latest';
import type { DatedValue } from '@/lib/types';

const LIVE: DatedValue[] = [
  { date: '2026-08-24', value: 62 },
  { date: '2026-08-25', value: 59 },
  { date: '2026-08-26', value: 58 },
  { date: '2026-08-27', value: null },
  { date: '2026-08-28', value: 58 },
];

describe('latestReading', () => {
  it('returns the most recent value that exists', () => {
    const reading = latestReading(LIVE, '2026-08-29', 30);
    expect(reading.value).toBe(58);
    expect(reading.inputs.observedOn).toBe('2026-08-28');
  });

  it('reports four days as a value, where a 30-day average must refuse', () => {
    // The gate is right to refuse 4/30. The point is that refusing to AVERAGE
    // is not a reason to report the measurements as absent.
    const reading = latestReading(LIVE, '2026-08-29', 30);
    expect(reading.value).not.toBeNull();
    expect(reading.observations).toBe(4);
  });

  it('skips over a day with no measurement rather than reading it as zero', () => {
    const reading = latestReading(
      [...LIVE.slice(0, 3), { date: '2026-08-28', value: null }],
      '2026-08-28',
      30,
    );
    expect(reading.value).toBe(58);
    expect(reading.inputs.observedOn).toBe('2026-08-26');
  });

  it('treats a measured zero as a reading, not as missing (spec §33)', () => {
    const reading = latestReading([{ date: '2026-08-28', value: 0 }], '2026-08-28', 30);
    expect(reading.value).toBe(0);
    expect(reading.confidence).not.toBe('INSUFFICIENT');
  });

  it('reports how old the reading is, so it is not read as today’s', () => {
    const reading = latestReading(LIVE, '2026-08-31', 30);
    expect(reading.inputs.ageDays).toBe(3);
    expect(reading.notes[0]).toContain('2026-08-28');
    expect(reading.notes[0]).toContain('not an estimate');
  });

  it('adds no staleness note when the reading is from the day itself', () => {
    const reading = latestReading(LIVE, '2026-08-28', 30);
    expect(reading.inputs.ageDays).toBe(0);
    expect(reading.notes).toEqual([]);
  });

  it('degrades confidence as the reading ages', () => {
    expect(latestReading(LIVE, '2026-08-29', 30).confidence).toBe('HIGH');
    expect(latestReading(LIVE, '2026-09-02', 30).confidence).toBe('MODERATE');
    expect(latestReading(LIVE, '2026-09-10', 30).confidence).toBe('LOW');
  });

  it('refuses a reading older than the window rather than reaching back', () => {
    const reading = latestReading(LIVE, '2026-10-30', 30);
    expect(reading.value).toBeNull();
    expect(reading.confidence).toBe('INSUFFICIENT');
    // Zero observations IN THE WINDOW is the "nothing to show" case, which the
    // UI renders as "not logged" - correctly, for this window.
    expect(reading.observations).toBe(0);
  });

  it('distinguishes never-logged from too-sparse via observations', () => {
    const never = latestReading([], '2026-08-29', 30);
    expect(never.value).toBeNull();
    expect(never.observations).toBe(0);
    expect(never.notes[0]).toContain('No measurement');
  });
});
