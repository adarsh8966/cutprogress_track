/**
 * Import idempotency (spec §38).
 *
 * "If you paste the same Bevel report twice: it should NOT duplicate your data."
 *
 * The key is a SHA-256 over the normalised paste text plus the target date. It
 * is stored with a UNIQUE (user_id, idempotency_key) constraint, so the second
 * paste is refused by the database rather than by application logic that could
 * be bypassed or race.
 *
 * Normalisation deliberately ignores things that do not change meaning -
 * whitespace runs, trailing spaces, blank lines, letter case - so a report
 * re-copied with slightly different spacing is still recognised as the same
 * report. It does NOT ignore digits or punctuation, so a genuinely edited value
 * produces a different key and imports as new data.
 */
import { createHash } from 'node:crypto';
import type { LocalDate } from '@/lib/types';

export function normaliseForHashing(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, ' ').toLowerCase())
    .filter((line) => line !== '')
    .join('\n');
}

export function idempotencyKey(rawText: string, targetDate: LocalDate | null): string {
  const normalised = normaliseForHashing(rawText);
  return createHash('sha256')
    .update(`${targetDate ?? 'no-date'} ${normalised}`)
    .digest('hex');
}

/** Content hash for a generated Context Pack (spec §30). */
export function contentHash(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}
