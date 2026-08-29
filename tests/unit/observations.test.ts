/**
 * The plausible-range rails (spec §8, §33).
 *
 * These bounds exist to catch a value the DATABASE would refuse, before the
 * insert happens, so the user is never told an import succeeded when a row was
 * rejected. That only works while the numbers here match the CHECK constraints
 * in supabase/migrations - which is what most of this file asserts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  OBSERVATION_RANGES, checkObservation, isRecordable, isObservationKey,
} from '@/lib/validation/observations';

const migrations = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../supabase/migrations/${name}`, import.meta.url)), 'utf8');

describe('observation ranges', () => {
  it('accepts a value inside its range', () => {
    expect(checkObservation('weightKg', 92.4)).toBeNull();
    expect(checkObservation('restingHeartRate', 58)).toBeNull();
    expect(checkObservation('sleepMinutes', 450)).toBeNull();
    expect(checkObservation('hrZone', 2)).toBeNull();
  });

  it('accepts a measured zero where zero is a real measurement', () => {
    expect(checkObservation('steps', 0)).toBeNull();
    expect(checkObservation('calories', 0)).toBeNull();
    expect(checkObservation('distanceKm', 0)).toBeNull();
    expect(checkObservation('sessionMinutes', 0)).toBeNull();
  });

  it('rejects a value below its floor', () => {
    expect(checkObservation('weightKg', 19)).toMatch(/outside the recordable range/);
    expect(checkObservation('waistCm', 29)).toMatch(/outside the recordable range/);
    expect(checkObservation('restingHeartRate', 24)).toMatch(/outside the recordable range/);
    expect(checkObservation('hrZone', 0)).toMatch(/outside the recordable range/);
  });

  it('rejects a value above its ceiling', () => {
    expect(checkObservation('weightKg', 401)).toMatch(/outside the recordable range/);
    expect(checkObservation('sleepMinutes', 1441)).toMatch(/outside the recordable range/);
    expect(checkObservation('averageHeartRate', 251)).toMatch(/outside the recordable range/);
    expect(checkObservation('hrZone', 6)).toMatch(/outside the recordable range/);
  });

  it('rejects every negative value', () => {
    for (const key of Object.keys(OBSERVATION_RANGES)) {
      expect(isRecordable(key, -1)).toBe(false);
    }
  });

  it('rejects a non-finite number whatever the key', () => {
    expect(checkObservation('steps', Number.NaN)).toMatch(/not a number/);
    expect(checkObservation('steps', Number.POSITIVE_INFINITY)).toMatch(/not a number/);
    expect(checkObservation('anything at all', Number.NaN)).toMatch(/not a number/);
  });

  it('says nothing about a key it does not police', () => {
    expect(checkObservation('workoutLabel', 5)).toBeNull();
    expect(isObservationKey('workoutLabel')).toBe(false);
  });

  it('names the value and the range in the message', () => {
    const message = checkObservation('weightKg', 4535.9);
    expect(message).toContain('4,535.9');
    expect(message).toContain('20 to 400 kg');
  });
});

describe('ranges match the database CHECK constraints', () => {
  const raw = migrations('0003_raw_observations.sql');
  const training = migrations('0004_training.sql');
  const intensity = migrations('0010_session_intensity.sql');

  it('matches body_measurements', () => {
    expect(raw).toContain('weight_kg between 20 and 400');
    expect(OBSERVATION_RANGES.weightKg).toEqual({ min: 20, max: 400, unit: 'kg' });
    expect(raw).toContain('waist_cm between 30 and 250');
    expect(OBSERVATION_RANGES.waistCm).toEqual({ min: 30, max: 250, unit: 'cm' });
  });

  it('matches sleep_records', () => {
    expect(raw).toContain('duration_minutes between 0 and 1440');
    expect(OBSERVATION_RANGES.sleepMinutes.min).toBe(0);
    expect(OBSERVATION_RANGES.sleepMinutes.max).toBe(1440);
  });

  it('matches cardio_sessions heart rate and zone', () => {
    expect(raw).toContain('average_heart_rate between 25 and 250');
    expect(OBSERVATION_RANGES.averageHeartRate).toEqual({ min: 25, max: 250, unit: 'bpm' });
    expect(raw).toContain('hr_zone between 1 and 5');
    expect(OBSERVATION_RANGES.hrZone.min).toBe(1);
    expect(OBSERVATION_RANGES.hrZone.max).toBe(5);
  });

  it('matches workout_sessions duration', () => {
    expect(training).toContain('duration_minutes between 0 and 1440');
    expect(OBSERVATION_RANGES.sessionMinutes.min).toBe(0);
    expect(OBSERVATION_RANGES.sessionMinutes.max).toBe(1440);
  });

  it('matches the maximum heart rate added in 0010', () => {
    expect(intensity).toContain('max_heart_rate between 25 and 250');
    expect(OBSERVATION_RANGES.maxHeartRate).toEqual({ min: 25, max: 250, unit: 'bpm' });
  });

  it('keeps a lower bound of zero wherever the schema says >= 0', () => {
    for (const key of ['calories', 'proteinG', 'carbsG', 'fatG', 'fiberG', 'steps',
      'activeCalories', 'hrvMs', 'distanceKm', 'sessionCalories'] as const) {
      expect(OBSERVATION_RANGES[key].min).toBe(0);
    }
  });
});
