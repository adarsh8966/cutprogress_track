/**
 * Series primitives (spec §7, §18, §33).
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: a missing measurement is null, and null
 * is never treated as zero. `presentValues` is the only sanctioned way to drop
 * nulls from a series, and it reports how much it dropped so every downstream
 * calculation can decide whether the remaining coverage is good enough.
 *
 * Averaging over "days that have data" and averaging over "days in the window"
 * are different questions. Everything here answers the first and reports
 * coverage, so the caller can never silently confuse them.
 */
import type { DatedValue, LocalDate } from '@/lib/types';
import { addDays, compareDates, daysBetween } from '@/lib/normalization/dates';

export interface Coverage {
  /** Days in the requested window. */
  window: number;
  /** Days in the window that carry an actual measurement. */
  present: number;
  /** present / window, 0..1. */
  ratio: number;
}

export function coverageOf(values: (number | null)[]): Coverage {
  const present = values.filter((v) => v !== null).length;
  const window = values.length;
  return { window, present, ratio: window === 0 ? 0 : present / window };
}

/**
 * Drops nulls. The ONLY place in the codebase permitted to do so.
 * Note this filters null and undefined but keeps 0, which is a real measurement.
 */
export function presentValues(values: (number | null | undefined)[]): number[] {
  const out: number[] = [];
  for (const v of values) {
    if (v === null || v === undefined) continue;
    if (!Number.isFinite(v)) continue;
    out.push(v);
  }
  return out;
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function sum(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0);
}

export function standardDeviation(values: number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values)!;
  const variance =
    values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Coefficient of variation: sd / |mean|. Used by plateau detection to ask
 * "were calories actually stable?" in a scale-free way (spec §19).
 * Null when the mean is zero or too few points exist.
 */
export function coefficientOfVariation(values: number[]): number | null {
  const m = mean(values);
  const sd = standardDeviation(values);
  if (m === null || sd === null || m === 0) return null;
  return sd / Math.abs(m);
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

/**
 * Builds a gap-filled series over every date in [start, end]. Days with no
 * observation appear as an explicit null rather than being absent, so window
 * arithmetic is over calendar days and coverage is measurable.
 */
export function densify(
  points: DatedValue[],
  start: LocalDate,
  end: LocalDate,
): DatedValue[] {
  const byDate = new Map<LocalDate, number | null>();
  for (const point of points) {
    // Later observations for the same date win; canonical resolution has
    // already happened upstream, so duplicates here are just re-reads.
    byDate.set(point.date, point.value);
  }
  const span = daysBetween(start, end);
  if (span < 0) return [];
  return Array.from({ length: span + 1 }, (_, i) => {
    const date = addDays(start, i);
    return { date, value: byDate.get(date) ?? null };
  });
}

export function sortByDate(points: DatedValue[]): DatedValue[] {
  return [...points].sort((a, b) => compareDates(a.date, b.date));
}

/** The most recent point that actually carries a value. */
export function latestPresent(points: DatedValue[]): DatedValue | null {
  const sorted = sortByDate(points);
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const point = sorted[i]!;
    if (point.value !== null) return point;
  }
  return null;
}

/** The `count` most recent calendar days ending at `end`, gap-filled. */
export function trailingWindow(
  points: DatedValue[],
  end: LocalDate,
  count: number,
): DatedValue[] {
  if (count <= 0) return [];
  return densify(points, addDays(end, -(count - 1)), end);
}

export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
