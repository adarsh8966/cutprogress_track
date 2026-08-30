/**
 * One day's RAW observations, as things a person can look at and act on.
 *
 * Pure, and deliberately importable without `server-only` - the same reasoning
 * as lib/data/rows.ts. This is where a stored row becomes something the day
 * view can render, so it is where a column silently stops being represented,
 * and it needs to be testable without a database.
 *
 * WHY THE DAY VIEW NEEDS THIS AT ALL. Every other page reads daily_metrics,
 * which is one resolved row per day. That is the right thing to analyse and
 * the wrong thing to correct: it cannot say WHICH of two weigh-ins is being
 * shown, and it has no id to withdraw. Correcting data means seeing the
 * observations themselves - what was recorded, by what, when, and whether it
 * still counts.
 *
 * Values stay CANONICAL here (kg, cm, km, kcal, minutes). Conversion to what
 * the user reads happens at the edge, in formatDayField, exactly as everywhere
 * else in this codebase.
 */
import type { DailyMetrics, DataSource, LocalDate } from '@/lib/types';
import type { WithdrawableTable } from '@/lib/health/corrections';
import { toNumber } from '@/lib/normalization/numbers';
import {
  displayWeight, displayLength, displayDistance,
  type DisplayUnits,
} from '@/lib/normalization/units';

/**
 * How a canonical number becomes something to read. The unit is a property of
 * the FIELD, not of the value, so a null still knows what it would have been
 * measured in.
 */
export type DayFieldUnit =
  | 'WEIGHT'
  | 'LENGTH'
  | 'DISTANCE'
  | 'DURATION'
  | 'KCAL'
  | 'GRAMS'
  | 'BPM'
  | 'MS'
  | 'COUNT'
  | 'SERVINGS'
  | 'ZONE'
  | 'SCORE';

export interface DayField {
  label: string;
  /** Canonical, or null for "not recorded on this observation" - never 0. */
  value: number | null;
  unit: DayFieldUnit;
}

export interface DayRecord {
  table: WithdrawableTable;
  id: string;
  /** A short name for the kind of record: "Weight", "Nutrition", "Pull". */
  title: string;
  fields: DayField[];
  source: DataSource;
  /** When the observation was recorded, ISO-8601. */
  recordedAt: string;
  supersededAt: string | null;
  supersededBy: string | null;
  notes: string | null;
  /** Set when the record has a page of its own. */
  href: string | null;
  /** True when a correction replaced it, as opposed to it being withdrawn. */
  replaced: boolean;
}

/** Minutes as "7h 30m", which is how a person reads a duration. */
export function formatDuration(minutes: number): string {
  const whole = Math.round(minutes);
  if (whole < 60) return `${whole} min`;
  const hours = Math.floor(whole / 60);
  return `${hours}h ${whole - hours * 60}m`;
}

function round(value: number, places: number): string {
  const factor = 10 ** places;
  return String(Math.round(value * factor) / factor);
}

/**
 * A field, written out. Returns null when the observation did not carry this
 * field - the caller renders that as "not recorded", never as a zero (§33).
 */
export function formatDayField(field: DayField, units: DisplayUnits): string | null {
  if (field.value === null) return null;
  const value = field.value;
  switch (field.unit) {
    case 'WEIGHT':
      return `${round(displayWeight(value, units.weight), 1)} ${units.weight === 'KG' ? 'kg' : 'lb'}`;
    case 'LENGTH':
      return `${round(displayLength(value, units.length), 1)} ${units.length === 'CM' ? 'cm' : 'in'}`;
    case 'DISTANCE':
      return `${round(displayDistance(value, units.distance), 2)} ${units.distance === 'KM' ? 'km' : 'mi'}`;
    case 'DURATION':
      return formatDuration(value);
    case 'KCAL':
      return `${round(value, 0)} kcal`;
    case 'GRAMS':
      return `${round(value, 0)} g`;
    case 'BPM':
      return `${round(value, 0)} bpm`;
    case 'MS':
      return `${round(value, 0)} ms`;
    case 'SERVINGS':
      return `${round(value, 1)} servings`;
    case 'ZONE':
      return `zone ${round(value, 0)}`;
    case 'SCORE':
      return `${round(value, 0)} / 100`;
    case 'COUNT':
    default:
      return round(value, 0);
  }
}

/** Drops the fields this observation did not carry. */
export function presentFields(record: DayRecord): DayField[] {
  return record.fields.filter((field) => field.value !== null);
}

// ---------------------------------------------------------------------------
// Row shapes. Only the columns this module reads, so a test can build one.
// ---------------------------------------------------------------------------

interface Supersedable {
  id: string;
  source: string;
  notes: string | null;
  /** Optional: a database still on migration 0011 has no such column. */
  superseded_at?: string | null;
  superseded_by?: string | null;
}

export interface BodyRow extends Supersedable {
  measured_at: string;
  weight_kg: unknown;
  waist_cm: unknown;
}

export interface MetricRow extends Supersedable {
  metric: string;
  value: unknown;
  measured_at: string;
}

export interface NutritionRow extends Supersedable {
  logged_at: string;
  calories: unknown;
  protein_g: unknown;
  carbs_g: unknown;
  fat_g: unknown;
  fiber_g: unknown;
  fruit_veg_servings: unknown;
}

export interface SleepRow extends Supersedable {
  created_at: string;
  duration_minutes: unknown;
  sleep_score: unknown;
}

export interface CardioRow extends Supersedable {
  created_at: string;
  cardio_type: string;
  duration_minutes: unknown;
  distance_km: unknown;
  average_heart_rate: unknown;
  max_heart_rate: unknown;
  hr_zone: unknown;
  calories: unknown;
}

export interface WorkoutRow extends Supersedable {
  created_at: string;
  session_type: string;
  duration_minutes: unknown;
  average_heart_rate: unknown;
  max_heart_rate: unknown;
  calories: unknown;
  completed: boolean;
}

export interface DayRows {
  body: BodyRow[];
  metrics: MetricRow[];
  nutrition: NutritionRow[];
  sleep: SleepRow[];
  cardio: CardioRow[];
  workouts: WorkoutRow[];
}

/** A timestamp column as text, whatever the driver handed back. */
function isoOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  return '';
}

function titleCase(enumValue: string): string {
  const words = enumValue.replaceAll('_', ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const METRIC_LABEL: Record<string, { title: string; unit: DayFieldUnit }> = {
  STEPS: { title: 'Steps', unit: 'COUNT' },
  ACTIVE_CALORIES: { title: 'Active calories', unit: 'KCAL' },
  TOTAL_CALORIES_BURNED: { title: 'Total calories burned', unit: 'KCAL' },
  RESTING_HEART_RATE: { title: 'Resting heart rate', unit: 'BPM' },
  HRV_MS: { title: 'HRV', unit: 'MS' },
  WORKOUT_MINUTES: { title: 'Workout minutes', unit: 'DURATION' },
  CARDIO_MINUTES: { title: 'Cardio minutes', unit: 'DURATION' },
};

function base(row: Supersedable): Omit<DayRecord, 'table' | 'title' | 'fields' | 'recordedAt' | 'href'> {
  return {
    id: row.id,
    source: row.source as DataSource,
    supersededAt: isoOf(row.superseded_at) || null,
    supersededBy: row.superseded_by ?? null,
    notes: row.notes,
    // A row with a successor was CORRECTED; one without was withdrawn. The two
    // read differently on screen and only the second can be restored.
    replaced: row.superseded_by != null,
  };
}

/**
 * Every observation recorded against one day, newest first.
 *
 * Superseded rows are included on purpose. This is the one view whose job is
 * to show what is on record, including what no longer counts - hiding them
 * would make a correction look like the value had simply changed, and would
 * leave a withdrawn row with no way back.
 */
export function toDayRecords(rows: DayRows): DayRecord[] {
  const records: DayRecord[] = [];

  for (const row of rows.body) {
    records.push({
      ...base(row),
      table: 'body_measurements',
      title: 'Body measurement',
      recordedAt: isoOf(row.measured_at),
      href: null,
      fields: [
        { label: 'Weight', value: toNumber(row.weight_kg), unit: 'WEIGHT' },
        { label: 'Waist', value: toNumber(row.waist_cm), unit: 'LENGTH' },
      ],
    });
  }

  for (const row of rows.metrics) {
    const known = METRIC_LABEL[row.metric];
    records.push({
      ...base(row),
      table: 'metric_observations',
      // An unrecognised metric keeps its own name rather than being hidden.
      title: known?.title ?? titleCase(row.metric),
      recordedAt: isoOf(row.measured_at),
      href: null,
      fields: [
        { label: known?.title ?? titleCase(row.metric), value: toNumber(row.value), unit: known?.unit ?? 'COUNT' },
      ],
    });
  }

  for (const row of rows.nutrition) {
    records.push({
      ...base(row),
      table: 'nutrition_logs',
      title: 'Nutrition',
      recordedAt: isoOf(row.logged_at),
      href: null,
      fields: [
        { label: 'Calories', value: toNumber(row.calories), unit: 'KCAL' },
        { label: 'Protein', value: toNumber(row.protein_g), unit: 'GRAMS' },
        { label: 'Carbohydrate', value: toNumber(row.carbs_g), unit: 'GRAMS' },
        { label: 'Fat', value: toNumber(row.fat_g), unit: 'GRAMS' },
        { label: 'Fibre', value: toNumber(row.fiber_g), unit: 'GRAMS' },
        { label: 'Fruit + veg', value: toNumber(row.fruit_veg_servings), unit: 'SERVINGS' },
      ],
    });
  }

  for (const row of rows.sleep) {
    records.push({
      ...base(row),
      table: 'sleep_records',
      title: 'Sleep',
      recordedAt: isoOf(row.created_at),
      href: null,
      fields: [
        { label: 'Asleep', value: toNumber(row.duration_minutes), unit: 'DURATION' },
        { label: 'Sleep score', value: toNumber(row.sleep_score), unit: 'SCORE' },
      ],
    });
  }

  for (const row of rows.cardio) {
    records.push({
      ...base(row),
      table: 'cardio_sessions',
      title: `Cardio · ${titleCase(row.cardio_type)}`,
      recordedAt: isoOf(row.created_at),
      href: null,
      fields: [
        { label: 'Duration', value: toNumber(row.duration_minutes), unit: 'DURATION' },
        { label: 'Distance', value: toNumber(row.distance_km), unit: 'DISTANCE' },
        { label: 'Average HR', value: toNumber(row.average_heart_rate), unit: 'BPM' },
        { label: 'Maximum HR', value: toNumber(row.max_heart_rate), unit: 'BPM' },
        { label: 'Calories burned', value: toNumber(row.calories), unit: 'KCAL' },
        { label: 'Heart-rate zone', value: toNumber(row.hr_zone), unit: 'ZONE' },
      ],
    });
  }

  for (const row of rows.workouts) {
    records.push({
      ...base(row),
      table: 'workout_sessions',
      title: `Training · ${titleCase(row.session_type)}`,
      recordedAt: isoOf(row.created_at),
      href: `/training/${row.id}`,
      fields: [
        { label: 'Duration', value: toNumber(row.duration_minutes), unit: 'DURATION' },
        { label: 'Average HR', value: toNumber(row.average_heart_rate), unit: 'BPM' },
        { label: 'Maximum HR', value: toNumber(row.max_heart_rate), unit: 'BPM' },
        { label: 'Calories burned', value: toNumber(row.calories), unit: 'KCAL' },
      ],
    });
  }

  // Newest first, and a live row ahead of a superseded one recorded at the
  // same moment, so what currently counts is what is read first.
  return records.sort((a, b) => {
    if (a.supersededAt === null && b.supersededAt !== null) return -1;
    if (a.supersededAt !== null && b.supersededAt === null) return 1;
    return a.recordedAt < b.recordedAt ? 1 : a.recordedAt > b.recordedAt ? -1 : 0;
  });
}

/**
 * The day as the canonical layer resolved it, field by field.
 *
 * `key` is the provenance key, so the caller can look up which observation won
 * the field and how many competed for it - the record that daily_metrics has
 * kept since 0005 and that nothing read until this view existed.
 *
 * `aggregate` marks the four fields that are SUMS of a day's sessions rather
 * than resolutions between competing observations. They have no provenance
 * entry and never will, and saying so is better than a blank where a source
 * should be.
 */
export interface CanonicalField {
  key: string;
  label: string;
  value: number | null;
  unit: DayFieldUnit;
  aggregate?: true;
}

export function canonicalSummary(metrics: DailyMetrics): CanonicalField[] {
  return [
    { key: 'weightKg', label: 'Weight', value: metrics.weightKg, unit: 'WEIGHT' },
    { key: 'waistCm', label: 'Waist', value: metrics.waistCm, unit: 'LENGTH' },

    { key: 'caloriesConsumed', label: 'Calories', value: metrics.caloriesConsumed, unit: 'KCAL' },
    { key: 'proteinG', label: 'Protein', value: metrics.proteinG, unit: 'GRAMS' },
    { key: 'carbsG', label: 'Carbohydrate', value: metrics.carbsG, unit: 'GRAMS' },
    { key: 'fatG', label: 'Fat', value: metrics.fatG, unit: 'GRAMS' },
    { key: 'fiberG', label: 'Fibre', value: metrics.fiberG, unit: 'GRAMS' },
    {
      key: 'fruitVegServings', label: 'Fruit + veg',
      value: metrics.fruitVegServings, unit: 'SERVINGS',
    },

    { key: 'steps', label: 'Steps', value: metrics.steps, unit: 'COUNT' },
    { key: 'activeCalories', label: 'Active calories', value: metrics.activeCalories, unit: 'KCAL' },
    {
      key: 'totalCaloriesBurned', label: 'Total calories burned',
      value: metrics.totalCaloriesBurned, unit: 'KCAL',
    },

    {
      key: 'sleepDurationMinutes', label: 'Sleep',
      value: metrics.sleepDurationMinutes, unit: 'DURATION',
    },
    { key: 'sleepScore', label: 'Sleep score', value: metrics.sleepScore, unit: 'SCORE' },
    {
      key: 'restingHeartRate', label: 'Resting heart rate',
      value: metrics.restingHeartRate, unit: 'BPM',
    },
    { key: 'hrvMs', label: 'HRV', value: metrics.hrvMs, unit: 'MS' },

    // Summed, not resolved (lib/data/canonicalise.ts).
    {
      key: 'trainingSessions', label: 'Training sessions',
      value: metrics.trainingSessions, unit: 'COUNT', aggregate: true,
    },
    {
      key: 'workoutMinutes', label: 'Training time',
      value: metrics.workoutMinutes, unit: 'DURATION', aggregate: true,
    },
    {
      key: 'cardioMinutes', label: 'Cardio time',
      value: metrics.cardioMinutes, unit: 'DURATION', aggregate: true,
    },
    {
      key: 'zone2Minutes', label: 'Zone 2 time',
      value: metrics.zone2Minutes, unit: 'DURATION', aggregate: true,
    },
  ];
}

/**
 * The records still counting towards the day.
 *
 * `== null` rather than `=== null`, matching live() in lib/data/canonicalise.ts
 * and for the same reason: a record whose supersession cannot be read must not
 * be presented as withdrawn. Erring the other way hides a live observation.
 */
export function liveRecords(records: DayRecord[]): DayRecord[] {
  return records.filter((record) => record.supersededAt == null);
}

/** The records on file that no longer count: corrected, or withdrawn. */
export function supersededRecords(records: DayRecord[]): DayRecord[] {
  return records.filter((record) => record.supersededAt != null);
}

export type { LocalDate };
