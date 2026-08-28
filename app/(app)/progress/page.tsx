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
import { getAnalyticsWindow } from '@/lib/data/queries';
import { DEFAULT_PROFILE } from '@/lib/defaults';
import { Card, Figure, formatNumber } from '@/components/ui/primitives';
import { Evidence } from '@/components/ui/Evidence';
import { TrendChart } from '@/components/charts/TrendChart';
import { BarSeries } from '@/components/charts/BarSeries';
import { LogMeasurementForm } from '@/components/dashboard/LogMeasurementForm';
import { trailingAverage } from '@/lib/analytics/movingAverage';
import { trend, trendChange } from '@/lib/analytics/trend';
import { densify, trailingWindow } from '@/lib/analytics/series';
import { addDays } from '@/lib/normalization/dates';
import { kgToLb, cmToInches } from '@/lib/normalization/units';
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

  const weight = pick(metrics, 'weightKg');
  const waist = pick(metrics, 'waistCm');
  const calories = pick(metrics, 'caloriesConsumed');

  const start = addDays(end, -(WINDOW_DAYS - 1));
  const weightWindow = densify(weight, start, end);
  const waistWindow = densify(waist, start, end);
  const calorieWindow = densify(calories, start, end);

  // Convert to display units for the chart. Analytics stayed metric throughout.
  const weightPoints = weightWindow.map((point) => ({
    date: point.date,
    raw: point.value === null ? null : kgToLb(point.value),
    smoothed: (() => {
      const avg = trailingAverage(weight, point.date, 7);
      return avg.value === null ? null : kgToLb(avg.value);
    })(),
  }));

  const waistPoints = waistWindow.map((point) => ({
    date: point.date,
    raw: point.value === null ? null : cmToInches(point.value),
    smoothed: (() => {
      // Waist is weekly, so it gets a 28-day smoothing window rather than 7.
      const avg = trailingAverage(waist, point.date, 28, { minCoverage: 0.1 });
      return avg.value === null ? null : cmToInches(avg.value);
    })(),
  }));

  const weightTrend = trend(weight, end, 28, 'Weight trend (28 days)');
  const waistTrend = trend(waist, end, 84, 'Waist trend (84 days)');
  const direction = trendChange(weight, end, 28, 'Weight rate change');
  const weightAvg = trailingAverage(weight, end, 7, { label: 'Weight 7-day average' });

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
        <Card title="7-day average">
          <Figure
            value={weightAvg.value === null ? null : formatNumber(kgToLb(weightAvg.value), 1)}
            unit="lb"
          />
          <Evidence derived={weightAvg} />
        </Card>
        <Card title="Rate of change">
          <Figure
            value={
              weightTrend.value === null
                ? null
                : formatNumber(kgToLb(weightTrend.value.perWeek), 2)
            }
            unit="lb/wk"
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
          <Figure
            value={
              waistTrend.value === null
                ? null
                : formatNumber(cmToInches(waistTrend.value.perWeek), 2)
            }
            unit="in/wk"
          />
          <Evidence derived={waistTrend} />
        </Card>
      </div>

      <Card title="Weight">
        <TrendChart
          data={weightPoints}
          unit="lb"
          target={profile.targetWeightKg === null ? null : kgToLb(profile.targetWeightKg)}
          height={300}
        />
      </Card>

      <Card title="Waist">
        <TrendChart
          data={waistPoints}
          unit="in"
          smoothedLabel="28-day average"
          height={220}
        />
      </Card>

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
            <TrendChart data={weightPoints} unit="lb" height={200} />
          </div>
        </div>
      </Card>

      {!hasData && (
        <Card title="Log a measurement">
          <LogMeasurementForm today={today} />
        </Card>
      )}
      {hasData && (
        <Card title="Log a measurement">
          <p className="mb-4 text-xs leading-relaxed text-ink-faint">
            Each entry is a new observation. Earlier measurements are never
            overwritten, so the full history stays reconstructable.
          </p>
          <LogMeasurementForm today={today} />
          <div className="mt-6 border-t border-line pt-4">
            <div className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">
              Recent measurements
            </div>
            <ul className="mt-2 divide-y divide-line/60 text-sm">
              {trailingWindow(weight, end, 10)
                .filter((point) => point.value !== null)
                .reverse()
                .map((point) => (
                  <li key={point.date} className="flex justify-between py-1.5">
                    <span className="tabular text-ink-muted">{point.date}</span>
                    <span className="tabular">
                      {formatNumber(kgToLb(point.value!), 1)} lb
                    </span>
                  </li>
                ))}
            </ul>
          </div>
        </Card>
      )}
    </div>
  );
}
