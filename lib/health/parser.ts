/**
 * Paste ingestion parser (spec §8, §28, §38).
 *
 * Turns a pasted Bevel / Health Connect / workout summary into structured
 * fields. Three rules govern this file:
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
 */
import type { LocalDate } from '@/lib/types';
import { isLocalDate } from '@/lib/normalization/dates';
import {
  hoursMinutesToMinutes, lbToKg, milesToKm, inchesToCm,
} from '@/lib/normalization/units';

export const PARSER_NAME = 'text-line-parser';
export const PARSER_VERSION = '1.0.0';

export type FieldKey =
  | 'date'
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
  | 'sleepMinutes'
  | 'workoutType'
  | 'workoutMinutes'
  | 'cardioMinutes'
  | 'cardioDistanceKm';

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

export interface ParseResult {
  fields: ParsedField[];
  /** Lines that matched no known label, reported rather than silently dropped. */
  unrecognisedLines: string[];
  parserName: string;
  parserVersion: string;
}

/** Strips thousands separators and parses. Returns null on anything non-numeric. */
function toNumber(text: string): number | null {
  const cleaned = text.replace(/,/g, '').trim();
  if (cleaned === '') return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

interface LabelSpec {
  key: FieldKey;
  /** Labels matched case-insensitively, longest first. */
  labels: string[];
  parse: (raw: string) => Omit<ParsedField, 'key' | 'rawText'> | null;
}

/** kcal is unambiguous; a bare number is taken at face value. */
function plainNumber(unit: string | null = null) {
  return (raw: string): Omit<ParsedField, 'key' | 'rawText'> | null => {
    const value = toNumber(raw.replace(/[a-z%]/gi, ''));
    if (value === null) return null;
    return { value, sourceUnit: unit, confidence: 'HIGH' };
  };
}

/** Grams. "143g", "143 g" and "143" all mean the same thing. */
function grams(raw: string): Omit<ParsedField, 'key' | 'rawText'> | null {
  const match = /(-?[\d,]+(?:\.\d+)?)\s*(g|grams?)?/i.exec(raw);
  if (!match) return null;
  const value = toNumber(match[1]!);
  if (value === null) return null;
  return { value, sourceUnit: match[2] ? 'g' : null, confidence: 'HIGH' };
}

/**
 * Body weight. Reads lb/kg explicitly. A bare number is a genuine ambiguity, so
 * it is resolved by magnitude and flagged - 205 is a plausible lb reading and an
 * implausible kg one, but the user still gets told an assumption was made.
 */
function bodyWeight(raw: string): Omit<ParsedField, 'key' | 'rawText'> | null {
  const match = /(-?[\d,]+(?:\.\d+)?)\s*(lbs?|pounds?|kgs?|kilograms?)?/i.exec(raw);
  if (!match) return null;
  const value = toNumber(match[1]!);
  if (value === null) return null;
  const unit = match[2]?.toLowerCase();

  if (unit && /^(lbs?|pounds?)$/.test(unit)) {
    return { value: lbToKg(value), sourceUnit: 'lb', confidence: 'HIGH' };
  }
  if (unit && /^(kgs?|kilograms?)$/.test(unit)) {
    return { value, sourceUnit: 'kg', confidence: 'HIGH' };
  }
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
  const match = /(-?[\d,]+(?:\.\d+)?)\s*(in|inch(?:es)?|"|cm)?/i.exec(raw);
  if (!match) return null;
  const value = toNumber(match[1]!);
  if (value === null) return null;
  const unit = match[2]?.toLowerCase();
  if (unit === 'cm') return { value, sourceUnit: 'cm', confidence: 'HIGH' };
  if (unit) return { value: inchesToCm(value), sourceUnit: 'in', confidence: 'HIGH' };
  // A waist under 60 is inches; over 60 it is centimetres. Still flagged.
  const assumedInches = value < 60;
  return {
    value: assumedInches ? inchesToCm(value) : value,
    sourceUnit: null,
    confidence: 'LOW',
    note: `No unit given; ${value} was read as ${assumedInches ? 'inches' : 'centimetres'}.`,
  };
}

/** Durations: "58 min", "1h 30m", "7h 42m", "1.5 hours", "90". */
function duration(raw: string): Omit<ParsedField, 'key' | 'rawText'> | null {
  // Decimal hours are checked FIRST. Otherwise the hours-and-minutes pattern
  // below matches the fractional digits of "7.5 hours" and reads it as 5 hours.
  const decimalHours = /(\d+\.\d+)\s*(?:hours?|hrs?)\b/i.exec(raw);
  if (decimalHours && decimalHours[1]) {
    return {
      value: Number(decimalHours[1]) * 60,
      sourceUnit: 'h',
      confidence: 'HIGH',
    };
  }
  // The lookbehind is a second guard against latching onto a fractional part.
  const hm = /(?<![\d.])(\d+)\s*(?:h|hr|hrs|hours?)\s*(\d+)?\s*(?:m|min|mins|minutes?)?/i.exec(raw);
  if (hm && hm[1]) {
    const hours = Number(hm[1]);
    const minutes = hm[2] ? Number(hm[2]) : 0;
    return {
      value: hoursMinutesToMinutes(hours, minutes),
      sourceUnit: 'h m',
      confidence: 'HIGH',
    };
  }
  const mins = /(-?[\d,]+(?:\.\d+)?)\s*(?:m|min|mins|minutes?)?/i.exec(raw);
  if (!mins) return null;
  const value = toNumber(mins[1]!);
  if (value === null) return null;
  return { value, sourceUnit: 'min', confidence: 'HIGH' };
}

function distance(raw: string): Omit<ParsedField, 'key' | 'rawText'> | null {
  const match = /(-?[\d,]+(?:\.\d+)?)\s*(mi|miles?|km|kilometers?|kilometres?)?/i.exec(raw);
  if (!match) return null;
  const value = toNumber(match[1]!);
  if (value === null) return null;
  const unit = match[2]?.toLowerCase();
  if (unit && /^(mi|miles?)$/.test(unit)) {
    return { value: milesToKm(value), sourceUnit: 'mi', confidence: 'HIGH' };
  }
  if (unit) return { value, sourceUnit: 'km', confidence: 'HIGH' };
  return {
    value,
    sourceUnit: null,
    confidence: 'LOW',
    note: `No unit given; ${value} was read as kilometres.`,
  };
}

function label(raw: string): Omit<ParsedField, 'key' | 'rawText'> | null {
  const text = raw.trim();
  if (text === '') return null;
  return { value: text, sourceUnit: null, confidence: 'HIGH' };
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Dates. ISO is taken as-is. "Aug 28" and "Aug 28, 2026" are understood.
 * An ambiguous numeric date like 03/04/2026 is deliberately NOT guessed.
 */
function parseDate(raw: string, referenceYear: number): Omit<ParsedField, 'key' | 'rawText'> | null {
  const text = raw.trim();

  const iso = /(\d{4}-\d{2}-\d{2})/.exec(text);
  if (iso && isLocalDate(iso[1]!)) {
    return { value: iso[1]!, sourceUnit: 'ISO', confidence: 'HIGH' };
  }

  const named = /([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/i.exec(text);
  if (named) {
    const month = MONTHS[named[1]!.slice(0, 3).toLowerCase()];
    if (month !== undefined) {
      const day = Number(named[2]);
      const year = named[3] ? Number(named[3]) : referenceYear;
      const candidate =
        `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      if (isLocalDate(candidate)) {
        return {
          value: candidate,
          sourceUnit: 'named',
          confidence: named[3] ? 'HIGH' : 'MODERATE',
          ...(named[3] ? {} : { note: `No year given; ${referenceYear} assumed.` }),
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

const SPECS: LabelSpec[] = [
  { key: 'date', labels: ['date'], parse: () => null }, // handled specially
  { key: 'weightKg', labels: ['weight', 'body weight', 'bodyweight'], parse: bodyWeight },
  { key: 'waistCm', labels: ['waist'], parse: waist },
  { key: 'calories', labels: ['calories', 'calories consumed', 'energy', 'kcal'], parse: plainNumber('kcal') },
  { key: 'proteinG', labels: ['protein'], parse: grams },
  { key: 'carbsG', labels: ['carbs', 'carbohydrates', 'carbohydrate', 'net carbs'], parse: grams },
  { key: 'fatG', labels: ['fat', 'fats', 'total fat'], parse: grams },
  { key: 'fiberG', labels: ['fiber', 'fibre'], parse: grams },
  { key: 'steps', labels: ['steps', 'step count'], parse: plainNumber(null) },
  { key: 'activeCalories', labels: ['active calories', 'active energy'], parse: plainNumber('kcal') },
  { key: 'restingHeartRate', labels: ['resting heart rate', 'resting hr', 'rhr'], parse: plainNumber('bpm') },
  { key: 'hrvMs', labels: ['hrv', 'heart rate variability'], parse: plainNumber('ms') },
  { key: 'sleepMinutes', labels: ['sleep', 'sleep duration', 'time asleep'], parse: duration },
  { key: 'workoutType', labels: ['workout', 'training', 'session'], parse: label },
  { key: 'workoutMinutes', labels: ['duration', 'workout duration'], parse: duration },
  { key: 'cardioMinutes', labels: ['cardio', 'cardio duration'], parse: duration },
  { key: 'cardioDistanceKm', labels: ['distance'], parse: distance },
];

/** Longest labels first so "active calories" wins over "calories". */
const MATCHERS = SPECS.flatMap((spec) =>
  spec.labels.map((text) => ({ spec, text })),
).sort((a, b) => b.text.length - a.text.length);

export function parseText(input: string, referenceYear = new Date().getUTCFullYear()): ParseResult {
  const fields: ParsedField[] = [];
  const unrecognised: string[] = [];
  const claimed = new Set<FieldKey>();

  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;

    // Bullets and list markers are noise, not data.
    const cleaned = line.replace(/^[-*•\s]+/, '');
    const separator = cleaned.search(/[:=\t]|\s{2,}/);
    if (separator === -1) {
      // A bare date line is common in pasted reports and worth catching.
      const bare = parseDate(cleaned, referenceYear);
      if (bare && !claimed.has('date')) {
        claimed.add('date');
        fields.push({ key: 'date', rawText: line, ...bare });
        continue;
      }
      unrecognised.push(line);
      continue;
    }

    const labelText = cleaned.slice(0, separator).trim().toLowerCase();
    const valueText = cleaned.slice(separator).replace(/^[:=\t\s]+/, '').trim();
    if (valueText === '') {
      unrecognised.push(line);
      continue;
    }

    const matcher = MATCHERS.find((m) => m.text === labelText);
    if (!matcher) {
      unrecognised.push(line);
      continue;
    }

    // First occurrence of a field wins; a repeat is reported, not silently
    // overwritten, because a report listing two weights needs human attention.
    if (claimed.has(matcher.spec.key)) {
      unrecognised.push(`${line}   (duplicate ${matcher.spec.key}, ignored)`);
      continue;
    }

    const parsed =
      matcher.spec.key === 'date'
        ? parseDate(valueText, referenceYear)
        : matcher.spec.parse(valueText);

    if (parsed === null) {
      unrecognised.push(`${line}   (could not read a value)`);
      continue;
    }

    claimed.add(matcher.spec.key);
    fields.push({ key: matcher.spec.key, rawText: line, ...parsed });
  }

  return {
    fields,
    unrecognisedLines: unrecognised,
    parserName: PARSER_NAME,
    parserVersion: PARSER_VERSION,
  };
}

/** Convenience lookup over a parse result. */
export function fieldValue(result: ParseResult, key: FieldKey): number | string | null {
  return result.fields.find((f) => f.key === key)?.value ?? null;
}

export function parsedDate(result: ParseResult): LocalDate | null {
  const value = fieldValue(result, 'date');
  return typeof value === 'string' && isLocalDate(value) ? value : null;
}
