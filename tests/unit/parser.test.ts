import { describe, it, expect } from 'vitest';
import {
  parseText, fieldValue, sessionValue, parsedDate, parsedDates, PARSER_VERSION,
} from '@/lib/health/parser';
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

    // The workout is a session now, which is what actually reaches the
    // database. It used to parse into a flat field that was silently dropped.
    const session = result.records[0]!.sessions[0]!;
    expect(session.kind).toBe('WORKOUT');
    expect(session.rawLabel).toBe('Pull');
    expect(sessionValue(session, 'sessionMinutes')).toBe(58);

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

  it('flags a duration with no unit rather than assuming minutes silently', () => {
    // "Sleep: 7.5" almost certainly means hours. Reading it as 7.5 minutes and
    // saying nothing is the same class of mistake a unitless weight would be.
    const field = parseText('Sleep: 7.5').fields[0]!;
    expect(field.value).toBe(7.5);
    expect(field.confidence).toBe('LOW');
    expect(field.note).toMatch(/read as minutes/);
  });

  it('reads every duration format', () => {
    expect(fieldValue(parseText('Sleep: 7h 42m'), 'sleepMinutes')).toBe(462);
    expect(fieldValue(parseText('Sleep: 7.5 hours'), 'sleepMinutes')).toBe(450);
    expect(fieldValue(parseText('Sleep: 462 min'), 'sleepMinutes')).toBe(462);
    // The fractional part must not be mistaken for the hour count.
    expect(fieldValue(parseText('Sleep: 6.25 hours'), 'sleepMinutes')).toBe(375);

    const workout = (text: string) =>
      sessionValue(parseText(`Workout: Pull\n${text}`).records[0]!.sessions[0]!, 'sessionMinutes');
    expect(workout('Duration: 58 min')).toBe(58);
    expect(workout('Duration: 1h')).toBe(60);
    expect(workout('Duration: 1.5 hrs')).toBe(90);
  });

  it('reads "7 hours 30 minutes" as 450, not 420', () => {
    // Regex alternation is leftmost-first, so an "h|hours" ordering matched the
    // "h" of "hours" and never bound the minutes group.
    expect(fieldValue(parseText('Sleep: 7 hours 30 minutes'), 'sleepMinutes')).toBe(450);
    expect(fieldValue(parseText('Sleep: 7 hrs 30 mins'), 'sleepMinutes')).toBe(450);
    expect(fieldValue(parseText('Sleep: 7 h 30 m'), 'sleepMinutes')).toBe(450);
  });

  it('reads distance in miles or kilometres inside a cardio block', () => {
    const cardio = (text: string) =>
      parseText(`Cardio: Running\n${text}`).records[0]!.sessions[0]!;
    expect(
      kmToMiles(sessionValue(cardio('Distance: 3.1 mi'), 'distanceKm') as number),
    ).toBeCloseTo(3.1, 6);
    expect(sessionValue(cardio('Distance: 5 km'), 'distanceKm')).toBe(5);
    expect(
      cardio('Distance: 5').fields.find((f) => f.key === 'distanceKm')!.confidence,
    ).toBe('LOW');
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
    const field = result.records[0]!.date!;
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
    expect(result.records).toHaveLength(0);
    expect(result.fields).toHaveLength(0);
    expect(result.unrecognisedLines).toHaveLength(0);
  });

  it('never emits a zero for a field that was absent', () => {
    const result = parseText('Calories: 1950');
    expect(fieldValue(result, 'proteinG')).toBeNull();
    expect(result.fields.map((f) => f.key)).not.toContain('proteinG');
  });
});

describe('label and unit variations (spec §39)', () => {
  it('accepts every spelling of pounds and kilograms', () => {
    for (const text of ['203.7 lb', '203.7 lbs', '203.7 LB', '203.7 Lbs', '203.7 pounds']) {
      expect(kgToLb(fieldValue(parseText(`Weight: ${text}`), 'weightKg') as number))
        .toBeCloseTo(203.7, 6);
    }
    for (const text of ['92.4 kg', '92.4 KG', '92.4 kgs', '92.4 kilograms']) {
      expect(fieldValue(parseText(`Weight: ${text}`), 'weightKg')).toBeCloseTo(92.4, 6);
    }
  });

  it('accepts carbohydrate and fibre spellings', () => {
    expect(fieldValue(parseText('Carbs: 198g'), 'carbsG')).toBe(198);
    expect(fieldValue(parseText('Carbohydrates: 198g'), 'carbsG')).toBe(198);
    expect(fieldValue(parseText('Carbohydrate: 198g'), 'carbsG')).toBe(198);
    expect(fieldValue(parseText('Fiber: 29g'), 'fiberG')).toBe(29);
    expect(fieldValue(parseText('Fibre: 29g'), 'fiberG')).toBe(29);
    expect(fieldValue(parseText('Dietary fibre: 29 g'), 'fiberG')).toBe(29);
  });

  it('accepts every resting heart-rate alias', () => {
    for (const label of ['Resting HR', 'Resting heart rate', 'RHR', 'resting hr']) {
      expect(fieldValue(parseText(`${label}: 58 bpm`), 'restingHeartRate')).toBe(58);
    }
  });

  it('accepts every average and maximum heart-rate alias', () => {
    const avg = (label: string) => sessionValue(
      parseText(`Workout: Push\n${label}: 142 bpm`).records[0]!.sessions[0]!,
      'averageHeartRate',
    );
    for (const label of ['Avg HR', 'Average HR', 'Average heart rate', 'Avg heart rate', 'Avg. HR']) {
      expect(avg(label)).toBe(142);
    }
    const max = (label: string) => sessionValue(
      parseText(`Workout: Push\n${label}: 174 bpm`).records[0]!.sessions[0]!,
      'maxHeartRate',
    );
    for (const label of ['Max HR', 'Maximum HR', 'Maximum heart rate', 'Peak HR']) {
      expect(max(label)).toBe(174);
    }
  });

  it('reads a unit written into the label', () => {
    expect(kgToLb(fieldValue(parseText('Weight (lb): 203.7'), 'weightKg') as number))
      .toBeCloseTo(203.7, 6);
    expect(fieldValue(parseText('Weight (kg): 92.4'), 'weightKg')).toBeCloseTo(92.4, 6);
  });

  it('does not treat an arbitrary parenthetical as a unit', () => {
    // "(morning)" is not a unit, so the label is left alone and simply does not
    // match - which is reported, not guessed at.
    const result = parseText('Weight (morning): 203.7');
    expect(fieldValue(result, 'weightKg')).toBeNull();
    expect(result.unrecognisedLines).toContain('Weight (morning): 203.7');
  });

  it('splits at the colon even when the label contains a double space', () => {
    expect(fieldValue(parseText('Resting  HR: 58'), 'restingHeartRate')).toBe(58);
  });

  it('splits a column-aligned line whose value contains a colon', () => {
    // Two possible split points, nearest first, and the one yielding a label
    // this parser knows wins - so "Resting  HR: 58" splits at the colon while
    // "Workout      Push: heavy" splits at the spaces.
    const result = parseText('Workout      Push: heavy\nDuration: 45 min');
    const session = result.records[0]!.sessions[0]!;
    expect(session.rawLabel).toBe('Push: heavy');
    expect(sessionValue(session, 'sessionMinutes')).toBe(45);
    expect(result.unrecognisedLines).toHaveLength(0);
  });

  it('rejects a unit the field is not measured in', () => {
    const result = parseText('Steps: 5 km');
    const field = result.fields[0]!;
    expect(field.confidence).toBe('LOW');
    expect(field.note).toMatch(/not one this field is measured in/);
  });
});

describe('formatting tolerance', () => {
  it('is case-insensitive on labels', () => {
    for (const label of ['CALORIES', 'calories', 'CaLoRiEs']) {
      expect(fieldValue(parseText(`${label}: 2001`), 'calories')).toBe(2001);
    }
  });

  it('tolerates ragged whitespace around the separator', () => {
    expect(fieldValue(parseText('   Protein   :   172 g   '), 'proteinG')).toBe(172);
    expect(fieldValue(parseText('Protein:172g'), 'proteinG')).toBe(172);
  });

  it('reads commas in numbers and decimals without them', () => {
    expect(fieldValue(parseText('Steps: 15,000'), 'steps')).toBe(15000);
    expect(fieldValue(parseText('Steps: 15000'), 'steps')).toBe(15000);
    expect(fieldValue(parseText('Calories: 2,001'), 'calories')).toBe(2001);
    expect(fieldValue(parseText('Waist: 35.4 in'), 'waistCm')).toBeCloseTo(89.916, 6);
  });

  it('reads an equals sign as a separator', () => {
    expect(fieldValue(parseText('Protein = 172g'), 'proteinG')).toBe(172);
  });
});

describe('edge cases', () => {
  it('keeps a measured zero, which is not the same as missing', () => {
    const result = parseText('Steps: 0\nCalories: 0');
    expect(fieldValue(result, 'steps')).toBe(0);
    expect(fieldValue(result, 'calories')).toBe(0);
    expect(result.fields[0]!.confidence).toBe('HIGH');
  });

  it('flags a negative value rather than accepting it', () => {
    const result = parseText('Steps: -500');
    expect(result.fields[0]!.confidence).toBe('LOW');
    expect(result.fields[0]!.note).toMatch(/outside the recordable range/);
  });

  it('flags an implausibly large value the database would refuse', () => {
    const result = parseText('Weight: 9999 lb');
    expect(result.fields[0]!.confidence).toBe('LOW');
    expect(result.fields[0]!.note).toMatch(/outside the recordable range/);
  });

  it('accepts a very small decimal', () => {
    expect(fieldValue(parseText('Protein: 0.0001g'), 'proteinG')).toBe(0.0001);
  });

  it('refuses exponent and hex notation instead of misreading it', () => {
    for (const value of ['1e3', '0x10', 'Infinity', 'NaN']) {
      const result = parseText(`Calories: ${value}`);
      expect(fieldValue(result, 'calories')).toBeNull();
      expect(result.unrecognisedLines.join(' ')).toContain('could not read a value');
    }
  });

  it('refuses a value it only half understands', () => {
    const result = parseText('Calories: about 2000');
    expect(fieldValue(result, 'calories')).toBeNull();
    expect(result.unrecognisedLines.join(' ')).toContain('could not read a value');
  });

  it('reports text where a number belongs', () => {
    const result = parseText('Protein: lots');
    expect(fieldValue(result, 'proteinG')).toBeNull();
    expect(result.unrecognisedLines.join(' ')).toContain('could not read a value');
  });

  it('reports an unknown field without disturbing its neighbours', () => {
    const result = parseText('Calories: 1950\nMood: great\nProtein: 143g');
    expect(fieldValue(result, 'calories')).toBe(1950);
    expect(fieldValue(result, 'proteinG')).toBe(143);
    expect(result.unrecognisedLines).toEqual(['Mood: great']);
  });

  it('reports a label with no value', () => {
    const result = parseText('Weight:');
    expect(result.unrecognisedLines).toContain('Weight:');
  });

  it('reports a conflicting repeat and keeps the first', () => {
    const result = parseText('Calories: 1950\nCalories: 2400');
    expect(fieldValue(result, 'calories')).toBe(1950);
    expect(result.unrecognisedLines.join(' ')).toMatch(/duplicate calories/);
  });

  it('reports pace and speed as understood but unstorable', () => {
    const record = parseText('Cardio: Running\nDuration: 30 min\nPace: 9:12 /mi').records[0]!;
    expect(record.sessions[0]!.notStored).toHaveLength(1);
    expect(record.sessions[0]!.notStored[0]!.reason).toMatch(/not stored separately/);
    expect(record.unrecognisedLines).toHaveLength(0);
  });

  it('refuses a session field with no open session block', () => {
    const result = parseText('Date: 2026-09-01\nSteps: 12000\nDuration: 45 min');
    expect(result.records[0]!.sessions).toHaveLength(0);
    expect(result.unrecognisedLines.join(' ')).toMatch(/no open Workout: or Cardio: block/);
  });
});

describe('dates', () => {
  it('reads every supported date form', () => {
    expect(parsedDate(parseText('Date: 2026-09-01'))).toBe('2026-09-01');
    expect(parsedDate(parseText('Date: September 1, 2026'))).toBe('2026-09-01');
    expect(parsedDate(parseText('Date: Sep 1 2026'))).toBe('2026-09-01');
    expect(parsedDate(parseText('Date: 1 Sep 2026'))).toBe('2026-09-01');
  });

  it('does not open a new day on a prose line that mentions a date', () => {
    // An unlabelled line is only a guess, so the whole line has to be the date.
    const result = parseText([
      'Date: 2026-08-25',
      'Steps: 1000',
      'Synced from Health Connect on 2026-08-28',
      'Protein: 143g',
    ].join('\n'));

    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.localDate).toBe('2026-08-25');
    expect(fieldValue(result, 'proteinG')).toBe(143);
    expect(result.unrecognisedLines).toContain('Synced from Health Connect on 2026-08-28');
  });

  it('still opens a day on a bare date wearing a weekday', () => {
    for (const line of ['Fri 2026-08-28', '2026-08-28 (Friday)', 'Friday, 2026-08-28']) {
      expect(parsedDate(parseText(line)), line).toBe('2026-08-28');
    }
  });

  it('still reads a labelled date that carries extra words', () => {
    expect(parsedDate(parseText('Date: 2026-08-28 (Friday)'))).toBe('2026-08-28');
  });

  it('does not treat "Day:" as a date boundary', () => {
    // "Day: 3" is a programme week, not a calendar date. Splitting there would
    // separate a workout from its own duration and orphan both.
    const result = parseText([
      'Date: 2026-08-28',
      'Workout: Push',
      'Day: 3',
      'Duration: 50 min',
      'Weight: 205 lb',
    ].join('\n'));

    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.localDate).toBe('2026-08-28');
    expect(sessionValue(result.records[0]!.sessions[0]!, 'sessionMinutes')).toBe(50);
    expect(fieldValue(result, 'weightKg')).not.toBeNull();
    expect(result.unrecognisedLines).toContain('Day: 3');
  });

  it('does not read a line of prose as a date', () => {
    // "May 5 min row" is a rowing set. Reading it as 5 May opens a day nobody
    // wrote and files everything below it under a date that never existed.
    for (const line of ['May 5 min row', 'Oct 5 sets', 'Mar 3 x 10']) {
      const result = parseText(line, 2026);
      expect(result.records[0]?.localDate ?? null, line).toBeNull();
    }
  });

  it('does not read the year of "1 Sep 2026" as the day', () => {
    // A month-first pattern matches "Sep 2026" here and takes "20" as the day,
    // filing the record three weeks late. Day-first is checked first.
    expect(parsedDate(parseText('Date: 1 Sep 2026'))).toBe('2026-09-01');
    expect(parsedDate(parseText('Date: 1st September 2026'))).toBe('2026-09-01');
    expect(parsedDate(parseText('Date: 28 Aug 2026'))).toBe('2026-08-28');
    // A month and a year with no day is not a date this can use.
    expect(parsedDate(parseText('Date: Sep 2026'))).toBeNull();
  });

  it('flags a named date with no year', () => {
    const field = parseText('Date: Sep 1', 2026).records[0]!.date!;
    expect(field.confidence).toBe('MODERATE');
    expect(field.note).toMatch(/No year given/);
  });

  it('keeps records in the order they were written, even out of date order', () => {
    const result = parseText(
      ['Date: 2026-09-03', 'Steps: 3', 'Date: 2026-09-01', 'Steps: 1'].join('\n'),
    );
    expect(parsedDates(result)).toEqual(['2026-09-03', '2026-09-01']);
  });

  it('treats a repeated date as a second record, not a duplicate field', () => {
    const result = parseText(
      ['Date: 2026-09-01', 'Steps: 100', 'Date: 2026-09-01', 'Steps: 200'].join('\n'),
    );
    expect(result.records).toHaveLength(2);
    expect(fieldValue(result, 'steps')).toBe(100);
    expect(result.records[1]!.fields[0]!.value).toBe(200);
  });

  it('does not stamp a value written above the first date with that date', () => {
    // The pre-date weight used to be filed under the day BELOW it, and that
    // day's own weight was then discarded as a duplicate.
    const result = parseText(
      ['Weight: 203.7 lb', 'Date: 2026-09-01', 'Weight: 203.1 lb'].join('\n'),
    );
    expect(result.records).toHaveLength(2);
    expect(result.records[0]!.localDate).toBeNull();
    expect(kgToLb(result.records[0]!.fields[0]!.value as number)).toBeCloseTo(203.7, 6);
    expect(result.records[1]!.localDate).toBe('2026-09-01');
    expect(kgToLb(result.records[1]!.fields[0]!.value as number)).toBeCloseTo(203.1, 6);
    expect(result.unrecognisedLines).toHaveLength(0);
  });

  it('closes a record on a Date line even when the date cannot be read', () => {
    // The line is unmistakably a boundary. Treating an unreadable one as noise
    // stamped the day below it with the day above.
    const result = parseText([
      'Date: 2026-09-01', 'Steps: 1000',
      'Date: yesterday', 'Steps: 2000',
    ].join('\n'));

    expect(result.records).toHaveLength(2);
    expect(result.records[0]!.localDate).toBe('2026-09-01');
    expect(result.records[0]!.fields[0]!.value).toBe(1000);
    expect(result.records[1]!.localDate).toBeNull();
    expect(result.records[1]!.fields[0]!.value).toBe(2000);
    expect(result.records[1]!.unrecognisedLines.join(' ')).toMatch(/could not read a date/);
  });

  it('keeps a leading header line inside the first record', () => {
    // This is what makes a single-day paste hash to the same idempotency key it
    // always did, header and all.
    const result = parseText('Bevel weekly export\nDate: 2026-09-01\nSteps: 100');
    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.rawText).toContain('Bevel weekly export');
  });
});

describe('multiple records', () => {
  const twoDays = [
    'Date: 2026-09-01',
    'Weight: 203.7 lb',
    'Waist: 35.4 in',
    'Calories: 2,001',
    'Protein: 172g',
    'Carbs: 198g',
    'Fat: 67g',
    'Fiber: 29g',
    'Steps: 15,000',
    'Sleep: 7h 30m',
    'Workout: Push',
    'Duration: 55 min',
    '',
    'Date: 2026-09-02',
    'Weight: 203.1 lb',
    'Calories: 1,950',
    'Protein: 180g',
    'Steps: 11,250',
    'Workout: Pull',
    'Duration: 61 min',
  ].join('\n');

  it('parses a two-day paste as two records', () => {
    const result = parseText(twoDays);
    expect(result.records).toHaveLength(2);
    expect(parsedDates(result)).toEqual(['2026-09-01', '2026-09-02']);
    expect(result.unrecognisedLines).toHaveLength(0);
  });

  it('keeps each day’s values with its own day', () => {
    const [first, second] = parseText(twoDays).records;
    expect(kgToLb(first!.fields.find((f) => f.key === 'weightKg')!.value as number))
      .toBeCloseTo(203.7, 6);
    expect(kgToLb(second!.fields.find((f) => f.key === 'weightKg')!.value as number))
      .toBeCloseTo(203.1, 6);
    expect(first!.fields.find((f) => f.key === 'calories')!.value).toBe(2001);
    expect(second!.fields.find((f) => f.key === 'calories')!.value).toBe(1950);
    // Day two logged no waist. That must stay absent, not inherit day one's.
    expect(second!.fields.find((f) => f.key === 'waistCm')).toBeUndefined();
  });

  it('gives each day its own session', () => {
    const [first, second] = parseText(twoDays).records;
    expect(first!.sessions).toHaveLength(1);
    expect(first!.sessions[0]!.rawLabel).toBe('Push');
    expect(sessionValue(first!.sessions[0]!, 'sessionMinutes')).toBe(55);
    expect(second!.sessions[0]!.rawLabel).toBe('Pull');
    expect(sessionValue(second!.sessions[0]!, 'sessionMinutes')).toBe(61);
  });

  it('parses seven days', () => {
    const week = Array.from({ length: 7 }, (_, i) =>
      [`Date: 2026-09-0${i + 1}`, `Steps: ${1000 * (i + 1)}`].join('\n'),
    ).join('\n\n');
    const result = parseText(week);
    expect(result.records).toHaveLength(7);
    expect(result.records.map((r) => r.fields[0]!.value)).toEqual(
      [1000, 2000, 3000, 4000, 5000, 6000, 7000],
    );
  });

  it('gives each record its own raw text for hashing', () => {
    const [first, second] = parseText(twoDays).records;
    expect(first!.rawText).toContain('2026-09-01');
    expect(first!.rawText).not.toContain('2026-09-02');
    expect(second!.rawText).toContain('2026-09-02');
    expect(idempotencyKey(first!.rawText, '2026-09-01'))
      .not.toBe(idempotencyKey(second!.rawText, '2026-09-02'));
  });
});

describe('session blocks', () => {
  it('attaches following lines to the session above them', () => {
    const record = parseText([
      'Workout: Push',
      'Duration: 55 min',
      'Avg HR: 128 bpm',
      'Max HR: 161 bpm',
      'Calories burned: 430',
    ].join('\n')).records[0]!;

    const session = record.sessions[0]!;
    expect(session.kind).toBe('WORKOUT');
    expect(sessionValue(session, 'sessionMinutes')).toBe(55);
    expect(sessionValue(session, 'averageHeartRate')).toBe(128);
    expect(sessionValue(session, 'maxHeartRate')).toBe(161);
    expect(sessionValue(session, 'sessionCalories')).toBe(430);
  });

  it('supports two workouts on one day', () => {
    const record = parseText([
      'Date: 2026-09-01',
      'Workout: Push',
      'Duration: 45 min',
      'Workout: Legs',
      'Duration: 50 min',
    ].join('\n')).records[0]!;

    expect(record.sessions).toHaveLength(2);
    expect(sessionValue(record.sessions[0]!, 'sessionMinutes')).toBe(45);
    expect(sessionValue(record.sessions[1]!, 'sessionMinutes')).toBe(50);
    expect(record.sessions[1]!.rawLabel).toBe('Legs');
  });

  it('supports a workout and cardio on the same day', () => {
    const record = parseText([
      'Date: 2026-09-01',
      'Workout: Pull',
      'Duration: 58 min',
      'Avg HR: 121 bpm',
      'Cardio: Incline walk',
      'Duration: 30 min',
      'Distance: 2.1 mi',
      'Zone: 2',
    ].join('\n')).records[0]!;

    expect(record.sessions.map((s) => s.kind)).toEqual(['WORKOUT', 'CARDIO']);
    // The avg HR belongs to the workout, not to the cardio that follows it.
    expect(sessionValue(record.sessions[0]!, 'averageHeartRate')).toBe(121);
    expect(sessionValue(record.sessions[1]!, 'averageHeartRate')).toBeNull();
    expect(sessionValue(record.sessions[1]!, 'hrZone')).toBe(2);
    expect(kmToMiles(sessionValue(record.sessions[1]!, 'distanceKm') as number))
      .toBeCloseTo(2.1, 6);
  });

  it('supports several cardio sessions on one day', () => {
    const record = parseText([
      'Date: 2026-09-01',
      'Cardio: Walk',
      'Duration: 25 min',
      'Cardio: Cycling',
      'Duration: 40 min',
      'Distance: 18 km',
    ].join('\n')).records[0]!;

    expect(record.sessions).toHaveLength(2);
    expect(sessionValue(record.sessions[0]!, 'sessionMinutes')).toBe(25);
    expect(sessionValue(record.sessions[1]!, 'distanceKm')).toBe(18);
  });

  it('reads a duration written on the opening line', () => {
    const session = parseText('Cardio: 30 min').records[0]!.sessions[0]!;
    expect(sessionValue(session, 'sessionMinutes')).toBe(30);
    expect(session.kind).toBe('CARDIO');
  });

  it('reads a zone written on the opening line without mistaking it for minutes', () => {
    const session = parseText('Cardio: Zone 2 bike').records[0]!.sessions[0]!;
    expect(sessionValue(session, 'hrZone')).toBe(2);
    expect(sessionValue(session, 'sessionMinutes')).toBeNull();
  });

  it('keeps day-level calories out of a session, and says the reading is a guess', () => {
    // "Calories" is intake. Reading it as burn would invent a figure, so the
    // safe reading is kept - but inside a workout block it is genuinely
    // ambiguous, and the review screen is told so rather than the user finding
    // out from a wrong TDEE six weeks later.
    const record = parseText([
      'Workout: Push',
      'Duration: 45 min',
      'Calories: 2100',
    ].join('\n')).records[0]!;

    const calories = record.fields.find((f) => f.key === 'calories')!;
    expect(calories.value).toBe(2100);
    expect(calories.confidence).toBe('MODERATE');
    expect(calories.note).toMatch(/Calories burned/);
    expect(sessionValue(record.sessions[0]!, 'sessionCalories')).toBeNull();
  });

  it('leaves calories written outside a session unflagged', () => {
    const calories = parseText('Calories: 2100\nWorkout: Push\nDuration: 45 min')
      .records[0]!.fields.find((f) => f.key === 'calories')!;
    expect(calories.confidence).toBe('HIGH');
    expect(calories.note).toBeUndefined();
  });

  it('reads an explicit burn label as the session’s own calories', () => {
    const record = parseText('Workout: Push\nDuration: 45 min\nCalories burned: 430')
      .records[0]!;
    expect(sessionValue(record.sessions[0]!, 'sessionCalories')).toBe(430);
    expect(record.fields.find((f) => f.key === 'calories')).toBeUndefined();
  });

  it('lets a labelled Duration line beat a number scraped from the opener', () => {
    // "12 min/mi" is a pace. Reading it as the session length and then throwing
    // away the real "Duration: 45 min" as a duplicate is the wrong way round.
    const result = parseText('Cardio: Treadmill 12 min/mi pace\nDuration: 45 min');
    const session = result.records[0]!.sessions[0]!;
    expect(sessionValue(session, 'sessionMinutes')).toBe(45);
    expect(result.unrecognisedLines).toHaveLength(0);
  });

  it('lets a labelled HR zone line beat one read out of the opener', () => {
    const result = parseText('Cardio: Zone 2 bike\nHR zone: 3\nDuration: 40 min');
    const session = result.records[0]!.sessions[0]!;
    expect(sessionValue(session, 'hrZone')).toBe(3);
    expect(result.unrecognisedLines).toHaveLength(0);
  });

  it('keeps both halves of an hours-and-minutes duration on the opener', () => {
    const push = parseText('Workout: Push 1h 30m').records[0]!.sessions[0]!;
    expect(sessionValue(push, 'sessionMinutes')).toBe(90);
    const bike = parseText('Cardio: Bike 2 hours 15 minutes').records[0]!.sessions[0]!;
    expect(sessionValue(bike, 'sessionMinutes')).toBe(135);
  });

  it('does not read a distance in metres as a duration', () => {
    // "500m row" is 500 metres. Reading it as 500 minutes adds eight hours to
    // the day's training total, and only values over 1440 are caught by range.
    const session = parseText('Cardio: 500m row').records[0]!.sessions[0]!;
    expect(sessionValue(session, 'sessionMinutes')).toBeNull();
  });

  it('still reads a duration written as bare minutes on the opener', () => {
    expect(sessionValue(parseText('Cardio: 45m').records[0]!.sessions[0]!, 'sessionMinutes'))
      .toBe(45);
  });

  it('records the unit an opener duration was written in', () => {
    const hours = parseText('Cardio: Bike 1h').records[0]!.sessions[0]!;
    const field = hours.fields.find((f) => f.key === 'sessionMinutes')!;
    expect(field.value).toBe(60);
    // The provenance stored in health_imports must not claim the source said
    // minutes when it said hours.
    expect(field.sourceUnit).toBe('h');
  });

  it('flags a duration written on the opener with no unit', () => {
    const session = parseText('Cardio: 45').records[0]!.sessions[0]!;
    const field = session.fields.find((f) => f.key === 'sessionMinutes')!;
    expect(field.value).toBe(45);
    expect(field.confidence).toBe('LOW');
    expect(field.note).toMatch(/read as minutes/);
  });

  it('reports a repeated field within one session', () => {
    const result = parseText('Workout: Push\nDuration: 45 min\nDuration: 60 min');
    expect(sessionValue(result.records[0]!.sessions[0]!, 'sessionMinutes')).toBe(45);
    expect(result.unrecognisedLines.join(' ')).toMatch(/duplicate sessionMinutes in this session/);
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

  it('gives a single-day paste the same key it had before records existed', () => {
    // A one-day paste is one record whose rawText is the whole input, so days
    // already imported under the old parser are still recognised as duplicates.
    const record = parseText(report).records[0]!;
    expect(idempotencyKey(record.rawText, '2026-08-28'))
      .toBe(idempotencyKey(report, '2026-08-28'));
  });
});
