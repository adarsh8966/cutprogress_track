import 'server-only';

/**
 * Canonical readers: the one door the future AI layer knocks on.
 *
 * WHAT THIS IS FOR. The next feature after this integration is an assistant
 * built on the OpenAI API. The way that goes wrong is predictable: it reaches
 * for whatever query is nearest, ends up reading provider tables directly, and
 * then a change to Google Health breaks the coaching. So the boundary is drawn
 * now, before there is anything on the other side of it to be lazy with.
 *
 * THREE PROPERTIES, EACH LOAD-BEARING:
 *
 *  1. NO PROVIDER NAMES CROSS THIS LINE. Not in a parameter, not in a return
 *     type, not in a field. The assistant asks for sleep and gets sleep; it
 *     never learns that Fitbit exists. A test asserts this, because it is the
 *     kind of thing that erodes the first time somebody needs "just the one"
 *     provider-specific field.
 *
 *  2. THESE ARE THE SAME READERS THE UI USES. getAnalyticsWindow and the pure
 *     analytics underneath it, not a parallel path. One source of truth means
 *     the assistant and the screen cannot disagree - which they would, within a
 *     month, if there were two.
 *
 *  3. NOTHING IS COPIED ANYWHERE. There is no AI store, no embedding of the
 *     fitness history, no duplicate. These are functions over the canonical
 *     model, and a question is answered by calling the ones it needs.
 *
 * SCOPED, NOT WHOLESALE. Each reader takes a range and returns only what it
 * covers, so "why was yesterday's workout hard?" fetches yesterday's workout,
 * its heart rate, the night before and recent load - not the database.
 */
import type { LocalDate, DailyMetrics } from '@/lib/types';
import { derived, insufficient, unavailable } from '@/lib/types';
import {
  getAnalyticsWindow, getDailyMetrics, getProfile, getWorkoutSessions,
  getSetsForSession, getWorkoutSession, getSessionTelemetry, getHeartRateZones,
  getCanonicalFieldPins,
} from '@/lib/data/queries';
import { trailingAverage } from '@/lib/analytics/movingAverage';
import { latestReading } from '@/lib/analytics/latest';
import { trend } from '@/lib/analytics/trend';
import { pickMetric, densify } from '@/lib/analytics/series';
import { recoverySummary } from '@/lib/analytics/recovery';
import { volumeByMuscleGroup, groupByExercise } from '@/lib/analytics/training';
import { addDays, localToday } from '@/lib/normalization/dates';
import { todayForUser } from '@/app/actions/log';
import type {
  DailyHealthContext, TrendContext, HeartRateContext, WorkoutContext,
  RecoveryContext, SleepContext, Zone2Context, TrainingContext,
  NutritionContext, FitnessContext, Provenance,
} from './types';

/** How far back an unqualified "recent" reaches. */
export const DEFAULT_WINDOW_DAYS = 30;

function toProvenance(raw: unknown, pinned: Set<string>): Record<string, Provenance> {
  const out: Record<string, Provenance> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [field, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as { source?: unknown; confidence?: unknown; sources?: unknown;
      candidates?: unknown };
    out[field] = {
      source: typeof e.source === 'string' ? e.source : 'UNKNOWN',
      confidence: typeof e.confidence === 'string' ? e.confidence : 'UNKNOWN',
      sources: typeof e.sources === 'number'
        ? e.sources
        : typeof e.candidates === 'number' ? e.candidates : 1,
      pinnedByUser: pinned.has(field),
    };
  }
  return out;
}

function shapeDay(
  day: DailyMetrics,
  provenance: Record<string, Provenance>,
): DailyHealthContext {
  return {
    date: day.localDate,
    body: {
      weightKg: day.weightKg,
      waistCm: day.waistCm,
      bodyFatPct: day.bodyFatPct,
    },
    activity: {
      steps: day.steps,
      distanceKm: day.distanceKm,
      floors: day.floors,
      activeMinutes: day.activeMinutes,
      activeZoneMinutes: day.activeZoneMinutes,
      activeCalories: day.activeCalories,
      totalCaloriesBurned: day.totalCaloriesBurned,
    },
    recovery: {
      restingHeartRate: day.restingHeartRate,
      hrvMs: day.hrvMs,
      respiratoryRate: day.respiratoryRate,
      oxygenSaturationPct: day.oxygenSaturationPct,
      vo2Max: day.vo2Max,
    },
    sleep: {
      durationMinutes: day.sleepDurationMinutes,
      score: day.sleepScore,
      remMinutes: day.remMinutes,
      deepMinutes: day.deepMinutes,
      lightMinutes: day.lightMinutes,
      awakeMinutes: day.awakeMinutes,
      temperatureDeltaC: day.sleepTemperatureDeltaC,
    },
    nutrition: {
      calories: day.caloriesConsumed,
      proteinG: day.proteinG,
      carbsG: day.carbsG,
      fatG: day.fatG,
      fiberG: day.fiberG,
      manuallyEntered: true,
    },
    training: {
      sessions: day.trainingSessions,
      minutes: day.workoutMinutes,
      cardioMinutes: day.cardioMinutes,
      zone2Minutes: day.zone2Minutes,
    },
    provenance,
  };
}

/** One day, resolved, with the provenance of every field it holds. */
export async function getDailyHealthContext(
  date?: LocalDate,
): Promise<DailyHealthContext | null> {
  const target = date ?? (await todayForUser());
  const [days, pins] = await Promise.all([
    getDailyMetrics(target, target),
    getCanonicalFieldPins(target),
  ]);
  const day = days[0];
  if (day === undefined) return null;

  // The provenance map lives on the row rather than the domain type, so it is
  // read from the day view's own reader rather than rebuilt here.
  const { getDayDetail } = await import('@/lib/data/queries');
  const detail = await getDayDetail(target);
  const pinned = new Set(pins.map((p) => p.field));
  return shapeDay(day, toProvenance(detail.provenance, pinned));
}

/** A metric over a window: what is typical, what was last true, and the shape. */
function shapeTrend(
  days: DailyMetrics[],
  key: keyof DailyMetrics,
  metric: string,
  unit: string,
  from: LocalDate,
  to: LocalDate,
  windowDays: number,
): TrendContext {
  const series = pickMetric(days, key);
  return {
    metric,
    unit,
    windowDays,
    average: trailingAverage(series, to, windowDays >= 30 ? 30 : 7, { label: metric }),
    latest: latestReading(series, to, windowDays, { label: metric }),
    perWeek: (() => {
      const fitted = trend(series, to, windowDays, `${metric} trend`);
      if (fitted.value === null) {
        return unavailable<number>(
          `${metric} rate of change`, fitted.inputs,
          fitted.notes[0] ?? 'not enough measurements to fit a trend',
          fitted.observations ?? 0,
        );
      }
      return derived(
        fitted.value.perWeek, `${metric} rate of change`, fitted.inputs,
        fitted.confidence, fitted.notes, fitted.observations,
      );
    })(),
    // densify makes every day in the range explicit, so a gap reads as a gap
    // rather than as an absence the reader has to notice.
    series: densify(series, from, to).map((p) => ({ date: p.date, value: p.value })),
  };
}

export async function getWeightTrend(windowDays = 90): Promise<TrendContext> {
  const { metrics, end } = await getAnalyticsWindow();
  const from = addDays(end, -(windowDays - 1));
  return shapeTrend(metrics, 'weightKg', 'Weight', 'kg', from, end, windowDays);
}

export async function getRecoveryContext(windowDays = 30): Promise<RecoveryContext> {
  const { metrics, end } = await getAnalyticsWindow();
  const from = addDays(end, -(windowDays - 1));
  const summary = recoverySummary(metrics, end);
  return {
    from,
    to: end,
    sleepDuration: shapeTrend(metrics, 'sleepDurationMinutes', 'Sleep duration', 'min', from, end, windowDays),
    restingHeartRate: shapeTrend(metrics, 'restingHeartRate', 'Resting heart rate', 'bpm', from, end, windowDays),
    hrv: shapeTrend(metrics, 'hrvMs', 'HRV', 'ms', from, end, windowDays),
    respiratoryRate: shapeTrend(metrics, 'respiratoryRate', 'Respiratory rate', 'breaths/min', from, end, windowDays),
    oxygenSaturation: shapeTrend(metrics, 'oxygenSaturationPct', 'Blood oxygen', '%', from, end, windowDays),
    belowBaseline: summary.belowBaseline,
  };
}

export async function getSleepContext(windowDays = 30): Promise<SleepContext> {
  const { metrics, end } = await getAnalyticsWindow();
  const from = addDays(end, -(windowDays - 1));
  const inWindow = metrics.filter((d) => d.localDate >= from && d.localDate <= end);
  return {
    from,
    to: end,
    nights: inWindow.map((d) => ({
      date: d.localDate,
      durationMinutes: d.sleepDurationMinutes,
      score: d.sleepScore,
      remMinutes: d.remMinutes,
      deepMinutes: d.deepMinutes,
      lightMinutes: d.lightMinutes,
      awakeMinutes: d.awakeMinutes,
      temperatureDeltaC: d.sleepTemperatureDeltaC,
    })),
    averageDuration: trailingAverage(
      pickMetric(metrics, 'sleepDurationMinutes'), end, 30, { label: 'Sleep duration' },
    ),
    averageDeep: trailingAverage(
      pickMetric(metrics, 'deepMinutes'), end, 30, { label: 'Deep sleep' },
    ),
    averageRem: trailingAverage(
      pickMetric(metrics, 'remMinutes'), end, 30, { label: 'REM sleep' },
    ),
  };
}

/**
 * The heart rate recorded during one session.
 *
 * Returns null when there is none, rather than a shape full of zeros. A session
 * with no telemetry is a session nobody measured, and an assistant handed
 * `averageBpm: 0` will describe a workout the user did not do.
 */
export async function getHeartRateContext(sessionId: string): Promise<HeartRateContext | null> {
  const telemetry = (await getSessionTelemetry([sessionId])).get(sessionId);
  if (telemetry === undefined) return null;

  const zones = (telemetry.zone_minutes ?? {}) as Record<string, unknown>;
  const zoneMinutes: Record<string, number> = {};
  for (const [zone, value] of Object.entries(zones)) {
    if (typeof value === 'number') zoneMinutes[zone] = value;
  }

  const coverage = telemetry.hr_coverage_pct === null
    ? null
    : Number(telemetry.hr_coverage_pct) / 100;

  const caveats: string[] = [];
  if (telemetry.hr_sample_count === 0 || telemetry.hr_sample_count === null) {
    caveats.push(
      'These figures come from the source’s own session summary, not from '
      + 'individual heart-rate readings.',
    );
  }
  if (coverage !== null && coverage < 0.8) {
    caveats.push(
      `Heart rate covers ${Math.round(coverage * 100)}% of this session, so the `
      + 'zone minutes are a floor rather than a total.',
    );
  }
  if (telemetry.match_confidence !== null && Number(telemetry.match_confidence) < 0.75) {
    caveats.push(
      'This session was matched to the recording by time overlap with low '
      + 'confidence. The figures may belong to a different activity.',
    );
  }
  if (Object.keys(zoneMinutes).length === 0) {
    caveats.push('No zone breakdown could be computed for this session.');
  }

  return {
    sessionId,
    averageBpm: telemetry.average_hr === null ? null : Number(telemetry.average_hr),
    minBpm: telemetry.min_hr === null ? null : Number(telemetry.min_hr),
    maxBpm: telemetry.max_hr === null ? null : Number(telemetry.max_hr),
    sampleCount: telemetry.hr_sample_count ?? 0,
    coverage,
    zoneMinutes,
    zone2Minutes: zoneMinutes['2'] ?? null,
    method: telemetry.hr_sample_count && telemetry.hr_sample_count > 0
      ? 'measured heart-rate samples'
      : Object.keys(zoneMinutes).length > 0 ? 'the source’s own zone summary' : null,
    matchConfidence: telemetry.match_confidence === null
      ? null : Number(telemetry.match_confidence),
    caveats,
  };
}

export async function getWorkoutContext(sessionId: string): Promise<WorkoutContext | null> {
  const session = await getWorkoutSession(sessionId);
  if (session === null) return null;

  const [sets, heartRate] = await Promise.all([
    getSetsForSession(sessionId),
    getHeartRateContext(sessionId),
  ]);

  return {
    sessionId,
    date: session.date,
    title: session.title,
    sessionType: session.sessionType,
    startTime: session.startTime,
    endTime: session.endTime,
    durationMinutes: session.durationMinutes,
    caloriesKcal: session.calories,
    source: session.source,
    exercises: groupByExercise(sets).map((block) => ({
      exerciseId: block.exerciseId,
      name: block.exerciseName,
      // Taken from the first set rather than the block, which does not carry
      // it: every set of one exercise shares a muscle group by construction.
      muscleGroup: block.sets[0]?.primaryMuscleGroup ?? 'Unspecified',
      sets: block.sets.map((set) => ({
        setNumber: set.setNumber,
        weightKg: set.weightKg,
        reps: set.reps,
        rpe: set.rpe,
        warmup: set.warmup,
      })),
    })),
    heartRate,
  };
}

export async function getTrainingContext(windowDays = 30): Promise<TrainingContext> {
  const { end } = await getAnalyticsWindow();
  const from = addDays(end, -(windowDays - 1));
  const sessions = await getWorkoutSessions(from, end);

  const contexts = await Promise.all(
    sessions.map((session) => getWorkoutContext(session.id)),
  );
  const present = contexts.filter((c): c is WorkoutContext => c !== null);

  const { sets } = await getAnalyticsWindow();
  const inWindow = sets.filter((s) => s.date >= from && s.date <= end);
  const minutes = sessions
    .map((s) => s.durationMinutes)
    .filter((m): m is number => m !== null);

  return {
    from,
    to: end,
    sessions: present,
    totalSessions: sessions.length,
    // Null, not zero, when no session reported a duration: "I trained four
    // times for an unknown number of minutes" is not "I trained for 0 minutes".
    totalMinutes: minutes.length > 0 ? minutes.reduce((a, b) => a + b, 0) : null,
    setsByMuscleGroup: volumeByMuscleGroup(inWindow).map((group) => ({
      muscleGroup: group.muscleGroup,
      sets: group.sets,
      volumeKg: group.volumeKg,
    })),
  };
}

/**
 * Zone 2 across a window, and the sessions that produced it.
 *
 * The breakdown matters as much as the total: "you did 84 minutes of Zone 2" is
 * a claim the user should be able to check against four specific workouts, and
 * an assistant that can name them is one that can be corrected.
 */
export async function getZone2Context(windowDays = 28): Promise<Zone2Context> {
  const { end } = await getAnalyticsWindow();
  const from = addDays(end, -(windowDays - 1));

  const [sessions, zones] = await Promise.all([
    getWorkoutSessions(from, end),
    getHeartRateZones(),
  ]);
  const telemetry = await getSessionTelemetry(sessions.map((s) => s.id));

  const bySession: Zone2Context['bySession'] = [];
  for (const session of sessions) {
    const row = telemetry.get(session.id);
    if (row === undefined) continue;
    const zoneMinutes = (row.zone_minutes ?? {}) as Record<string, unknown>;
    const zone2 = zoneMinutes['2'];
    if (typeof zone2 !== 'number' || zone2 <= 0) continue;
    bySession.push({
      sessionId: session.id,
      date: session.date,
      title: session.title,
      zone2Minutes: zone2,
      method: row.hr_sample_count && row.hr_sample_count > 0
        ? 'measured heart-rate samples'
        : 'the source’s own zone summary',
    });
  }

  const inputs = { windowDays, from, to: end, sessions: bySession.length };
  const total = bySession.reduce((sum, s) => sum + s.zone2Minutes, 0);

  return {
    from,
    to: end,
    bySession,
    totalMinutes: bySession.length === 0
      ? insufficient<number>(
        'Zone 2 minutes from session telemetry',
        inputs,
        'No session in this window has heart-rate data with time in Zone 2.',
        0,
      )
      : derived(
        Math.round(total * 10) / 10,
        'Zone 2 minutes from session telemetry',
        inputs,
        'HIGH',
        [`Summed over ${bySession.length} session(s) with heart-rate data.`],
        bySession.length,
      ),
    zoneDefinition: zones[1]
      ? `Zone 2 is ${zones[1].lower_bpm}–${zones[1].upper_bpm ?? ''} bpm, `
        + `from ${zones[1].derived_from ?? 'your saved settings'}.`
      : null,
  };
}

/**
 * Nutrition, which is manual and stays manual.
 *
 * `manuallyEntered: true` is a literal on the type, not a computed flag. There
 * is no import path to these fields - the Google Health integration requests no
 * nutrition scope and a boundary test asserts it names no nutrition table - so
 * an assistant reading this can state without hedging that the user entered
 * every one of these figures.
 */
export async function getNutritionContext(windowDays = 30): Promise<NutritionContext> {
  const { metrics, end, profile } = await getAnalyticsWindow();
  const from = addDays(end, -(windowDays - 1));
  const inWindow = metrics.filter((d) => d.localDate >= from && d.localDate <= end);

  return {
    from,
    to: end,
    manuallyEntered: true,
    days: inWindow.map((d) => ({
      date: d.localDate,
      calories: d.caloriesConsumed,
      proteinG: d.proteinG,
      carbsG: d.carbsG,
      fatG: d.fatG,
      fiberG: d.fiberG,
    })),
    averageCalories: trailingAverage(
      pickMetric(metrics, 'caloriesConsumed'), end, 30, { label: 'Calories' },
    ),
    averageProtein: trailingAverage(
      pickMetric(metrics, 'proteinG'), end, 30, { label: 'Protein' },
    ),
    targets: {
      calories: profile?.targets.calories ?? null,
      proteinG: profile?.targets.proteinG ?? null,
      fiberG: profile?.targets.fiberG ?? null,
    },
  };
}

/** Everything, over an explicit range. */
export async function getFitnessContextForDateRange(
  from: LocalDate,
  to: LocalDate,
): Promise<FitnessContext> {
  const windowDays = Math.max(
    1,
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`))
      / 86_400_000) + 1,
  );

  const [profile, days, recovery, training, nutrition, weight, zone2] = await Promise.all([
    getProfile(),
    getDailyMetrics(from, to),
    getRecoveryContext(windowDays),
    getTrainingContext(windowDays),
    getNutritionContext(windowDays),
    getWeightTrend(windowDays),
    getZone2Context(windowDays),
  ]);

  const timezone = profile?.timezone ?? 'UTC';
  const today = localToday(timezone);

  /**
   * What is absent, said out loud.
   *
   * A model that cannot see a gap fills it. Listing the metrics with no
   * measurement in the window is what lets the assistant say "you have not
   * logged sleep this month" rather than reasoning around an absence it never
   * registered.
   */
  const NAMED: [keyof DailyMetrics, string][] = [
    ['weightKg', 'body weight'],
    ['caloriesConsumed', 'nutrition'],
    ['steps', 'steps'],
    ['sleepDurationMinutes', 'sleep'],
    ['restingHeartRate', 'resting heart rate'],
    ['hrvMs', 'HRV'],
    ['bodyFatPct', 'body fat'],
    ['vo2Max', 'VO2 max'],
    ['respiratoryRate', 'respiratory rate'],
    ['oxygenSaturationPct', 'blood oxygen'],
    ['remMinutes', 'sleep stages'],
  ];
  const missing = NAMED
    .filter(([key]) => days.every((day) => day[key] === null))
    .map(([, label]) => label);

  return {
    from,
    to,
    timezone,
    today,
    days: days.map((day) => shapeDay(day, {})),
    recovery,
    training,
    nutrition,
    weight,
    zone2,
    missing,
  };
}

/** The last 30 days, which is what most questions are actually about. */
export function getRecentFitnessContext(
  windowDays = DEFAULT_WINDOW_DAYS,
): Promise<FitnessContext> {
  return todayForUser().then((today) =>
    getFitnessContextForDateRange(addDays(today, -(windowDays - 1)), today));
}
