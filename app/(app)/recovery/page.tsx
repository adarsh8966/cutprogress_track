/**
 * Recovery page (spec §14).
 *
 * Spec §14 is explicit that recovery must never be a hard gate: bad sleep is
 * not an instruction to skip the gym. So this page reports and contextualises,
 * and the one interpretive line it prints is conditional on performance also
 * declining. It never tells the user not to train.
 *
 * Every figure comes from recoverySummary() in lib/analytics/recovery.ts. The
 * page does no arithmetic of its own, because a calculation that only exists
 * inside a server component cannot be tested - which is how resting heart rate
 * and HRV were reported as "not logged" for four days that were imported,
 * stored and canonicalised correctly.
 *
 * EVERY METRIC HERE IS READ TWO WAYS: the latest actual reading, and the 30-day
 * average. The average is gated on coverage and will decline to be computed
 * from a handful of days; the latest reading is not, because "what was last
 * recorded" is answerable from one observation. A metric whose only reader is
 * the gated average vanishes from this page until half a month has been logged.
 */
import { getAnalyticsWindow } from '@/lib/data/queries';
import { DEFAULT_PROFILE } from '@/lib/defaults';
import { Card, DerivedFigure, formatNumber } from '@/components/ui/primitives';
import { Evidence } from '@/components/ui/Evidence';
import { BarSeries } from '@/components/charts/BarSeries';
import { LogSleepForm, LogCardioForm, LogMetricsForm } from '@/components/dashboard/LogRecoveryForms';
import { recoverySummary } from '@/lib/analytics/recovery';
import { densify } from '@/lib/analytics/series';
import { addDays, formatShortDate } from '@/lib/normalization/dates';
import { displayDistance, unitsOf, unitLabels } from '@/lib/normalization/units';
import { todayForUser } from '@/app/actions/log';
import type { Derived } from '@/lib/types';

export const dynamic = 'force-dynamic';

function formatSleep(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${Math.round(minutes - hours * 60)}m`;
}

const whole = (value: number) => formatNumber(value, 0);

/**
 * "measured 28 Aug" under a latest reading.
 *
 * The date is not decoration. A resting heart rate from five days ago is a fact
 * about five days ago, and a figure that does not say when it was taken invites
 * being read as today's.
 */
function measuredOn(reading: Derived<number>) {
  const observedOn = reading.inputs.observedOn;
  if (reading.value === null || typeof observedOn !== 'string') return undefined;
  const age = reading.inputs.ageDays;
  return (
    <span>
      measured {formatShortDate(observedOn)}
      {age === 0 ? ' (today)' : ''}
    </span>
  );
}

export default async function RecoveryPage() {
  const { profile: loaded, end, metrics, cardio } = await getAnalyticsWindow();
  const profile = loaded ?? DEFAULT_PROFILE;
  const today = await todayForUser();

  // The cardio list and the cardio form must name the same unit logCardio
  // converts with (spec §39).
  const units = unitsOf(profile);
  const label = unitLabels(units);

  const recovery = recoverySummary(metrics, end);
  const { restingHeartRate, hrv, sleepScore, totalCaloriesBurned, activeCalories } = recovery;

  const recentCardio = cardio.slice(0, 12);
  const chartStart = addDays(end, -29);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-xl font-light">Recovery</h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-muted">
          Recovery data is informational. It is never a reason on its own to skip
          training.
        </p>
      </header>

      {recovery.belowBaseline && (
        <p className="rounded border border-warn/40 bg-warn/5 px-4 py-3 text-sm leading-relaxed text-warn">
          Recovery is below your own baseline: the last 7 days average{' '}
          {formatSleep(recovery.sleep7.value!)} against a 30-day average of{' '}
          {formatSleep(recovery.sleep30.value!)}. Consider reducing training intensity{' '}
          <span className="text-ink-muted">
            if your performance is also declining
          </span>
          . On its own this is not a reason to train less.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card title="Sleep (7-day)">
          <DerivedFigure derived={recovery.sleep7} format={formatSleep} size="sm" />
          <Evidence derived={recovery.sleep7} />
        </Card>
        <Card title="Sleep (30-day)">
          <DerivedFigure derived={recovery.sleep30} format={formatSleep} size="sm" />
          <Evidence derived={recovery.sleep30} />
        </Card>
        <Card title="Resting heart rate">
          <DerivedFigure
            derived={restingHeartRate.latest}
            format={whole}
            unit="bpm"
            size="sm"
            sub={measuredOn(restingHeartRate.latest)}
          />
          <Evidence derived={restingHeartRate.latest} />
        </Card>
        <Card title="HRV">
          <DerivedFigure
            derived={hrv.latest}
            format={whole}
            unit="ms"
            size="sm"
            sub={measuredOn(hrv.latest)}
          />
          <Evidence derived={hrv.latest} />
        </Card>
      </div>

      {/* The 30-day averages sit beside the latest readings rather than
          replacing them. Each answers a different question, and the average
          declines to answer at all until the window is half full. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card title="Resting HR (30-day)">
          <DerivedFigure
            derived={restingHeartRate.average30}
            format={whole}
            unit="bpm"
            size="sm"
          />
          <Evidence derived={restingHeartRate.average30} />
        </Card>
        <Card title="HRV (30-day)">
          <DerivedFigure derived={hrv.average30} format={whole} unit="ms" size="sm" />
          <Evidence derived={hrv.average30} />
        </Card>
        <Card title="Sleep score">
          <DerivedFigure
            derived={sleepScore.latest}
            format={whole}
            unit="/100"
            size="sm"
            sub={measuredOn(sleepScore.latest)}
          />
          <Evidence derived={sleepScore.latest} />
        </Card>
        <Card title="Sleep score (30-day)">
          <DerivedFigure
            derived={sleepScore.average30}
            format={whole}
            unit="/100"
            size="sm"
          />
          <Evidence derived={sleepScore.average30} />
        </Card>
      </div>

      {/* Energy out. Both of these were resolved into daily_metrics, written by
          two forms each, and read by no page at all - the same "saved but
          invisible" fault as resting heart rate. Active calories is the one
          that survived longest: two forms named Recovery as its destination
          while Recovery did not show it. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card title="Total calories burned">
          <DerivedFigure
            derived={totalCaloriesBurned.latest}
            format={whole}
            unit="kcal"
            size="sm"
            sub={measuredOn(totalCaloriesBurned.latest)}
          />
          <Evidence derived={totalCaloriesBurned.latest} />
        </Card>
        <Card title="Total calories burned (30-day)">
          <DerivedFigure
            derived={totalCaloriesBurned.average30}
            format={whole}
            unit="kcal"
            size="sm"
          />
          <Evidence derived={totalCaloriesBurned.average30} />
        </Card>
        <Card title="Active calories">
          <DerivedFigure
            derived={activeCalories.latest}
            format={whole}
            unit="kcal"
            size="sm"
            sub={measuredOn(activeCalories.latest)}
          />
          <Evidence derived={activeCalories.latest} />
        </Card>
        <Card title="Active calories (30-day)">
          <DerivedFigure
            derived={activeCalories.average30}
            format={whole}
            unit="kcal"
            size="sm"
          />
          <Evidence derived={activeCalories.average30} />
        </Card>
      </div>

      <Card title="Sleep, last 30 days">
        <BarSeries
          data={densify(recovery.sleepSeries, chartStart, end)}
          unit="min"
          label="asleep"
          height={200}
        />
      </Card>

      {/* Charts of the daily values on their own dates. A gated average can
          refuse to summarise a sparse month; the days themselves are still
          measurements and belong on screen. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Resting heart rate, last 30 days">
          <BarSeries
            data={densify(restingHeartRate.series, chartStart, end)}
            unit="bpm"
            label="resting HR"
            height={200}
          />
        </Card>
        <Card title="HRV, last 30 days">
          <BarSeries
            data={densify(hrv.series, chartStart, end)}
            unit="ms"
            label="HRV"
            height={200}
          />
        </Card>
      </div>

      <Card title="Steps, last 30 days">
        <BarSeries
          data={densify(recovery.stepsSeries, chartStart, end)}
          label="steps"
          height={200}
        />
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Cardio">
          <DerivedFigure
            derived={recovery.zone2Minutes}
            format={whole}
            label="Zone 2, last 28 days"
            unit="min"
            size="sm"
          />
          <Evidence derived={recovery.zone2Minutes} />
          {recentCardio.length > 0 && (
            <ul className="mt-4 divide-y divide-line/60 text-sm">
              {recentCardio.map((session) => (
                <li key={session.id} className="py-2">
                  <div className="flex flex-wrap items-baseline gap-x-3">
                    <span className="tabular text-ink-muted">{session.date}</span>
                    <span className="text-xs text-ink-faint">
                      {session.type.replaceAll('_', ' ').toLowerCase()}
                    </span>
                    <span className="tabular ml-auto">
                      {formatNumber(session.durationMinutes, 0)} min
                      {session.distanceKm !== null &&
                        ` · ${formatNumber(
                          displayDistance(session.distanceKm, units.distance), 2,
                        )} ${label.distance}`}
                    </span>
                  </div>
                  {/* Heart rates, energy and zone are stored on every cardio
                      row and were previously read by nothing at all. */}
                  {(session.averageHeartRate !== null ||
                    session.maxHeartRate !== null ||
                    session.calories !== null ||
                    session.hrZone !== null) && (
                    <div className="mt-1 flex flex-wrap items-baseline gap-x-3 text-xs text-ink-faint">
                      {session.averageHeartRate !== null && (
                        <span className="tabular">
                          avg {formatNumber(session.averageHeartRate, 0)} bpm
                        </span>
                      )}
                      {session.maxHeartRate !== null && (
                        <span className="tabular">
                          max {formatNumber(session.maxHeartRate, 0)} bpm
                        </span>
                      )}
                      {session.calories !== null && (
                        <span className="tabular">
                          {formatNumber(session.calories, 0)} kcal
                        </span>
                      )}
                      {session.hrZone !== null && <span>zone {session.hrZone}</span>}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Log cardio">
          <LogCardioForm today={today} distanceUnit={label.distance} />
        </Card>
      </div>

      <Card title="Log sleep">
        <LogSleepForm today={today} />
      </Card>

      <Card title="Log daily metrics">
        <LogMetricsForm today={today} />
      </Card>
    </div>
  );
}
