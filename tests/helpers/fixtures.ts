/**
 * A fixed synthetic dataset used by the Context Pack snapshot test.
 *
 * Deliberately imperfect: it contains unlogged days, a weekly-only waist
 * measurement, rest days, and a nutrition gap. A dataset where everything is
 * present would not exercise the parts of the pack that matter most - the
 * missing-data handling and the coverage gates.
 *
 * Generated arithmetically rather than typed out so the trends are exact and
 * the assertions can be about known values.
 */
import type { DailyMetrics, UserProfile } from '@/lib/types';
import type { LoggedSet, TrainingSession } from '@/lib/analytics/training';
import { addDays, dateRange } from '@/lib/normalization/dates';
import { feetInchesToCm, lbToKg } from '@/lib/normalization/units';
import { emptyDay } from '@/lib/defaults';

export const FIXTURE_END = '2026-11-20';
export const FIXTURE_DAYS = 120;
export const FIXTURE_START = addDays(FIXTURE_END, -(FIXTURE_DAYS - 1));

export const FIXTURE_PROFILE: UserProfile = {
  heightCm: feetInchesToCm(5, 10),
  sex: 'MALE',
  dateOfBirth: '1996-03-15',
  timezone: 'America/New_York',
  startingWeightKg: lbToKg(205),
  targetWeightKg: lbToKg(180),
  phase: 'CUT',
  targets: {
    calories: 1950,
    proteinG: 145,
    fiberG: 30,
    steps: 10000,
    trainingSessionsPerWeek: 5,
    cardioMinutesPerWeek: 150,
  },
  maxWeeklyLossRatePct: 1.0,
  cutStartDate: '2026-08-28',
  weightDisplayUnit: 'LB',
  distanceDisplayUnit: 'MI',
  lengthDisplayUnit: 'IN',
};

/**
 * A deterministic pseudo-random generator, so the fixture is stable across runs
 * and machines. Math.random() would make the snapshot meaningless.
 */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

export function fixtureDays(): DailyMetrics[] {
  const random = seeded(20260828);
  /**
   * A SECOND, INDEPENDENT STREAM for the wearable metrics.
   *
   * Not `random()` again. These generators are seeded and deterministic, so
   * every draw taken from `random` shifts every later draw - and adding one
   * here would silently change the weight, nutrition and sleep values this
   * fixture has produced since it was written. That would move numbers in the
   * Context Pack snapshot that nothing in this change touches, and a snapshot
   * diff full of unrelated movement is one nobody reads carefully.
   */
  const wearable = seeded(20260916);
  const dates = dateRange(FIXTURE_START, FIXTURE_END);

  return dates.map((localDate, i): DailyMetrics => {
    // Losing ~1.2 lb/week with day-to-day water noise on top.
    const trendKg = lbToKg(205) - i * (lbToKg(1.2) / 7);
    const noise = (random() - 0.5) * 0.9;
    // Weight is missed roughly one day in seven.
    const weighed = random() > 0.14;
    // Nutrition is logged well, but not perfectly.
    const loggedNutrition = random() > 0.12;
    const dayOfWeek = i % 7;
    const isRestDay = dayOfWeek === 2 || dayOfWeek === 6;

    /**
     * THE BASE DAY IS BUILT FIRST, AND EXACTLY AS IT ALWAYS WAS.
     *
     * Every field below draws from `random` in the same order it has since this
     * fixture was written, so the weight, nutrition and sleep values - and the
     * Context Pack snapshot built on them - are unchanged by this addition. The
     * wearable metrics are added afterwards, from their own stream.
     */
    const base: DailyMetrics = {
      ...emptyDay(localDate),
      localDate,
      weightKg: weighed ? Math.round((trendKg + noise) * 1000) / 1000 : null,
      // Waist is measured weekly, which is a complete cadence, not a gap.
      waistCm: dayOfWeek === 0 ? Math.round((90 - i * 0.02) * 10) / 10 : null,
      steps: Math.round(9200 + random() * 2600),
      activeCalories: Math.round(420 + random() * 260),
      totalCaloriesBurned: null,
      workoutMinutes: isRestDay ? 0 : Math.round(45 + random() * 25),
      cardioMinutes: dayOfWeek === 2 || dayOfWeek === 5 ? Math.round(30 + random() * 20) : 0,
      zone2Minutes: dayOfWeek === 2 || dayOfWeek === 5 ? Math.round(25 + random() * 15) : 0,
      restingHeartRate: Math.round(56 + random() * 6),
      hrvMs: Math.round(48 + random() * 22),
      sleepDurationMinutes: Math.round(410 + random() * 70),
      sleepScore: Math.round(70 + random() * 20),
      caloriesConsumed: loggedNutrition ? Math.round(1880 + random() * 220) : null,
      proteinG: loggedNutrition ? Math.round(132 + random() * 26) : null,
      carbsG: loggedNutrition ? Math.round(180 + random() * 60) : null,
      fatG: loggedNutrition ? Math.round(52 + random() * 22) : null,
      fiberG: loggedNutrition ? Math.round(22 + random() * 14) : null,
      fruitVegServings: loggedNutrition ? Math.round(2 + random() * 4) : null,
      trainingSessions: isRestDay ? 0 : 1,
    };

    /**
     * What a wearable adds, drawn from the second stream.
     *
     * `wore` gates them together rather than field by field: the device is
     * either on the wrist overnight or it is not, and a night with a
     * respiratory rate but no sleep stages is not a shape a real device
     * produces. A fixture that cannot happen proves nothing about code that
     * has to handle what can.
     */
    const wore = wearable() > 0.1;
    const sleepMinutes = base.sleepDurationMinutes ?? 0;

    return {
      ...base,
      // Stages partition the night, so they are shares of it rather than
      // independent draws: three unrelated numbers would not add up to the
      // duration sitting beside them.
      remMinutes: wore ? Math.round(sleepMinutes * 0.21) : null,
      deepMinutes: wore ? Math.round(sleepMinutes * 0.16) : null,
      lightMinutes: wore ? Math.round(sleepMinutes * 0.63) : null,
      awakeMinutes: wore ? Math.round(wearable() * 22) : null,
      respiratoryRate: wore ? Math.round((13.5 + wearable() * 2.5) * 10) / 10 : null,
      oxygenSaturationPct: wore ? Math.round((95 + wearable() * 3) * 10) / 10 : null,
      // Signed, and sometimes negative: a colder night than baseline is a real
      // reading, and a fixture that only ever produces positives would let a
      // formatter that drops the sign pass.
      sleepTemperatureDeltaC: wore ? Math.round((wearable() * 1.6 - 0.8) * 100) / 100 : null,
      // Weekly-ish, like waist: a body-composition reading is a deliberate act.
      bodyFatPct: dayOfWeek === 0 ? Math.round((18 - i * 0.01) * 10) / 10 : null,
      vo2Max: dayOfWeek === 3 ? Math.round((44 + wearable() * 2) * 10) / 10 : null,
      distanceKm: Math.round((6.4 + wearable() * 2.2) * 1000) / 1000,
      floors: Math.round(6 + wearable() * 10),
      activeMinutes: Math.round(38 + wearable() * 30),
      activeZoneMinutes: dayOfWeek === 2 || dayOfWeek === 5
        ? Math.round(28 + wearable() * 18)
        : Math.round(wearable() * 12),
    };
  });
}

export function fixtureSets(): LoggedSet[] {
  const random = seeded(913);
  const sets: LoggedSet[] = [];
  const plan = [
    { id: 'cable-row', name: 'Cable Row', muscle: 'Back', base: 31.75 },
    { id: 'machine-chest-press', name: 'Machine Chest Press', muscle: 'Chest', base: 45 },
    { id: 'smith-machine-squat', name: 'Smith Machine Squat', muscle: 'Quadriceps', base: 70 },
    { id: 'cable-lateral-raise', name: 'Cable Lateral Raise', muscle: 'Shoulders', base: 9 },
  ];

  const dates = dateRange(addDays(FIXTURE_END, -27), FIXTURE_END);
  dates.forEach((date, dayIndex) => {
    if (dayIndex % 7 === 2 || dayIndex % 7 === 6) return; // rest days
    const exercise = plan[dayIndex % plan.length]!;
    const sessionId = `session-${date}`;
    // Slow linear progression so the progression tests have a real signal.
    const load = exercise.base + Math.floor(dayIndex / 7) * 2.5;
    for (let setNumber = 1; setNumber <= 3; setNumber += 1) {
      sets.push({
        date,
        sessionId,
        exerciseId: exercise.id,
        exerciseName: exercise.name,
        primaryMuscleGroup: exercise.muscle,
        weightKg: load,
        reps: 12 - setNumber + (random() > 0.7 ? 1 : 0),
        rir: 2,
        rpe: 8,
        warmup: false,
        setNumber,
        // Logged by hand in the fixture's world: no exercise block, no source
        // vocabulary, no per-set distance or duration.
        exerciseIndex: null,
        exerciseNotes: null,
        setType: null,
        supersetId: null,
        distanceKm: null,
        durationSeconds: null,
      });
    }
  });

  return sets;
}

/**
 * Sessions matching fixtureSets(), so the fixture describes one coherent user:
 * the same session ids the sets hang off, with the session-level figures a
 * tracker reports.
 *
 * The last two sessions deliberately carry NO sets. That is the imported-summary
 * case - a session that is entirely real and has no exercise detail - and having
 * it in the shared fixture keeps every consumer honest about handling it.
 */
export function fixtureSessions(): TrainingSession[] {
  const random = seeded(4471);
  const dates = dateRange(addDays(FIXTURE_END, -27), FIXTURE_END);
  const types = ['PULL', 'PUSH', 'LEGS', 'UPPER'];

  return dates
    .filter((_, dayIndex) => dayIndex % 7 !== 2 && dayIndex % 7 !== 6)
    .map((date, i) => {
      // The fixture runs to 20 sessions; the last two are summary-only.
      const summaryOnly = i >= 18;
      return {
        id: summaryOnly ? `imported-${date}` : `session-${date}`,
        date,
        sessionType: types[i % types.length]!,
        // The fixture predates external sources; every session in it was
        // recorded here, with no name of its own.
        title: null,
        externalSource: null,
        durationMinutes: 55 + Math.round(random() * 12),
        averageHeartRate: 132 + Math.round(random() * 14),
        maxHeartRate: 165 + Math.round(random() * 10),
        calories: 380 + Math.round(random() * 60),
        notes: null,
        source: summaryOnly ? 'IMPORT_TEXT' : 'MANUAL',
        completed: true,
        importId: null,
        // Date-only, deliberately. This fixture is what the Context Pack
        // snapshot is taken over, so leaving it timeless keeps that snapshot a
        // real assertion that mapping start and end times moved no figure.
        startTime: null,
        endTime: null,
      };
    });
}

export function fixtureCardio() {
  return dateRange(addDays(FIXTURE_END, -27), FIXTURE_END)
    .filter((_, i) => i % 7 === 2 || i % 7 === 5)
    .map((date, i) => ({
      date,
      type: i % 2 === 0 ? 'INCLINE_WALKING' : 'RUNNING',
      durationMinutes: 35,
      distanceKm: i % 2 === 0 ? 3.2 : 5.0,
      hrZone: 2,
    }));
}
