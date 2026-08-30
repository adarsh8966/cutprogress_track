/**
 * Progress page (spec §25).
 *
 * Weight, waist, and the calories-versus-weight comparison the spec asks for.
 *
 * ON THE CALORIES/WEIGHT OVERLAY: the spec asks to allow overlaying them. They
 * are plotted as two charts stacked on a SHARED x-axis rather than as one chart
 * with two y-scales. A dual-axis chart lets the author manufacture any apparent
 * relationship by choosing the scales, which is exactly the wrong property for
 * the one comparison the user will make real decisions from. Stacked and
 * aligned answers the same question honestly.
 */
import Link from 'next/link';
import { getAnalyticsWindow } from '@/lib/data/queries';
import { DEFAULT_PROFILE } from '@/lib/defaults';
import { Card, DerivedFigure, formatNumber } from '@/components/ui/primitives';
import { Evidence } from '@/components/ui/Evidence';
import { TrendChart } from '@/components/charts/TrendChart';
import { BarSeries } from '@/components/charts/BarSeries';
import { LogMeasurementForm } from '@/components/dashboard/LogMeasurementForm';
import { trailingAverage } from '@/lib/analytics/movingAverage';
import { latestReading } from '@/lib/analytics/latest';
import { trend, trendChange } from '@/lib/analytics/trend';
import { densify, trailingWindow } from '@/lib/analytics/series';
import { addDays } from '@/lib/normalization/dates';
import {
  displayWeight, displayLength, unitsOf, unitLabels,
} from '@/lib/normalization/units';
import { todayForUser } from '@/app/actions/log';
import type { DailyMetrics, DatedValue } from '@/lib/types';

export const dynamic = 'force-dynamic';

const WINDOW_DAYS = 120;

function pick(days: DailyMetrics[], key: keyof DailyMetrics): DatedValue[] {
  return days.map((day) => {
    const value = day[key];
    return { date: day.localDate, value: typeof value === 'number' ? value : null };
  });
}

export default async function ProgressPage() {
  const { profile: loaded, end, metrics } = await getAnalyticsWindow();
  const profile = loaded ?? DEFAULT_PROFILE;
  const today = await todayForUser();

  // Every figure and every input label on this page reads its unit from here,
  // so what is displayed, what is typed and what logBodyMeasurement converts
  // with cannot disagree (spec §39).
  const units = unitsOf(profile);
  const label = unitLabels(units);
  const asWeight = (kg: number) => displayWeight(kg, units.weight);
  const asLength = (cm: number) => displayLength(cm, units.length);

  const weight = pick(metrics, 'weightKg');
  const waist = pick(metrics, 'waistCm');
  /**
   * Body composition and cardio fitness, where a connected source measures them.
   *
   * These belong on Progress rather than the Dashboard because they are slow:
   * body fat moves over months and VO2 max over training blocks, and a figure
   * that barely changes day to day earns a place in a trend view, not on a home
   * screen that is about today.
   */
  const bodyFat = pick(metrics, 'bodyFatPct');
  const vo2Max = pick(metrics, 'vo2Max');
  const calories = pick(metrics, 'caloriesConsumed');

  const start = addDays(end, -(WINDOW_DAYS - 1));
  const weightWindow = densify(weight, start, end);
  const waistWindow = densify(waist, start, end);
  const calorieWindow = densify(calories, start, end);

  // Convert to display units for the chart. Analytics stayed metric throughout.
  const weightPoints = weightWindow.map((point) => ({
    date: point.date,
    raw: point.value === null ? null : asWeight(point.value),
    smoothed: (() => {
      const avg = trailingAverage(weight, point.date, 7);
      return avg.value === null ? null : asWeight(avg.value);
    })(),
  }));

  const waistPoints = waistWindow.map((point) => ({
    date: point.date,
    raw: point.value === null ? null : asLength(point.value),
    smoothed: (() => {
      // Waist is weekly, so it gets a 28-day smoothing window rather than 7.
      const avg = trailingAverage(waist, point.date, 28, { minCoverage: 0.1 });
      return avg.value === null ? null : asLength(avg.value);
    })(),
  }));

  const weightTrend = trend(weight, end, 28, 'Weight trend (28 days)');
  const waistTrend = trend(waist, end, 84, 'Waist trend (84 days)');
  const direction = trendChange(weight, end, 28, 'Weight rate change');
  const weightAvg = trailingAverage(weight, end, 7, { label: 'Weight 7-day average' });
  const bodyFatLatest = latestReading(bodyFat, end, 90, { label: 'Body fat' });
  const vo2MaxLatest = latestReading(vo2Max, end, 90, { label: 'VO2 max' });
  /**
   * Body fat with a 28-day smoothing line, matching waist.
   *
   * Smoothed over four weeks rather than one because a body-composition
   * reading carries more noise than a scale weight does - hydration moves it -
   * and a 7-day line would present that noise as a trend.
   */
  const bodyFatPoints = densify(bodyFat, start, end).map((point) => ({
    date: point.date,
    raw: point.value,
    smoothed: trailingAverage(bodyFat, point.date, 30).value,
  }));

  const hasData = metrics.length > 0;

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-xl font-light">Progress</h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-muted">
          Last {WINDOW_DAYS} days. Days with no measurement are gaps, not zeros.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-3">
        {/* DerivedFigure, not Figure: a figure the coverage gate declined to
            compute must not report itself as never measured. */}
        <Card title="7-day average">
          <DerivedFigure
            derived={weightAvg}
            format={(kg) => formatNumber(asWeight(kg), 1)}
            unit={label.weight}
          />
          <Evidence derived={weightAvg} />
        </Card>
        <Card title="Rate of change">
          <DerivedFigure
            derived={weightTrend}
            format={(t) => formatNumber(asWeight(t.perWeek), 2)}
            unit={`${label.weight}/wk`}
            sub={
              direction.value ? (
                <span className="text-ink-faint">
                  {direction.value.direction.toLowerCase()}
                </span>
              ) : null
            }
          />
          <Evidence derived={weightTrend} />
        </Card>
        <Card title="Waist rate">
          <DerivedFigure
            derived={waistTrend}
            format={(t) => formatNumber(asLength(t.perWeek), 2)}
            unit={`${label.length}/wk`}
          />
          <Evidence derived={waistTrend} />
        </Card>
      </div>

      <Card title="Weight">
        <TrendChart
          data={weightPoints}
          unit={label.weight}
          target={profile.targetWeightKg === null ? null : asWeight(profile.targetWeightKg)}
          height={300}
        />
      </Card>

      <Card title="Waist">
        <TrendChart
          data={waistPoints}
          unit={label.length}
          smoothedLabel="28-day average"
          height={220}
        />
      </Card>

      {/*
        Body composition and cardio fitness.
        
        Shown only when there is something to show. An empty chart and two
        "not logged" cards on every Progress visit would be a permanent
        reminder of a source the user may have no intention of connecting -
        and unlike weight, these are not measurements the app is asking for.
      */}
      {(bodyFatLatest.value !== null || vo2MaxLatest.value !== null) && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Card title="Body fat">
              <DerivedFigure
                derived={bodyFatLatest}
                format={(v) => formatNumber(v, 1)}
                unit="%"
              />
              <Evidence derived={bodyFatLatest} />
            </Card>
            <Card title="VO2 max">
              <DerivedFigure
                derived={vo2MaxLatest}
                format={(v) => formatNumber(v, 1)}
                unit="ml/kg/min"
              />
              <Evidence derived={vo2MaxLatest} />
            </Card>
          </div>
          {bodyFatLatest.value !== null && (
            <Card title="Body fat over time">
              <TrendChart
                data={bodyFatPoints}
                unit="%"
                smoothedLabel="30-day average"
                height={200}
              />
            </Card>
          )}
        </>
      )}

      {/*
        Spec §25's calories-versus-weight comparison. Two charts, one shared
        time axis, one y-scale each. See the file header for why this is not a
        dual-axis overlay.
      */}
      <Card title="Calories against weight">
        <p className="mb-4 text-xs leading-relaxed text-ink-faint">
          Plotted on a shared time axis with separate scales rather than as a
          single two-axis chart: with two y-scales, any pair of series can be made
          to look correlated by choosing the scales, and this is the comparison you
          would actually change your intake over.
        </p>
        <div className="space-y-1">
          <div>
            <div className="mb-1 text-[11px] uppercase tracking-[0.12em] text-ink-faint">
              Calories consumed
            </div>
            <BarSeries
              data={calorieWindow}
              target={profile.targets.calories}
              unit="kcal"
              label="consumed"
              height={160}
            />
          </div>
          <div>
            <div className="mb-1 text-[11px] uppercase tracking-[0.12em] text-ink-faint">
              Weight
            </div>
            <TrendChart data={weightPoints} unit={label.weight} height={200} />
          </div>
        </div>
      </Card>

      {!hasData && (
        <Card title="Log a measurement">
          <LogMeasurementForm
            today={today} weightUnit={label.weight} lengthUnit={label.length}
          />
        </Card>
      )}
      {hasData && (
        <Card title="Log a measurement">
          <p className="mb-4 text-xs leading-relaxed text-ink-faint">
            Each entry is a new observation. Earlier measurements are never
            overwritten, so the full history stays reconstructable.
          </p>
          <LogMeasurementForm
            today={today} weightUnit={label.weight} lengthUnit={label.length}
          />
          <div className="mt-6 border-t border-line pt-4">
            <div className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">
              Recent measurements
            </div>
            {/* Each row opens the day it was recorded on, which is where a
                measurement can be corrected or withdrawn. A list of values with
                nothing to click is where "how do I fix that?" used to end. */}
            <ul className="mt-2 divide-y divide-line/60 text-sm">
              {trailingWindow(weight, end, 10)
                .filter((point) => point.value !== null)
                .reverse()
                .map((point) => (
                  <li key={point.date}>
                    <Link
                      href={`/day/${point.date}`}
                      className="-mx-2 flex items-baseline justify-between gap-3 rounded px-2 py-2 transition-colors hover:bg-raised"
                    >
                      <span className="tabular text-ink-muted">{point.date}</span>
                      <span className="tabular">
                        {formatNumber(asWeight(point.value!), 1)} {label.weight}
                      </span>
                    </Link>
                  </li>
                ))}
            </ul>
            <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
              Open a day to see every observation behind its figures, correct one, or
              withdraw a record that should not count.
            </p>
          </div>
        </Card>
      )}
    </div>
  );
}
