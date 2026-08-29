/**
 * Free text -> the closed session vocabularies (spec §11, §13, §26).
 *
 * The safety property here is that a label the parser does not understand
 * becomes OTHER *with its text preserved*, never a plausible-looking guess. A
 * mislabelled session silently changes what the training analytics see.
 */
import { describe, it, expect } from 'vitest';
import {
  toSessionType, toCardioType,
  SESSION_TYPE_VALUES, CARDIO_TYPE_VALUES,
  SESSION_TYPE_LABEL, CARDIO_TYPE_LABEL,
} from '@/lib/health/sessionTypes';

describe('session types', () => {
  it('maps the obvious names', () => {
    expect(toSessionType('Push').value).toBe('PUSH');
    expect(toSessionType('pull').value).toBe('PULL');
    expect(toSessionType('Legs').value).toBe('LEGS');
    expect(toSessionType('Leg day').value).toBe('LEGS');
    expect(toSessionType('Upper').value).toBe('UPPER');
    expect(toSessionType('Lower body').value).toBe('LOWER');
    expect(toSessionType('Full body').value).toBe('FULL_BODY');
    expect(toSessionType('full-body').value).toBe('FULL_BODY');
    expect(toSessionType('Cardio').value).toBe('CARDIO');
  });

  it('falls back to OTHER and keeps the text', () => {
    const match = toSessionType('Arms and abs');
    expect(match.value).toBe('OTHER');
    expect(match.recognised).toBe(false);
    expect(match.rawText).toBe('Arms and abs');
  });

  it('does not match a word inside a longer one', () => {
    // "pullover" is a movement, not a pull day.
    expect(toSessionType('Pullover circuit').value).toBe('OTHER');
    expect(toSessionType('Pushup ladder').value).toBe('OTHER');
  });

  it('treats an empty label as unrecognised rather than matching', () => {
    expect(toSessionType('').value).toBe('OTHER');
    expect(toSessionType('   ').recognised).toBe(false);
  });

  it('returns only members of the enum', () => {
    for (const text of ['Push', 'nonsense', '', 'Zone 2', 'legs']) {
      expect(SESSION_TYPE_VALUES).toContain(toSessionType(text).value);
    }
  });
});

describe('cardio types', () => {
  it('maps the obvious names', () => {
    expect(toCardioType('Running').value).toBe('RUNNING');
    expect(toCardioType('run').value).toBe('RUNNING');
    expect(toCardioType('Jog').value).toBe('RUNNING');
    expect(toCardioType('Treadmill run').value).toBe('RUNNING');
    expect(toCardioType('Walk').value).toBe('WALKING');
    expect(toCardioType('Walking').value).toBe('WALKING');
    expect(toCardioType('Cycling').value).toBe('CYCLING');
    expect(toCardioType('Bike').value).toBe('CYCLING');
    expect(toCardioType('Zone 2 bike').value).toBe('CYCLING');
  });

  it('prefers the more specific incline walk over plain walking', () => {
    expect(toCardioType('Incline walk').value).toBe('INCLINE_WALKING');
    expect(toCardioType('Incline walking').value).toBe('INCLINE_WALKING');
    expect(toCardioType('Treadmill incline walk').value).toBe('INCLINE_WALKING');
  });

  it('falls back to OTHER and keeps the text', () => {
    const match = toCardioType('Rowing erg');
    expect(match.value).toBe('OTHER');
    expect(match.recognised).toBe(false);
    expect(match.rawText).toBe('Rowing erg');
  });

  it('returns only members of the enum', () => {
    for (const text of ['Running', 'nonsense', '', '30 min']) {
      expect(CARDIO_TYPE_VALUES).toContain(toCardioType(text).value);
    }
  });
});

describe('display labels', () => {
  it('names every enum member', () => {
    for (const value of SESSION_TYPE_VALUES) expect(SESSION_TYPE_LABEL[value]).toBeTruthy();
    for (const value of CARDIO_TYPE_VALUES) expect(CARDIO_TYPE_LABEL[value]).toBeTruthy();
  });
});
