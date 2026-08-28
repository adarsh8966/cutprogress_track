/**
 * Recovery page (spec §14).
 *
 * Spec §14 is explicit that recovery must never be a hard gate: bad sleep is
 * not an instruction to skip the gym. So this page reports and contextualises,
 * and the one interpretive line it prints is conditional on performance also
 * declining. It never tells the user not to train.
 */
import { getAnalyticsWindow } from '@/lib/data/queries';
import { Card, Figure, formatNumber } from '@/components/ui/primitives';
import { Evidence } from '@/components/ui/Evidence';
import { BarSeries } from '@/components/charts/BarSeries';
import { LogSleepForm, LogCardioForm, LogMetricsForm } from '@/components/dashboard/LogRecoveryForms';
import { trailingAverage } from '@/lib/analytics/movingAverage';
import { densify, presentValues, trailingWindow } from '@/lib/analytics/series';
import { addDays } from '@/lib/normalization/dates';
import { kmToMiles } from '@/lib/normalization/units';
import { todayForUser } from '@/app/actions/log';
import type { DailyMetrics, DatedValue } from '@/lib/types';

export const dynamic = 'force-dynamic';

function pick(days: DailyMetrics[], key: keyof DailyMetrics): DatedValue[] {
  return days.map((day) => {
    const value = day[key];
    return { date: day.localDate, value: typeof value === 'number' ? value : null };
  });
}

function formatSleep(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${Math.round(minutes - hours * 60)}m`;
}

export default async function RecoveryPage() {
  const { end, metrics, cardio } = await getAnalyticsWindow();
  const today = await todayForUser();

  const sleep = pick(metrics, 'sleepDurationMinutes');
  const rhr = pick(metrics, 'restingHeartRate');
  const hrv = pick(metrics, 'hrvMs');
  const steps = pick(metrics, 'steps');

  const sleep7 = trailingAverage(sleep, end, 7, { label: 'Sleep 7-day average' });
  const sleep30 = trailingAverage(sleep, end, 30, { label: 'Sleep 30-day average' });
  const rhr30 = trailingAverage(rhr, end, 30, { label: 'Resting HR 30-day average' });
  const hrv30 = trailingAverage(hrv, end, 30, { label: 'HRV 30-day average' });

  const recentCardio = cardio.slice(0, 12);
  const zone2 = presentValues(
    trailingWindow(pick(metrics, 'zone2Minutes'), end, 28).map((p) => p.value),
  ).reduce((total, v) => total + v, 0);

  // Spec §14: informational only, and phrased as a consideration, not a gate.
  const belowBaseline =
    sleep7.value !== null && sleep30.value !== null && sleep7.value < sleep30.value * 0.9;

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-xl font-light">Recovery</h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-muted">
          Recovery data is informational. It is never a reason on its own to skip
          training.
        </p>
      </header>

      {belowBaseline && (
        <p className="rounded border border-warn/40 bg-warn/5 px-4 py-3 text-sm leading-relaxed text-warn">
          Recovery is below your own baseline: the last 7 days average{' '}
          {formatSleep(sleep7.value!)} against a 30-day average of{' '}
          {formatSleep(sleep30.value!)}. Consider reducing training intensity{' '}
          <span className="text-ink-muted">
            if your performance is also declining
          </span>
          . On its own this is not a reason to train less.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card title="Sleep (7-day)">
          <Figure
            value={sleep7.value === null ? null : formatSleep(sleep7.value)}
            size="sm"
          />
          <Evidence derived={sleep7} />
        </Card>
        <Card title="Sleep (30-day)">
          <Figure
            value={sleep30.value === null ? null : formatSleep(sleep30.value)}
            size="sm"
          />
        </Card>
        <Card title="Resting heart rate">
          <Figure
            value={rhr30.value === null ? null : formatNumber(rhr30.value, 0)}
            unit="bpm"
            size="sm"
          />
          <Evidence derived={rhr30} />
        </Card>
        <Card title="HRV">
          <Figure
            value={hrv30.value === null ? null : formatNumber(hrv30.value, 0)}
            unit="ms"
            size="sm"
          />
          <Evidence derived={hrv30} />
        </Card>
      </div>

      <Card title="Sleep, last 30 days">
        <BarSeries
          data={densify(sleep, addDays(end, -29), end)}
          unit="min"
          label="asleep"
          height={200}
        />
      </Card>

      <Card title="Steps, last 30 days">
        <BarSeries
          data={densify(steps, addDays(end, -29), end)}
          label="steps"
          height={200}
        />
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Cardio">
          <Figure
            label="Zone 2, last 28 days"
            value={zone2 > 0 ? formatNumber(zone2, 0) : null}
            unit="min"
            size="sm"
          />
          {recentCardio.length > 0 && (
            <ul className="mt-4 divide-y divide-line/60 text-sm">
              {recentCardio.map((session) => (
                <li key={session.id} className="flex flex-wrap items-baseline gap-x-3 py-2">
                  <span className="tabular text-ink-muted">{session.date}</span>
                  <span className="text-xs text-ink-faint">
                    {session.type.replaceAll('_', ' ').toLowerCase()}
                  </span>
                  <span className="tabular ml-auto">
                    {formatNumber(session.durationMinutes, 0)} min
                    {session.distanceKm !== null &&
                      ` · ${formatNumber(kmToMiles(session.distanceKm), 2)} mi`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Log cardio">
          <LogCardioForm today={today} />
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
