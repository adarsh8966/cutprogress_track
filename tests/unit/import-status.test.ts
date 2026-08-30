/**
 * What the review screen promises about each value (spec §8, §16, §38).
 *
 * THE RULE. "Never let the user believe something will be saved when it will
 * actually be discarded" - and its other half, never let a number look like it
 * changes a day it will leave alone. These are the verdicts that make either
 * claim, so they are tested as claims.
 */
import { describe, it, expect } from 'vitest';
import {
  dayFieldVerdict, sessionVerdict, blocksImport, sameValue,
  CANONICAL_FIELD, UNKNOWN_DAY, type ExistingDay,
} from '@/lib/health/importStatus';
import { DAY_FIELD_ORDER, summariseImport } from '@/lib/health/importPayload';

function day(
  values: Record<string, number | null>,
  sources: Record<string, string> = {},
): ExistingDay {
  return { values, sources: sources as never, known: true };
}

const EMPTY = day({});

describe('the parser field names map onto the canonical ones', () => {
  it('covers every day field the review can show', () => {
    for (const key of DAY_FIELD_ORDER) {
      expect(CANONICAL_FIELD[key], `${key} has no canonical field`).toBeTruthy();
    }
  });

  it('uses the resolver\'s names where they differ from the parser\'s', () => {
    // These three are the ones that differ. Getting one wrong makes the field
    // permanently read as NEW, promising the user they are adding data when
    // they are replacing it.
    expect(CANONICAL_FIELD.calories).toBe('caloriesConsumed');
    expect(CANONICAL_FIELD.sleepMinutes).toBe('sleepDurationMinutes');
    expect(CANONICAL_FIELD.waistCm).toBe('waistCm');
  });
});

describe('dayFieldVerdict', () => {
  it('calls a value NEW when the day holds nothing for it', () => {
    const verdict = dayFieldVerdict('calories', 2001, EMPTY);
    expect(verdict.status).toBe('NEW');
    expect(verdict.existing).toBeNull();
  });

  it('calls it UPDATED when the same source already recorded a different value', () => {
    const verdict = dayFieldVerdict(
      'calories', 2001, day({ caloriesConsumed: 1950 }, { caloriesConsumed: 'IMPORT_TEXT' }),
    );
    expect(verdict.status).toBe('UPDATED');
    // The screen shows the existing value, so the change is visible before it
    // happens rather than inferable afterwards.
    expect(verdict.existing).toBe(1950);
  });

  it('calls it DUPLICATE when the day already resolves to the same value', () => {
    const verdict = dayFieldVerdict(
      'calories', 2001, day({ caloriesConsumed: 2001 }, { caloriesConsumed: 'IMPORT_TEXT' }),
    );
    expect(verdict.status).toBe('DUPLICATE');
    // Honest about what still happens: the observation is written, the day is
    // unchanged. Saying "nothing will be saved" would be the opposite lie.
    expect(verdict.reason).toMatch(/still written/i);
  });

  /**
   * The distinction the resolver itself draws. One source correcting its own
   * earlier reading is a correction; two sources disagreeing is a conflict,
   * and only the second is worth stopping over.
   */
  it('calls it CONFLICT when a different source already recorded a different value', () => {
    const verdict = dayFieldVerdict(
      'weightKg', 93.2, day({ weightKg: 92.4 }, { weightKg: 'MANUAL' }),
    );
    expect(verdict.status).toBe('CONFLICT');
    expect(verdict.existingSource).toBe('MANUAL');
    // And it says what will happen anyway, which is that the import wins.
    expect(verdict.reason).toMatch(/newer observation wins/i);
    expect(verdict.reason).toMatch(/neither reading is deleted/i);
  });

  it('treats a value within the resolver\'s tolerance as the same value', () => {
    // The same tolerance canonical.ts uses to decide whether sources agree, so
    // the review and the resolver cannot call one reading two different things.
    expect(sameValue(92.4, 92.42)).toBe(true);
    const verdict = dayFieldVerdict(
      'weightKg', 92.42, day({ weightKg: 92.4 }, { weightKg: 'MANUAL' }),
    );
    expect(verdict.status).toBe('DUPLICATE');
  });

  it('calls a blank field IGNORED and says the existing value survives', () => {
    const verdict = dayFieldVerdict(
      'calories', null, day({ caloriesConsumed: 1950 }, { caloriesConsumed: 'MANUAL' }),
    );
    expect(verdict.status).toBe('IGNORED');
    expect(verdict.reason).toMatch(/unchanged/i);
  });

  it('calls a blank field on an empty day IGNORED without implying loss', () => {
    const verdict = dayFieldVerdict('calories', null, EMPTY);
    expect(verdict.status).toBe('IGNORED');
    expect(verdict.reason).toMatch(/nothing will be written/i);
  });

  /**
   * The one that must never be silent. An out-of-range value is refused by the
   * database, so the screen has to say it will not be saved BEFORE the confirm.
   */
  it('calls an out-of-range value INVALID and says the day cannot be imported', () => {
    const verdict = dayFieldVerdict('restingHeartRate', 280, EMPTY);
    expect(verdict.status).toBe('INVALID');
    expect(verdict.reason).toMatch(/outside the recordable range/i);
    expect(verdict.reason).toMatch(/cannot be imported/i);
    expect(blocksImport(verdict.status)).toBe(true);
  });

  it('calls an impossible weight INVALID', () => {
    expect(dayFieldVerdict('weightKg', 5, EMPTY).status).toBe('INVALID');
    expect(dayFieldVerdict('weightKg', 4000, EMPTY).status).toBe('INVALID');
  });

  it('lets a plausible value through', () => {
    expect(dayFieldVerdict('restingHeartRate', 57, EMPTY).status).toBe('NEW');
    expect(dayFieldVerdict('weightKg', 92.4, EMPTY).status).toBe('NEW');
  });

  /**
   * A failed lookup must read as "unknown", never as "this day is empty" -
   * which would show every field as NEW and promise the user they were adding
   * rather than replacing.
   */
  it('says the effect is unknown when the day could not be read', () => {
    const verdict = dayFieldVerdict('calories', 2001, UNKNOWN_DAY);
    expect(verdict.status).toBe('NEW');
    expect(verdict.reason).toMatch(/could not be read/i);
    expect(verdict.reason).toMatch(/recorded either way/i);
  });

  it('still calls an invalid value invalid when the day is unknown', () => {
    // Range is a property of the value, not of the day. This must not be
    // downgraded to "unknown" and let through.
    expect(dayFieldVerdict('restingHeartRate', 280, UNKNOWN_DAY).status).toBe('INVALID');
  });

  it('only INVALID blocks the import', () => {
    for (const status of ['NEW', 'UPDATED', 'DUPLICATE', 'CONFLICT', 'IGNORED', 'REPLACE'] as const) {
      expect(blocksImport(status)).toBe(false);
    }
  });
});

describe('sessionVerdict', () => {
  const pull = { id: 'w1', kind: 'WORKOUT' as const, label: 'PULL', durationMinutes: 58 };

  function verdict(overrides: Partial<Parameters<typeof sessionVerdict>[0]> = {}) {
    return sessionVerdict({
      kind: 'WORKOUT', type: 'PULL', minutes: 65,
      disposition: 'ADD', supersedes: null, removed: false,
      existing: [], known: true,
      ...overrides,
    });
  }

  it('calls a session on an empty day NEW', () => {
    expect(verdict().status).toBe('NEW');
  });

  it('says an added session joins the ones already there', () => {
    const result = verdict({ existing: [pull] });
    expect(result.status).toBe('NEW');
    expect(result.reason).toMatch(/alongside the 1 workout/i);
  });

  /**
   * daily_metrics SUMS a day's sessions, so a second copy is not a harmless
   * duplicate observation - it permanently doubles the day's minutes. That is
   * why an identical ADD is DUPLICATE rather than NEW.
   */
  it('calls an identical added session DUPLICATE and names what it matches', () => {
    const result = verdict({
      minutes: 58,
      existing: [pull],
    });
    expect(result.status).toBe('DUPLICATE');
    expect(result.match?.id).toBe('w1');
    expect(result.reason).toMatch(/pull session of 58 min/i);
    expect(result.reason).toMatch(/gives the day both/i);
  });

  it('does not call a different duration a duplicate', () => {
    expect(verdict({ minutes: 65, existing: [pull] }).status).toBe('NEW');
  });

  it('does not match a session of another type', () => {
    const push = { ...pull, id: 'w2', label: 'PUSH' };
    expect(verdict({ minutes: 58, existing: [push] }).status).toBe('NEW');
  });

  it('does not match across kinds', () => {
    const cardio = { id: 'c1', kind: 'CARDIO' as const, label: 'PULL', durationMinutes: 58 };
    expect(verdict({ minutes: 58, existing: [cardio] }).status).toBe('NEW');
  });

  it('calls a REPLACE a replacement and names the row it supersedes', () => {
    const result = verdict({
      disposition: 'REPLACE', supersedes: 'w1', existing: [pull],
    });
    expect(result.status).toBe('REPLACE');
    expect(result.reason).toMatch(/stops the existing pull session of 58 min counting/i);
    expect(result.reason).toMatch(/neither row is deleted/i);
  });

  it('says so when a REPLACE has not been told what it replaces', () => {
    const result = verdict({ disposition: 'REPLACE', supersedes: null, existing: [pull] });
    expect(result.status).toBe('REPLACE');
    expect(result.reason).toMatch(/is not set/i);
  });

  it('calls KEEP and a removed session IGNORED, saying nothing is written', () => {
    expect(verdict({ disposition: 'KEEP', existing: [pull] }).status).toBe('IGNORED');
    expect(verdict({ removed: true }).status).toBe('IGNORED');
    expect(verdict({ removed: true }).reason).toMatch(/nothing will be written/i);
  });

  it('calls a cardio session with no duration INVALID', () => {
    const result = verdict({
      kind: 'CARDIO', type: 'RUNNING', minutes: null,
      invalidReason: 'A cardio session needs a duration before it can be saved.',
    });
    expect(result.status).toBe('INVALID');
    expect(blocksImport(result.status)).toBe(true);
  });

  it('reports unknown rather than NEW when the day could not be read', () => {
    const result = verdict({ known: false });
    expect(result.reason).toMatch(/could not be read/i);
  });

  it('checks removal before validity, so a removed bad session does not block', () => {
    const result = verdict({ removed: true, invalidReason: 'bad' });
    expect(result.status).toBe('IGNORED');
    expect(blocksImport(result.status)).toBe(false);
  });
});

describe('summariseImport', () => {
  it('groups written rows by where they can be seen', () => {
    const summary = summariseImport([
      {
        status: 'IMPORTED',
        wrote: [
          { table: 'body_measurements', rows: 1 },
          { table: 'metric_observations', rows: 4 },
        ],
      },
      {
        status: 'IMPORTED',
        wrote: [
          { table: 'body_measurements', rows: 1 },
          { table: 'workout_sessions', rows: 1 },
        ],
      },
    ]);

    expect(summary.imported).toBe(2);
    expect(summary.totalRows).toBe(7);
    expect(summary.groups.find((g) => g.group === 'Body')!.rows).toBe(2);
    expect(summary.groups.find((g) => g.group === 'Activity and vitals')!.rows).toBe(4);
    expect(summary.groups.find((g) => g.group === 'Training')!.where).toBe('Training');
  });

  it('counts the outcomes that wrote nothing, separately from each other', () => {
    const summary = summariseImport([
      { status: 'DUPLICATE', wrote: [] },
      { status: 'SKIPPED', wrote: [] },
      { status: 'FAILED', wrote: [] },
      { status: 'IMPORTED', wrote: [] },
    ]);

    expect(summary.duplicates).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.failed).toBe(1);
    // An IMPORTED day that wrote nothing is its own thing - a resumed attempt
    // that found everything already in place - and is not a failure.
    expect(summary.noChange).toBe(1);
    expect(summary.groups).toEqual([]);
  });

  it('reports a table it has no destination for rather than dropping it', () => {
    const summary = summariseImport([
      { status: 'IMPORTED', wrote: [{ table: 'future_table', rows: 3 }] },
    ]);
    expect(summary.totalRows).toBe(3);
    expect(summary.groups[0]!.group).toBe('future table');
    expect(summary.groups[0]!.where).toMatch(/not mapped/i);
  });
});
