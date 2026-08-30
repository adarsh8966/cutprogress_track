/**
 * Dashboard (spec §24, §50).
 *
 * The home screen answers exactly three questions and then stops:
 *   1. Where am I?         current weight against target
 *   2. Am I progressing?   rate of loss, waist direction
 *   3. What should I do?   one line
 *
 * Spec §50: "That's it. No information swamp." Everything else lives on the
 * pages built for it, so this page resists growing a fourth section.
 */
import Link from 'next/link';
import { getAnalyticsWindow } from '@/lib/data/queries';
import { DEFAULT_PROFILE } from '@/lib/defaults';
import {
  Card, DerivedFigure, DerivedMeter, Figure, StatusDot, formatNumber, type Status,
} from '@/components/ui/primitives';
import { Evidence } from '@/components/ui/Evidence';
import { trailingAverage } from '@/lib/analytics/movingAverage';
import { latestReading } from '@/lib/analytics/latest';
import { trend } from '@/lib/analytics/trend';
import { detectPlateau } from '@/lib/analytics/plateau';
import { computeAdherence } from '@/lib/analytics/adherence';
import { computeDataQuality } from '@/lib/analytics/dataQuality';
import { forecastTargetDate } from '@/lib/analytics/forecast';
import { generateRecommendations } from '@/lib/analytics/recommendations';
import { latestPresent, mean, presentValues, trailingWindow } from '@/lib/analytics/series';
import { readingOf } from '@/lib/analytics/reading';
import { displayWeight, displayLength, unitsOf, unitLabels } from '@/lib/normalization/units';
import { daysBetween, formatShortDate } from '@/lib/normalization/dates';
import type { DailyMetrics, DatedValue } from '@/lib/types';

export const dynamic = 'force-dynamic';

function pick(days: DailyMetrics[], key: keyof DailyMetrics): DatedValue[] {
  return days.map((day) => {
    const value = day[key];
    return { date: day.localDate, value: typeof value === 'number' ? value : null };
  });
}

export default async function DashboardPage() {
  const { profile: loaded, start: windowStart, end, metrics } = await getAnalyticsWindow();
  const profile = loaded ?? DEFAULT_PROFILE;

  if (metrics.length === 0) {
    return <FirstRun hasProfile={loaded !== null} />;
  }

  // The user's own units (spec §39). Analytics stay metric throughout; this is
  // the boundary where a number becomes something to read.
  const units = unitsOf(profile);
  const label = unitLabels(units);
  const asWeight = (kg: number) => displayWeight(kg, units.weight);
  const asLength = (cm: number) => displayLength(cm, units.length);

  const weight = pick(metrics, 'weightKg');
  const waist = pick(metrics, 'waistCm');
  const calories = pick(metrics, 'caloriesConsumed');
  const protein = pick(metrics, 'proteinG');
  const steps = pick(metrics, 'steps');
  const sessions = pick(metrics, 'trainingSessions');
  const cardioMinutes = pick(metrics, 'cardioMinutes');
  const sleep = pick(metrics, 'sleepDurationMinutes');

  const weightAvg = trailingAverage(weight, end, 7, { label: 'Weight 7-day average' });
  // Searched over the WHOLE loaded window, not the average's seven days. The
  // hero has always shown the last weigh-in when there was no average, and
  // narrowing that to a week would hide a real measurement from someone who
  // last weighed in a fortnight ago - the same disappearing-data fault, just
  // moved. latestReading reports the reading's age, which is what makes an old
  // one safe to show.
  const weightLatest = latestReading(weight, end, daysBetween(windowStart, end) + 1, {
    label: 'Latest weigh-in',
  });

  // Every 28-day card reads its metric BOTH ways - the gated average and the
  // latest actual value - so a window too sparse to average still shows what
  // was recorded rather than reporting the day as never logged. The coverage
  // gates themselves are untouched; see lib/analytics/reading.ts.
  const WINDOW = 28;
  const calorieReading = readingOf(calories, 'Calories', end, WINDOW);
  const proteinReading = readingOf(protein, 'Protein', end, WINDOW);
  const stepReading = readingOf(steps, 'Steps', end, WINDOW);
  const cardioReading = readingOf(cardioMinutes, 'Cardio', end, WINDOW);
  const weightTrend = trend(weight, end, 28, 'Weight trend (28 days)');
  const waistTrend = trend(waist, end, 84, 'Waist trend (84 days)');
  const plateau = detectPlateau(weight, calories, steps, end, 21);
  const adherence = computeAdherence(
    { calories, protein, steps, weight, trainingSessions: sessions, cardioMinutes },
    profile.targets, end, 28,
  );
  const dataQuality = computeDataQuality(
    { weight, calories, trainingSessions: sessions, steps, sleepMinutes: sleep, waist },
    end, 28,
  );
  const forecast = forecastTargetDate(weight, profile.targetWeightKg, end, 28);

  // The 7-day average when there is one, otherwise the last actual weigh-in.
  // Which of the two is on screen is stated rather than left to be assumed:
  // a single morning reading is not a 7-day average and must not be captioned
  // as one.
  const current = weightAvg.value ?? weightLatest.value ?? null;
  const currentIsAverage = weightAvg.value !== null;
  const start = profile.startingWeightKg;
  const target = profile.targetWeightKg;
  const averageSleep = mean(presentValues(trailingWindow(sleep, end, 28).map((p) => p.value)));

  const recommendations = generateRecommendations({
    date: end,
    weightTrend,
    currentWeightKg: current,
    plateau,
    adherence,
    dataQuality,
    averageSleepMinutes: averageSleep,
    maxWeeklyLossRatePct: profile.maxWeeklyLossRatePct,
  });

  // Progress toward target, as a fraction of the total journey.
  const progress =
    start !== null && target !== null && current !== null && start !== target
      ? Math.min(1, Math.max(0, (start - current) / (start - target)))
      : null;

  const ratePerWeek = weightTrend.value ? asWeight(weightTrend.value.perWeek) : null;

  // What the fallback figure IS, said once. A weigh-in from eleven days ago is
  // a fact about eleven days ago; showing it unlabelled under a hero number
  // invites it being read as this morning's.
  const weighedOn = weightLatest.inputs.observedOn;
  const latestWeightCaption =
    `latest weigh-in${
      typeof weighedOn === 'string' && weighedOn !== end
        ? `, ${formatShortDate(weighedOn)}`
        : ''
    } · ${weightAvg.observations ?? 0} of 7 days logged`;

  return (
    <div className="space-y-8">
      {/* ------------------------------------------------ 1. Where am I? */}
      <section className="pt-4 text-center">
        <Figure
          value={current === null ? null : formatNumber(asWeight(current), 1)}
          unit={label.weight}
          size="hero"
        />
        <div className="mt-3 space-y-1 text-sm text-ink-muted">
          <div>
            {ratePerWeek === null ? (
              <span className="text-ink-faint">rate not yet computable</span>
            ) : (
              <span className="tabular">
                {ratePerWeek < 0 ? '↓' : '↑'} {formatNumber(Math.abs(ratePerWeek), 2)}{' '}
                {label.weight}/week
              </span>
            )}
          </div>
          {current !== null && (
            <div className="text-xs text-ink-faint">
              {currentIsAverage ? '7-day average' : latestWeightCaption}
            </div>
          )}
        </div>

        {progress !== null && start !== null && target !== null && (
          <div className="mx-auto mt-6 max-w-md">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-raised">
              <div
                className="h-full rounded-full transition-[width]"
                style={{
                  width: `${progress * 100}%`,
                  background: 'var(--color-series-1)',
                }}
              />
            </div>
            <div className="mt-2 flex justify-between text-[11px] text-ink-faint">
              <span className="tabular">
                {formatNumber(asWeight(start), 0)} {label.weight} start
              </span>
              <span className="tabular">
                {formatNumber(Math.abs(asWeight(current! - target)), 1)} {label.weight} to go
              </span>
              <span className="tabular">
                {formatNumber(asWeight(target), 0)} {label.weight} target
              </span>
            </div>
          </div>
        )}

        {/* The day view is where today's figures and the records behind them
            live. The Dashboard answers three questions and stops (spec §50), so
            it points at the cockpit rather than growing into one. */}
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link
            href={`/day/${end}`}
            className="inline-flex min-h-11 items-center rounded border border-line-strong px-4 text-sm text-ink transition-colors hover:border-accent"
          >
            Today
          </Link>
          <Link
            href={`/quick?date=${end}`}
            className="inline-flex min-h-11 items-center rounded border border-line px-4 text-sm text-ink-muted transition-colors hover:border-accent"
          >
            Quick add
          </Link>
        </div>
      </section>

      {/* --------------------------------------- 3. What should I do? */}
      <Card title="What matters today">
        {recommendations.length === 0 ? (
          <div className="space-y-2">
            <StatusDot status="good" label="On track" />
            <p className="text-sm text-ink-muted">
              Nothing in the data calls for a change right now.
            </p>
          </div>
        ) : (
          <ul className="space-y-5">
            {recommendations.slice(0, 3).map((candidate) => (
              <li key={candidate.kind}>
                <StatusDot
                  status={statusFor(candidate.kind)}
                  label={candidate.kind.replaceAll('_', ' ').toLowerCase()}
                />
                <p className="mt-1.5 text-sm text-ink">{candidate.headline}</p>
                <details className="mt-1.5">
                  <summary className="cursor-pointer text-[11px] text-ink-faint hover:text-accent">
                    Why?
                  </summary>
                  <ul className="mt-2 space-y-1 rounded border border-line bg-ground/60 p-3 text-[11px]">
                    {Object.entries(candidate.evidence).map(([key, value]) => (
                      <li key={key} className="flex flex-wrap gap-2">
                        <span className="text-ink-faint">{key}</span>
                        <span className="tabular text-ink-muted">
                          {typeof value === 'object' && value !== null
                            ? JSON.stringify(value)
                            : String(value)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-5 border-t border-line pt-4 text-[11px] leading-relaxed text-ink-faint">
          These are candidates with their evidence, not instructions. Generate a{' '}
          <Link href="/context" className="text-accent hover:underline">
            context pack
          </Link>{' '}
          to hand the full picture to ChatGPT for the coaching call.
        </p>
      </Card>

      {/* ------------------------------------- 2. Am I progressing? */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {/* The average and the last weigh-in are different claims. This card
            used to print whichever it had under the fixed caption "7-day
            average", so one morning's reading was presented as a week of
            them. DerivedFigure renders the average's own state, and the
            fallback below names itself. */}
        <Card title="Weight">
          {weightAvg.value !== null ? (
            <Figure
              value={formatNumber(asWeight(weightAvg.value), 1)}
              unit={label.weight}
              sub={<span className="text-ink-faint">7-day average</span>}
            />
          ) : weightLatest.value !== null ? (
            <Figure
              value={formatNumber(asWeight(weightLatest.value), 1)}
              unit={label.weight}
              sub={
                <span className="text-ink-faint">
                  {latestWeightCaption} — not enough for a 7-day average
                </span>
              }
            />
          ) : (
            <DerivedFigure
              derived={weightAvg}
              format={(kg) => formatNumber(asWeight(kg), 1)}
              unit={label.weight}
            />
          )}
          <Evidence derived={weightAvg} />
        </Card>

        <Card title="Waist">
          <Figure
            value={
              latestPresent(waist)?.value != null
                ? formatNumber(asLength(latestPresent(waist)!.value!), 1)
                : null
            }
            unit={label.length}
            sub={
              waistTrend.value ? (
                <span className="tabular">
                  {formatNumber(asLength(waistTrend.value.perWeek), 2)} {label.length}/week
                </span>
              ) : (
                <span className="text-ink-faint">trend not yet computable</span>
              )
            }
          />
          <Evidence derived={waistTrend} />
        </Card>

        <Card title="Data quality">
          <DerivedFigure
            derived={dataQuality}
            format={(q) => formatNumber(q.score, 0)}
            unit="/100"
            sub={
              dataQuality.value ? (
                <StatusDot
                  status={
                    dataQuality.value.band === 'HIGH'
                      ? 'good'
                      : dataQuality.value.band === 'MODERATE'
                        ? 'warn'
                        : 'bad'
                  }
                  label={`${dataQuality.value.band.toLowerCase()} confidence`}
                />
              ) : null
            }
          />
          <Evidence derived={dataQuality} />
        </Card>

        {/* DerivedMeter, not Meter: these four passed `.value` and threw away
            everything the calculation knew, so a 28-day window holding one
            real day rendered as "not logged" - about data that was imported,
            stored and visible on the Nutrition page. */}
        <Card title="Nutrition (28-day average)">
          <div className="space-y-3">
            <DerivedMeter
              label="Calories"
              reading={calorieReading}
              target={profile.targets.calories}
              unit="kcal"
            />
            <DerivedMeter
              label="Protein"
              reading={proteinReading}
              target={profile.targets.proteinG}
              unit="g"
              overIsFine
            />
          </div>
        </Card>

        <Card title="Activity (28-day average)">
          <div className="space-y-3">
            <DerivedMeter
              label="Steps"
              reading={stepReading}
              target={profile.targets.steps}
              overIsFine
            />
            <DerivedMeter
              label="Cardio"
              reading={cardioReading}
              target={profile.targets.cardioMinutesPerWeek}
              unit="min/wk"
              // A single day's cardio is reported as that day's minutes, never
              // multiplied up into a week the user did not train.
              latestUnit="min"
              overIsFine
              scale={7}
            />
          </div>
        </Card>

        <Card title="Training">
          <DerivedFigure
            derived={adherence.training}
            format={(v) => formatNumber(v * 100, 0)}
            unit="%"
            sub={<span className="text-ink-faint">adherence, last 28 days</span>}
          />
          <Evidence derived={adherence.training} />
        </Card>
      </div>

      {/* Forecast and plateau, stated with their uncertainty (spec §22). */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Card title="Projected target date">
          {forecast.value ? (
            <>
              <Figure value={forecast.value.bestEstimateDate} size="sm" />
              <p className="mt-2 text-xs text-ink-muted">
                Range {forecast.value.optimisticDate} to {forecast.value.conservativeDate}
              </p>
            </>
          ) : (
            <p className="text-sm text-ink-faint">
              {forecast.notes[0] ?? 'Not enough data to project a date.'}
            </p>
          )}
          <Evidence derived={forecast} />
        </Card>

        <Card title="Plateau check">
          {plateau.value && (
            <>
              <StatusDot
                status={
                  plateau.value.verdict === 'PLATEAU'
                    ? 'warn'
                    : plateau.value.verdict === 'NO_PLATEAU'
                      ? 'good'
                      : 'neutral'
                }
                label={plateau.value.verdict.replaceAll('_', ' ').toLowerCase()}
              />
              <p className="mt-2 text-xs leading-relaxed text-ink-muted">
                {plateau.value.reasons[0] ?? 'No issues detected.'}
              </p>
            </>
          )}
          <Evidence derived={plateau} />
        </Card>
      </div>
    </div>
  );
}

function statusFor(kind: string): Status {
  if (kind === 'MAINTAIN_CURRENT_INTAKE') return 'good';
  if (kind === 'RATE_OF_LOSS_TOO_FAST_CONSIDER_EASING') return 'bad';
  if (kind === 'COLLECT_MORE_DATA_BEFORE_CHANGING') return 'neutral';
  return 'warn';
}

function FirstRun({ hasProfile }: { hasProfile: boolean }) {
  return (
    <div className="mx-auto max-w-lg pt-16 text-center">
      <h1 className="text-2xl font-light">Nothing logged yet</h1>
      <p className="mt-3 text-sm leading-relaxed text-ink-muted">
        CUT OS has no data to analyse. It will not estimate, infer or fill in
        anything on your behalf, so every number stays blank until you record one.
      </p>
      <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center">
        {!hasProfile && (
          <Link
            href="/settings"
            className="rounded border border-line-strong px-4 py-2 text-sm text-ink transition-colors hover:border-accent"
          >
            Set up your profile
          </Link>
        )}
        <Link
          href="/import"
          className="rounded border border-line-strong px-4 py-2 text-sm text-ink transition-colors hover:border-accent"
        >
          Paste your first report
        </Link>
        <Link
          href="/progress"
          className="rounded border border-line-strong px-4 py-2 text-sm text-ink transition-colors hover:border-accent"
        >
          Log a weight
        </Link>
      </div>
    </div>
  );
}
