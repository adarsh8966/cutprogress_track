import { describe, it, expect } from 'vitest';
import {
  lbToKg, kgToLb, milesToKm, kmToMiles, inchesToCm, cmToInches,
  feetInchesToCm, cmToFeetInches, canonicalWeight, displayWeight,
} from '@/lib/normalization/units';
import {
  toLocalDate, localToday, addDays, daysBetween, dateRange, lastNDays,
  startOfWeek, endOfWeek, startOfMonth, endOfMonth, monthKey, isLocalDate,
  isValidTimezone,
} from '@/lib/normalization/dates';

describe('unit conversion (spec §39)', () => {
  it('round-trips weight without drift', () => {
    for (const lb of [180, 205.4, 92.5, 1]) {
      expect(kgToLb(lbToKg(lb))).toBeCloseTo(lb, 10);
    }
  });

  it('round-trips distance without drift', () => {
    for (const mi of [3.1, 26.2, 0.5]) {
      expect(kmToMiles(milesToKm(mi))).toBeCloseTo(mi, 10);
    }
  });

  it('converts the profile baseline correctly', () => {
    // 205 lb and 5'10" from the spec's starting profile.
    expect(lbToKg(205)).toBeCloseTo(92.986, 3);
    expect(feetInchesToCm(5, 10)).toBeCloseTo(177.8, 4);
  });

  it('round-trips feet and inches', () => {
    const { feet, inches } = cmToFeetInches(feetInchesToCm(5, 10));
    expect(feet).toBe(5);
    expect(inches).toBeCloseTo(10, 8);
  });

  it('leaves canonical values untouched when the display unit is already metric', () => {
    expect(canonicalWeight(92.986, 'KG')).toBe(92.986);
    expect(displayWeight(92.986, 'KG')).toBe(92.986);
  });

  it('converts inches and centimetres symmetrically', () => {
    expect(cmToInches(inchesToCm(34))).toBeCloseTo(34, 10);
  });
});

describe('timezone-correct dates (spec §40)', () => {
  it('puts a late-night workout on the local day, not the UTC day', () => {
    // 23:30 on 28 Aug in New York is 03:30 on 29 Aug UTC. The workout belongs
    // to the 28th. This is the exact bug the spec calls out.
    const instant = new Date('2026-08-29T03:30:00Z');
    expect(toLocalDate(instant, 'America/New_York')).toBe('2026-08-28');
    expect(toLocalDate(instant, 'UTC')).toBe('2026-08-29');
  });

  it('handles the other direction across the date line', () => {
    const instant = new Date('2026-08-28T20:00:00Z');
    expect(toLocalDate(instant, 'Asia/Tokyo')).toBe('2026-08-29');
    expect(toLocalDate(instant, 'America/Los_Angeles')).toBe('2026-08-28');
  });

  it('survives a daylight-saving transition', () => {
    // US DST ends 1 Nov 2026. Adding days must not slip an hour into the
    // previous day.
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02');
    expect(daysBetween('2026-10-25', '2026-11-05')).toBe(11);
  });

  it('counts days across a leap day', () => {
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('builds inclusive ranges', () => {
    expect(dateRange('2026-08-26', '2026-08-28')).toEqual([
      '2026-08-26', '2026-08-27', '2026-08-28',
    ]);
    expect(dateRange('2026-08-28', '2026-08-26')).toEqual([]);
    expect(lastNDays('2026-08-28', 3)).toEqual([
      '2026-08-26', '2026-08-27', '2026-08-28',
    ]);
  });

  it('runs weeks Monday to Sunday', () => {
    // 2026-08-28 is a Friday.
    expect(startOfWeek('2026-08-28')).toBe('2026-08-24');
    expect(endOfWeek('2026-08-28')).toBe('2026-08-30');
    // A Sunday belongs to the week that started the previous Monday.
    expect(startOfWeek('2026-08-30')).toBe('2026-08-24');
  });

  it('bounds months, including February in a leap year', () => {
    expect(startOfMonth('2026-08-28')).toBe('2026-08-01');
    expect(endOfMonth('2026-08-28')).toBe('2026-08-31');
    expect(endOfMonth('2026-02-10')).toBe('2026-02-28');
    expect(endOfMonth('2028-02-10')).toBe('2028-02-29');
    expect(monthKey('2026-08-28')).toBe('2026-08');
  });

  it('validates date and timezone strings', () => {
    expect(isLocalDate('2026-08-28')).toBe(true);
    expect(isLocalDate('2026-02-30')).toBe(false);
    expect(isLocalDate('28-08-2026')).toBe(false);
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('Mars/Olympus_Mons')).toBe(false);
  });

  it('reports today in the user timezone', () => {
    const now = new Date('2026-08-29T02:00:00Z');
    expect(localToday('America/New_York', now)).toBe('2026-08-28');
    expect(localToday('Europe/London', now)).toBe('2026-08-29');
  });
});
