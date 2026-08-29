import { describe, it, expect } from 'vitest';
import { parseText, fieldValue, parsedDate, PARSER_VERSION } from '@/lib/health/parser';
import { idempotencyKey, normaliseForHashing } from '@/lib/health/idempotency';
import { kgToLb, cmToInches, kmToMiles } from '@/lib/normalization/units';

describe('paste parser (spec §8, §28)', () => {
  it("parses the spec's own example paste", () => {
    const result = parseText(
      [
        'Calories: 1,987',
        'Protein: 143g',
        'Carbs: 210g',
        'Fat: 61g',
        'Fiber: 28g',
        'Steps: 10,421',
        'Workout: Pull',
        'Duration: 58 min',
      ].join('\n'),
      2026,
    );

    expect(fieldValue(result, 'calories')).toBe(1987);
    expect(fieldValue(result, 'proteinG')).toBe(143);
    expect(fieldValue(result, 'carbsG')).toBe(210);
    expect(fieldValue(result, 'fatG')).toBe(61);
    expect(fieldValue(result, 'fiberG')).toBe(28);
    expect(fieldValue(result, 'steps')).toBe(10421);
    expect(fieldValue(result, 'workoutType')).toBe('Pull');
    expect(fieldValue(result, 'workoutMinutes')).toBe(58);
    expect(result.unrecognisedLines).toHaveLength(0);
  });

  it('keeps the source text for every field so the review screen can show it', () => {
    const result = parseText('Protein: 143g');
    expect(result.fields[0]!.rawText).toBe('Protein: 143g');
    expect(result.parserVersion).toBe(PARSER_VERSION);
  });

  it('converts pounds to canonical kilograms', () => {
    const result = parseText('Weight: 205.4 lb');
    expect(kgToLb(fieldValue(result, 'weightKg') as number)).toBeCloseTo(205.4, 6);
    expect(result.fields[0]!.sourceUnit).toBe('lb');
    expect(result.fields[0]!.confidence).toBe('HIGH');
  });

  it('takes kilograms as already canonical', () => {
    const result = parseText('Weight: 93.2 kg');
    expect(fieldValue(result, 'weightKg')).toBeCloseTo(93.2, 6);
  });

  it('flags an assumption when a weight carries no unit', () => {
    const result = parseText('Weight: 205');
    expect(result.fields[0]!.confidence).toBe('LOW');
    expect(result.fields[0]!.note).toMatch(/read as pounds/);
    // Still converted, so the value is usable - just marked for review.
    expect(kgToLb(fieldValue(result, 'weightKg') as number)).toBeCloseTo(205, 6);
  });

  it('reads waist in inches or centimetres', () => {
    expect(
      cmToInches(fieldValue(parseText('Waist: 34.5 in'), 'waistCm') as number),
    ).toBeCloseTo(34.5, 6);
    expect(fieldValue(parseText('Waist: 88 cm'), 'waistCm')).toBe(88);
    expect(parseText('Waist: 34.5').fields[0]!.confidence).toBe('LOW');
  });

  it('reads every duration format', () => {
    expect(fieldValue(parseText('Sleep: 7h 42m'), 'sleepMinutes')).toBe(462);
    expect(fieldValue(parseText('Sleep: 7.5 hours'), 'sleepMinutes')).toBe(450);
    expect(fieldValue(parseText('Sleep: 462 min'), 'sleepMinutes')).toBe(462);
    expect(fieldValue(parseText('Duration: 58 min'), 'workoutMinutes')).toBe(58);
    expect(fieldValue(parseText('Duration: 1h'), 'workoutMinutes')).toBe(60);
    expect(fieldValue(parseText('Duration: 1.5 hrs'), 'workoutMinutes')).toBe(90);
    // The fractional part must not be mistaken for the hour count.
    expect(fieldValue(parseText('Sleep: 6.25 hours'), 'sleepMinutes')).toBe(375);
  });

  it('reads distance in miles or kilometres', () => {
    expect(
      kmToMiles(fieldValue(parseText('Distance: 3.1 mi'), 'cardioDistanceKm') as number),
    ).toBeCloseTo(3.1, 6);
    expect(fieldValue(parseText('Distance: 5 km'), 'cardioDistanceKm')).toBe(5);
    expect(parseText('Distance: 5').fields[0]!.confidence).toBe('LOW');
  });

  it('prefers the longest matching label', () => {
    const result = parseText('Active Calories: 620\nCalories: 1950');
    expect(fieldValue(result, 'activeCalories')).toBe(620);
    expect(fieldValue(result, 'calories')).toBe(1950);
  });

  it('parses ISO and named dates', () => {
    expect(parsedDate(parseText('Date: 2026-08-28'))).toBe('2026-08-28');
    expect(parsedDate(parseText('Date: Aug 28, 2026'))).toBe('2026-08-28');
    expect(parsedDate(parseText('Date: Aug 28', 2026))).toBe('2026-08-28');
    // A bare date line with no label still registers.
    expect(parsedDate(parseText('2026-08-28'))).toBe('2026-08-28');
  });

  it('refuses to guess an ambiguous numeric date', () => {
    // 03/04/2026 is 3 April or 4 March depending on locale. Guessing here would
    // silently file a day's data under the wrong date.
    const result = parseText('Date: 03/04/2026');
    const field = result.fields.find((f) => f.key === 'date')!;
    expect(field.confidence).toBe('LOW');
    expect(field.note).toMatch(/ambiguous/);
    expect(parsedDate(result)).toBeNull();
  });

  it('reports unreadable lines rather than dropping them', () => {
    const result = parseText('Calories: 1950\nMood: great\nsomething entirely else');
    expect(fieldValue(result, 'calories')).toBe(1950);
    expect(result.unrecognisedLines).toContain('Mood: great');
    expect(result.unrecognisedLines).toContain('something entirely else');
  });

  it('reports a repeated field instead of silently overwriting it', () => {
    const result = parseText('Weight: 205 lb\nWeight: 210 lb');
    expect(kgToLb(fieldValue(result, 'weightKg') as number)).toBeCloseTo(205, 6);
    expect(result.unrecognisedLines.join(' ')).toMatch(/duplicate weightKg/);
  });

  it('tolerates bullets, tabs and multiple spaces as separators', () => {
    const tab = String.fromCharCode(9);
    const result = parseText(
      ['- Calories: 1950', `* Protein${tab}143g`, 'Steps   10421'].join('\n'),
    );
    expect(fieldValue(result, 'calories')).toBe(1950);
    expect(fieldValue(result, 'proteinG')).toBe(143);
    expect(fieldValue(result, 'steps')).toBe(10421);
  });

  it('returns nothing for empty input rather than inventing defaults', () => {
    const result = parseText('');
    expect(result.fields).toHaveLength(0);
    expect(result.unrecognisedLines).toHaveLength(0);
  });

  it('never emits a zero for a field that was absent', () => {
    const result = parseText('Calories: 1950');
    expect(fieldValue(result, 'proteinG')).toBeNull();
    expect(result.fields.map((f) => f.key)).not.toContain('proteinG');
  });
});

describe('import idempotency (spec §38)', () => {
  const report = [
    'Date: 2026-08-28',
    'Calories: 1,987',
    'Protein: 143g',
    'Steps: 10,421',
  ].join('\n');

  it('produces the same key for the same paste', () => {
    expect(idempotencyKey(report, '2026-08-28')).toBe(
      idempotencyKey(report, '2026-08-28'),
    );
  });

  it('ignores whitespace, case and blank-line differences', () => {
    const reformatted = [
      'date:  2026-08-28',
      '',
      '  Calories:   1,987',
      'Protein: 143G',
      'Steps: 10,421',
      '',
    ].join('\n');
    expect(idempotencyKey(reformatted, '2026-08-28')).toBe(
      idempotencyKey(report, '2026-08-28'),
    );
  });

  it('produces a different key when a value genuinely changed', () => {
    const edited = report.replace('1,987', '1,887');
    expect(idempotencyKey(edited, '2026-08-28')).not.toBe(
      idempotencyKey(report, '2026-08-28'),
    );
  });

  it('separates the same text filed under different dates', () => {
    expect(idempotencyKey(report, '2026-08-28')).not.toBe(
      idempotencyKey(report, '2026-08-29'),
    );
  });

  it('normalises predictably', () => {
    expect(normaliseForHashing('  A   B  \n\n c \n')).toBe('a b\nc');
  });
});
