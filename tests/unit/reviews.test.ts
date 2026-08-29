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
