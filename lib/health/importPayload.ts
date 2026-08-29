/**
 * The bridge between what the review screen SHOWS and what the import WRITES.
 *
 * This is the one piece of the importer where a quiet mistake is invisible: the
 * user sees 92.4 kg, the database receives something else, and nothing in the
 * UI ever says so. Keeping it here - pure, with no React and no Supabase - is
 * what makes it testable, so the agreement between the two is a property with a
 * test rather than a hope.
 *
 * Two rules:
 *
 *  1. AN UNTOUCHED FIELD SUBMITS THE PARSER'S NUMBER. Display values are
 *     rounded for reading. Re-deriving a canonical value from a rounded string
 *     would change a number the review screen presented as exact - 92.4 kg
 *     shown as 203.7 lb and converted back is 92.39978 kg.
 *
 *  2. A FIELD WITH NO COLUMN IS NAMED, NOT DROPPED. workout_sessions has no
 *     distance and no heart-rate zone, so a distance written under a `Workout:`
 *     block is reported as unsaveable rather than silently discarded.
 */
import type {
  ParsedField, SessionFieldKey, DayFieldKey, SessionKind,
} from '@/lib/health/parser';
import type { CardioTypeEnum, SessionTypeEnum } from '@/lib/supabase/types';
import {
  displayWeight, canonicalWeight, displayLength, canonicalLength,
  displayDistance, canonicalDistance,
  WEIGHT_UNIT_LABEL, LENGTH_UNIT_LABEL, DISTANCE_UNIT_LABEL,
  type WeightUnit, type LengthUnit, type DistanceUnit,
} from '@/lib/normalization/units';

export interface DisplayUnits {
  weight: WeightUnit;
  length: LengthUnit;
  distance: DistanceUnit;
}

export interface FieldRow<K> {
  key: K;
  label: string;
  unit: string;
  /** Canonical → display, for the fields stored in metric units. */
  toDisplay?: (canonical: number) => number;
  /** Display → canonical, applied on submit. */
  toCanonical?: (display: number) => number;
  step?: string;
}

export const DAY_FIELD_ORDER: DayFieldKey[] = [
  'weightKg', 'waistCm', 'calories', 'proteinG', 'carbsG', 'fatG', 'fiberG',
  'steps', 'activeCalories', 'sleepMinutes', 'restingHeartRate', 'hrvMs',
];

const DAY_LABEL: Record<DayFieldKey, string> = {
  weightKg: 'Weight', waistCm: 'Waist', calories: 'Calories', proteinG: 'Protein',
  carbsG: 'Carbohydrate', fatG: 'Fat', fiberG: 'Fibre', steps: 'Steps',
  activeCalories: 'Active calories', sleepMinutes: 'Sleep',
  restingHeartRate: 'Resting heart rate', hrvMs: 'HRV',
};

const DAY_UNIT: Record<DayFieldKey, string> = {
  weightKg: '', waistCm: '', calories: 'kcal', proteinG: 'g', carbsG: 'g',
  fatG: 'g', fiberG: 'g', steps: '', activeCalories: 'kcal',
  sleepMinutes: 'min', restingHeartRate: 'bpm', hrvMs: 'ms',
};

export const SESSION_FIELD_LABEL: Record<SessionFieldKey, string> = {
  sessionMinutes: 'Duration',
  distanceKm: 'Distance',
  averageHeartRate: 'Average HR',
  maxHeartRate: 'Maximum HR',
  sessionCalories: 'Calories burned',
  hrZone: 'HR zone',
};

/**
 * Which session fields each table can actually hold. workout_sessions has
 * duration, the two heart rates and calories; cardio_sessions adds distance and
 * the zone.
 */
export const WORKOUT_FIELDS: SessionFieldKey[] = [
  'sessionMinutes', 'averageHeartRate', 'maxHeartRate', 'sessionCalories',
];
export const CARDIO_FIELDS: SessionFieldKey[] = [
  'sessionMinutes', 'distanceKm', 'averageHeartRate', 'maxHeartRate',
  'sessionCalories', 'hrZone',
];

export function storableFields(kind: SessionKind): SessionFieldKey[] {
  return kind === 'WORKOUT' ? WORKOUT_FIELDS : CARDIO_FIELDS;
}

export function dayRow(key: DayFieldKey, units: DisplayUnits): FieldRow<DayFieldKey> {
  if (key === 'weightKg') {
    return {
      key, label: DAY_LABEL[key], unit: WEIGHT_UNIT_LABEL[units.weight], step: '0.1',
      toDisplay: (kg) => displayWeight(kg, units.weight),
      toCanonical: (value) => canonicalWeight(value, units.weight),
    };
  }
  if (key === 'waistCm') {
    return {
      key, label: DAY_LABEL[key], unit: LENGTH_UNIT_LABEL[units.length], step: '0.1',
      toDisplay: (cm) => displayLength(cm, units.length),
      toCanonical: (value) => canonicalLength(value, units.length),
    };
  }
  // A step count is whole, and the confirm schema enforces that, so the input
  // should not invite a fractional one.
  return {
    key, label: DAY_LABEL[key], unit: DAY_UNIT[key],
    ...(key === 'steps' ? { step: '1' } : {}),
  };
}

export function sessionFieldRow(
  key: SessionFieldKey, units: DisplayUnits,
): FieldRow<SessionFieldKey> {
  if (key === 'distanceKm') {
    return {
      key, label: SESSION_FIELD_LABEL[key], unit: DISTANCE_UNIT_LABEL[units.distance],
      step: '0.01',
      toDisplay: (km) => displayDistance(km, units.distance),
      toCanonical: (value) => canonicalDistance(value, units.distance),
    };
  }
  const unit =
    key === 'sessionMinutes' ? 'min'
      : key === 'sessionCalories' ? 'kcal'
        : key === 'hrZone' ? '' : 'bpm';
  // hr_zone is a smallint bucket, not a measurement.
  return {
    key, label: SESSION_FIELD_LABEL[key], unit,
    ...(key === 'hrZone' ? { step: '1' } : {}),
  };
}

// ---------------------------------------------------------------------------
// Paths, so the edit state is one flat map rather than nested React state
// ---------------------------------------------------------------------------

export function dayPath(record: number, key: DayFieldKey): string {
  return `${record}.${key}`;
}

export function sessionPath(record: number, session: number, key: SessionFieldKey): string {
  return `${record}.s${session}.${key}`;
}

export function sessionTypePath(record: number, session: number): string {
  return `${record}.s${session}`;
}

/** What the review screen is holding: display strings plus what was edited. */
export interface EditState {
  dates: string[];
  values: Record<string, string>;
  /** The parser's canonical numbers, by path. */
  canonical: Record<string, number>;
  dirty: Record<string, boolean>;
  /** The chosen enum per session, by sessionTypePath. */
  types: Record<string, string>;
  /**
   * Sessions the reviewer removed, by sessionTypePath. A session the parser
   * found but the user does not want written has to be droppable, or one
   * unfixable session blocks the whole paste.
   */
  removed: Record<string, boolean>;
  /**
   * Per session, what to do about one already recorded on the same day, keyed
   * by sessionTypePath. Absent means ADD, which is what the importer has always
   * done and stays the default.
   */
  dispositions: Record<string, SessionDisposition>;
  /** The existing session id a REPLACE targets, by sessionTypePath. */
  supersedes: Record<string, string>;
}

export function emptyEdits(): EditState {
  return {
    dates: [], values: {}, canonical: {}, dirty: {}, types: {}, removed: {},
    dispositions: {}, supersedes: {},
  };
}

/** Rounds for display without pretending to more precision than was read. */
export function forDisplay(value: number, row: FieldRow<unknown>): string {
  const display = row.toDisplay ? row.toDisplay(value) : value;
  return String(Math.round(display * 100) / 100);
}

/**
 * The canonical number a field will be saved as. Returns null for a blank
 * field, which is "not logged" - never zero.
 */
export function canonicalValue(
  path: string, row: FieldRow<unknown>, edits: EditState,
): number | null {
  const text = (edits.values[path] ?? '').trim();
  if (text === '') return null;
  if (!edits.dirty[path] && edits.canonical[path] !== undefined) {
    return edits.canonical[path]!;
  }
  const entered = Number(text);
  if (!Number.isFinite(entered)) return null;
  return row.toCanonical ? row.toCanonical(entered) : entered;
}

// ---------------------------------------------------------------------------
// Building the payload
// ---------------------------------------------------------------------------

/** The parts of a previewed session this module needs. */
export interface PayloadSession {
  kind: SessionKind;
  rawLabel: string;
  sessionType: SessionTypeEnum;
  cardioType: CardioTypeEnum;
  fields: ParsedField[];
}

export interface PayloadRecord {
  fields: ParsedField[];
  sessions: PayloadSession[];
  rawText: string;
  /** The date the parser resolved, or null when it found none it trusts. */
  targetDate: string | null;
}

export type SessionDisposition = 'ADD' | 'REPLACE' | 'KEEP';

export interface ConfirmSessionValues {
  kind: SessionKind;
  sessionType: SessionTypeEnum;
  cardioType: CardioTypeEnum;
  rawLabel: string;
  sessionMinutes: number | null;
  distanceKm: number | null;
  averageHeartRate: number | null;
  maxHeartRate: number | null;
  sessionCalories: number | null;
  hrZone: number | null;
  /** What to do about a session already on this day. See app/actions/import.ts. */
  disposition: SessionDisposition;
  /** The session REPLACE supersedes. Null for ADD and KEEP. */
  supersedes: string | null;
}

export type ConfirmRecordValues =
  { rawText: string; date: string; sessions: ConfirmSessionValues[] }
  & Record<DayFieldKey, number | null>;

export interface ConfirmPayloadValues {
  records: ConfirmRecordValues[];
}

/** Seeds the edit state from a fresh parse. */
export function editsFromPreview(
  records: PayloadRecord[], units: DisplayUnits, fallbackDate: string,
): EditState {
  const edits = emptyEdits();
  records.forEach((record, r) => {
    for (const key of DAY_FIELD_ORDER) {
      const field = record.fields.find((f) => f.key === key);
      if (!field || typeof field.value !== 'number') continue;
      const row = dayRow(key, units);
      const path = dayPath(r, key);
      edits.canonical[path] = field.value;
      edits.values[path] = forDisplay(field.value, row);
    }
    record.sessions.forEach((session, s) => {
      edits.types[sessionTypePath(r, s)] =
        session.kind === 'WORKOUT' ? session.sessionType : session.cardioType;
      for (const key of storableFields(session.kind)) {
        const field = session.fields.find((f) => f.key === key);
        if (!field || typeof field.value !== 'number') continue;
        const row = sessionFieldRow(key, units);
        const path = sessionPath(r, s, key);
        edits.canonical[path] = field.value;
        edits.values[path] = forDisplay(field.value, row);
      }
    });
  });
  // Each record keeps its OWN date. Seeding them all from the fallback and
  // relying on the caller to overwrite it would put every day of a week-long
  // paste on the same date the moment someone forgot to.
  edits.dates = records.map((record) => record.targetDate ?? fallbackDate);
  return edits;
}

export function buildConfirmPayload(
  records: PayloadRecord[], edits: EditState, units: DisplayUnits, fallbackDate: string,
): ConfirmPayloadValues {
  return {
    records: records.map((record, r) => {
      const day = {} as Record<DayFieldKey, number | null>;
      for (const key of DAY_FIELD_ORDER) {
        day[key] = canonicalValue(dayPath(r, key), dayRow(key, units), edits);
      }

      const sessions = record.sessions.flatMap((session, s): ConfirmSessionValues[] => {
        if (edits.removed[sessionTypePath(r, s)]) return [];
        const read = (key: SessionFieldKey): number | null =>
          storableFields(session.kind).includes(key)
            ? canonicalValue(sessionPath(r, s, key), sessionFieldRow(key, units), edits)
            : null;

        const typePath = sessionTypePath(r, s);
        const chosen = edits.types[typePath];
        const disposition = edits.dispositions[typePath] ?? 'ADD';
        return [{
          kind: session.kind,
          sessionType: (session.kind === 'WORKOUT' && chosen
            ? chosen as SessionTypeEnum : session.sessionType),
          cardioType: (session.kind === 'CARDIO' && chosen
            ? chosen as CardioTypeEnum : session.cardioType),
          rawLabel: session.rawLabel,
          sessionMinutes: read('sessionMinutes'),
          distanceKm: read('distanceKm'),
          averageHeartRate: read('averageHeartRate'),
          maxHeartRate: read('maxHeartRate'),
          sessionCalories: read('sessionCalories'),
          hrZone: read('hrZone'),
          disposition,
          supersedes: disposition === 'REPLACE' ? edits.supersedes[typePath] ?? null : null,
        }];
      });

      return { rawText: record.rawText, date: edits.dates[r] ?? fallbackDate, ...day, sessions };
    }),
  };
}

/**
 * Session fields the parser read that this session's table cannot hold. Shown
 * in review so the promise the screen makes matches what the write can keep.
 */
export function unstorableFields(session: PayloadSession): ParsedField[] {
  const storable = storableFields(session.kind);
  return session.fields.filter(
    (field) => !storable.includes(field.key as SessionFieldKey),
  );
}

/** The rows a confirm would actually write, phrased for the review screen. */
export function summariseWrites(record: ConfirmRecordValues): string[] {
  const parts: string[] = [];
  if (record.weightKg != null || record.waistCm != null) parts.push('1 body measurement');

  const macros = [record.calories, record.proteinG, record.carbsG, record.fatG, record.fiberG];
  if (macros.some((v) => v != null)) parts.push('1 nutrition log');

  const metrics = [record.steps, record.activeCalories, record.restingHeartRate, record.hrvMs]
    .filter((v) => v != null).length;
  if (metrics > 0) parts.push(`${metrics} metric observation${metrics === 1 ? '' : 's'}`);

  if (record.sleepMinutes != null) parts.push('1 sleep record');

  // A session the reviewer chose to KEEP writes nothing, so it must not be
  // counted here: the line is a promise about what confirming will do.
  const writing = record.sessions.filter((s) => s.disposition !== 'KEEP');

  const workouts = writing.filter((s) => s.kind === 'WORKOUT').length;
  if (workouts > 0) parts.push(`${workouts} workout${workouts === 1 ? '' : 's'}`);

  const cardio = writing.filter((s) => s.kind === 'CARDIO').length;
  if (cardio > 0) parts.push(`${cardio} cardio session${cardio === 1 ? '' : 's'}`);

  const replacing = writing.filter((s) => s.disposition === 'REPLACE').length;
  if (replacing > 0) {
    parts.push(
      `replacing ${replacing} existing session${replacing === 1 ? '' : 's'}`,
    );
  }

  const keeping = record.sessions.length - writing.length;
  if (keeping > 0) {
    parts.push(`keeping ${keeping} existing session${keeping === 1 ? '' : 's'} as recorded`);
  }

  return parts;
}
