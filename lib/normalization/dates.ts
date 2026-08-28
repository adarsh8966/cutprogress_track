/**
 * Timezone-correct date handling (spec §40).
 *
 * Daily aggregation happens in the USER'S LOCAL TIMEZONE, never UTC. A workout
 * logged at 23:30 local time belongs to that day, not to tomorrow - which is
 * exactly what happens if you take the UTC date of the timestamp.
 *
 * Implemented with Intl rather than a date library: it is dependency-free, uses
 * the platform's IANA database, and handles DST correctly because it asks the
 * runtime what the wall-clock date actually was.
 */
import type { LocalDate } from '@/lib/types';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timezone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  formatterCache.set(timezone, formatter);
  return formatter;
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function isLocalDate(value: string): value is LocalDate {
  if (!ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return (
    probe.getUTCFullYear() === y &&
    probe.getUTCMonth() === m - 1 &&
    probe.getUTCDate() === d
  );
}

/**
 * The calendar date an instant falls on, as seen from the user's timezone.
 * This is the single function that decides which day a record belongs to.
 */
export function toLocalDate(instant: Date, timezone: string): LocalDate {
  // en-CA formats as YYYY-MM-DD, which is the shape we store.
  return formatterFor(timezone).format(instant);
}

/** Today in the user's timezone. */
export function localToday(timezone: string, now: Date = new Date()): LocalDate {
  return toLocalDate(now, timezone);
}

/** Treats a LocalDate as midday UTC, avoiding DST edges in date-only maths. */
function toUtcNoon(date: LocalDate): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

function fromUtcNoon(instant: Date): LocalDate {
  const y = instant.getUTCFullYear();
  const m = String(instant.getUTCMonth() + 1).padStart(2, '0');
  const d = String(instant.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const instant = toUtcNoon(date);
  instant.setUTCDate(instant.getUTCDate() + days);
  return fromUtcNoon(instant);
}

/** Whole days from `from` to `to`. Negative when `to` precedes `from`. */
export function daysBetween(from: LocalDate, to: LocalDate): number {
  const ms = toUtcNoon(to).getTime() - toUtcNoon(from).getTime();
  return Math.round(ms / 86_400_000);
}

export function compareDates(a: LocalDate, b: LocalDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Inclusive list of every date from `start` to `end`. */
export function dateRange(start: LocalDate, end: LocalDate): LocalDate[] {
  const span = daysBetween(start, end);
  if (span < 0) return [];
  return Array.from({ length: span + 1 }, (_, i) => addDays(start, i));
}

/** The `count` dates ending on `end`, oldest first. */
export function lastNDays(end: LocalDate, count: number): LocalDate[] {
  if (count <= 0) return [];
  return dateRange(addDays(end, -(count - 1)), end);
}

/** ISO weeks start Monday; the spec's weekly review runs Monday to Sunday. */
export function startOfWeek(date: LocalDate): LocalDate {
  const dow = toUtcNoon(date).getUTCDay(); // 0 = Sunday
  const offset = dow === 0 ? -6 : 1 - dow;
  return addDays(date, offset);
}

export function endOfWeek(date: LocalDate): LocalDate {
  return addDays(startOfWeek(date), 6);
}

export function startOfMonth(date: LocalDate): LocalDate {
  return `${date.slice(0, 7)}-01`;
}

export function endOfMonth(date: LocalDate): LocalDate {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${date.slice(0, 7)}-${String(lastDay).padStart(2, '0')}`;
}

/** `2026-08` - the key monthly summaries are grouped by (spec §31). */
export function monthKey(date: LocalDate): string {
  return date.slice(0, 7);
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function formatMonth(key: string): string {
  const [y, m] = key.split('-').map(Number) as [number, number];
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

/** `Aug 28` - compact axis and table label. */
export function formatShortDate(date: LocalDate): string {
  const [, m, d] = date.split('-').map(Number) as [number, number, number];
  return `${MONTH_NAMES[m - 1]!.slice(0, 3)} ${d}`;
}
