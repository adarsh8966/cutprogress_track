/**
 * What confirming an import will actually DO to each value (spec §8, §16, §38).
 *
 * THE RULE THIS SERVES. The review screen must never let the user believe
 * something will be saved when it will be discarded, and must never let a
 * number appear to change a day it will leave untouched. Counts and warnings
 * cannot say either of those things; only a per-value verdict can.
 *
 * Pure, so the verdict is a property with a test rather than a rendering
 * accident. It compares the CANONICAL value the import would write against the
 * CANONICAL value the day already resolves to - the same numbers, in the same
 * units, that lib/normalization/canonical.ts works in.
 *
 * The six verdicts, and what each promises:
 *
 *   NEW        nothing is recorded for this field on this day yet
 *   UPDATED    a value exists and this will become the day's value instead
 *   DUPLICATE  a value exists and is the same; confirming changes nothing
 *   CONFLICT   a value exists, from a DIFFERENT source, and disagrees. This
 *              still wins - resolution is newest-first - but two sources
 *              disagreeing is worth stopping over, which UPDATED would not say
 *   IGNORED    nothing will be written for this field
 *   INVALID    the value cannot be stored, and confirming will be refused
 *
 * UPDATED vs CONFLICT is the same distinction the resolver draws between a
 * correction and a disagreement, made before the write rather than after it.
 */
import type { DataSource } from '@/lib/types';
import type { DayFieldKey } from '@/lib/health/parser';
import { AGREEMENT_TOLERANCE } from '@/lib/normalization/canonical';
import { checkObservation } from '@/lib/validation/observations';

export type ValueStatus =
  | 'NEW'
  | 'UPDATED'
  | 'DUPLICATE'
  | 'CONFLICT'
  | 'IGNORED'
  | 'INVALID'
  | 'REPLACE';

export interface FieldVerdict {
  status: ValueStatus;
  /** The canonical value already resolved for this day, when there is one. */
  existing: number | null;
  /** Which source that existing value came from. */
  existingSource: DataSource | null;
  /** Why this verdict, in a sentence the review screen can print as-is. */
  reason: string;
}

/**
 * The parser's day-field names against the canonical field names the resolver
 * and daily_metrics use. Three of them differ, and getting one wrong would
 * make a field permanently read as NEW.
 */
export const CANONICAL_FIELD: Record<DayFieldKey, string> = {
  weightKg: 'weightKg',
  waistCm: 'waistCm',
  calories: 'caloriesConsumed',
  proteinG: 'proteinG',
  carbsG: 'carbsG',
  fatG: 'fatG',
  fiberG: 'fiberG',
  steps: 'steps',
  activeCalories: 'activeCalories',
  restingHeartRate: 'restingHeartRate',
  hrvMs: 'hrvMs',
  sleepMinutes: 'sleepDurationMinutes',
};

/** What a day already holds, as the canonical layer resolved it. */
export interface ExistingDay {
  values: Record<string, number | null>;
  sources: Record<string, DataSource>;
  /**
   * False when the day could not be read. The review must then say it does not
   * know, rather than showing everything as NEW - which would promise the user
   * they were adding data when they may be replacing it.
   */
  known: boolean;
}

export const UNKNOWN_DAY: ExistingDay = { values: {}, sources: {}, known: false };

/** Two canonical values that agree to within the resolver's own tolerance. */
export function sameValue(a: number, b: number): boolean {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / scale <= AGREEMENT_TOLERANCE;
}

export function dayFieldVerdict(
  key: DayFieldKey,
  /** The canonical value that would be written, or null when blank. */
  proposed: number | null,
  day: ExistingDay,
  /** The source this import writes as. */
  source: DataSource = 'IMPORT_TEXT',
): FieldVerdict {
  const canonicalKey = CANONICAL_FIELD[key];
  const existing = day.values[canonicalKey] ?? null;
  const existingSource = day.sources[canonicalKey] ?? null;

  if (proposed === null) {
    return {
      status: 'IGNORED',
      existing,
      existingSource,
      reason: existing === null
        ? 'Not in this paste, and not recorded for this day. Nothing will be written.'
        : 'Not in this paste. The value already recorded for this day is unchanged.',
    };
  }

  const problem = checkObservation(key, proposed);
  if (problem !== null) {
    return {
      status: 'INVALID',
      existing,
      existingSource,
      reason: `${problem} This day cannot be imported until it is corrected or cleared.`,
    };
  }

  if (!day.known) {
    return {
      status: 'NEW',
      existing: null,
      existingSource: null,
      reason:
        'What this day already holds could not be read, so whether this replaces an '
        + 'existing value is unknown. It will be recorded either way.',
    };
  }

  if (existing === null) {
    return {
      status: 'NEW',
      existing: null,
      existingSource: null,
      reason: 'Nothing is recorded for this field on this day.',
    };
  }

  if (sameValue(existing, proposed)) {
    return {
      status: 'DUPLICATE',
      existing,
      existingSource,
      reason:
        'The same value is already recorded for this day. The observation is still '
        + 'written, and the day resolves to the same number.',
    };
  }

  // Two sources that disagree is a different thing from one source correcting
  // itself, and only the first is worth interrupting over.
  if (existingSource !== null && existingSource !== source) {
    return {
      status: 'CONFLICT',
      existing,
      existingSource,
      reason:
        `This disagrees with the value already recorded from ${
          existingSource.replaceAll('_', ' ').toLowerCase()
        }. The newer observation wins, so this will become the day's value. `
        + 'Neither reading is deleted.',
    };
  }

  return {
    status: 'UPDATED',
    existing,
    existingSource,
    reason: "This will become the day's value. The earlier observation is kept.",
  };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface ExistingSessionLike {
  id: string;
  kind: 'WORKOUT' | 'CARDIO';
  label: string;
  durationMinutes: number | null;
}

export interface SessionVerdict {
  status: ValueStatus;
  /** The session this one duplicates or replaces, when there is one. */
  match: ExistingSessionLike | null;
  reason: string;
}

/**
 * What confirming will do with one session.
 *
 * The stakes are higher here than for a scalar, because daily_metrics SUMS a
 * day's sessions rather than resolving them: a second copy of the same session
 * is not a harmless duplicate observation, it permanently doubles the day's
 * minutes. So an ADD that matches something already on the day is called a
 * DUPLICATE rather than NEW, with the row it matches named.
 */
export function sessionVerdict(input: {
  kind: 'WORKOUT' | 'CARDIO';
  /** The chosen enum, e.g. 'PULL' or 'INCLINE_WALKING'. */
  type: string;
  minutes: number | null;
  disposition: 'ADD' | 'REPLACE' | 'KEEP';
  supersedes: string | null;
  removed: boolean;
  existing: ExistingSessionLike[];
  /** Set when the session cannot be written at all. */
  invalidReason?: string | null;
  /** False when the day's sessions could not be read. */
  known?: boolean;
}): SessionVerdict {
  if (input.removed) {
    return {
      status: 'IGNORED',
      match: null,
      reason: 'Marked not to import. Nothing will be written for this session.',
    };
  }

  if (input.invalidReason) {
    return {
      status: 'INVALID',
      match: null,
      reason: `${input.invalidReason} This day cannot be imported until it is fixed.`,
    };
  }

  const candidates = input.existing.filter((row) => row.kind === input.kind);

  if (input.disposition === 'KEEP') {
    return {
      status: 'IGNORED',
      match: candidates[0] ?? null,
      reason:
        'Set to keep what is already on this day. Nothing will be written for this '
        + 'session.',
    };
  }

  if (input.disposition === 'REPLACE') {
    const match = candidates.find((row) => row.id === input.supersedes) ?? null;
    return {
      status: 'REPLACE',
      match,
      reason: match === null
        ? 'Set to replace an existing session, but the session it replaces is not set.'
        : `Writes this session and stops the existing ${describe(match)} counting `
          + 'towards the day. Neither row is deleted.',
    };
  }

  if (input.known === false) {
    return {
      status: 'NEW',
      match: null,
      reason:
        'The sessions already on this day could not be read, so whether this adds to '
        + "one is unknown. A day's minutes are the total of its sessions.",
    };
  }

  // ADD, with something already on the day that looks like the same session.
  const twin = candidates.find(
    (row) =>
      row.label === input.type
      && ((row.durationMinutes === null && input.minutes === null)
        || (row.durationMinutes !== null
          && input.minutes !== null
          && sameValue(row.durationMinutes, input.minutes))),
  );
  if (twin) {
    return {
      status: 'DUPLICATE',
      match: twin,
      reason:
        `This day already has ${describe(twin)}. Adding it again gives the day both, `
        + "and a day's minutes are the total of its sessions. Choose Replace, or "
        + 'Keep what is there.',
    };
  }

  if (candidates.length > 0) {
    return {
      status: 'NEW',
      match: candidates[0] ?? null,
      reason:
        `Written alongside the ${candidates.length} ${
          input.kind === 'WORKOUT' ? 'workout' : 'cardio session'
        }${candidates.length === 1 ? '' : 's'} already on this day.`,
    };
  }

  return { status: 'NEW', match: null, reason: 'Nothing like this is recorded for this day.' };
}

function describe(row: ExistingSessionLike): string {
  const label = row.label.replaceAll('_', ' ').toLowerCase();
  return row.durationMinutes === null
    ? `${label} session with no duration logged`
    : `${label} session of ${row.durationMinutes} min`;
}

/** Sorted so the review screen can lead with what needs attention. */
export const STATUS_ORDER: ValueStatus[] = [
  'INVALID', 'CONFLICT', 'DUPLICATE', 'REPLACE', 'UPDATED', 'NEW', 'IGNORED',
];

/** True when confirming is refused while this verdict stands. */
export function blocksImport(status: ValueStatus): boolean {
  return status === 'INVALID';
}
