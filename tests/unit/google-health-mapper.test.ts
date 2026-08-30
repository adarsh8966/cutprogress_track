/**
 * Translating Google Health into CUT OS, one data point at a time.
 *
 * This is where "missing is not zero" is either kept or lost. Every case below
 * is a way the API can hand over something incomplete, and the assertion is
 * always the same shape: the value that was measured, or null - never a
 * substituted number.
 */
import { describe, it, expect } from 'vitest';
import {
  mapDataPoint, mapSleepSession, mapExerciseSession, mapHeartRateSamples,
  bodyKey, timingOf,
} from '@/lib/integrations/googleHealth/mapper';
import { DATA_TYPE_BY_ID } from '@/lib/integrations/googleHealth/registry';
import {
  sample, daily, interval, exerciseSession, sleepSession, heartRateSamples,
} from '../helpers/googleHealthFixtures';

const spec = (id: string) => DATA_TYPE_BY_ID[id]!;
const UTC = { timezone: 'UTC' };
const NY = { timezone: 'America/New_York' };

describe('the data type body key', () => {
  it('turns a kebab data type into the camelCase key its payload uses', () => {
    expect(bodyKey('steps')).toBe('steps');
    expect(bodyKey('body-fat')).toBe('bodyFat');
    expect(bodyKey('daily-resting-heart-rate')).toBe('dailyRestingHeartRate');
    expect(bodyKey('daily-sleep-temperature-derivations'))
      .toBe('dailySleepTemperatureDerivations');
  });
});

describe('scalar data points', () => {
  it('reads a weight in kilograms', () => {
    const point = sample('weight', 'w1', '2026-08-29T07:12:00Z', { kilograms: 84.2 });
    const mapped = mapDataPoint(point as never, spec('weight'), UTC)!;
    expect(mapped.value).toBeCloseTo(84.2, 3);
    expect(mapped.unit).toBe('kg');
    expect(mapped.timing.localDate).toBe('2026-08-29');
  });

  it('reads a body fat percentage', () => {
    const point = sample('body-fat', 'bf1', '2026-08-29T07:12:00Z', { percentage: 19.4 });
    const mapped = mapDataPoint(point as never, spec('body-fat'), UTC)!;
    expect(mapped.value).toBeCloseTo(19.4, 2);
    expect(mapped.unit).toBe('%');
  });

  it('reads a heart rate serialised as a string', () => {
    // The vitals guide is explicit that 64-bit integers arrive as strings to
    // preserve precision. A reader that only accepts numbers loses every one.
    const point = sample('heart-rate', 'hr1', '2026-08-29T10:05:00Z', {
      beatsPerMinute: '142',
    });
    const mapped = mapDataPoint(point as never, spec('heart-rate'), UTC)!;
    expect(mapped.value).toBe(142);
  });

  it('reads HRV as rmssd in milliseconds', () => {
    const point = daily('daily-heart-rate-variability', 'hrv1', '2026-08-29', {
      rmssd: 58.4,
    });
    const mapped = mapDataPoint(point as never, spec('daily-heart-rate-variability'), UTC)!;
    expect(mapped.value).toBeCloseTo(58.4, 2);
    expect(mapped.unit).toBe('ms');
  });

  it('converts distance from millimetres to kilometres', () => {
    const point = interval('distance', 'd1', '2026-08-29T00:00:00Z', '2026-08-30T00:00:00Z', {
      distanceMillimetersSum: 8_400_000,
    });
    const mapped = mapDataPoint(point as never, spec('distance'), UTC)!;
    expect(mapped.value).toBeCloseTo(8.4, 4);
    expect(mapped.unit).toBe('km');
  });

  it('reads the misspelled distance field the API actually sends', () => {
    // The workouts guide documents distanceMillimeters; the observed response
    // sends distanceMillimiters. Both are read, because one of them is real.
    const point = interval('distance', 'd2', '2026-08-29T00:00:00Z', '2026-08-30T00:00:00Z', {
      distanceMillimitersSum: 1_609_344,
    });
    const mapped = mapDataPoint(point as never, spec('distance'), UTC)!;
    expect(mapped.value).toBeCloseTo(1.609344, 5);
  });

  it('returns a null value, not a zero, when the field cannot be read', () => {
    const point = sample('weight', 'w2', '2026-08-29T07:12:00Z', { somethingElse: 12 });
    const mapped = mapDataPoint(point as never, spec('weight'), UTC)!;
    expect(mapped.value).toBeNull();
    // The record is still kept: "this arrived and held nothing readable" is a
    // different fact from "this never arrived".
    expect(mapped.externalId).toContain('w2');
  });

  it('drops an implausible value with a warning rather than clamping it', () => {
    const point = sample('heart-rate', 'hr2', '2026-08-29T10:05:00Z', {
      beatsPerMinute: '400',
    });
    const mapped = mapDataPoint(point as never, spec('heart-rate'), UTC)!;
    expect(mapped.value).toBeNull();
    expect(mapped.warnings.join(' ')).toMatch(/outside the plausible range/);
  });

  it('refuses a data point with no identity', () => {
    expect(mapDataPoint({ name: '' } as never, spec('weight'), UTC)).toBeNull();
  });

  it('refuses a data point that cannot say when it was measured', () => {
    // Filing it under today would be a fabricated timestamp, and everything
    // downstream - the day it lands on, the workout it correlates with - is
    // built on that timestamp being real.
    const point = { name: 'users/1/dataTypes/weight/dataPoints/x', weight: { kilograms: 80 } };
    expect(mapDataPoint(point as never, spec('weight'), UTC)).toBeNull();
  });
});

describe('true zeros', () => {
  it('reads a steps record with no count as a measured zero', () => {
    // The true-zeros guide: a record returned WITHOUT its count property means
    // the device was worn and the user was still. That is a zero somebody
    // measured, and it is not the same as no record at all.
    const point = interval('steps', 's1', '2026-08-29T09:00:00Z', '2026-08-29T09:01:00Z', {});
    const mapped = mapDataPoint(point as never, spec('steps'), UTC)!;
    expect(mapped.value).toBe(0);
    expect(mapped.trueZero).toBe(true);
  });

  it('does not invent a zero for a data type without true-zero semantics', () => {
    const point = daily('daily-resting-heart-rate', 'rhr1', '2026-08-29', {});
    const mapped = mapDataPoint(point as never, spec('daily-resting-heart-rate'), UTC)!;
    expect(mapped.value).toBeNull();
    expect(mapped.trueZero).toBe(false);
  });
});

describe('timezones and the day a measurement lands on', () => {
  it('puts a late-evening reading on the local day, not the UTC one', () => {
    // 2026-08-30T02:30Z is still the 29th in New York.
    const point = sample('weight', 'w3', '2026-08-30T02:30:00Z', { kilograms: 84 });
    expect(mapDataPoint(point as never, spec('weight'), UTC)!.timing.localDate)
      .toBe('2026-08-30');
    expect(mapDataPoint(point as never, spec('weight'), NY)!.timing.localDate)
      .toBe('2026-08-29');
  });

  it('takes a daily record at its own date, with no instant invented', () => {
    // A Daily record is a statement about the user's calendar day. Synthesising
    // midnight and rendering it back through a timezone would move some users
    // to the wrong day.
    const point = daily('daily-resting-heart-rate', 'rhr2', '2026-08-29', {
      beatsPerMinute: 58,
    });
    const timing = timingOf(point as never, spec('daily-resting-heart-rate'), NY.timezone)!;
    expect(timing.localDate).toBe('2026-08-29');
    expect(timing.observedAt).toBeNull();
  });
});

describe('sleep sessions', () => {
  it('sums the stages and attributes the night to the morning it ended', () => {
    const mapped = mapSleepSession(sleepSession() as never, UTC)!;
    // 22:30-23:45 light (75) + 23:45-01:15 deep (90) + 01:15-02:00 awake (45)
    // + 02:00-04:00 REM (120) + 04:00-06:30 light (150).
    expect(mapped.lightMinutes).toBe(225);
    expect(mapped.deepMinutes).toBe(90);
    expect(mapped.remMinutes).toBe(120);
    expect(mapped.awakeMinutes).toBe(45);
    // Duration is time ASLEEP, not time in bed: the awake stage is excluded.
    expect(mapped.durationMinutes).toBe(435);
    // The night began on the 28th and belongs to the 29th.
    expect(mapped.localDate).toBe('2026-08-29');
  });

  it('counts short awakenings without adding them to the awake total', () => {
    // The sleep guide says short awakenings OVERLAP the surrounding stages
    // rather than partitioning the timeline with them. Adding their duration
    // would count the same minutes twice and make the parts exceed the whole.
    const mapped = mapSleepSession(sleepSession({
      shortAwakenings: [
        { startTime: '2026-08-28T23:10:00Z', endTime: '2026-08-28T23:11:30Z', type: 'AWAKE' },
        { startTime: '2026-08-29T03:00:00Z', endTime: '2026-08-29T03:02:00Z', type: 'AWAKE' },
      ],
    }) as never, UTC)!;
    expect(mapped.shortAwakenings).toBe(2);
    expect(mapped.awakeMinutes).toBe(45);
    expect(mapped.durationMinutes).toBe(435);
  });

  it('leaves stages null for a classic log rather than reporting zero REM', () => {
    // A device that does not measure stages is not a device reporting no REM.
    const mapped = mapSleepSession(sleepSession({
      type: 'CLASSIC', stages: [],
    }) as never, UTC)!;
    expect(mapped.remMinutes).toBeNull();
    expect(mapped.deepMinutes).toBeNull();
    expect(mapped.durationMinutes).toBe(480);
  });

  it('skips a stage missing a timestamp, with a warning, and keeps the rest', () => {
    const mapped = mapSleepSession(sleepSession({
      stages: [
        { startTime: '2026-08-28T22:30:00Z', endTime: '2026-08-28T23:30:00Z', type: 'LIGHT' },
        { startTime: '2026-08-28T23:30:00Z', endTime: '', type: 'DEEP' },
      ],
    }) as never, UTC)!;
    expect(mapped.lightMinutes).toBe(60);
    expect(mapped.deepMinutes).toBe(0);
    expect(mapped.warnings.join(' ')).toMatch(/without both timestamps/);
  });

  it('handles a night that crosses midnight in the user timezone', () => {
    const mapped = mapSleepSession(sleepSession({
      startTime: '2026-08-29T03:00:00Z',
      endTime: '2026-08-29T11:00:00Z',
      stages: [
        { startTime: '2026-08-29T03:00:00Z', endTime: '2026-08-29T11:00:00Z', type: 'LIGHT' },
      ],
    }) as never, NY)!;
    // 11:00Z is 07:00 in New York on the 29th.
    expect(mapped.localDate).toBe('2026-08-29');
  });
});

describe('exercise sessions', () => {
  it('reads the summary the codelab response actually contains', () => {
    const mapped = mapExerciseSession(exerciseSession({
      caloriesKcal: 412,
      distanceMm: 1_609_344,
      steps: '2038',
      averageHeartRate: '131',
      activeZoneMinutes: '24',
      heartRateZoneDurations: { lightTime: '900s', fatBurnTime: '1320s' },
    }) as never, UTC)!;

    expect(mapped.caloriesKcal).toBe(412);
    expect(mapped.distanceKm).toBeCloseTo(1.609, 3);
    expect(mapped.steps).toBe(2038);
    expect(mapped.averageHeartRate).toBe(131);
    expect(mapped.activeZoneMinutes).toBe(24);
    expect(mapped.providerZoneSeconds).toEqual({ lightTime: 900, fatBurnTime: 1320 });
  });

  it('separates elapsed time from active time', () => {
    // The workouts guide: use activeDuration for averages, because paused
    // intervals must not skew them.
    const mapped = mapExerciseSession(exerciseSession({
      startTime: '2026-08-29T08:00:00Z',
      endTime: '2026-08-29T08:35:00Z',
      activeDuration: '1800s',
    }) as never, UTC)!;
    expect(mapped.durationMinutes).toBe(35);
    expect(mapped.activeMinutes).toBe(30);
  });

  it('classifies a run as cardio and a lift as resistance training', () => {
    expect(mapExerciseSession(
      exerciseSession({ exerciseType: 'RUNNING' }) as never, UTC,
    )!.isCardio).toBe(true);
    expect(mapExerciseSession(
      exerciseSession({ exerciseType: 'WEIGHTLIFTING' }) as never, UTC,
    )!.isCardio).toBe(false);
  });

  it('treats an unrecognised activity as resistance training, not cardio', () => {
    // The conservative direction: a strength session that was really cardio is
    // visible on Training, while the reverse silently pads a cardio target.
    expect(mapExerciseSession(
      exerciseSession({ exerciseType: 'SOMETHING_NEW' }) as never, UTC,
    )!.isCardio).toBe(false);
  });

  it('drops an end time that precedes the start, keeping the session', () => {
    const mapped = mapExerciseSession(exerciseSession({
      startTime: '2026-08-29T11:00:00Z',
      endTime: '2026-08-29T10:00:00Z',
    }) as never, UTC)!;
    expect(mapped.endTime).toBeNull();
    expect(mapped.warnings.join(' ')).toMatch(/ended before it began/);
  });

  it('records the external update time, so an edit can be told from a repeat', () => {
    const mapped = mapExerciseSession(
      exerciseSession({ updateTime: '2026-08-29T12:34:56Z' }) as never, UTC,
    )!;
    expect(mapped.externalUpdatedAt).toBe('2026-08-29T12:34:56.000Z');
  });
});

describe('heart-rate samples', () => {
  it('sorts them and drops anything without a rate or a time', () => {
    const points = [
      ...heartRateSamples('2026-08-29T10:00:00Z', 3, () => 120),
      { name: 'users/1/dataTypes/heart-rate/dataPoints/bad', heartRate: {} },
    ];
    const samples = mapHeartRateSamples(points as never);
    expect(samples).toHaveLength(3);
    expect(samples[0]!.at).toBeLessThan(samples[1]!.at);
  });

  it('refuses an implausible rate rather than letting it drag an average', () => {
    const points = heartRateSamples('2026-08-29T10:00:00Z', 3, (i) => (i === 1 ? 0 : 130));
    expect(mapHeartRateSamples(points as never)).toHaveLength(2);
  });
});
