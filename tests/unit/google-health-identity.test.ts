/**
 * What identifies a Google Health observation, and what happens when Google
 * does not say.
 *
 * THE REGRESSION THIS FILE EXISTS FOR. `DataPoint.name` was required by the
 * response schema, and every fixture had one, so every test passed - and the
 * first real sync rejected most of a year of data because Google documents that
 * field as optional and does not send it for the majority of data types.
 *
 * So the cases below are the ones that were never asserted: a point with a
 * name, a point without, several without in one response, the same one twice,
 * and a response that mixes the two. The property under test is always the
 * same: an identity that is stable across syncs, unique between observations,
 * and honest about which of the two kinds it is.
 */
import { describe, it, expect } from 'vitest';
import {
  derivedExternalId, isDerivedExternalId, sourceFingerprint,
  canonicalJson, contentVersion, DERIVED_ID_SCHEME, GOOGLE_HEALTH_PROVIDER,
} from '@/lib/integrations/googleHealth/identity';
import { parseDataPoints, dataPointSchema } from '@/lib/integrations/googleHealth/types';
import { mapDataPoint, mapSleepSession, mapExerciseSession } from '@/lib/integrations/googleHealth/mapper';
import { DATA_TYPE_BY_ID } from '@/lib/integrations/googleHealth/registry';
import {
  sample, daily, interval, namelessSample, namelessDaily, namelessInterval,
  stepsDay, exerciseSession, sleepSession, dataPointName, FITBIT_SOURCE,
} from '../helpers/googleHealthFixtures';

const spec = (id: string) => DATA_TYPE_BY_ID[id]!;
const UTC = { timezone: 'UTC' };

describe('the response boundary', () => {
  it('accepts a data point with no name, which is most of them', () => {
    // Google's steps response: a dataSource, a body, and no resource name.
    const parsed = dataPointSchema.safeParse(stepsDay('2026-08-29', 8421));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.name).toBeNull();
  });

  it('preserves a name that is present, exactly as it arrived', () => {
    const name = dataPointName('weight', 'w1');
    const parsed = dataPointSchema.parse(
      sample('weight', 'w1', '2026-08-29T07:00:00Z', { kilograms: 84 }),
    );
    expect(parsed.name).toBe(name);
  });

  it('treats an empty name as absent rather than as an identity', () => {
    // "" is not something a record can be keyed on, and storing it would make
    // every nameless point of that type collide on one external id.
    const parsed = dataPointSchema.parse({ name: '', steps: { countSum: '10' } });
    expect(parsed.name).toBeNull();
  });

  it('keeps the readable points in a page and reports only the bad one', () => {
    // The whole point of parsing per element: one unreadable record used to
    // throw away the window it arrived in, and the sync then abandoned the
    // rest of the data type.
    const { points, rejected } = parseDataPoints([
      stepsDay('2026-08-29', 8421),
      { dataSource: 'a phone', steps: { countSum: '99' } },
      stepsDay('2026-08-28', 6210),
    ]);
    expect(points).toHaveLength(2);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.index).toBe(1);
    expect(rejected[0]!.reason).toContain('dataSource');
  });

  it('gives a reason short enough to put on one line', () => {
    // The failing sync printed the serialised issue array - several hundred
    // characters of JSON - once per data type.
    const { rejected } = parseDataPoints(['not a data point at all']);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason.length).toBeLessThan(120);
    expect(rejected[0]!.reason).not.toContain('{');
  });
});

describe('a derived identity', () => {
  const timing = {
    observedAt: null,
    intervalStart: '2026-08-29T00:00:00.000Z',
    intervalEnd: '2026-08-30T00:00:00.000Z',
    localDate: '2026-08-29',
  };

  it('is stable: the same observation mints the same id every time', () => {
    const once = derivedExternalId({
      provider: GOOGLE_HEALTH_PROVIDER, dataType: 'steps', timing,
      dataSource: { ...FITBIT_SOURCE },
    });
    const again = derivedExternalId({
      provider: GOOGLE_HEALTH_PROVIDER, dataType: 'steps', timing,
      dataSource: { ...FITBIT_SOURCE },
    });
    expect(once).toBe(again);
  });

  it('cannot be mistaken for a name Google issued', () => {
    const id = derivedExternalId({
      provider: GOOGLE_HEALTH_PROVIDER, dataType: 'steps', timing, dataSource: null,
    });
    expect(id.startsWith(`${DERIVED_ID_SCHEME}/`)).toBe(true);
    expect(isDerivedExternalId(id)).toBe(true);
    // A Google resource name always begins users/.
    expect(isDerivedExternalId(dataPointName('steps', 'x'))).toBe(false);
  });

  it('separates two days, and two sources on one day', () => {
    const base = {
      provider: GOOGLE_HEALTH_PROVIDER, dataType: 'steps',
      dataSource: { ...FITBIT_SOURCE },
    };
    const monday = derivedExternalId({ ...base, timing });
    const tuesday = derivedExternalId({
      ...base,
      timing: {
        ...timing,
        intervalStart: '2026-08-30T00:00:00.000Z',
        intervalEnd: '2026-08-31T00:00:00.000Z',
        localDate: '2026-08-30',
      },
    });
    // A phone and a watch both report the day, and they are two measurements
    // of it. Folding the source in is what stops one overwriting the other.
    const fromPhone = derivedExternalId({
      ...base, timing, dataSource: { platform: 'ANDROID', recordingMethod: 'MANUAL' },
    });
    expect(new Set([monday, tuesday, fromPhone]).size).toBe(3);
  });

  it('still mints an id when there is no device metadata at all', () => {
    // A real response is under no obligation to describe the device.
    const bare = derivedExternalId({
      provider: GOOGLE_HEALTH_PROVIDER, dataType: 'steps', timing, dataSource: null,
    });
    expect(bare).toContain('s=-~-~-~-');
    expect(bare).toBe(derivedExternalId({
      provider: GOOGLE_HEALTH_PROVIDER, dataType: 'steps', timing, dataSource: undefined,
    }));
  });

  it('keeps the shape of the id fixed when only part of the source is missing', () => {
    const partial = sourceFingerprint({ platform: 'FITBIT' });
    expect(partial).toBe('FITBIT~-~-~-');
    expect(partial.split('~')).toHaveLength(4);
  });

  it('does not let punctuation in a device name break the format', () => {
    const id = derivedExternalId({
      provider: GOOGLE_HEALTH_PROVIDER,
      dataType: 'steps',
      timing,
      dataSource: { device: { displayName: 'Ana’s Watch / Pixel~3' } },
    });
    expect(id.split('/')).toHaveLength(5);
    expect(id).toContain('Ana_s_Watch_Pixel_3');
  });

  it('says nothing about the measurement itself', () => {
    // Deliberate: a revised step count has to be a CORRECTION to one
    // observation, not a second observation of the same day.
    const id = derivedExternalId({
      provider: GOOGLE_HEALTH_PROVIDER, dataType: 'steps', timing,
      dataSource: { ...FITBIT_SOURCE },
    });
    expect(id).not.toContain('8421');
  });
});

describe('the content version', () => {
  it('is the same for two renderings of the same record', () => {
    // JSON.stringify preserves insertion order and the API is under no
    // obligation to serialise its fields the same way twice. Without a
    // canonical form, a transposition would read as a correction on every
    // sync, forever.
    const one = { a: 1, b: { c: 2, d: [3, 4] } };
    const other = { b: { d: [3, 4], c: 2 }, a: 1 };
    expect(canonicalJson(one)).toBe(canonicalJson(other));
    expect(contentVersion(one)).toBe(contentVersion(other));
  });

  it('changes when the measurement does', () => {
    expect(contentVersion(stepsDay('2026-08-29', 8421)))
      .not.toBe(contentVersion(stepsDay('2026-08-29', 9330)));
  });

  it('keeps array order, because in a list of sleep stages order is meaning', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});

describe('mapping a point that has a name', () => {
  it('uses the provider id verbatim and says the identity is theirs', () => {
    const point = sample('weight', 'w1', '2026-08-29T07:12:00Z', { kilograms: 84.2 });
    const mapped = mapDataPoint(point as never, spec('weight'), UTC)!;
    expect(mapped.externalId).toBe(dataPointName('weight', 'w1'));
    expect(mapped.identitySource).toBe('PROVIDER');
  });

  it('does the same for a session', () => {
    const sleep = mapSleepSession(sleepSession() as never, UTC)!;
    expect(sleep.identitySource).toBe('PROVIDER');
    expect(sleep.externalId).toBe(dataPointName('sleep', 'sleep-1'));

    const workout = mapExerciseSession(exerciseSession() as never, UTC)!;
    expect(workout.identitySource).toBe('PROVIDER');
    expect(workout.externalId).toBe(dataPointName('exercise', '8896720705097069096'));
  });
});

describe('mapping a point that has no name', () => {
  it('imports it, with an identity of CUT OS’s own', () => {
    const mapped = mapDataPoint(stepsDay('2026-08-29', 8421) as never, spec('steps'), UTC)!;
    expect(mapped).not.toBeNull();
    expect(mapped.value).toBe(8421);
    expect(mapped.identitySource).toBe('DERIVED');
    expect(isDerivedExternalId(mapped.externalId)).toBe(true);
  });

  it('mints the same identity when the same point is synced again', () => {
    const first = mapDataPoint(stepsDay('2026-08-29', 8421) as never, spec('steps'), UTC)!;
    const second = mapDataPoint(stepsDay('2026-08-29', 8421) as never, spec('steps'), UTC)!;
    expect(second.externalId).toBe(first.externalId);
    expect(second.contentVersion).toBe(first.contentVersion);
  });

  it('gives several nameless points in one response several identities', () => {
    const days = ['2026-08-27', '2026-08-28', '2026-08-29']
      .map((date, i) => mapDataPoint(
        stepsDay(date, 5000 + i) as never, spec('steps'), UTC,
      )!);
    expect(new Set(days.map((d) => d.externalId)).size).toBe(3);
  });

  it('keeps a nameless point apart from a named one', () => {
    const named = mapDataPoint(
      daily('daily-resting-heart-rate', 'rhr1', '2026-08-29', { beatsPerMinute: 54 }) as never,
      spec('daily-resting-heart-rate'), UTC,
    )!;
    const anonymous = mapDataPoint(
      namelessDaily('daily-resting-heart-rate', '2026-08-29', { beatsPerMinute: 54 }) as never,
      spec('daily-resting-heart-rate'), UTC,
    )!;
    expect(named.identitySource).toBe('PROVIDER');
    expect(anonymous.identitySource).toBe('DERIVED');
    expect(named.externalId).not.toBe(anonymous.externalId);
  });

  it('carries the raw point through untouched, name or no name', () => {
    // §17: the payload is what the provider sent, before anything interpreted
    // it. Minting an identity must not put one INTO the record.
    const raw = stepsDay('2026-08-29', 8421);
    const mapped = mapDataPoint(raw as never, spec('steps'), UTC)!;
    expect(mapped.payload).toEqual(raw);
    expect(mapped.payload).not.toHaveProperty('name');
  });

  it('identifies a nameless sample by its instant', () => {
    const morning = mapDataPoint(
      namelessSample('weight', '2026-08-29T07:00:00Z', { kilograms: 84.2 }) as never,
      spec('weight'), UTC,
    )!;
    const evening = mapDataPoint(
      namelessSample('weight', '2026-08-29T19:00:00Z', { kilograms: 84.9 }) as never,
      spec('weight'), UTC,
    )!;
    expect(morning.externalId).toContain('t=2026-08-29T07:00:00.000Z');
    expect(morning.externalId).not.toBe(evening.externalId);
  });

  it('identifies a nameless session by its interval', () => {
    const sleep = mapSleepSession(sleepSession({ name: null }) as never, UTC)!;
    expect(sleep.identitySource).toBe('DERIVED');
    expect(sleep.externalId).toContain('i=2026-08-28T22:30:00.000Z..2026-08-29T06:30:00.000Z');

    const workout = mapExerciseSession(exerciseSession({ name: null }) as never, UTC)!;
    expect(workout.identitySource).toBe('DERIVED');
    expect(workout.durationMinutes).toBe(65);
  });

  it('separates two zones of one interval, which share everything else', () => {
    // time-in-heart-rate-zone returns one point PER ZONE over one interval from
    // one device. Without the registry's discriminator all five mint the same
    // id and four are refused by the idempotency index - silently.
    const zone = (name: string) => mapDataPoint(
      namelessInterval(
        'time-in-heart-rate-zone',
        '2026-08-29T10:00:00Z', '2026-08-29T11:00:00Z',
        { zone: name, duration: '900s' },
      ) as never,
      spec('time-in-heart-rate-zone'), UTC,
    )!;
    expect(zone('FAT_BURN').externalId).not.toBe(zone('CARDIO').externalId);
    expect(zone('FAT_BURN').externalId).toContain('FAT_BURN');
  });

  it('still refuses a point that cannot say when it was measured', () => {
    // Unchanged, and the reason is unchanged: a record with no time has no day
    // to land on, nothing to correlate with, and nothing to mint an id from.
    // Filing it under today would be a fabricated timestamp.
    expect(mapDataPoint({ weight: { kilograms: 80 } } as never, spec('weight'), UTC)).toBeNull();
    expect(mapDataPoint({} as never, spec('weight'), UTC)).toBeNull();
  });

  it('does not refuse a point merely for having no name', () => {
    const point = namelessSample('body-fat', '2026-08-29T07:00:00Z', { percentage: 19.4 });
    expect(mapDataPoint(point as never, spec('body-fat'), UTC)).not.toBeNull();
  });

  it('reads a nameless interval that carries a true zero', () => {
    // The true-zeros rule is about the body, not the identity, and it has to
    // keep working for a point that arrived without a name.
    const point = namelessInterval(
      'steps', '2026-08-29T09:00:00Z', '2026-08-29T09:01:00Z', {},
    );
    const mapped = mapDataPoint(point as never, spec('steps'), UTC)!;
    expect(mapped.value).toBe(0);
    expect(mapped.trueZero).toBe(true);
  });
});

describe('a mixed response', () => {
  it('lands both kinds, each with the identity it deserves', () => {
    const page = parseDataPoints([
      sample('weight', 'w1', '2026-08-29T07:00:00Z', { kilograms: 84.2 }),
      namelessSample('weight', '2026-08-29T19:00:00Z', { kilograms: 84.9 }),
      interval('steps', 's1', '2026-08-29T00:00:00Z', '2026-08-30T00:00:00Z', { countSum: '10' }),
      stepsDay('2026-08-28', 6210),
    ]);
    expect(page.rejected).toHaveLength(0);

    const weights = page.points.slice(0, 2)
      .map((p) => mapDataPoint(p, spec('weight'), UTC)!);
    expect(weights.map((w) => w.identitySource)).toEqual(['PROVIDER', 'DERIVED']);

    const steps = page.points.slice(2)
      .map((p) => mapDataPoint(p, spec('steps'), UTC)!);
    expect(steps.map((s) => s.identitySource)).toEqual(['PROVIDER', 'DERIVED']);
    expect(new Set(page.points.map((p, i) => (i < 2
      ? mapDataPoint(p, spec('weight'), UTC)!.externalId
      : mapDataPoint(p, spec('steps'), UTC)!.externalId))).size).toBe(4);
  });
});
