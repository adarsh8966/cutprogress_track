/**
 * Context Pack generator (spec §30, §31, §32, §53).
 *
 * This is the product. Everything else in the app exists so that this function
 * has something true to say.
 *
 * COMPRESSION (spec §31). Dumping 400 days of raw rows produces a blob no model
 * reads well. The pack is layered instead:
 *   - last 14 days     full daily detail
 *   - 30/60/90 days    summary statistics
 *   - older            monthly summaries
 * That gives recent texture plus long-term trajectory without the bulk.
 *
 * VERSIONING (spec §43). CONTEXT_VERSION is stamped on every export and stored
 * with it, so a pack generated today stays interpretable later even if the
 * format changes.
 */
import type {
  DailyMetrics, DatedValue, Derived, LocalDate, UserProfile,
} from '@/lib/types';
import { ANALYTICS_VERSION } from '@/lib/types';
import { banner, formatNumber, formatRate, line, percent, section, table } from './format';
import { CHATGPT_INSTRUCTIONS } from './instructions';
import { movingAverages, trailingAverage } from '@/lib/analytics/movingAverage';
import { trend, trendChange } from '@/lib/analytics/trend';
import { detectPlateau } from '@/lib/analytics/plateau';
import { estimateTdee } from '@/lib/analytics/tdee';
import { forecastTargetDate } from '@/lib/analytics/forecast';
import { computeAdherence } from '@/lib/analytics/adherence';
import { computeDataQuality } from '@/lib/analytics/dataQuality';
import {
  summariseTraining, summariseSessions,
  type LoggedSet, type TrainingSession,
} from '@/lib/analytics/training';
import { generateRecommendations } from '@/lib/analytics/recommendations';
import {
  cmToInches, kgToLb, kmToMiles,
} from '@/lib/normalization/units';
import {
  addDays, daysBetween, formatMonth, formatShortDate, monthKey,
} from '@/lib/normalization/dates';
import { latestPresent, mean, presentValues, roundTo, trailingWindow } from '@/lib/analytics/series';

// 1.1 splits Training into session-level and exercise-level blocks, so a
// summary-imported session is reported instead of silently omitted.
export const CONTEXT_VERSION = '1.1';

/** Spec §31's compression windows. */
export const DETAIL_DAYS = 14;
export const SUMMARY_WINDOWS = [30, 60, 90] as const;
/** Weight is daily, so 28 days is plenty of points to fit a trend. */
export const WEIGHT_TREND_WINDOW_DAYS = 28;
/** Waist is weekly. 84 days is twelve measurements, which supports a fit. */
export const WAIST_TREND_WINDOW_DAYS = 84;

export interface ContextInput {
  generatedFor: LocalDate;
  profile: UserProfile;
  /** Canonical daily rows, oldest first. */
  days: DailyMetrics[];
  /** Working and warm-up sets over the reporting period. */
  sets: LoggedSet[];
  /**
   * Training sessions over the reporting period, read separately from the sets.
   * A session imported as a summary has no sets, and the pack has to be able to
   * report it: leaving it out told ChatGPT nothing was trained.
   */
  sessions: TrainingSession[];
  cardio: {
    date: LocalDate;
    type: string;
    durationMinutes: number;
    distanceKm: number | null;
    hrZone: number | null;
  }[];
  /** Free-text notes the user wants ChatGPT to see (spec §30 RECENT EVENTS). */
  recentEvents?: { date: LocalDate; note: string }[];
  /** Questions the user wants answered (spec §30's closing section). */
  questions?: string[];
}

export interface ContextPack {
  body: string;
  version: string;
  analyticsVersion: string;
  generatedFor: LocalDate;
  dataQualityScore: number | null;
  parameters: Record<string, unknown>;
}

function pick(days: DailyMetrics[], key: keyof DailyMetrics): DatedValue[] {
  return days.map((day) => {
    const value = day[key];
    return { date: day.localDate, value: typeof value === 'number' ? value : null };
  });
}

/** Renders a Derived value as "value (confidence)" plus its caveats. */
function derivedLine(
  label: string,
  value: Derived<number>,
  render: (v: number) => string,
): string {
  if (value.value === null) {
    return `- ${label}: not computable (${value.notes[0] ?? 'insufficient data'})`;
  }
  return `- ${label}: ${render(value.value)} [confidence: ${value.confidence.toLowerCase()}]`;
}

export function generateContextPack(input: ContextInput): ContextPack {
  const { profile, days, generatedFor: end } = input;
  const lb = (kg: number) => `${formatNumber(kgToLb(kg), 1)} lb`;
  const inches = (cm: number) => `${formatNumber(cmToInches(cm), 1)} in`;

  const weight = pick(days, 'weightKg');
  const waist = pick(days, 'waistCm');
  const calories = pick(days, 'caloriesConsumed');
  const protein = pick(days, 'proteinG');
  const carbs = pick(days, 'carbsG');
  const fat = pick(days, 'fatG');
  const fiber = pick(days, 'fiberG');
  const steps = pick(days, 'steps');
  const sleep = pick(days, 'sleepDurationMinutes');
  const rhr = pick(days, 'restingHeartRate');
  const hrv = pick(days, 'hrvMs');
  const cardioMinutes = pick(days, 'cardioMinutes');
  const zone2 = pick(days, 'zone2Minutes');
  const sessions = pick(days, 'trainingSessions');
  const sessionSummary = summariseSessions(input.sessions, input.sets);

  const weightAverages = movingAverages(weight, end, 'Weight');
  const weightTrend = trend(weight, end, WEIGHT_TREND_WINDOW_DAYS, 'Weight trend');
  const weightDirection = trendChange(weight, end, WEIGHT_TREND_WINDOW_DAYS, 'Weight rate change');
  // Waist is measured weekly, so a 28-day window can only ever hold four
  // points - below the minimum needed to fit a trend. It gets a window matched
  // to its own cadence rather than to weight's daily one.
  const waistTrend = trend(waist, end, WAIST_TREND_WINDOW_DAYS, 'Waist trend');
  const plateau = detectPlateau(weight, calories, steps, end, 21);
  const adherence = computeAdherence(
    { calories, protein, steps, weight, trainingSessions: sessions, cardioMinutes },
    profile.targets, end, 28,
  );
  const dataQuality = computeDataQuality(
    { weight, calories, trainingSessions: sessions, steps, sleepMinutes: sleep, waist },
    end, 28,
  );
  const tdee = estimateTdee(profile, weight, calories, steps, end, 28);
  const forecast = forecastTargetDate(weight, profile.targetWeightKg, end, 28);
  const training = summariseTraining(input.sets);

  const currentWeight = latestPresent(weight);
  const currentWaist = latestPresent(waist);
  const averageSleep = mean(
    presentValues(trailingWindow(sleep, end, 28).map((p) => p.value)),
  );

  const recommendations = generateRecommendations({
    date: end,
    weightTrend,
    currentWeightKg: weightAverages.sevenDay.value ?? currentWeight?.value ?? null,
    plateau,
    adherence,
    dataQuality,
    averageSleepMinutes: averageSleep,
    maxWeeklyLossRatePct: profile.maxWeeklyLossRatePct,
  });

  const parts: string[] = [];

  // ---------------------------------------------------------------- header
  parts.push(banner('Fitness Context Pack'));
  parts.push(
    [
      `Generated: ${end}`,
      `Context version: ${CONTEXT_VERSION}`,
      `Analytics version: ${ANALYTICS_VERSION}`,
      '',
      'PURPOSE:',
      "Provide ChatGPT with the current state of the user's fitness",
      'journey for analysis and coaching.',
    ].join('\n'),
  );
  parts.push('');
  parts.push(CHATGPT_INSTRUCTIONS);

  // ------------------------------------------------------------ data quality
  // Deliberately placed BEFORE the data, so the reader is calibrated first.
  parts.push(section('Data quality'));
  if (dataQuality.value) {
    parts.push(
      `DATA QUALITY: ${formatNumber(dataQuality.value.score, 0)}/100 ` +
        `(${dataQuality.value.band} confidence)`,
    );
    parts.push('');
    parts.push(
      table(
        ['Input', 'Coverage', 'Days', 'Points'],
        dataQuality.value.components.map((c) => [
          c.label, percent(c.coverage), c.daysPresent, `${c.points}/${c.weight}`,
        ]),
      ),
    );
    if (dataQuality.value.band !== 'HIGH') {
      parts.push('');
      parts.push(
        'LOW/MODERATE data quality means conclusions below are provisional.',
      );
    }
  } else {
    parts.push('DATA QUALITY: not computable - no data in the window.');
  }

  // --------------------------------------------------------------- profile
  parts.push(section('User profile'));
  parts.push(
    [
      line('Height', profile.heightCm === null ? null : inches(profile.heightCm)),
      line('Sex', profile.sex),
      line('Timezone', profile.timezone),
      line('Phase', profile.phase),
      line(
        'Starting weight',
        profile.startingWeightKg === null ? null : lb(profile.startingWeightKg),
      ),
      line(
        'Target weight',
        profile.targetWeightKg === null ? null : lb(profile.targetWeightKg),
      ),
      line('Cut start date', profile.cutStartDate),
      line('Self-imposed max loss rate', `${profile.maxWeeklyLossRatePct}% of bodyweight/week`),
    ].join('\n'),
  );

  // ----------------------------------------------------------------- goals
  parts.push(section('Goals and targets'));
  parts.push(
    [
      line('Daily calories', profile.targets.calories, 'kcal'),
      line('Daily protein', profile.targets.proteinG, 'g'),
      line('Daily fibre', profile.targets.fiberG, 'g'),
      line('Daily steps', profile.targets.steps),
      line('Training sessions', profile.targets.trainingSessionsPerWeek, 'per week'),
      line('Cardio', profile.targets.cardioMinutesPerWeek, 'minutes per week'),
    ].join('\n'),
  );

  // --------------------------------------------------------- current state
  parts.push(section('Current state'));
  const startWeight = profile.startingWeightKg;
  const current = weightAverages.sevenDay.value ?? currentWeight?.value ?? null;
  parts.push(
    [
      line(
        'Latest weight measurement',
        currentWeight ? `${lb(currentWeight.value!)} on ${currentWeight.date}` : null,
      ),
      derivedLine('7-day average weight', weightAverages.sevenDay, lb),
      derivedLine('14-day average weight', weightAverages.fourteenDay, lb),
      derivedLine('30-day average weight', weightAverages.thirtyDay, lb),
      line(
        'Total change from start',
        startWeight !== null && current !== null
          ? `${formatRate(kgToLb(current - startWeight), 'lb')}`
          : null,
      ),
      line(
        'Remaining to target',
        profile.targetWeightKg !== null && current !== null
          ? `${formatNumber(Math.abs(kgToLb(current - profile.targetWeightKg)), 1)} lb`
          : null,
      ),
      line(
        'Latest waist measurement',
        currentWaist ? `${inches(currentWaist.value!)} on ${currentWaist.date}` : null,
      ),
    ].join('\n'),
  );

  // --------------------------------------------------------- weight trend
  parts.push(section('Weight trend'));
  if (weightTrend.value) {
    parts.push(
      [
        line('Rate of change', formatRate(kgToLb(weightTrend.value.perWeek), 'lb/week')),
        line('Fit quality (R²)', roundTo(weightTrend.value.rSquared, 3)),
        line('Days with a measurement', weightTrend.value.daysWithData),
        line('Confidence', weightTrend.confidence),
        line(
          'Rate direction',
          weightDirection.value
            ? `${weightDirection.value.direction} ` +
              `(recent ${formatRate(kgToLb(weightDirection.value.recentPerWeek), 'lb/wk')} ` +
              `vs earlier ${formatRate(kgToLb(weightDirection.value.earlierPerWeek), 'lb/wk')})`
            : null,
        ),
      ].join('\n'),
    );
    if (weightTrend.notes.length) {
      parts.push(`  Caveats: ${weightTrend.notes.join(' ')}`);
    }
  } else {
    parts.push(`- Not computable: ${weightTrend.notes[0] ?? 'insufficient data'}`);
  }

  // ---------------------------------------------------------- waist trend
  parts.push(section('Waist trend'));
  parts.push(
    waistTrend.value
      ? [
          line('Rate of change', formatRate(cmToInches(waistTrend.value.perWeek), 'in/week')),
          line('Measurements used', `${waistTrend.value.daysWithData} over ${WAIST_TREND_WINDOW_DAYS} days`),
          line('Confidence', waistTrend.confidence),
        ].join('\n')
      : `- Not computable: ${waistTrend.notes[0] ?? 'insufficient data'}`,
  );

  // ------------------------------------------------------------- nutrition
  parts.push(section('Nutrition'));
  parts.push(
    [
      line('Calorie target', profile.targets.calories, 'kcal'),
      derivedLine('7-day average calories', trailingAverage(calories, end, 7), (v) => `${formatNumber(v, 0)} kcal`),
      derivedLine('14-day average calories', trailingAverage(calories, end, 14), (v) => `${formatNumber(v, 0)} kcal`),
      derivedLine('30-day average calories', trailingAverage(calories, end, 30), (v) => `${formatNumber(v, 0)} kcal`),
      line('Protein target', profile.targets.proteinG, 'g'),
      derivedLine('30-day average protein', trailingAverage(protein, end, 30), (v) => `${formatNumber(v, 0)} g`),
      derivedLine('30-day average carbohydrate', trailingAverage(carbs, end, 30), (v) => `${formatNumber(v, 0)} g`),
      derivedLine('30-day average fat', trailingAverage(fat, end, 30), (v) => `${formatNumber(v, 0)} g`),
      derivedLine('30-day average fibre', trailingAverage(fiber, end, 30), (v) => `${formatNumber(v, 0)} g`),
      line(
        'Days logged (last 30)',
        `${trailingWindow(calories, end, 30).filter((p) => p.value !== null).length} of 30`,
      ),
      line(
        'Days missing (last 30)',
        `${trailingWindow(calories, end, 30).filter((p) => p.value === null).length} of 30`,
      ),
    ].join('\n'),
  );

  // -------------------------------------------------------------- activity
  parts.push(section('Activity'));
  const cardioWindow = input.cardio.filter(
    (c) => daysBetween(c.date, end) >= 0 && daysBetween(c.date, end) < 28,
  );
  const runningKm = cardioWindow
    .filter((c) => c.type === 'RUNNING')
    .reduce((total, c) => total + (c.distanceKm ?? 0), 0);
  parts.push(
    [
      line('Step target', profile.targets.steps),
      derivedLine('7-day average steps', trailingAverage(steps, end, 7), (v) => formatNumber(v, 0)),
      derivedLine('14-day average steps', trailingAverage(steps, end, 14), (v) => formatNumber(v, 0)),
      derivedLine('30-day average steps', trailingAverage(steps, end, 30), (v) => formatNumber(v, 0)),
      line(
        'Zone 2 minutes (last 28 days)',
        sumOrNull(trailingWindow(zone2, end, 28).map((p) => p.value)),
        'min',
      ),
      line('Cardio sessions (last 28 days)', cardioWindow.length),
      line(
        'Running sessions (last 28 days)',
        cardioWindow.filter((c) => c.type === 'RUNNING').length,
      ),
      line('Running distance (last 28 days)', runningKm > 0 ? formatNumber(kmToMiles(runningKm), 1) : null, 'mi'),
      line(
        'Active calories (30-day average)',
        trailingAverage(pick(days, 'activeCalories'), end, 30).value === null
          ? null
          : formatNumber(trailingAverage(pick(days, 'activeCalories'), end, 30).value!, 0),
        'kcal',
      ),
    ].join('\n'),
  );

  // -------------------------------------------------------------- training
  // Session level and exercise level are reported separately, and the absence
  // of one is stated rather than silencing the whole section. This block used
  // to be gated on totalWorkingSets > 0, so a period of imported summary
  // sessions produced "No training sets logged" and nothing else - the pack
  // implied no training at all when training had in fact happened.
  parts.push(section('Training'));
  const sessionValue = sessionSummary.value;
  if (sessionValue && sessionValue.totalSessions > 0) {
    parts.push(
      [
        line('Sessions target', profile.targets.trainingSessionsPerWeek, 'per week'),
        line('Sessions completed (period)', sessionValue.totalSessions),
        line('Total training time (period)', sessionValue.totalMinutes, 'min'),
        line('Average session heart rate', sessionValue.averageHeartRate, 'bpm'),
        line('Peak session heart rate', sessionValue.maxHeartRate, 'bpm'),
        line('Calories burned in sessions (period)', sessionValue.totalCalories, 'kcal'),
        derivedLine('Training adherence', adherence.training, (v) => percent(v)),
      ].join('\n'),
    );
    if (sessionValue.byType.length > 0) {
      parts.push('');
      parts.push('Sessions by type (period):');
      parts.push(
        table(
          ['Session type', 'Sessions', 'Minutes'],
          sessionValue.byType.map((t) => [
            t.sessionType,
            t.sessions,
            t.minutes === null ? 'not logged' : t.minutes,
          ]),
        ),
      );
    }
  } else {
    parts.push('- No training sessions recorded in this period.');
  }

  parts.push('');
  if (training.value && training.value.totalWorkingSets > 0) {
    parts.push(
      [
        line('Working sets (period)', training.value.totalWorkingSets),
        line(
          'Total volume (period)',
          training.value.totalVolumeKg === null
            ? null
            : formatNumber(kgToLb(training.value.totalVolumeKg), 0),
          'lb',
        ),
        line('Average RIR', training.value.averageRir),
        line('Average RPE', training.value.averageRpe),
        // Coverage, not a caveat: the volume above is the volume of the
        // sessions that were logged set-by-set, and saying how many those were
        // stops it being read as the period's whole training load.
        sessionValue && sessionValue.sessionsWithoutSets > 0
          ? line(
              'Sessions without exercise detail',
              `${sessionValue.sessionsWithoutSets} of ${sessionValue.totalSessions}`,
            )
          : null,
      ].filter((l) => l !== null).join('\n'),
    );
    parts.push('');
    parts.push('Sets per muscle group (period):');
    parts.push(
      table(
        ['Muscle group', 'Sets', 'Sessions'],
        training.value.byMuscleGroup.map((g) => [g.muscleGroup, g.sets, g.sessions]),
      ),
    );
  } else if (sessionValue && sessionValue.totalSessions > 0) {
    // The distinction that matters to a coach: sessions happened, but what was
    // performed inside them was not recorded. Volume and RIR are unavailable,
    // not zero, and no exercise-level conclusion should be drawn.
    parts.push(
      `- No exercise or set detail for ${sessionValue.sessionsWithoutSets} of ` +
        `${sessionValue.totalSessions} session(s). Volume, RIR and per-exercise ` +
        'progression are not available for those sessions and must not be inferred.',
    );
  } else {
    parts.push('- No training sets logged in this period.');
  }

  // -------------------------------------------------------------- recovery
  parts.push(section('Recovery'));
  parts.push(
    [
      derivedLine('7-day average sleep', trailingAverage(sleep, end, 7), formatSleep),
      derivedLine('30-day average sleep', trailingAverage(sleep, end, 30), formatSleep),
      derivedLine('30-day average resting heart rate', trailingAverage(rhr, end, 30), (v) => `${formatNumber(v, 0)} bpm`),
      derivedLine('30-day average HRV', trailingAverage(hrv, end, 30), (v) => `${formatNumber(v, 0)} ms`),
      line(
        'Rest days (last 28)',
        trailingWindow(sessions, end, 28).filter((p) => p.value === 0).length,
      ),
    ].join('\n'),
  );
  parts.push(
    '  Note: recovery data is informational. Poor sleep alone is not a reason to skip training.',
  );

  // ------------------------------------------------------------- adherence
  parts.push(section('Adherence'));
  parts.push(
    [
      derivedLine('Calorie adherence', adherence.calories, (v) => percent(v)),
      derivedLine('Protein adherence', adherence.protein, (v) => percent(v)),
      derivedLine('Step adherence', adherence.steps, (v) => percent(v)),
      derivedLine('Training adherence', adherence.training, (v) => percent(v)),
      derivedLine('Cardio adherence', adherence.cardio, (v) => percent(v)),
      derivedLine('Logging adherence', adherence.logging, (v) => percent(v)),
      derivedLine('Overall adherence', adherence.overall, (v) => percent(v)),
    ].join('\n'),
  );

  // ------------------------------------------- recent detail (spec §31)
  parts.push(section(`Recent detail (last ${DETAIL_DAYS} days)`));
  const detailDays = days.filter((d) => {
    const age = daysBetween(d.localDate, end);
    return age >= 0 && age < DETAIL_DAYS;
  });
  parts.push(
    table(
      ['Date', 'Weight', 'kcal', 'P', 'C', 'F', 'Fib', 'Steps', 'Sleep', 'Sess'],
      detailDays.map((d) => [
        formatShortDate(d.localDate),
        d.weightKg === null ? null : formatNumber(kgToLb(d.weightKg), 1),
        d.caloriesConsumed, d.proteinG, d.carbsG, d.fatG, d.fiberG,
        d.steps,
        d.sleepDurationMinutes === null ? null : formatSleep(d.sleepDurationMinutes),
        d.trainingSessions,
      ]),
    ),
  );
  parts.push('  "-" means not logged. It does not mean zero.');

  // ------------------------------------------ summary windows (spec §31)
  parts.push(section('Summary windows'));
  parts.push(
    table(
      ['Window', 'Weight avg', 'kcal avg', 'Protein avg', 'Steps avg', 'Days logged'],
      SUMMARY_WINDOWS.map((w) => {
        const weightAvg = trailingAverage(weight, end, w);
        const calorieAvg = trailingAverage(calories, end, w);
        const proteinAvg = trailingAverage(protein, end, w);
        const stepAvg = trailingAverage(steps, end, w);
        const logged = trailingWindow(calories, end, w).filter((p) => p.value !== null).length;
        return [
          `${w}d`,
          weightAvg.value === null ? null : `${formatNumber(kgToLb(weightAvg.value), 1)} lb`,
          calorieAvg.value === null ? null : formatNumber(calorieAvg.value, 0),
          proteinAvg.value === null ? null : `${formatNumber(proteinAvg.value, 0)} g`,
          stepAvg.value === null ? null : formatNumber(stepAvg.value, 0),
          `${logged}/${w}`,
        ];
      }),
    ),
  );

  // --------------------------------------- monthly history (spec §31)
  const monthly = monthlySummaries(days, end);
  if (monthly.length > 0) {
    parts.push(section('Monthly history'));
    parts.push(
      table(
        ['Month', 'Weight avg', 'Change', 'kcal avg', 'Steps avg', 'Days logged'],
        monthly.map((m) => [
          m.label,
          m.averageWeightKg === null ? null : `${formatNumber(kgToLb(m.averageWeightKg), 1)} lb`,
          m.changeKg === null ? null : formatRate(kgToLb(m.changeKg), 'lb'),
          m.averageCalories === null ? null : formatNumber(m.averageCalories, 0),
          m.averageSteps === null ? null : formatNumber(m.averageSteps, 0),
          `${m.daysLogged}/${m.dayCount}`,
        ]),
      ),
    );
  }

  // ------------------------------------------------------------- analytics
  parts.push(section('Analytics'));
  parts.push(
    [
      line(
        'Estimated TDEE',
        tdee.value === null
          ? null
          : `${formatNumber(tdee.value.kcal, 0)} ± ${formatNumber(tdee.value.standardError, 0)} kcal`,
      ),
      line('TDEE method', tdee.method),
      line(
        'TDEE observed share',
        tdee.value === null ? null : percent(tdee.value.observedWeight),
      ),
      line('Plateau verdict', plateau.value?.verdict ?? null),
      line(
        'Plateau window',
        plateau.value === null ? null : `${plateau.value.windowDays} days`,
      ),
      line(
        'Projected target date (best estimate)',
        forecast.value?.bestEstimateDate ?? null,
      ),
      line(
        'Projected target date (range)',
        forecast.value
          ? `${forecast.value.optimisticDate} to ${forecast.value.conservativeDate}`
          : null,
      ),
    ].join('\n'),
  );
  for (const note of [...tdee.notes, ...plateau.notes, ...forecast.notes]) {
    parts.push(`  - ${note}`);
  }

  // ------------------------------------------------- system-detected issues
  parts.push(section('System-detected issues'));
  const issues = collectIssues(dataQuality, plateau, adherence, weightTrend);
  parts.push(issues.length ? issues.map((i) => `- ${i}`).join('\n') : '- None.');

  // -------------------------------------------------- recommendation inputs
  parts.push(section('Recommendation candidates'));
  parts.push(
    'These are CANDIDATES with their evidence, not decisions. The coaching call is yours.',
  );
  if (recommendations.length === 0) {
    parts.push('- None generated for this period.');
  } else {
    for (const candidate of recommendations) {
      parts.push('');
      parts.push(`[${candidate.kind}] (confidence: ${candidate.confidence.toLowerCase()})`);
      parts.push(candidate.headline);
      parts.push('Evidence:');
      for (const [key, value] of Object.entries(candidate.evidence)) {
        parts.push(`  - ${key}: ${renderEvidence(value)}`);
      }
    }
  }

  // -------------------------------------------------------- recent events
  if (input.recentEvents?.length) {
    parts.push(section('Recent events'));
    for (const event of input.recentEvents) {
      parts.push(`- ${event.date}: ${event.note}`);
    }
  }

  // ------------------------------------------------------------- questions
  parts.push(section('Questions for ChatGPT'));
  const questions = input.questions?.length
    ? input.questions
    : [
        'Is the current rate of progress appropriate, given the data quality above?',
        'Is there evidence to justify changing calories, activity or training right now?',
        'What is the single most useful thing to change or keep the same this week?',
      ];
  questions.forEach((q, i) => parts.push(`${i + 1}. ${q}`));

  parts.push('');
  parts.push('='.repeat(52));
  parts.push('END OF CONTEXT PACK');
  parts.push('='.repeat(52));

  return {
    body: parts.join('\n'),
    version: CONTEXT_VERSION,
    analyticsVersion: ANALYTICS_VERSION,
    generatedFor: end,
    dataQualityScore: dataQuality.value?.score ?? null,
    parameters: {
      detailDays: DETAIL_DAYS,
      summaryWindows: SUMMARY_WINDOWS,
      weightTrendWindowDays: WEIGHT_TREND_WINDOW_DAYS,
      waistTrendWindowDays: WAIST_TREND_WINDOW_DAYS,
      plateauWindowDays: 21,
    },
  };
}

function formatSleep(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${Math.round(minutes - hours * 60)}m`;
}

function sumOrNull(values: (number | null)[]): number | null {
  const present = presentValues(values);
  return present.length ? roundTo(present.reduce((a, b) => a + b, 0), 0) : null;
}

function renderEvidence(value: unknown): string {
  if (value === null || value === undefined) return 'not available';
  if (typeof value === 'number') return formatNumber(value, undefined);
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

interface MonthlySummary {
  label: string;
  averageWeightKg: number | null;
  changeKg: number | null;
  averageCalories: number | null;
  averageSteps: number | null;
  daysLogged: number;
  dayCount: number;
}

/** Spec §31's historical layer: everything older than 90 days, by month. */
export function monthlySummaries(
  days: DailyMetrics[],
  end: LocalDate,
): MonthlySummary[] {
  const cutoff = addDays(end, -90);
  const older = days.filter((d) => d.localDate < cutoff);
  const byMonth = new Map<string, DailyMetrics[]>();
  for (const day of older) {
    const key = monthKey(day.localDate);
    byMonth.set(key, [...(byMonth.get(key) ?? []), day]);
  }

  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, monthDays]) => {
      const weights = presentValues(monthDays.map((d) => d.weightKg));
      const first = weights[0];
      const last = weights[weights.length - 1];
      return {
        label: formatMonth(key),
        averageWeightKg: weights.length ? roundTo(mean(weights)!, 3) : null,
        changeKg:
          first !== undefined && last !== undefined && weights.length > 1
            ? roundTo(last - first, 3)
            : null,
        averageCalories: nullableMean(monthDays.map((d) => d.caloriesConsumed)),
        averageSteps: nullableMean(monthDays.map((d) => d.steps)),
        daysLogged: monthDays.filter((d) => d.caloriesConsumed !== null).length,
        dayCount: monthDays.length,
      };
    });
}

function nullableMean(values: (number | null)[]): number | null {
  const present = presentValues(values);
  return present.length ? roundTo(mean(present)!, 1) : null;
}

function collectIssues(
  dataQuality: ReturnType<typeof computeDataQuality>,
  plateau: ReturnType<typeof detectPlateau>,
  adherence: ReturnType<typeof computeAdherence>,
  weightTrend: ReturnType<typeof trend>,
): string[] {
  const issues: string[] = [];

  if (dataQuality.value && dataQuality.value.band !== 'HIGH') {
    issues.push(
      `Data quality is ${dataQuality.value.band} (${dataQuality.value.score}/100). ` +
        `Weakest inputs: ${dataQuality.value.components
          .filter((c) => c.points / c.weight < 0.6)
          .map((c) => c.label)
          .join(', ') || 'none individually'}.`,
    );
  }
  if (plateau.value?.verdict === 'INSUFFICIENT_DATA') {
    issues.push(
      'Plateau status is undetermined because logging adherence is below the threshold ' +
        'needed to tell a real plateau from an unmeasured one.',
    );
  }
  if (plateau.value?.verdict === 'PLATEAU') {
    issues.push(
      `Probable plateau over ${plateau.value.windowDays} days with adherence high ` +
        'enough to support that reading.',
    );
  }
  if (weightTrend.value && weightTrend.value.rSquared < 0.2) {
    issues.push(
      'The weight trend fit is weak; day-to-day scatter dominates over this window.',
    );
  }
  for (const [name, component] of Object.entries(adherence)) {
    if (name === 'overall') continue;
    if (component.value !== null && component.value < 0.7) {
      issues.push(`${component.method} is ${percent(component.value)}.`);
    }
  }
  return issues;
}
