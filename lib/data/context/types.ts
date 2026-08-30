/**
 * The shapes the future AI layer reads.
 *
 * PURE TYPES. No Supabase, no provider, no I/O - so the contract can be read
 * and reasoned about without opening a query.
 *
 * NOTHING HERE NAMES A PROVIDER. There is no `fitbit`, no `googleHealth`, no
 * `hevy` in any field name or any value type, and a test asserts it. That is
 * the whole point of this layer: the assistant asks CUT OS what is true, and
 * CUT OS answers from its canonical model. If Google Health is replaced
 * tomorrow, or a second source is added, every one of these shapes is
 * unchanged and nothing that reads them has to know.
 *
 * WHY Derived<T> RATHER THAN BARE NUMBERS. An assistant that receives `62` for
 * resting heart rate cannot tell whether that is today's measurement, a 30-day
 * average, or an estimate - and will confidently say whichever it guesses.
 * Derived<T> carries the method, the inputs, the confidence and the caveats, so
 * the model has the material to say "your resting heart rate averaged 62 over
 * the last 30 days, from 22 days of readings" instead of inventing a framing.
 */
import type { Derived, LocalDate } from '@/lib/types';

/** Where a canonical value came from, in the vocabulary CUT OS uses. */
export interface Provenance {
  /** MANUAL, IMPORT_TEXT, GOOGLE_HEALTH, HEVY - the data_source vocabulary. */
  source: string;
  confidence: string;
  /** How many distinct sources reported this field for the day. */
  sources: number;
  /** True when the user authored this value and imports are not moving it. */
  pinnedByUser: boolean;
}

/** One day, resolved, with the provenance of each field. */
export interface DailyHealthContext {
  date: LocalDate;
  body: {
    weightKg: number | null;
    waistCm: number | null;
    bodyFatPct: number | null;
  };
  activity: {
    steps: number | null;
    distanceKm: number | null;
    floors: number | null;
    activeMinutes: number | null;
    activeZoneMinutes: number | null;
    activeCalories: number | null;
    totalCaloriesBurned: number | null;
  };
  recovery: {
    restingHeartRate: number | null;
    hrvMs: number | null;
    respiratoryRate: number | null;
    oxygenSaturationPct: number | null;
    vo2Max: number | null;
  };
  sleep: {
    durationMinutes: number | null;
    score: number | null;
    remMinutes: number | null;
    deepMinutes: number | null;
    lightMinutes: number | null;
    awakeMinutes: number | null;
    /** Signed: below baseline is negative. */
    temperatureDeltaC: number | null;
  };
  nutrition: {
    calories: number | null;
    proteinG: number | null;
    carbsG: number | null;
    fatG: number | null;
    fiberG: number | null;
    /** Always true. Nutrition in CUT OS is entered by hand and only by hand. */
    manuallyEntered: true;
  };
  training: {
    sessions: number | null;
    minutes: number | null;
    cardioMinutes: number | null;
    zone2Minutes: number | null;
  };
  /** Per-field, keyed by the canonical field name. */
  provenance: Record<string, Provenance>;
}

/** A metric over a window, both ways: what is typical, and what was last true. */
export interface TrendContext {
  metric: string;
  unit: string;
  windowDays: number;
  average: Derived<number>;
  latest: Derived<number>;
  /** Per-week rate of change, where enough points exist to fit one. */
  perWeek: Derived<number>;
  /** The daily points, with explicit nulls for days that hold no measurement. */
  series: { date: LocalDate; value: number | null }[];
}

/** The heart rate recorded during one session, and what it means. */
export interface HeartRateContext {
  sessionId: string;
  averageBpm: number | null;
  minBpm: number | null;
  maxBpm: number | null;
  sampleCount: number;
  /** 0..1, or null when there is no basis to say. */
  coverage: number | null;
  /** Minutes per zone 1-5. Empty when no zone breakdown could be computed. */
  zoneMinutes: Record<string, number>;
  zone2Minutes: number | null;
  /** How the zones were arrived at: from samples, or the provider's own bands. */
  method: string | null;
  /** Present when the session was matched to a source's own recording. */
  matchConfidence: number | null;
  /** Everything the figures above depend on being read carefully. */
  caveats: string[];
}

export interface WorkoutContext {
  sessionId: string;
  date: LocalDate;
  title: string | null;
  sessionType: string;
  startTime: string | null;
  endTime: string | null;
  durationMinutes: number | null;
  caloriesKcal: number | null;
  source: string;
  exercises: {
    exerciseId: string;
    name: string;
    muscleGroup: string;
    sets: {
      setNumber: number;
      weightKg: number | null;
      reps: number | null;
      rpe: number | null;
      warmup: boolean;
    }[];
  }[];
  heartRate: HeartRateContext | null;
}

export interface RecoveryContext {
  from: LocalDate;
  to: LocalDate;
  sleepDuration: TrendContext;
  restingHeartRate: TrendContext;
  hrv: TrendContext;
  respiratoryRate: TrendContext;
  oxygenSaturation: TrendContext;
  /** True only when the last 7 days sit materially below the 30-day baseline. */
  belowBaseline: boolean;
}

export interface SleepContext {
  from: LocalDate;
  to: LocalDate;
  nights: {
    date: LocalDate;
    durationMinutes: number | null;
    score: number | null;
    remMinutes: number | null;
    deepMinutes: number | null;
    lightMinutes: number | null;
    awakeMinutes: number | null;
    temperatureDeltaC: number | null;
  }[];
  averageDuration: Derived<number>;
  averageDeep: Derived<number>;
  averageRem: Derived<number>;
}

export interface Zone2Context {
  from: LocalDate;
  to: LocalDate;
  /** Total Zone 2 minutes across the window. */
  totalMinutes: Derived<number>;
  /** The sessions that contributed, so a total can be traced to its parts. */
  bySession: {
    sessionId: string;
    date: LocalDate;
    title: string | null;
    zone2Minutes: number;
    method: string | null;
  }[];
  /** How the zone boundaries were arrived at, in plain words. */
  zoneDefinition: string | null;
}

export interface TrainingContext {
  from: LocalDate;
  to: LocalDate;
  sessions: WorkoutContext[];
  totalSessions: number;
  totalMinutes: number | null;
  /** Working-set counts per muscle group over the window. */
  setsByMuscleGroup: { muscleGroup: string; sets: number; volumeKg: number | null }[];
}

export interface NutritionContext {
  from: LocalDate;
  to: LocalDate;
  /** Always true: nutrition is manual in CUT OS and no import can change it. */
  manuallyEntered: true;
  days: {
    date: LocalDate;
    calories: number | null;
    proteinG: number | null;
    carbsG: number | null;
    fatG: number | null;
    fiberG: number | null;
  }[];
  averageCalories: Derived<number>;
  averageProtein: Derived<number>;
  targets: {
    calories: number | null;
    proteinG: number | null;
    fiberG: number | null;
  };
}

/** Everything at once, for a question that could be about anything. */
export interface FitnessContext {
  from: LocalDate;
  to: LocalDate;
  timezone: string;
  today: LocalDate;
  days: DailyHealthContext[];
  recovery: RecoveryContext;
  training: TrainingContext;
  nutrition: NutritionContext;
  weight: TrendContext;
  zone2: Zone2Context;
  /**
   * What is NOT known, stated explicitly.
   *
   * An assistant that cannot see the gaps will fill them. This is the list of
   * metrics with no data in the window, so the model can say "you have not
   * logged sleep this month" instead of reasoning from an absence it did not
   * notice.
   */
  missing: string[];
}
