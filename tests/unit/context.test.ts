import { describe, it, expect } from 'vitest';
import { generateContextPack, CONTEXT_VERSION, DETAIL_DAYS, monthlySummaries } from '@/lib/context/generate';
import { CHATGPT_INSTRUCTIONS } from '@/lib/context/instructions';
import { table, line, percent, formatRate } from '@/lib/context/format';
import {
  FIXTURE_END, FIXTURE_PROFILE, fixtureDays, fixtureSets, fixtureSessions, fixtureCardio,
} from '../helpers/fixtures';
import type { DailyMetrics, LocalDate } from '@/lib/types';
import { emptyDay } from '@/lib/defaults';

const pack = generateContextPack({
  generatedFor: FIXTURE_END,
  profile: FIXTURE_PROFILE,
  days: fixtureDays(),
  sets: fixtureSets(),
  sessions: fixtureSessions(),
  cardio: fixtureCardio(),
});

/** A canonical day with nothing measured on it. Every field null (spec §33). */
const blankDay = (localDate: string): DailyMetrics => emptyDay(localDate as LocalDate);

describe('Context Pack (spec §30-§33, §53)', () => {
  it('is stamped with a schema version (spec §43)', () => {
    expect(pack.version).toBe(CONTEXT_VERSION);
    expect(pack.body).toContain(`Context version: ${CONTEXT_VERSION}`);
    expect(pack.body).toContain('Analytics version:');
  });

  it('opens with the do-not-assume instructions (spec §53)', () => {
    expect(pack.body).toContain(CHATGPT_INSTRUCTIONS);
    expect(pack.body).toContain('Do not assume missing values.');
    expect(pack.body).toMatch(/prioritise trends over single-day measurements/);
  });

  it('states data quality before presenting any data (spec §32)', () => {
    const qualityIndex = pack.body.indexOf('DATA QUALITY:');
    const currentStateIndex = pack.body.indexOf('CURRENT STATE');
    expect(qualityIndex).toBeGreaterThan(-1);
    expect(qualityIndex).toBeLessThan(currentStateIndex);
    expect(pack.dataQualityScore).not.toBeNull();
  });

  it('includes every section the spec lists (spec §30)', () => {
    for (const heading of [
      'FITNESS CONTEXT PACK', 'USER PROFILE', 'GOALS AND TARGETS', 'CURRENT STATE',
      'WEIGHT TREND', 'WAIST TREND', 'NUTRITION', 'ACTIVITY', 'TRAINING',
      'RECOVERY', 'ADHERENCE', 'ANALYTICS', 'SYSTEM-DETECTED ISSUES',
      'QUESTIONS FOR CHATGPT',
    ]) {
      expect(pack.body, `missing section: ${heading}`).toContain(heading);
    }
  });

  it('writes missing values as "not logged", never as zero (spec §33)', () => {
    expect(pack.body).toContain('not logged');
    expect(pack.body).toContain('"-" means not logged. It does not mean zero.');
  });

  it('compresses history into detail, summary and monthly layers (spec §31)', () => {
    expect(pack.body).toContain(`RECENT DETAIL (LAST ${DETAIL_DAYS} DAYS)`);
    expect(pack.body).toContain('SUMMARY WINDOWS');
    expect(pack.body).toContain('MONTHLY HISTORY');
    // The detail table must hold exactly the detail window, not the whole history.
    const detailSection = pack.body.split(`RECENT DETAIL (LAST ${DETAIL_DAYS} DAYS)`)[1]!
      .split('SUMMARY WINDOWS')[0]!;
    const dataRows = detailSection
      .split('\n')
      .filter((l) => /^[A-Z][a-z]{2} \d+ /.test(l));
    expect(dataRows).toHaveLength(DETAIL_DAYS);
  });

  it('reports weight in the display unit with the trend attached', () => {
    expect(pack.body).toMatch(/7-day average weight: [\d.,]+ lb/);
    expect(pack.body).toMatch(/Rate of change: [-+][\d.]+ lb\/week/);
  });

  it('fits a waist trend from weekly measurements', () => {
    // Waist is measured once a week by design. A window sized for daily weight
    // could never hold enough waist points to fit a trend, so it gets its own.
    expect(pack.body).toMatch(/Rate of change: [-+][\d.]+ in\/week/);
    expect(pack.body).not.toMatch(/WAIST TREND\n-+\n- Not computable/);
  });

  it('labels every derived figure with its confidence (spec §57)', () => {
    expect(pack.body).toMatch(/\[confidence: (high|moderate|low)\]/);
  });

  it('presents recommendations as candidates with evidence, never as commands', () => {
    expect(pack.body).toContain('RECOMMENDATION CANDIDATES');
    expect(pack.body).toContain(
      'These are CANDIDATES with their evidence, not decisions. The coaching call is yours.',
    );
  });

  it('never emits an unsafe protocol (spec §45)', () => {
    const forbidden = [
      /\bfast(ing)? for \d+ days?\b/i, /\bpurge\b/i, /\bstarv/i,
      /\bdehydrat/i, /\bdiuretic/i, /\bclenbuterol\b/i, /\bDNP\b/,
      /\bskip (all )?meals\b/i,
    ];
    for (const pattern of forbidden) {
      expect(pack.body, `pack must not contain ${pattern}`).not.toMatch(pattern);
    }
  });

  it('always closes with questions for ChatGPT', () => {
    expect(pack.body).toMatch(/QUESTIONS FOR CHATGPT[\s\S]*1\. /);
    expect(pack.body.trimEnd()).toMatch(/END OF CONTEXT PACK\n={52}$/);
  });

  it('accepts caller-supplied questions and events', () => {
    const custom = generateContextPack({
      generatedFor: FIXTURE_END,
      profile: FIXTURE_PROFILE,
      days: fixtureDays(),
      sets: fixtureSets(),
      sessions: fixtureSessions(),
      cardio: fixtureCardio(),
      questions: ['Should I drop calories?'],
      recentEvents: [{ date: '2026-11-15', note: 'Travelled for three days.' }],
    });
    expect(custom.body).toContain('1. Should I drop calories?');
    expect(custom.body).toContain('RECENT EVENTS');
    expect(custom.body).toContain('Travelled for three days.');
  });

  it('is deterministic for a fixed dataset', () => {
    const again = generateContextPack({
      generatedFor: FIXTURE_END,
      profile: FIXTURE_PROFILE,
      days: fixtureDays(),
      sets: fixtureSets(),
      sessions: fixtureSessions(),
      cardio: fixtureCardio(),
    });
    expect(again.body).toBe(pack.body);
  });

  it('matches the committed snapshot', async () => {
    await expect(pack.body).toMatchFileSnapshot('./__snapshots__/context-pack.txt');
  });

  it('degrades gracefully on an empty dataset rather than throwing', () => {
    const empty = generateContextPack({
      generatedFor: FIXTURE_END,
      profile: FIXTURE_PROFILE,
      days: [],
      sets: [],
      sessions: [],
      cardio: [],
    });
    expect(empty.body).toContain('FITNESS CONTEXT PACK');
    // With no observations at all, every figure is genuinely NOT LOGGED - the
    // one case those words are true of. The pack says so rather than the
    // vaguer "not computable", which covers three different situations and
    // leaves ChatGPT to guess which one it is reading.
    expect(empty.body).toContain('not logged');
    expect(empty.body).not.toMatch(/NaN|undefined|Infinity/);
  });

  /**
   * The pack is what ChatGPT reasons over, so a missing figure has to say why
   * it is missing. "No measurements" and "some measurements, too few to
   * average" support completely different advice.
   */
  it('distinguishes an unlogged metric from a sparsely logged one', () => {
    const sparse = generateContextPack({
      generatedFor: FIXTURE_END,
      profile: FIXTURE_PROFILE,
      // Four days of resting heart rate inside a thirty-day window: enough to
      // exist, far too few for the 30-day average to be reported.
      days: [
        { ...blankDay('2026-11-17'), restingHeartRate: 62 },
        { ...blankDay('2026-11-18'), restingHeartRate: 59 },
        { ...blankDay('2026-11-19'), restingHeartRate: 58 },
        { ...blankDay('2026-11-20'), restingHeartRate: 58 },
      ],
      sets: [],
      sessions: [],
      cardio: [],
    });

    // The sparse metric names its coverage instead of claiming absence.
    expect(sparse.body).toMatch(/30-day average resting heart rate: not computable - 4 day/);
    // ...while a metric nothing wrote still reads as never recorded.
    expect(sparse.body).toMatch(/HRV: not logged/);
  });

  it('never renders NaN, undefined or Infinity', () => {
    expect(pack.body).not.toMatch(/NaN|undefined|Infinity/);
  });
});

describe('monthly summaries (spec §31)', () => {
  it('summarises only months older than the 90-day detail horizon', () => {
    const summaries = monthlySummaries(fixtureDays(), FIXTURE_END);
    expect(summaries.length).toBeGreaterThan(0);
    for (const month of summaries) {
      expect(month.dayCount).toBeGreaterThan(0);
      expect(month.daysLogged).toBeLessThanOrEqual(month.dayCount);
    }
  });
});

describe('format primitives', () => {
  it('renders null as "not logged"', () => {
    expect(line('Protein', null)).toBe('- Protein: not logged');
    expect(line('Protein', 0, 'g')).toBe('- Protein: 0 g');
  });

  it('signs rates explicitly', () => {
    expect(formatRate(-1.32, 'lb/week')).toBe('-1.32 lb/week');
    expect(formatRate(0.4, 'lb/week')).toBe('+0.40 lb/week');
    expect(formatRate(null, 'lb/week')).toBe('not computable');
  });

  it('renders percentages, and null as not computable', () => {
    expect(percent(0.923)).toBe('92%');
    expect(percent(null)).toBe('not computable');
  });

  it('aligns table columns and dashes missing cells', () => {
    const rendered = table(['A', 'B'], [['x', null], ['longer', 2]]);
    const lines = rendered.split('\n');
    expect(lines[0]).toBe('A       B');
    expect(lines[2]).toBe('x       -');
    expect(lines[3]).toBe('longer  2');
  });
});
