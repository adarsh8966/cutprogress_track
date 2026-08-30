import { describe, it, expect } from 'vitest';
import { weeklyReview, monthlyReview } from '@/lib/analytics/reviews';
import { fixtureDays, fixtureSets, FIXTURE_PROFILE, FIXTURE_END } from '../helpers/fixtures';
import { startOfWeek, endOfWeek } from '@/lib/normalization/dates';
import { kgToLb } from '@/lib/normalization/units';

const days = fixtureDays();
const sets = fixtureSets();

describe('weekly review (spec §51)', () => {
  const review = weeklyReview(days, sets, FIXTURE_PROFILE.targets, FIXTURE_END);

  it('runs Monday to Sunday', () => {
    expect(review.value!.weekStart).toBe(startOfWeek(FIXTURE_END));
    expect(review.value!.weekEnd).toBe(endOfWeek(FIXTURE_END));
  });

  it('measures weight change between 7-day averages, not single weigh-ins', () => {
    expect(review.inputs.note).toMatch(/7-day averages, not single weigh-ins/);
    expect(review.value!.weightChangeKg).not.toBeNull();
    // The fixture loses roughly 1.2 lb/week, so a week should land near that.
    expect(Math.abs(kgToLb(review.value!.weightChangeKg!))).toBeLessThan(3);
  });

  it('assesses against the user\'s own rate ceiling', () => {
    expect(review.value!.assessment).not.toBe('INSUFFICIENT_DATA');
    const fast = weeklyReview(days, sets, FIXTURE_PROFILE.targets, FIXTURE_END, 0.1);
    // With a 0.1%/week ceiling, the fixture's normal rate now reads as too fast.
    expect(fast.value!.assessment).toBe('LOSING_TOO_FAST');
  });

  it('flags a sparsely logged week as provisional', () => {
    const sparse = days.map((day, i) =>
      i % 3 === 0 ? day : { ...day, caloriesConsumed: null },
    );
    const result = weeklyReview(sparse, sets, FIXTURE_PROFILE.targets, FIXTURE_END);
    expect(result.confidence).toBe('LOW');
    expect(result.notes.join(' ')).toMatch(/provisional/);
  });

  /**
   * Sessions and sets are counted from different places on purpose. This test
   * used to pass an empty set list and expect zero sessions, which is what the
   * bug looked like from the inside: sessions were counted by looking at sets,
   * so a week of sessions with no set-level detail reported no training at all
   * while the adherence figure beside it - which reads daily_metrics - said the
   * week was fully trained.
   */
  it('counts sessions from the canonical rollup, not from logged sets', () => {
    const result = weeklyReview(days, [], FIXTURE_PROFILE.targets, FIXTURE_END);
    const week = days.filter(
      (d) => d.localDate >= result.value!.weekStart && d.localDate <= result.value!.weekEnd,
    );
    const expected = week.reduce((total, d) => total + (d.trainingSessions ?? 0), 0);

    expect(expected).toBeGreaterThan(0);
    expect(result.value!.trainingSessions).toBe(expected);
    // No sets were logged, so the set-level figure is a real zero beside it.
    expect(result.value!.workingSets).toBe(0);
  });

  it('reports zero sessions when the week genuinely has none', () => {
    const untrained = days.map((day) => ({ ...day, trainingSessions: null }));
    const result = weeklyReview(untrained, [], FIXTURE_PROFILE.targets, FIXTURE_END);
    expect(result.value!.trainingSessions).toBe(0);
    expect(result.value!.workingSets).toBe(0);
  });

  it('returns nulls, not zeros, for an empty week', () => {
    const result = weeklyReview([], [], FIXTURE_PROFILE.targets, FIXTURE_END);
    expect(result.value!.weightChangeKg).toBeNull();
    expect(result.value!.averageCalories).toBeNull();
    expect(result.value!.assessment).toBe('INSUFFICIENT_DATA');
  });
});

describe('monthly review (spec §52)', () => {
  const review = monthlyReview(days, sets, FIXTURE_END);

  it('bounds the calendar month', () => {
    expect(review.value!.monthStart).toBe('2026-11-01');
    expect(review.value!.monthEnd).toBe('2026-11-30');
  });

  it('counts the longest consecutive logging streak', () => {
    const streak = review.value!.longestLoggingStreak;
    expect(streak).toBeGreaterThan(0);
    expect(streak).toBeLessThanOrEqual(review.value!.daysLogged);
  });

  it('never reports more logged days than days in the range', () => {
    expect(review.value!.daysLogged).toBeLessThanOrEqual(review.value!.dayCount);
  });

  it('reports a net loss over the month', () => {
    expect(review.value!.totalChangeKg).toBeLessThan(0);
  });
});

/**
 * A mean over one logged day and a mean over seven are the same arithmetic and
 * completely different claims. The review used to report both as "Average
 * calories" with nothing to tell them apart, so a week with a single logged day
 * read as a weekly habit.
 *
 * The formula is deliberately unchanged - the mean is still taken over the days
 * that carry data, which is the only honest denominator. What is new is that
 * the count travels with it, so the page can stop calling one day an average.
 */
describe('reviews carry the coverage behind every average', () => {
  it('reports how many days each weekly average was built from', () => {
    const review = weeklyReview(days, sets, FIXTURE_PROFILE.targets, FIXTURE_END).value!;
    expect(review.coverage.days).toBeGreaterThan(0);
    expect(review.coverage.calories).toBeGreaterThan(0);
    // Never more days of data than days in the period.
    expect(review.coverage.calories).toBeLessThanOrEqual(review.coverage.days);
    expect(review.coverage.protein).toBeLessThanOrEqual(review.coverage.days);
    expect(review.coverage.steps).toBeLessThanOrEqual(review.coverage.days);
    expect(review.coverage.weight).toBeLessThanOrEqual(review.coverage.days);
  });

  it('says ONE when a week holds a single logged day', () => {
    // The Aug 29 shape: a real value, and a coverage count that stops it being
    // presented as a week's worth.
    const week = startOfWeek(FIXTURE_END);
    const oneDay = days.map((day) =>
      day.localDate === week ? { ...day, caloriesConsumed: 2050 } : { ...day, caloriesConsumed: null },
    );
    const review = weeklyReview(oneDay, sets, FIXTURE_PROFILE.targets, FIXTURE_END).value!;
    // The value is still reported - the data exists and must not vanish.
    expect(review.averageCalories).toBe(2050);
    // ...and it is one day, not a week.
    expect(review.coverage.calories).toBe(1);
    expect(review.coverage.days).toBe(7);
  });

  it('says ZERO for a metric the week never recorded', () => {
    const none = days.map((day) => ({ ...day, caloriesConsumed: null }));
    const review = weeklyReview(none, sets, FIXTURE_PROFILE.targets, FIXTURE_END).value!;
    expect(review.averageCalories).toBeNull();
    expect(review.coverage.calories).toBe(0);
  });

  it('reports monthly coverage against the length of the month', () => {
    const review = monthlyReview(days, sets, FIXTURE_END).value!;
    expect(review.coverage.days).toBeGreaterThanOrEqual(28);
    expect(review.coverage.calories).toBeLessThanOrEqual(review.coverage.days);
    expect(review.coverage.calories).toBe(review.daysLogged);
  });
});
