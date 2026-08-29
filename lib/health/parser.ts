/**
 * Paste ingestion parser (spec §8, §28, §38).
 *
 * Turns a pasted Bevel / Health Connect / workout summary into structured
 * records. Four rules govern this file:
 *
 *  1. NOTHING IS TRUSTED. The parser's job is to propose, not to commit. Every
 *     field comes back with the exact source text it was read from and a
 *     confidence, and the UI shows all of it for editing before anything is
 *     written (spec §8's "Review imported data" step).
 *
 *  2. UNITS ARE READ, NOT ASSUMED. "205 lb", "93 kg", "3.1 mi", "5 km",
 *     "7h 42m" and "462 min" all parse to canonical units, and a bare number
 *     for a unit-bearing field is flagged as a lower-confidence assumption
 *     rather than silently taken as metric.
 *
 *  3. FAILURE IS EXPLICIT. A line that cannot be parsed is reported as
 *     unrecognised rather than dropped, so the user can see what was ignored.
 *     A field that IS understood but has nowhere in the schema to live is
 *     reported too, under `notStored`, because a review screen that shows a
 *     value it will not save is lying.
 *
 *  4. A PASTE IS A LIST OF DAYS. One `Date:` line opens one record. Within a
 *     record, a `Workout:` or `Cardio:` line opens a session block, and the
 *     lines that follow attach to it. This is how people actually write these
 *     reports, and it is what lets a bare `Duration:` mean the right thing.
 */
import type { LocalDate } from '@/lib/types';
import { isLocalDate } from '@/lib/normalization/dates';
import {
  hoursMinutesToMinutes, lbToKg, milesToKm, inchesToCm,
} from '@/lib/normalization/units';
import { checkObservation } from '@/lib/validation/observations';

export const PARSER_NAME = 'text-line-parser';
/**
 * 2.0.0: records and session blocks replace the single flat field list. The
 * version is stamped into every health_imports row, so a future reader can tell
 * which parser produced a stored `parsed` blob.
 */
export const PARSER_VERSION = '2.0.0';

/** Scalars that belong to a whole day. */
export type DayFieldKey =
  | 'weightKg'
  | 'waistCm'
  | 'calories'
  | 'proteinG'
  | 'carbsG'
  | 'fatG'
  | 'fiberG'
  | 'steps'
  | 'activeCalories'
  | 'restingHeartRate'
  | 'hrvMs'
  | 'sleepMinutes';

/**
 * Scalars that belong to one training or cardio session. Deliberately named so
 * that each key is also its own key in OBSERVATION_RANGES - there is no lookup
 * table between the parser and the range rails to drift out of step.
 */
export type SessionFieldKey =
  | 'sessionMinutes'
  | 'distanceKm'
  | 'averageHeartRate'
  | 'maxHeartRate'
  | 'sessionCalories'
  | 'hrZone';

export type FieldKey = DayFieldKey | SessionFieldKey | 'date';

export type FieldConfidence = 'HIGH' | 'MODERATE' | 'LOW';

export interface ParsedField {
  key: FieldKey;
  /** Canonical value: kg, cm, km, kcal, minutes, or an ISO date / label. */
  value: number | string;
  /** The exact substring this was read from, shown in the review UI. */
  rawText: string;
  /** The unit as written by the source, or null when none was present. */
  sourceUnit: string | null;
  confidence: FieldConfidence;
  /** Why confidence is not HIGH. */
  note?: string;
}

/** A field the parser understood but the schema has nowhere to put. */
export interface NotStored {
  label: string;
  rawText: string;
  reason: string;
}

export type SessionKind = 'WORKOUT' | 'CARDIO';

export interface ParsedSession {
  kind: SessionKind;
  /** The opener's value exactly as written ("Push", "Zone 2 bike"). */
  rawLabel: string;
  /** The whole opening line, for the review screen's "read from" column. */
  openerRawText: string;
  fields: ParsedField[];
  notStored: NotStored[];
}

export interface ParsedRecord {
  /** The date field as parsed, kept so the review UI can show its source line. */
  date: ParsedField | null;
  /** Resolved date, or null when absent or too ambiguous to guess. */
  localDate: LocalDate | null;
  fields: ParsedField[];
  sessions: ParsedSession[];
  unrecognisedLines: string[];
  notStored: NotStored[];
  /** This record's own lines, verbatim. The unit of import idempotency. */
  rawText: string;
}

export interface ParseResult {
  records: ParsedRecord[];
  /**
   * Day-level fields of the FIRST record. Kept so single-day callers and the
   * existing convenience helpers read naturally.
   */
  fields: ParsedField[];
  /** Every unreadable line across every record, reported rather than dropped. */
  unrecognisedLines: string[];
  parserName: string;
  parserVersion: string;
}

/**
 * Strips thousands separators and parses. Returns null on anything that is not
 * a plain decimal - hex, exponent and Infinity notations are refused, because
 * "1e3" in a health report is a typo, not three orders of magnitude.
 */
function toNumber(text: string): number | null {
  const cleaned = text.replace(/,/g, '').trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

type ParseFn = (raw: string) => Omit<ParsedField, 'key' | 'rawText'> | null;

/**
 * A number with an optional trailing unit word, and nothing else. Anchoring is
 * what keeps "Calories: about 2000" from being read as 2000: a value the parser
 * only half understands is not a value it should propose.
 */
function numberWithUnit(raw: string): { value: number; unit: string | null } | null {
  const match = /^(-?[\d,]+(?:\.\d+)?)\s*([a-z%"][a-z%/"]*)?$/i.exec(raw.trim());
  if (!match) return null;
  const value = toNumber(match[1]!);
  if (value === null) return null;
  return { value, unit: match[2] ? match[2].toLowerCase() : null };
}

/**
 * Unit-free counts and rates: kcal, bpm, ms, steps. `expected` is the unit the
 * field is measured in; a different one written on the line is not silently
 * accepted, because "Steps: 5 km" is a mis-pasted row, not five steps.
 */
function plainNumber(expected: RegExp | null, canonicalUnit: string | null): ParseFn {
  return (raw) => {
    const read = numberWithUnit(raw);
    if (read === null) return null;
    if (read.unit && expected && !expected.test(read.unit)) {
      return {
        value: read.value,
        sourceUnit: read.unit,
        confidence: 'LOW',
        note: `The unit "${read.unit}" is not one this field is measured in. Check the value.`,
      };
    }
    return {
      value: read.value,
      sourceUnit: read.unit ?? canonicalUnit,
      confidence: 'HIGH',
    };
  };
}

/** Grams. "143g", "143 g" and "143" all mean the same thing. */
function grams(raw: string): Omit<ParsedField, 'key' | 'rawText'> | null {
  const read = numberWithUnit(raw);
  if (read === null) return null;
  if (read.unit && !/^(g|gram|grams)$/.test(read.unit)) {
    return {
      value: read.value,
      sourceUnit: read.unit,
      confidence: 'LOW',
      note: `The unit "${read.unit}" is not grams. Check the value.`,
    };
  }
  return { value: read.value, sourceUnit: read.unit ? 'g' : null, confidence: 'HIGH' };
}

/**
 * Body weight. Reads lb/kg explicitly. A bare number is a genuine ambiguity, so
 * it is resolved by magnitude and flagged - 205 is a plausible lb reading and an
 * implausible kg one, but the user still gets told an assumption was made.
 */
function bodyWeight(raw: string): Omit<ParsedField, 'key' | 'rawText'> | null {
  const read = numberWithUnit(raw);
  if (read === null) return null;
  const { value, unit } = read;

  if (unit && /^(lb|lbs|pound|pounds)$/.test(unit)) {
    return { value: lbToKg(value), sourceUnit: 'lb', confidence: 'HIGH' };
  }
  if (unit && /^(kg|kgs|kilo|kilos|kilogram|kilograms)$/.test(unit)) {
    return { value, sourceUnit: 'kg', confidence: 'HIGH' };
  }
  if (unit) return null;

  // No unit given. Above 130 it is almost certainly pounds; below 130 it is
  // ambiguous enough to say so out loud.
  const assumedPounds = value > 130;
  return {
    value: assumedPounds ? lbToKg(value) : value,
    sourceUnit: null,
    confidence: 'LOW',
    note: assumedPounds
      ? `No unit given; ${value} was read as pounds. Correct it here if that is wrong.`
      : `No unit given; ${value} was read as kilograms. Correct it here if that is wrong.`,
  };
}

function waist(raw: string): Omit<ParsedField, 'key' | 'rawText'> | null {
  const read = numberWithUnit(raw);
  if (read === null) return null;
  const { value, unit } = read;

  if (unit && /^(cm|centimeter|centimeters|centimetre|centimetres)$/.test(unit)) {
    return { value, sourceUnit: 'cm', confidence: 'HIGH' };
  }
  if (unit && /^(in|inch|inches|")$/.test(unit)) {
    return { value: inchesToCm(value), sourceUnit: 'in', confidence: 'HIGH' };
  }
  if (unit) return null;

  // A waist under 60 is inches; over 60 it is centimetres. Still flagged.
  const assumedInches = value < 60;
  return {
    value: assumedInches ? inchesToCm(value) : value,
    sourceUnit: null,
    confidence: 'LOW',
    note: `No unit given; ${value} was read as ${assumedInches ? 'inches' : 'centimetres'}.`,
  };
}

/**
 * Durations: "58 min", "1h 30m", "7h 42m", "1.5 hours", "7 hours 30 minutes",
 * "90".
 *
 * Every unit alternation is ordered LONGEST FIRST. Regex alternation is
 * leftmost-first, not longest-first, so "h|hours" would match the "h" of
 * "hours" and leave "ours 30 minutes" unread - which is how "7 hours 30
 * minutes" used to come back as 420 instead of 450.
 */
function duration(raw: string): Omit<ParsedField, 'key' | 'rawText'> | null {
  const text = raw.trim();

  // Decimal hours are checked FIRST. Otherwise the hours-and-minutes pattern
  // below matches the fractional digits of "7.5 hours" and reads it as 5 hours.
  const decimalHours = /^(\d+\.\d+)\s*(?:hours?|hrs?|h)$/i.exec(text);
  if (decimalHours && decimalHours[1]) {
    return { value: Number(decimalHours[1]) * 60, sourceUnit: 'h', confidence: 'HIGH' };
  }

  const hm = /^(\d+)\s*(?:hours?|hrs?|h)(?:\s*(\d+)\s*(?:minutes?|mins?|m)?)?$/i.exec(text);
  if (hm && hm[1]) {
    const hours = Number(hm[1]);
    const minutes = hm[2] ? Number(hm[2]) : 0;
    return {
      value: hoursMinutesToMinutes(hours, minutes),
      sourceUnit: 'h m',
      confidence: 'HIGH',
    };
  }

  const mins = /^(-?[\d,]+(?:\.\d+)?)\s*(minutes?|mins?|m)?$/i.exec(text);
  if (!mins) return null;
  const value = toNumber(mins[1]!);
  if (value === null) return null;
  if (mins[2]) return { value, sourceUnit: 'min', confidence: 'HIGH' };
  // A bare number is an assumption, exactly as it is for weight and distance,
  // and "Sleep: 7.5" meaning 7.5 minutes is the mistake worth catching.
  return {
    value,
    sourceUnit: null,
    confidence: 'LOW',
    note: `No unit given; ${value} was read as minutes.`,
  };
}

function distance(raw: string): Omit<ParsedField, 'key' | 'rawText'> | null {
  const read = numberWithUnit(raw);
  if (read === null) return null;
  const { value, unit } = read;

  if (unit && /^(mi|mile|miles)$/.test(unit)) {
    return { value: milesToKm(value), sourceUnit: 'mi', confidence: 'HIGH' };
  }
  if (unit && /^(km|kilometer|kilometers|kilometre|kilometres)$/.test(unit)) {
    return { value, sourceUnit: 'km', confidence: 'HIGH' };
  }
  if (unit) return null;

  return {
    value,
    sourceUnit: null,
    confidence: 'LOW',
    note: `No unit given; ${value} was read as kilometres.`,
  };
}

/** Heart-rate zone 1-5. A zone is an integer bucket, not a measurement. */
function hrZone(raw: string): Omit<ParsedField, 'key' | 'rawText'> | null {
  const match = /^(?:zone\s*)?(\d)$/i.exec(raw.trim());
  if (!match) return null;
  return { value: Number(match[1]), sourceUnit: null, confidence: 'HIGH' };
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Dates. ISO is taken as-is. "Aug 28" and "Aug 28, 2026" are understood.
 * An ambiguous numeric date like 03/04/2026 is deliberately NOT guessed.
 */
function parseDate(
  raw: string,
  referenceYear: number,
  /**
   * A labelled `Date:` line says outright that its value is a date, so an ISO
   * date may be picked out of it. An UNLABELLED line is only a guess, and
   * "Synced from Health Connect on 2026-08-28" must not open a new day, so
   * there the whole line has to be the date.
   */
  strict = false,
): Omit<ParsedField, 'key' | 'rawText'> | null {
  // In strict mode a leading weekday and a trailing parenthetical are stripped
  // first, so "Fri 2026-08-28" and "2026-08-28 (Friday)" still open a day while
  // "Synced from Health Connect on 2026-08-28" does not.
  const text = strict
    ? raw
      .trim()
      .replace(/^(?:mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun)[a-z]*\.?,?\s+/i, '')
      .replace(/[(,]\s*(?:mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun)[a-z]*\.?\s*\)?$/i, '')
      .trim()
    : raw.trim();

  const iso = (strict ? /^(\d{4}-\d{2}-\d{2})$/ : /(\d{4}-\d{2}-\d{2})/).exec(text);
  if (iso && isLocalDate(iso[1]!)) {
    return { value: iso[1]!, sourceUnit: 'ISO', confidence: 'HIGH' };
  }

  // "1 Sep 2026" is checked before "Sep 1, 2026", because the month-first
  // pattern would otherwise read the leading "20" of the year as the day and
  // file the record three weeks late.
  const dayFirst = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?(?:,?\s*(\d{4}))?$/i.exec(text);
  // Anchored, like the day-first pattern above it. Unanchored, a bare line of
  // prose - "May 5 min row", "Oct 5 sets" - reads as a date, opens a record
  // nobody wrote, and files the lines below it under a day that never existed.
  const monthFirst =
    /^([a-z]{3,9})\.?\s+(\d{1,2})(?!\d)(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?$/i.exec(text);

  const named: { month: string; day: string; year: string | undefined } | null =
    dayFirst
      ? { month: dayFirst[2]!, day: dayFirst[1]!, year: dayFirst[3] }
      : monthFirst
        ? { month: monthFirst[1]!, day: monthFirst[2]!, year: monthFirst[3] }
        : null;

  if (named) {
    const month = MONTHS[named.month.slice(0, 3).toLowerCase()];
    if (month !== undefined) {
      const day = Number(named.day);
      const year = named.year ? Number(named.year) : referenceYear;
      const candidate =
        `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      if (isLocalDate(candidate)) {
        return {
          value: candidate,
          sourceUnit: 'named',
          confidence: named.year ? 'HIGH' : 'MODERATE',
          ...(named.year ? {} : { note: `No year given; ${referenceYear} assumed.` }),
        };
      }
    }
  }

  // 03/04/2026 is 3 April or 4 March depending on locale. Refuse to guess.
  if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(text)) {
    return {
      value: text,
      sourceUnit: 'ambiguous',
      confidence: 'LOW',
      note:
        'This date format is ambiguous between day/month and month/day orders. ' +
        'Set the date explicitly before importing.',
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// The label vocabulary
// ---------------------------------------------------------------------------

type LabelRole =
  | { role: 'date' }
  | { role: 'day'; key: DayFieldKey; parse: ParseFn }
  | { role: 'session'; key: SessionFieldKey; parse: ParseFn }
  | { role: 'opener'; kind: SessionKind }
  | { role: 'notStored'; reason: string };

interface LabelSpec {
  /** Matched case-insensitively after whitespace and dots are normalised. */
  labels: string[];
  role: LabelRole;
}

const DERIVED_FROM_DISTANCE =
  'Pace and speed are determined by distance and duration, so they are not ' +
  'stored separately. Record the distance and the duration and this follows.';

const SPECS: LabelSpec[] = [
  // "day" is deliberately NOT a synonym: "Day: 3" is a programme week, and
  // treating it as a date boundary splits a workout away from its own duration.
  { labels: ['date'], role: { role: 'date' } },

  // --- day-level -----------------------------------------------------------
  { labels: ['weight', 'body weight', 'bodyweight'],
    role: { role: 'day', key: 'weightKg', parse: bodyWeight } },
  { labels: ['waist', 'waist circumference'],
    role: { role: 'day', key: 'waistCm', parse: waist } },
  { labels: ['calories', 'calories consumed', 'energy', 'kcal', 'intake'],
    role: { role: 'day', key: 'calories', parse: plainNumber(/^(kcal|cal|calories)$/, 'kcal') } },
  { labels: ['protein'], role: { role: 'day', key: 'proteinG', parse: grams } },
  { labels: ['carbs', 'carbohydrates', 'carbohydrate', 'net carbs'],
    role: { role: 'day', key: 'carbsG', parse: grams } },
  { labels: ['fat', 'fats', 'total fat'], role: { role: 'day', key: 'fatG', parse: grams } },
  { labels: ['fiber', 'fibre', 'dietary fiber', 'dietary fibre'],
    role: { role: 'day', key: 'fiberG', parse: grams } },
  { labels: ['steps', 'step count', 'total steps'],
    role: { role: 'day', key: 'steps', parse: plainNumber(/^steps?$/, null) } },
  { labels: ['active calories', 'active energy'],
    role: { role: 'day', key: 'activeCalories', parse: plainNumber(/^(kcal|cal|calories)$/, 'kcal') } },
  { labels: ['resting heart rate', 'resting hr', 'rhr'],
    role: { role: 'day', key: 'restingHeartRate', parse: plainNumber(/^bpm$/, 'bpm') } },
  { labels: ['hrv', 'heart rate variability'],
    role: { role: 'day', key: 'hrvMs', parse: plainNumber(/^(ms|milliseconds?)$/, 'ms') } },
  { labels: ['sleep', 'sleep duration', 'time asleep', 'asleep'],
    role: { role: 'day', key: 'sleepMinutes', parse: duration } },

  // --- session openers -----------------------------------------------------
  { labels: ['workout', 'training', 'session', 'lift', 'strength'],
    role: { role: 'opener', kind: 'WORKOUT' } },
  { labels: ['cardio', 'conditioning'], role: { role: 'opener', kind: 'CARDIO' } },

  // --- session-scoped ------------------------------------------------------
  { labels: ['duration', 'workout duration', 'cardio duration', 'session duration',
             'time', 'elapsed time', 'moving time'],
    role: { role: 'session', key: 'sessionMinutes', parse: duration } },
  { labels: ['distance'], role: { role: 'session', key: 'distanceKm', parse: distance } },
  { labels: ['avg hr', 'average hr', 'avg heart rate', 'average heart rate',
             'mean hr', 'mean heart rate'],
    role: { role: 'session', key: 'averageHeartRate', parse: plainNumber(/^bpm$/, 'bpm') } },
  { labels: ['max hr', 'maximum hr', 'max heart rate', 'maximum heart rate',
             'peak hr', 'peak heart rate'],
    role: { role: 'session', key: 'maxHeartRate', parse: plainNumber(/^bpm$/, 'bpm') } },
  { labels: ['calories burned', 'workout calories', 'cardio calories',
             'session calories', 'energy burned'],
    role: { role: 'session', key: 'sessionCalories',
            parse: plainNumber(/^(kcal|cal|calories)$/, 'kcal') } },
  { labels: ['zone', 'hr zone', 'heart rate zone'],
    role: { role: 'session', key: 'hrZone', parse: hrZone } },

  // --- understood, but the schema has nowhere to put it --------------------
  { labels: ['pace', 'average pace', 'avg pace', 'speed', 'average speed', 'avg speed'],
    role: { role: 'notStored', reason: DERIVED_FROM_DISTANCE } },
];

const MATCHERS = new Map<string, LabelSpec>();
for (const spec of SPECS) {
  for (const text of spec.labels) MATCHERS.set(text, spec);
}

/** Units that may legitimately decorate a label, as in "Weight (lb)". */
const UNIT_IN_LABEL =
  /^(lbs?|pounds?|kgs?|kilograms?|in|inch(?:es)?|cm|km|mi|miles?|kcal|cal|g|grams?|bpm|ms|mins?|minutes?|hrs?|hours?|steps?)$/;

interface NormalisedLabel {
  label: string;
  /** A unit read out of the label, applied when the value carries none. */
  unitHint: string | null;
}

/**
 * "Weight (lb)" -> { label: 'weight', unitHint: 'lb' }. A parenthetical is only
 * stripped when it holds a recognised unit; "Weight (morning)" stays unmatched
 * rather than being quietly accepted as something it might not be.
 */
function normaliseLabel(text: string): NormalisedLabel {
  const flattened = text.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
  const parenthetical = /^(.*?)\s*\(([^)]*)\)$/.exec(flattened);
  if (parenthetical) {
    const inner = parenthetical[2]!.trim();
    if (UNIT_IN_LABEL.test(inner)) {
      return { label: parenthetical[1]!.trim(), unitHint: inner };
    }
  }
  return { label: flattened, unitHint: null };
}

// ---------------------------------------------------------------------------
// Records and sessions
// ---------------------------------------------------------------------------

interface RecordBuilder {
  date: ParsedField | null;
  fields: ParsedField[];
  sessions: ParsedSession[];
  unrecognisedLines: string[];
  notStored: NotStored[];
  lines: string[];
  claimed: Set<DayFieldKey>;
  openSession: {
    session: ParsedSession;
    claimed: Set<SessionFieldKey>;
    /** Keys read out of the opener's free text, which a labelled line replaces. */
    inferred: Set<SessionFieldKey>;
  } | null;
}

function newRecord(): RecordBuilder {
  return {
    date: null, fields: [], sessions: [], unrecognisedLines: [], notStored: [],
    lines: [], claimed: new Set(), openSession: null,
  };
}

function finishRecord(builder: RecordBuilder): ParsedRecord {
  const value = builder.date?.value;
  return {
    date: builder.date,
    localDate: typeof value === 'string' && isLocalDate(value) ? value : null,
    fields: builder.fields,
    sessions: builder.sessions,
    unrecognisedLines: builder.unrecognisedLines,
    notStored: builder.notStored,
    rawText: builder.lines.join('\n'),
  };
}

function isEmpty(builder: RecordBuilder): boolean {
  return (
    builder.date === null &&
    builder.fields.length === 0 &&
    builder.sessions.length === 0 &&
    builder.unrecognisedLines.length === 0 &&
    builder.notStored.length === 0
  );
}

/**
 * Whether a `Date:` line should close the record being built.
 *
 * It should, once that record holds anything a date would apply to. Otherwise a
 * value written above the first date line is stamped with the day BELOW it, and
 * that day's own value is then discarded as a duplicate.
 *
 * A record holding only unreadable lines - an export header - merges forward
 * into the dated record that follows, which is also what keeps a single-day
 * paste hashing to the same idempotency key it always did.
 */
function holdsDatedData(builder: RecordBuilder): boolean {
  return (
    builder.date !== null ||
    builder.fields.length > 0 ||
    builder.sessions.length > 0 ||
    builder.notStored.length > 0
  );
}

/**
 * Applies the plausible-range rails. A value the database would refuse is
 * downgraded and explained here, so the review screen can show it before the
 * insert fails - not after the user has been told the import succeeded.
 */
function withRangeCheck(
  key: FieldKey,
  parsed: Omit<ParsedField, 'key' | 'rawText'>,
): Omit<ParsedField, 'key' | 'rawText'> {
  if (typeof parsed.value !== 'number') return parsed;
  const problem = checkObservation(key, parsed.value);
  if (problem === null) return parsed;
  return {
    ...parsed,
    confidence: 'LOW',
    note: parsed.note ? `${parsed.note} ${problem}` : problem,
  };
}

/**
 * "Calories" inside an open session block means intake in a food diary and burn
 * in a workout summary, and the two cannot be told apart from the number.
 *
 * It stays day-level intake, because that is the reading that cannot invent a
 * burn figure - but the ambiguity is put in front of the user rather than
 * resolved behind them. `Calories burned:` says burn unambiguously.
 */
function ambiguousCalories(
  key: DayFieldKey,
  builder: RecordBuilder,
  parsed: Omit<ParsedField, 'key' | 'rawText'>,
): Omit<ParsedField, 'key' | 'rawText'> {
  if (key !== 'calories' || builder.openSession === null) return parsed;
  const note =
    'This sits inside a workout block, where it could mean food eaten or energy '
    + 'burned. It was read as food eaten. Write "Calories burned:" for the session.';
  return {
    ...parsed,
    confidence: parsed.confidence === 'HIGH' ? 'MODERATE' : parsed.confidence,
    note: parsed.note ? `${parsed.note} ${note}` : note,
  };
}

/**
 * A duration written on the opening line: "Cardio: 30 min", "Workout: Push 55
 * min". The trailing (?![/]) rejects a pace - the "12 min" of "12 min/mi" is a
 * rate, not a session length.
 *
 * Whatever this finds is an inference from free text, so it is marked as such
 * and an explicit `Duration:` line below replaces it.
 */
function minutesFromOpener(
  text: string,
): { minutes: number; unit: string | null; explicit: boolean } | null {
  // Hours-and-minutes first, or "Push 1h 30m" reads as one hour flat.
  const hoursAndMinutes =
    /(?:^|\s)(\d+)\s*(?:hours?|hrs?|h)\s*(\d+)\s*(?:minutes?|mins?|m)\b(?!\s*\/)/i.exec(text);
  if (hoursAndMinutes) {
    return {
      minutes: hoursMinutesToMinutes(Number(hoursAndMinutes[1]), Number(hoursAndMinutes[2])),
      unit: 'h m',
      explicit: true,
    };
  }
  // A bare "m" is deliberately absent: in free text "500m row" is a distance,
  // and reading it as 500 minutes would add eight hours to the day's training.
  const spelled =
    /(?:^|\s)(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?|h)\b(?!\s*\/)/i.exec(text);
  if (spelled) {
    const value = Number(spelled[1]);
    const hours = /^h/i.test(spelled[2]!);
    return { minutes: hours ? value * 60 : value, unit: hours ? 'h' : 'min', explicit: true };
  }
  // "45m" on its own is unambiguous, because there is nothing else it could be
  // measuring.
  const onlyMinutes = /^(\d+(?:\.\d+)?)\s*m$/i.exec(text.trim());
  if (onlyMinutes) {
    return { minutes: Number(onlyMinutes[1]), unit: 'min', explicit: true };
  }
  const bare = /^\d+(?:\.\d+)?$/.exec(text.trim());
  return bare ? { minutes: Number(bare[0]), unit: null, explicit: false } : null;
}

/** "Zone 2 bike" carries its zone in the opener. Only 1-5 is a zone. */
function zoneFromOpener(text: string): number | null {
  const match = /\bzone\s*([1-5])\b/i.exec(text);
  return match ? Number(match[1]) : null;
}

export function parseText(input: string, referenceYear = new Date().getUTCFullYear()): ParseResult {
  const records: ParsedRecord[] = [];
  let current = newRecord();

  const push = (builder: RecordBuilder) => {
    if (!isEmpty(builder)) records.push(finishRecord(builder));
  };

  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') {
      current.lines.push(rawLine);
      continue;
    }

    // Bullets and list markers are noise, not data.
    const cleaned = line.replace(/^[-*•\s]+/, '');

    // A line may be splittable in two places: at a colon, or at a run of
    // spaces in a column-aligned report. Neither wins outright - "Resting  HR:
    // 58" must split at the colon, and "Workout      Push: heavy" at the
    // spaces - so both are tried, nearest first, and the one that yields a
    // label this parser knows is used.
    const candidates = [cleaned.search(/[:=\t]/), cleaned.search(/\s{2,}/)]
      .filter((index) => index !== -1)
      .sort((a, b) => a - b);

    const split = candidates.find(
      (index) => MATCHERS.has(normaliseLabel(cleaned.slice(0, index)).label),
    );
    const separator = split ?? candidates[0] ?? -1;

    if (separator === -1) {
      // A bare date line is common in pasted reports and worth catching - but
      // only when the line is nothing but a date.
      const bare = parseDate(cleaned, referenceYear, true);
      if (bare) {
        if (holdsDatedData(current)) {
          push(current);
          current = newRecord();
        }
        current.lines.push(rawLine);
        current.date = { key: 'date', rawText: line, ...bare };
        continue;
      }
      current.lines.push(rawLine);
      current.unrecognisedLines.push(line);
      continue;
    }

    const { label, unitHint } = normaliseLabel(cleaned.slice(0, separator));
    const valueText = cleaned.slice(separator).replace(/^[:=\t\s]+/, '').trim();
    const spec = MATCHERS.get(label);

    if (spec === undefined || valueText === '') {
      current.lines.push(rawLine);
      current.unrecognisedLines.push(line);
      continue;
    }

    // A unit written into the label applies only when the value has none.
    const withUnit = unitHint && !/[a-z"]/i.test(valueText)
      ? `${valueText} ${unitHint}`
      : valueText;

    const { role } = spec;

    if (role.role === 'date') {
      // A date line opens the next day rather than being discarded as a
      // duplicate. This is what makes a week-long paste import as a week.
      //
      // It closes the current record even when its value cannot be read: the
      // line is unmistakably a boundary, and treating an unreadable one as
      // ordinary noise would stamp the day below it with the day above.
      if (holdsDatedData(current)) {
        push(current);
        current = newRecord();
      }
      current.lines.push(rawLine);
      const parsed = parseDate(valueText, referenceYear);
      if (parsed === null) {
        current.unrecognisedLines.push(`${line}   (could not read a date - set it below)`);
        continue;
      }
      current.date = { key: 'date', rawText: line, ...parsed };
      continue;
    }

    current.lines.push(rawLine);

    if (role.role === 'notStored') {
      const entry = { label, rawText: line, reason: role.reason };
      if (current.openSession) current.openSession.session.notStored.push(entry);
      else current.notStored.push(entry);
      continue;
    }

    if (role.role === 'opener') {
      const session: ParsedSession = {
        kind: role.kind,
        rawLabel: valueText,
        openerRawText: line,
        fields: [],
        notStored: [],
      };
      const claimed = new Set<SessionFieldKey>();
      const inferred = new Set<SessionFieldKey>();

      // "Cardio: 30 min" and "Workout: Push 55 min" both carry their duration
      // on the opening line; "Zone 2 bike" carries its zone there. Both are read
      // out of free text, so a later labelled line takes precedence.
      const minutes = minutesFromOpener(valueText);
      if (minutes !== null) {
        session.fields.push({
          key: 'sessionMinutes', rawText: line,
          ...withRangeCheck('sessionMinutes', {
            value: minutes.minutes,
            sourceUnit: minutes.unit,
            confidence: minutes.explicit ? 'HIGH' : 'LOW',
            ...(minutes.explicit
              ? {}
              : { note: `No unit given; ${minutes.minutes} was read as minutes.` }),
          }),
        });
        claimed.add('sessionMinutes');
        inferred.add('sessionMinutes');
      }
      const zone = zoneFromOpener(valueText);
      if (zone !== null) {
        session.fields.push({
          key: 'hrZone', rawText: line,
          value: zone, sourceUnit: null, confidence: 'HIGH',
        });
        claimed.add('hrZone');
        inferred.add('hrZone');
      }

      current.sessions.push(session);
      current.openSession = { session, claimed, inferred };
      continue;
    }

    if (role.role === 'session') {
      if (current.openSession === null) {
        current.unrecognisedLines.push(
          `${line}   (no open Workout: or Cardio: block - add one above this line)`,
        );
        continue;
      }
      const { session, claimed, inferred } = current.openSession;
      // A value read out of the opening line's free text is only a guess. A
      // labelled line replaces it rather than being refused as a duplicate -
      // otherwise "Cardio: Treadmill 12 min/mi" would outrank "Duration: 45 min".
      if (claimed.has(role.key) && !inferred.has(role.key)) {
        current.unrecognisedLines.push(`${line}   (duplicate ${role.key} in this session, ignored)`);
        continue;
      }
      const parsed = role.parse(withUnit);
      if (parsed === null) {
        current.unrecognisedLines.push(`${line}   (could not read a value)`);
        continue;
      }
      if (inferred.delete(role.key)) {
        const existing = session.fields.findIndex((f) => f.key === role.key);
        if (existing !== -1) session.fields.splice(existing, 1);
      }
      claimed.add(role.key);
      session.fields.push({
        key: role.key, rawText: line, ...withRangeCheck(role.key, parsed),
      });
      continue;
    }

    // Day-level. First occurrence wins; a repeat is reported, not silently
    // overwritten, because a report listing two weights needs human attention.
    if (current.claimed.has(role.key)) {
      current.unrecognisedLines.push(`${line}   (duplicate ${role.key}, ignored)`);
      continue;
    }
    const parsed = role.parse(withUnit);
    if (parsed === null) {
      current.unrecognisedLines.push(`${line}   (could not read a value)`);
      continue;
    }
    current.claimed.add(role.key);
    current.fields.push({
      key: role.key,
      rawText: line,
      ...withRangeCheck(role.key, ambiguousCalories(role.key, current, parsed)),
    });
  }

  push(current);

  return {
    records,
    fields: records[0]?.fields ?? [],
    unrecognisedLines: records.flatMap((r) => r.unrecognisedLines),
    parserName: PARSER_NAME,
    parserVersion: PARSER_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Convenience lookups over a parse result
// ---------------------------------------------------------------------------

/** Reads a day-level field of the first record. */
export function fieldValue(result: ParseResult, key: DayFieldKey): number | string | null {
  return result.records[0]?.fields.find((f) => f.key === key)?.value ?? null;
}

/** Reads a field of one session. */
export function sessionValue(
  session: ParsedSession,
  key: SessionFieldKey,
): number | string | null {
  return session.fields.find((f) => f.key === key)?.value ?? null;
}

export function parsedDate(result: ParseResult): LocalDate | null {
  return result.records[0]?.localDate ?? null;
}

/** Every date the paste resolved to, in the order they appeared. */
export function parsedDates(result: ParseResult): (LocalDate | null)[] {
  return result.records.map((record) => record.localDate);
}
