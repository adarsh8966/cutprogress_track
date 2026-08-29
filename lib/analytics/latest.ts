/**
 * The most recent actual reading of a metric (spec §18, §32, §33).
 *
 * WHY THIS EXISTS. A trailing average is the right way to read a noisy daily
 * metric, and lib/analytics/movingAverage.ts refuses to compute one from a
 * window that is mostly empty - correctly, because four readings are not a
 * thirty-day average. But a metric whose ONLY reader is a gated average
 * disappears entirely until half the window fills up: the measurements are in
 * the database, resolved into daily_metrics, queried and mapped, and the page
 * still reports nothing. That is what happened to resting heart rate and HRV.
 *
 * A latest reading is a different question with a different answer. It asks
 * "what is the most recent value actually recorded?", which four readings can
 * answer exactly, so it needs no coverage gate. It reports the date it came
 * from and how old it is, because a resting heart rate from three weeks ago is
 * a fact about three weeks ago and must not be presented as today's.
 *
 * The two readings are complements, not substitutes. The average says what is
 * typical, the latest says what was last true, and a page showing a metric
 * honestly generally wants both.
 */
import type { DatedValue, Derived, LocalDate } from '@/lib/types';
import { derived, insufficient } from '@/lib/types';
import { coverageOf, latestPresent, trailingWindow } from './series';
import { daysBetween } from '@/lib/normalization/dates';

/** Beyond this many days old, a reading is reported but flagged as stale. */
export const FRESH_DAYS = 2;
export const RECENT_DAYS = 7;

/**
 * The most recent value in the `withinDays` calendar days ending at `end`.
 *
 * A measured zero is a value and is returned as one. An absent day is null and
 * is never read as zero (spec §33) - that rule lives in presentValues() and
 * latestPresent(), which this delegates to rather than re-implementing.
 */
export function latestReading(
  points: DatedValue[],
  end: LocalDate,
  withinDays: number,
  options: { label?: string } = {},
): Derived<number> {
  const label = options.label ?? 'Latest reading';
  const window = trailingWindow(points, end, withinDays);
  const coverage = coverageOf(window.map((p) => p.value));
  const latest = latestPresent(window);

  if (latest === null || latest.value === null) {
    return insufficient<number>(
      label,
      { endDate: end, searchWindowDays: withinDays, daysWithData: 0 },
      `No measurement in the ${withinDays} days ending ${end}.`,
      0,
    );
  }

  const ageDays = daysBetween(latest.date, end);

  const inputs = {
    endDate: end,
    observedOn: latest.date,
    ageDays,
    searchWindowDays: withinDays,
    daysWithData: coverage.present,
  };

  // Confidence here is about STALENESS, not agreement: the number itself is
  // exactly what was recorded, but how well it describes today decays with age.
  const confidence =
    ageDays <= FRESH_DAYS ? 'HIGH' : ageDays <= RECENT_DAYS ? 'MODERATE' : 'LOW';

  const notes =
    ageDays === 0
      ? []
      : [
          `Measured on ${latest.date}, ${ageDays} day${ageDays === 1 ? '' : 's'} ` +
            `before ${end}. This is the last recorded value, not an estimate for ${end}.`,
        ];

  return derived(latest.value, label, inputs, confidence, notes, coverage.present);
}
