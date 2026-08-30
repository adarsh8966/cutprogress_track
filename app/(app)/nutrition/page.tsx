/**
 * Nutrition page (spec §9, §27).
 *
 * The score is deliberately transparent: it shows every component, its weight,
 * and what it was scored against. Spec §9 - "Score is not a health judgement",
 * it measures adherence to the user's own targets, so nothing here rates food
 * quality or marks a day down for its macro split.
 */
import Link from 'next/link';
import { getAnalyticsWindow } from '@/lib/data/queries';
import { DEFAULT_PROFILE } from '@/lib/defaults';
import { Card, Meter, Figure, StatusDot, formatNumber } from '@/components/ui/primitives';
import { Evidence } from '@/components/ui/Evidence';
import { BarSeries } from '@/components/charts/BarSeries';
import { LogNutritionForm } from '@/components/nutrition/LogNutritionForm';
import { scoreNutritionDay } from '@/lib/analytics/scores';
import { readingOf, coverageNote } from '@/lib/analytics/reading';
import { computeAdherence } from '@/lib/analytics/adherence';
import { densify, trailingWindow } from '@/lib/analytics/series';
import { addDays, formatShortDate } from '@/lib/normalization/dates';
import { todayForUser } from '@/app/actions/log';
import type { DailyMetrics, DatedValue } from '@/lib/types';

export const dynamic = 'force-dynamic';

function pick(days: DailyMetrics[], key: keyof DailyMetrics): DatedValue[] {
  return days.map((day) => {
    const value = day[key];
    return { date: day.localDate, value: typeof value === 'number' ? value : null };
  });
}

export default async function NutritionPage() {
  const { profile: loaded, end, metrics } = await getAnalyticsWindow();
  const profile = loaded ?? DEFAULT_PROFILE;
  const today = await todayForUser();

  const calories = pick(metrics, 'caloriesConsumed');
  const protein = pick(metrics, 'proteinG');
  const carbs = pick(metrics, 'carbsG');
  const fat = pick(metrics, 'fatG');
  const fiber = pick(metrics, 'fiberG');
  const steps = pick(metrics, 'steps');
  const weight = pick(metrics, 'weightKg');
  const sessions = pick(metrics, 'trainingSessions');
  const cardioMinutes = pick(metrics, 'cardioMinutes');

  const todayRow = metrics.find((day) => day.localDate === end) ?? null;
  const score = scoreNutritionDay(
    {
      calories: todayRow?.caloriesConsumed ?? null,
      proteinG: todayRow?.proteinG ?? null,
      carbsG: todayRow?.carbsG ?? null,
      fatG: todayRow?.fatG ?? null,
      fiberG: todayRow?.fiberG ?? null,
      // Was hard-coded null while the form offered the field and the score
      // weighted it 10 of 100, so logging it could never change the score.
      fruitVegServings: todayRow?.fruitVegServings ?? null,
      logged: todayRow?.caloriesConsumed != null || todayRow?.proteinG != null,
    },
    profile.targets,
  );

  const adherence = computeAdherence(
    { calories, protein, steps, weight, trainingSessions: sessions, cardioMinutes },
    profile.targets, end, 28,
  );

  const last30 = densify(calories, addDays(end, -29), end);
  const week = trailingWindow(calories, end, 7);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-xl font-light">Nutrition</h1>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Today">
          <div className="space-y-4">
            <Meter
              label="Calories"
              value={todayRow?.caloriesConsumed ?? null}
              target={profile.targets.calories}
              unit="kcal"
            />
            <Meter
              label="Protein"
              value={todayRow?.proteinG ?? null}
              target={profile.targets.proteinG}
              unit="g"
              overIsFine
            />
            <Meter
              label="Fibre"
              value={todayRow?.fiberG ?? null}
              target={profile.targets.fiberG}
              unit="g"
              overIsFine
            />
            <div className="grid grid-cols-2 gap-4 border-t border-line pt-4 sm:grid-cols-3">
              <Figure
                label="Carbohydrate"
                value={todayRow?.carbsG == null ? null : formatNumber(todayRow.carbsG)}
                unit="g"
                size="sm"
              />
              <Figure
                label="Fat"
                value={todayRow?.fatG == null ? null : formatNumber(todayRow.fatG)}
                unit="g"
                size="sm"
              />
              <Figure
                label="Fruit + veg"
                value={
                  todayRow?.fruitVegServings == null
                    ? null
                    : formatNumber(todayRow.fruitVegServings)
                }
                unit="servings"
                size="sm"
              />
            </div>
          </div>
        </Card>

        <Card title="Nutrition score (today)">
          {score.value === null ? (
            <p className="text-sm text-ink-faint">
              {score.notes[0] ?? 'Nothing logged today.'}
            </p>
          ) : (
            <>
              <Figure value={formatNumber(score.value.score, 0)} unit="/100" />
              <ul className="mt-4 space-y-1.5 text-xs">
                {score.value.components.map((component) => (
                  <li key={component.key} className="flex justify-between gap-3">
                    <span className="text-ink-muted">{component.label}</span>
                    <span className="tabular">
                      {component.points === null ? (
                        <span className="text-ink-faint">not scored</span>
                      ) : (
                        <>
                          {formatNumber(component.points, 1)}
                          <span className="text-ink-faint"> / {component.weight}</span>
                        </>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-4 border-t border-line pt-3 text-[11px] leading-relaxed text-ink-faint">
                This measures adherence to your own targets. It is not a judgement of
                what you ate, and the weights are configurable.
              </p>
            </>
          )}
          <Evidence derived={score} />
        </Card>
      </div>

      <Card title="Calories, last 30 days">
        <BarSeries
          data={last30}
          target={profile.targets.calories}
          unit="kcal"
          label="consumed"
          height={220}
        />
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Each row states the coverage behind it, whether or not the average
            could be computed. "not computable" on its own said nothing about
            whether the days existed - and when they did, it read as though
            they never had. */}
        <Card title="Averages">
          <dl className="space-y-3 text-sm">
            {(
              [
                ['Calories', calories, 'kcal'],
                ['Protein', protein, 'g'],
                ['Carbohydrate', carbs, 'g'],
                ['Fat', fat, 'g'],
                ['Fibre', fiber, 'g'],
              ] as const
            ).map(([label, series, unit]) => {
              const reading = readingOf(series, label, end, 28);
              const showing = reading.average.value ?? reading.latest.value;
              return (
                <div key={label}>
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink-muted">{label} (28-day)</dt>
                    <dd className="tabular">
                      {showing === null ? (
                        <span className="text-ink-faint">not logged</span>
                      ) : (
                        `${formatNumber(showing, 0)} ${unit}`
                      )}
                    </dd>
                  </div>
                  <div className="mt-0.5 text-[11px] text-ink-faint">
                    {coverageNote(reading.coverage)}
                    {reading.average.value === null && showing !== null
                      ? ' · latest reading, not enough for a 28-day average'
                      : ''}
                  </div>
                </div>
              );
            })}
          </dl>
          <div className="mt-4 border-t border-line pt-4">
            <Evidence derived={adherence.calories} />
          </div>
        </Card>

        <Card title="This week">
          {/* Spec §27's weekly adherence calendar. */}
          <ul className="space-y-2">
            {week.map((day) => {
              const status =
                day.value === null
                  ? 'neutral'
                  : profile.targets.calories === null
                    ? 'neutral'
                    : Math.abs(day.value - profile.targets.calories) /
                          profile.targets.calories <=
                        0.1
                      ? 'good'
                      : 'warn';
              return (
                <li key={day.date}>
                  <Link
                    href={`/day/${day.date}`}
                    className="-mx-2 flex items-center justify-between gap-3 rounded px-2 py-1.5 transition-colors hover:bg-raised"
                  >
                  <span className="text-xs text-ink-muted">
                    {formatShortDate(day.date)}
                  </span>
                  <StatusDot
                    status={status}
                    label={
                      day.value === null
                        ? 'not logged'
                        : `${formatNumber(day.value, 0)} kcal`
                    }
                  />
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      </div>

      <Card title="Log nutrition">
        <LogNutritionForm today={today} />
      </Card>
    </div>
  );
}
