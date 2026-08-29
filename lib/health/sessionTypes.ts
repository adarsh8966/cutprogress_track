/**
 * Free text -> the closed session/cardio vocabularies (spec §11, §13, §26).
 *
 * A pasted report says "Push", "Zone 2 bike" or "Treadmill incline walk". The
 * database stores session_type and cardio_type enums. This file is the only
 * place that translation happens.
 *
 * Two rules:
 *
 *  1. NOTHING IS LOST. The mapping always returns the enum AND the text it was
 *     read from. The caller writes that text into the session's notes column, so
 *     a label that lands on OTHER is still recoverable in full.
 *
 *  2. NO GUESSING BEYOND THE OBVIOUS. Only unambiguous, whole-word synonyms map.
 *     Anything else is OTHER, which is honest, rather than a near-miss that
 *     files a leg day under "lower" and quietly changes what the analytics see.
 */
import type { CardioTypeEnum, SessionTypeEnum } from '@/lib/supabase/types';

export interface TypeMatch<T> {
  value: T;
  /** The text exactly as written, preserved for the notes column. */
  rawText: string;
  /** False when nothing matched and the value fell back to OTHER. */
  recognised: boolean;
}

/** Lowercase, collapse whitespace, drop decorative punctuation. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[_/]+/g, ' ')
    .replace(/[^a-z0-9 -]+/g, ' ')
    .replace(/-+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Longest phrase first, so "full body" is tested before "body" could ever be,
 * and "incline walk" before "walk".
 */
const SESSION_TYPES: [SessionTypeEnum, string[]][] = [
  ['FULL_BODY', ['full body', 'fullbody', 'full']],
  ['UPPER', ['upper body', 'upper']],
  ['LOWER', ['lower body', 'lower']],
  ['PUSH', ['push day', 'push']],
  ['PULL', ['pull day', 'pull']],
  ['LEGS', ['leg day', 'legs', 'leg']],
  ['CARDIO', ['cardio', 'conditioning']],
];

const CARDIO_TYPES: [CardioTypeEnum, string[]][] = [
  ['INCLINE_WALKING', [
    'incline walking', 'incline walk', 'treadmill incline walk',
    'treadmill incline', 'incline treadmill', 'hill walk', 'hill walking',
  ]],
  ['RUNNING', [
    'treadmill run', 'treadmill running', 'running', 'run', 'jogging', 'jog',
  ]],
  ['CYCLING', [
    'stationary bike', 'exercise bike', 'cycling', 'cycle', 'biking', 'bike',
    'spin', 'spinning',
  ]],
  ['WALKING', ['walking', 'walk', 'ruck', 'rucking']],
];

/**
 * Matches when a phrase appears as a whole word or words. Substring matching
 * would read "pull" out of "pullover" and mislabel the session.
 */
function containsPhrase(haystack: string, phrase: string): boolean {
  const words = haystack.split(' ');
  const target = phrase.split(' ');
  for (let i = 0; i + target.length <= words.length; i += 1) {
    if (target.every((word, offset) => words[i + offset] === word)) return true;
  }
  return false;
}

function match<T>(table: [T, string[]][], fallback: T, rawText: string): TypeMatch<T> {
  const text = normalise(rawText);
  if (text !== '') {
    for (const [value, phrases] of table) {
      for (const phrase of phrases) {
        if (containsPhrase(text, phrase)) return { value, rawText, recognised: true };
      }
    }
  }
  return { value: fallback, rawText, recognised: false };
}

/** "Push" -> PUSH. "Arms and abs" -> OTHER, with the text kept. */
export function toSessionType(rawText: string): TypeMatch<SessionTypeEnum> {
  return match(SESSION_TYPES, 'OTHER', rawText);
}

/** "Zone 2 bike" -> CYCLING. "Rowing" -> OTHER, with the text kept. */
export function toCardioType(rawText: string): TypeMatch<CardioTypeEnum> {
  return match(CARDIO_TYPES, 'OTHER', rawText);
}

export const SESSION_TYPE_VALUES: SessionTypeEnum[] = [
  'UPPER', 'LOWER', 'PUSH', 'PULL', 'LEGS', 'FULL_BODY', 'CARDIO', 'OTHER',
];

export const CARDIO_TYPE_VALUES: CardioTypeEnum[] = [
  'WALKING', 'INCLINE_WALKING', 'RUNNING', 'CYCLING', 'OTHER',
];

/** Human labels for the review screen's selects. */
export const SESSION_TYPE_LABEL: Record<SessionTypeEnum, string> = {
  UPPER: 'Upper', LOWER: 'Lower', PUSH: 'Push', PULL: 'Pull', LEGS: 'Legs',
  FULL_BODY: 'Full body', CARDIO: 'Cardio', OTHER: 'Other',
};

export const CARDIO_TYPE_LABEL: Record<CardioTypeEnum, string> = {
  WALKING: 'Walking', INCLINE_WALKING: 'Incline walking', RUNNING: 'Running',
  CYCLING: 'Cycling', OTHER: 'Other',
};
