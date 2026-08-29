/**
 * Stress test over a realistic week of pasted data.
 *
 * The claim being tested is not "the parser handles messy input". It is the
 * stronger one the importer actually needs: what parses is exactly right, what
 * does not is reported, and neither contaminates the other. A field the parser
 * gets wrong here becomes a wrong number in the Context Pack.
 */
import { describe, it, expect } from 'vitest';
import { parseText, sessionValue, type ParsedRecord } from '@/lib/health/parser';
import { toCardioType, toSessionType } from '@/lib/health/sessionTypes';
import { kgToLb, cmToInches, kmToMiles } from '@/lib/normalization/units';
import {
  SEVEN_DAY_REPORT, SEVEN_DAY_DATES, HOSTILE_REPORT,
} from '../helpers/importFixtures';

const result = parseText(SEVEN_DAY_REPORT, 2026);
const days = result.records;

function day(index: number): ParsedRecord {
  const record = days[index];
  if (!record) throw new Error(`no record at index ${index}`);
  return record;
}

function value(record: ParsedRecord, key: string): number | string | null {
  return record.fields.find((f) => f.key === key)?.value ?? null;
}

describe('seven-day stress fixture', () => {
  it('finds exactly seven days, in the order they were written', () => {
    expect(days).toHaveLength(7);
    expect(days.map((d) => d.localDate)).toEqual(SEVEN_DAY_DATES);
  });

  it('keeps the export header with the first day rather than losing it', () => {
    expect(day(0).rawText).toContain('Bevel weekly export');
  });

  it('reads day one completely and in canonical units', () => {
    const first = day(0);
    expect(kgToLb(value(first, 'weightKg') as number)).toBeCloseTo(203.7, 6);
    expect(cmToInches(value(first, 'waistCm') as number)).toBeCloseTo(35.4, 6);
    expect(value(first, 'calories')).toBe(2001);
    expect(value(first, 'proteinG')).toBe(172);
    expect(value(first, 'carbsG')).toBe(198);
    expect(value(first, 'fatG')).toBe(67);
    expect(value(first, 'fiberG')).toBe(29);
    expect(value(first, 'steps')).toBe(15000);
    expect(value(first, 'activeCalories')).toBe(640);
    expect(value(first, 'sleepMinutes')).toBe(450);
    expect(value(first, 'restingHeartRate')).toBe(58);
    expect(value(first, 'hrvMs')).toBe(71);
    // The export's own header line is not data, and is reported as such rather
    // than being silently swallowed.
    expect(first.unrecognisedLines).toEqual(['Bevel weekly export']);
  });

  it('reads day one’s workout with its heart rates and burn', () => {
    const session = day(0).sessions[0]!;
    expect(session.kind).toBe('WORKOUT');
    expect(toSessionType(session.rawLabel).value).toBe('PUSH');
    expect(sessionValue(session, 'sessionMinutes')).toBe(55);
    expect(sessionValue(session, 'averageHeartRate')).toBe(128);
    expect(sessionValue(session, 'maxHeartRate')).toBe(161);
    expect(sessionValue(session, 'sessionCalories')).toBe(430);
  });

  it('reads metric input on day two without converting it twice', () => {
    const second = day(1);
    expect(value(second, 'weightKg')).toBeCloseTo(92.4, 6);
    expect(value(second, 'sleepMinutes')).toBe(450);
    expect(value(second, 'restingHeartRate')).toBe(57);
    // Day two logged no waist and no fibre. Both must stay absent.
    expect(value(second, 'waistCm')).toBeNull();
    expect(value(second, 'fiberG')).toBeNull();
  });

  it('keeps a workout and two cardio sessions apart on day two', () => {
    const sessions = day(1).sessions;
    expect(sessions.map((s) => s.kind)).toEqual(['WORKOUT', 'CARDIO', 'CARDIO']);

    expect(sessionValue(sessions[0]!, 'averageHeartRate')).toBe(124);
    expect(sessionValue(sessions[0]!, 'distanceKm')).toBeNull();

    expect(toCardioType(sessions[1]!.rawLabel).value).toBe('INCLINE_WALKING');
    expect(sessionValue(sessions[1]!, 'sessionMinutes')).toBe(30);
    expect(sessionValue(sessions[1]!, 'distanceKm')).toBe(2.4);
    expect(sessionValue(sessions[1]!, 'hrZone')).toBe(2);

    expect(toCardioType(sessions[2]!.rawLabel).value).toBe('CYCLING');
    expect(sessionValue(sessions[2]!, 'sessionMinutes')).toBe(45);
    expect(sessionValue(sessions[2]!, 'distanceKm')).toBe(18.2);
    expect(sessionValue(sessions[2]!, 'averageHeartRate')).toBe(131);
    expect(sessionValue(sessions[2]!, 'hrZone')).toBeNull();
  });

  it('handles a missing weight and two workouts on day three', () => {
    const third = day(2);
    expect(value(third, 'weightKg')).toBeNull();
    expect(value(third, 'sleepMinutes')).toBe(435);
    expect(value(third, 'fiberG')).toBe(24);
    expect(third.sessions).toHaveLength(2);
    expect(sessionValue(third.sessions[0]!, 'sessionMinutes')).toBe(65);
    expect(sessionValue(third.sessions[0]!, 'maxHeartRate')).toBe(172);
    expect(sessionValue(third.sessions[1]!, 'sessionMinutes')).toBe(40);
    expect(toSessionType(third.sessions[1]!.rawLabel).value).toBe('UPPER');
  });

  it('keeps a rest day sparse and reports its malformed value', () => {
    const fourth = day(3);
    expect(value(fourth, 'steps')).toBe(4102);
    expect(value(fourth, 'sleepMinutes')).toBe(480);
    // "two thousand" is not a number. It must be reported, not read as 2000
    // and not read as 0.
    expect(value(fourth, 'calories')).toBeNull();
    expect(fourth.unrecognisedLines.join(' ')).toContain('two thousand');
    expect(fourth.sessions).toHaveLength(0);
  });

  it('reads mixed case, reports a duplicate and an unknown field on day five', () => {
    const fifth = day(4);
    expect(kgToLb(value(fifth, 'weightKg') as number)).toBeCloseTo(202.9, 6);
    expect(value(fifth, 'waistCm')).toBe(89);
    expect(value(fifth, 'restingHeartRate')).toBe(56);
    expect(value(fifth, 'sleepMinutes')).toBe(405);
    // Fibre and Fiber are the same field. The first wins and the second is
    // reported, because a report giving two values needs a human.
    expect(value(fifth, 'fiberG')).toBe(31);
    expect(fifth.unrecognisedLines.join(' ')).toMatch(/duplicate fiberG/);
    expect(fifth.unrecognisedLines).toContain('Mood: pretty good');
  });

  it('reads a named date, ragged whitespace and a unit written into a label', () => {
    const sixth = day(5);
    expect(sixth.localDate).toBe('2026-09-06');
    expect(kgToLb(value(sixth, 'weightKg') as number)).toBeCloseTo(202.4, 6);
    expect(value(sixth, 'calories')).toBe(1990);
    expect(value(sixth, 'proteinG')).toBe(175);
    expect(value(sixth, 'steps')).toBe(13207);
    expect(value(sixth, 'activeCalories')).toBe(705);
    expect(value(sixth, 'sleepMinutes')).toBe(425);
    expect(sessionValue(sixth.sessions[0]!, 'averageHeartRate')).toBe(133);
    expect(toSessionType(sixth.sessions[0]!.rawLabel).value).toBe('FULL_BODY');
    expect(sixth.unrecognisedLines).toHaveLength(0);
  });

  it('reads a cardio-only day and reports the pace it cannot store', () => {
    const seventh = day(6);
    expect(seventh.sessions).toHaveLength(1);
    const cardio = seventh.sessions[0]!;
    expect(toCardioType(cardio.rawLabel).value).toBe('RUNNING');
    expect(sessionValue(cardio, 'sessionMinutes')).toBe(38);
    expect(kmToMiles(sessionValue(cardio, 'distanceKm') as number)).toBeCloseTo(3.1, 6);
    expect(sessionValue(cardio, 'averageHeartRate')).toBe(152);
    expect(sessionValue(cardio, 'maxHeartRate')).toBe(178);
    expect(sessionValue(cardio, 'sessionCalories')).toBe(465);

    // Pace is understood and deliberately not stored, so it is reported here
    // rather than shown as a value the review screen cannot honour.
    expect(cardio.notStored).toHaveLength(1);
    expect(cardio.notStored[0]!.rawText).toBe('Pace: 12:15 /mi');
    expect(seventh.unrecognisedLines).toHaveLength(0);
  });

  it('never invents a zero anywhere in the week', () => {
    for (const record of days) {
      for (const field of record.fields) {
        if (typeof field.value !== 'number') continue;
        // The fixture contains no measured zeroes, so any zero would be a
        // failed parse that leaked through as data.
        expect(field.value).not.toBe(0);
      }
    }
  });

  it('confines every problem to the day it came from', () => {
    // Day four's malformed calories and day five's duplicate must not appear in
    // any other record's report.
    expect(day(0).unrecognisedLines).toHaveLength(1);
    expect(day(1).unrecognisedLines).toHaveLength(0);
    expect(day(2).unrecognisedLines).toHaveLength(0);
    expect(day(3).unrecognisedLines).toHaveLength(1);
    expect(day(4).unrecognisedLines).toHaveLength(2);
    expect(day(5).unrecognisedLines).toHaveLength(0);
    expect(day(6).unrecognisedLines).toHaveLength(0);
  });

  it('gives every day its own idempotency text', () => {
    const texts = days.map((d) => d.rawText);
    expect(new Set(texts).size).toBe(7);
    days.forEach((record, index) => {
      const others = SEVEN_DAY_DATES.filter((_, i) => i !== index);
      for (const other of others) expect(record.rawText).not.toContain(other);
    });
  });
});

describe('hostile input', () => {
  const hostile = parseText(HOSTILE_REPORT, 2026).records[0]!;

  it('still reads the date', () => {
    expect(hostile.localDate).toBe('2026-10-01');
  });

  it('flags every value the database would refuse', () => {
    for (const key of ['weightKg', 'waistCm', 'restingHeartRate', 'sleepMinutes']) {
      const field = hostile.fields.find((f) => f.key === key);
      if (!field) continue;
      expect(field.confidence).toBe('LOW');
      expect(field.note).toMatch(/outside the recordable range/);
    }
  });

  it('refuses every malformed number rather than misreading it', () => {
    for (const key of ['calories', 'proteinG', 'carbsG', 'fatG', 'steps', 'hrvMs']) {
      expect(hostile.fields.find((f) => f.key === key)).toBeUndefined();
    }
    expect(hostile.unrecognisedLines.join(' ')).toContain('could not read a value');
  });

  it('refuses session fields with no session to attach them to', () => {
    expect(hostile.sessions).toHaveLength(0);
    expect(hostile.unrecognisedLines.join(' ')).toMatch(/no open Workout: or Cardio: block/);
  });

  it('reports the unknown field', () => {
    expect(hostile.unrecognisedLines).toContain('Random: nonsense');
  });
});
