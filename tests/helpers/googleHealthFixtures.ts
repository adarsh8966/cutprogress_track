/**
 * A fake Google Health API, and the data points to feed it.
 *
 * Modelled on tests/helpers/hevyFixtures.ts: a `fetch` implementation over an
 * in-memory store, so the client, the retry logic, the pagination and the whole
 * sync engine can be exercised with no network and no credentials.
 *
 * THE SHAPES ARE THE OBSERVED ONES. The exercise data point below is the
 * response captured in the API's own codelab, misspelling and all
 * (`distanceMillimiters`, where the guide says `distanceMillimeters`). Using
 * the real shape is the point: a fixture built from the prose would agree with
 * a mapper built from the prose and neither would agree with the API.
 *
 * AND SOME OF THEM HAVE NO `name`. Google documents DataPoint.name as supported
 * for a subset of identifiable data types only; the steps list and rollup
 * responses carry a `dataSource` and a body and nothing else. The nameless
 * builders below produce exactly that, because the fixtures that had one on
 * every point are why a schema requiring it passed every test and then rejected
 * the first real response.
 */

/** users/{uid}/dataTypes/{type}/dataPoints/{id} - the stable external id. */
export function dataPointName(dataType: string, id: string): string {
  return `users/2515055256096816351/dataTypes/${dataType}/dataPoints/${id}`;
}

/** The default recording source, as the observed responses carry it. */
export const FITBIT_SOURCE = {
  recordingMethod: 'AUTOMATICALLY_RECORDED',
  platform: 'FITBIT',
} as const;

/** A Sample record: an instant and a value. */
export function sample(
  dataType: string,
  id: string,
  physicalTime: string,
  body: Record<string, unknown>,
  updateTime?: string,
): Record<string, unknown> {
  const key = dataType.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  return {
    name: dataPointName(dataType, id),
    dataSource: { recordingMethod: 'AUTOMATICALLY_RECORDED', platform: 'FITBIT' },
    [key]: {
      sampleTime: { physicalTime },
      ...body,
      ...(updateTime ? { updateTime } : {}),
    },
  };
}

/** A Daily record: a civil date and a value, with no instant at all. */
export function daily(
  dataType: string,
  id: string,
  date: string,
  body: Record<string, unknown>,
  updateTime?: string,
): Record<string, unknown> {
  const key = dataType.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  const [year, month, day] = date.split('-').map(Number);
  return {
    name: dataPointName(dataType, id),
    dataSource: { recordingMethod: 'AUTOMATICALLY_RECORDED', platform: 'FITBIT' },
    [key]: {
      date: { year, month, day },
      ...body,
      ...(updateTime ? { updateTime } : {}),
    },
  };
}

/** An Interval record, as the rollup endpoints return them. */
export function interval(
  dataType: string,
  id: string,
  startTime: string,
  endTime: string,
  body: Record<string, unknown>,
  updateTime?: string,
): Record<string, unknown> {
  const key = dataType.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  return {
    name: dataPointName(dataType, id),
    dataSource: { recordingMethod: 'AUTOMATICALLY_RECORDED', platform: 'FITBIT' },
    [key]: {
      interval: { startTime, startUtcOffset: '0s', endTime, endUtcOffset: '0s' },
      ...body,
      ...(updateTime ? { updateTime } : {}),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The nameless shapes, which are the majority.                                */
/* -------------------------------------------------------------------------- */

/** The body key a data point nests its measurement under. */
function key(dataType: string): string {
  return dataType.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * A Sample with no `name`: a `dataSource` and a body, and that is all.
 *
 * `dataSource` is overridable and may be omitted entirely, because a real
 * response is under no obligation to describe the device - and an identity that
 * needs it to be present is an identity that breaks on the first point that
 * leaves it out.
 */
export function namelessSample(
  dataType: string,
  physicalTime: string,
  body: Record<string, unknown>,
  dataSource: Record<string, unknown> | null = { ...FITBIT_SOURCE },
): Record<string, unknown> {
  return {
    ...(dataSource === null ? {} : { dataSource }),
    [key(dataType)]: { sampleTime: { physicalTime }, ...body },
  };
}

/** A Daily record with no `name`: a civil date and a value. */
export function namelessDaily(
  dataType: string,
  date: string,
  body: Record<string, unknown>,
  dataSource: Record<string, unknown> | null = { ...FITBIT_SOURCE },
): Record<string, unknown> {
  const [year, month, day] = date.split('-').map(Number);
  return {
    ...(dataSource === null ? {} : { dataSource }),
    [key(dataType)]: { date: { year, month, day }, ...body },
  };
}

/** An Interval record with no `name`, as the rollup endpoints return them. */
export function namelessInterval(
  dataType: string,
  startTime: string,
  endTime: string,
  body: Record<string, unknown>,
  dataSource: Record<string, unknown> | null = { ...FITBIT_SOURCE },
): Record<string, unknown> {
  return {
    ...(dataSource === null ? {} : { dataSource }),
    [key(dataType)]: {
      interval: { startTime, startUtcOffset: '0s', endTime, endUtcOffset: '0s' },
      ...body,
    },
  };
}

/**
 * A day of steps, in the shape the current API actually answers with.
 *
 * THE FIXTURE THIS WHOLE FIX EXISTS FOR. No `name`; a `dataSource`; the count
 * as a STRING, because the API serialises 64-bit integers that way to preserve
 * precision; and the day expressed as an interval with its UTC offsets, which
 * is what `dailyRollUp` returns once it has reconciled them.
 */
export function stepsDay(
  date: string,
  count: number,
  options: {
    /**
     * The offset in force where the day was lived, in seconds.
     *
     * The interval instants are derived from it, so a day is the user's day and
     * not UTC's - -14400 (New York in August) makes the 29th run from 04:00Z to
     * 04:00Z, which is what the rollup endpoint actually returns once it has
     * reconciled the offsets.
     */
    utcOffsetSeconds?: number;
    dataSource?: Record<string, unknown> | null;
  } = {},
): Record<string, unknown> {
  const offsetSeconds = options.utcOffsetSeconds ?? 0;
  const source = options.dataSource === undefined
    ? { ...FITBIT_SOURCE }
    : options.dataSource;
  const startMs = Date.parse(`${date}T00:00:00Z`) - offsetSeconds * 1000;
  const offset = `${offsetSeconds}s`;
  return {
    ...(source === null ? {} : { dataSource: source }),
    steps: {
      interval: {
        startTime: new Date(startMs).toISOString(),
        startUtcOffset: offset,
        endTime: new Date(startMs + 86_400_000).toISOString(),
        endUtcOffset: offset,
      },
      // A string, because the API serialises 64-bit integers that way.
      countSum: String(count),
    },
  };
}

/**
 * An exercise session, in the shape the codelab actually returned.
 *
 * Note `distanceMillimiters`: that is the API's spelling, not a typo here.
 */
export function exerciseSession(overrides: {
  id?: string;
  /** Explicitly null for a session the API sent with no resource name. */
  name?: string | null;
  startTime?: string;
  endTime?: string;
  exerciseType?: string;
  displayName?: string;
  activeDuration?: string;
  caloriesKcal?: number;
  distanceMm?: number;
  steps?: string;
  averageHeartRate?: string;
  activeZoneMinutes?: string;
  heartRateZoneDurations?: Record<string, string>;
  hasGps?: boolean;
  updateTime?: string;
} = {}): Record<string, unknown> {
  const startTime = overrides.startTime ?? '2026-08-29T10:02:00Z';
  const endTime = overrides.endTime ?? '2026-08-29T11:07:00Z';
  const name = overrides.name === undefined
    ? dataPointName('exercise', overrides.id ?? '8896720705097069096')
    : overrides.name;
  return {
    ...(name === null ? {} : { name }),
    dataSource: { recordingMethod: 'AUTOMATICALLY_RECORDED', platform: 'FITBIT' },
    exercise: {
      interval: {
        startTime, startUtcOffset: '0s', endTime, endUtcOffset: '0s',
      },
      exerciseType: overrides.exerciseType ?? 'WEIGHTLIFTING',
      displayName: overrides.displayName ?? 'Weights',
      activeDuration: overrides.activeDuration ?? '3900s',
      metricsSummary: {
        ...(overrides.caloriesKcal === undefined
          ? {} : { caloriesKcal: overrides.caloriesKcal }),
        ...(overrides.distanceMm === undefined
          ? {} : { distanceMillimiters: overrides.distanceMm }),
        ...(overrides.steps === undefined ? {} : { steps: overrides.steps }),
        ...(overrides.averageHeartRate === undefined
          ? {} : { averageHeartRateBeatsPerMinute: overrides.averageHeartRate }),
        ...(overrides.activeZoneMinutes === undefined
          ? {} : { activeZoneMinutes: overrides.activeZoneMinutes }),
        ...(overrides.heartRateZoneDurations === undefined
          ? {} : { heartRateZoneDurations: overrides.heartRateZoneDurations }),
      },
      exerciseMetadata: overrides.hasGps ? { hasGps: true } : {},
      exerciseEvents: [
        { eventTime: startTime, eventUtcOffset: '0s', exerciseEventType: 'START' },
        { eventTime: endTime, eventUtcOffset: '0s', exerciseEventType: 'STOP' },
      ],
      updateTime: overrides.updateTime ?? '2026-08-29T12:00:00Z',
    },
  };
}

/** A sleep session with stages, in the shape the sleep guide documents. */
export function sleepSession(overrides: {
  id?: string;
  /** Explicitly null for a night the API sent with no resource name. */
  name?: string | null;
  startTime?: string;
  endTime?: string;
  stages?: { startTime: string; endTime: string; type: string }[];
  shortAwakenings?: { startTime: string; endTime: string; type: string }[];
  type?: string;
  updateTime?: string;
} = {}): Record<string, unknown> {
  const startTime = overrides.startTime ?? '2026-08-28T22:30:00Z';
  const endTime = overrides.endTime ?? '2026-08-29T06:30:00Z';
  const name = overrides.name === undefined
    ? dataPointName('sleep', overrides.id ?? 'sleep-1')
    : overrides.name;
  return {
    ...(name === null ? {} : { name }),
    dataSource: { recordingMethod: 'AUTOMATICALLY_RECORDED', platform: 'FITBIT' },
    sleep: {
      interval: {
        startTime, startUtcOffset: '0s', endTime, endUtcOffset: '0s',
      },
      type: overrides.type ?? 'STAGES',
      stages: overrides.stages ?? [
        { startTime: '2026-08-28T22:30:00Z', endTime: '2026-08-28T23:45:00Z', type: 'LIGHT' },
        { startTime: '2026-08-28T23:45:00Z', endTime: '2026-08-29T01:15:00Z', type: 'DEEP' },
        { startTime: '2026-08-29T01:15:00Z', endTime: '2026-08-29T02:00:00Z', type: 'AWAKE' },
        { startTime: '2026-08-29T02:00:00Z', endTime: '2026-08-29T04:00:00Z', type: 'REM' },
        { startTime: '2026-08-29T04:00:00Z', endTime: '2026-08-29T06:30:00Z', type: 'LIGHT' },
      ],
      ...(overrides.shortAwakenings ? { shortAwakenings: overrides.shortAwakenings } : {}),
      updateTime: overrides.updateTime ?? '2026-08-29T07:00:00Z',
    },
  };
}

/** Heart-rate samples, one per interval, across a window. */
export function heartRateSamples(
  from: string,
  count: number,
  bpmAt: (index: number) => number,
  everyMs = 60_000,
): Record<string, unknown>[] {
  const start = Date.parse(from);
  return Array.from({ length: count }, (_, i) =>
    sample(
      'heart-rate',
      `hr-${i}`,
      new Date(start + i * everyMs).toISOString(),
      { beatsPerMinute: String(bpmAt(i)) },
    ));
}

export interface FakeApiOptions {
  /**
   * Data points by data type. Everything else answers empty.
   *
   * `unknown[]`, not an array of objects: a test has to be able to put a
   * genuinely malformed element in a page - a string, a null, a point whose
   * `dataSource` is not an object - and assert that its neighbours still
   * import. A fixture type that can only express well-formed responses is a
   * fixture type that cannot test the interesting case.
   */
  points?: Record<string, unknown[]>;
  identity?: { healthUserId?: string; googleUserId?: string };
  /** Data types that should fail, and how. */
  fail?: Record<string, { status: number; body?: string }>;
  /** Records requests, so a test can assert what was asked for. */
  onRequest?: (url: string, init?: RequestInit) => void;
  /** Force pagination: pages of this size. */
  pageSize?: number;
  /** Fail the first N requests with a 429, to exercise the retry path. */
  rateLimitFirst?: number;
}

/**
 * A fetch that answers like the Google Health API.
 *
 * Honours pagination through nextPageToken, distinguishes the list and
 * dailyRollUp endpoints, and can be told to fail one data type so a partial
 * failure can be tested without breaking the whole run.
 */
export function fakeGoogleHealth(options: FakeApiOptions = {}): typeof fetch {
  const points = options.points ?? {};
  let rateLimited = 0;

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    options.onRequest?.(url, init);

    if (options.rateLimitFirst && rateLimited < options.rateLimitFirst) {
      rateLimited += 1;
      return new Response('{"error":"rate limited"}', {
        status: 429, headers: { 'retry-after': '0' },
      });
    }

    if (url.includes('/users/me/identity')) {
      return new Response(JSON.stringify({
        healthUserId: options.identity?.healthUserId ?? 'health-user-1',
        googleUserId: options.identity?.googleUserId ?? 'google-user-1',
      }), { status: 200 });
    }

    const match = url.match(/\/dataTypes\/([a-z0-9-]+)\/dataPoints/);
    const dataType = match?.[1] ?? null;
    if (dataType === null) return new Response('{}', { status: 404 });

    const failure = options.fail?.[dataType];
    if (failure) {
      return new Response(failure.body ?? '{"error":"refused"}', { status: failure.status });
    }

    const all = points[dataType] ?? [];
    const size = options.pageSize ?? (all.length || 1);
    const token = new URL(url, 'https://x').searchParams.get('pageToken');
    const offset = token === null ? 0 : Number(token);
    const page = all.slice(offset, offset + size);
    const next = offset + size < all.length ? String(offset + size) : '';

    return new Response(JSON.stringify({
      dataPoints: page,
      nextPageToken: next,
    }), { status: 200 });
  }) as typeof fetch;
}

/** A token endpoint that answers an exchange or a refresh. */
export function fakeTokenEndpoint(options: {
  accessToken?: string;
  refreshToken?: string | null;
  scope?: string;
  expiresIn?: number;
  status?: number;
  body?: string;
} = {}): typeof fetch {
  return (async () => {
    if (options.status && options.status !== 200) {
      return new Response(options.body ?? '{"error":"invalid_grant"}', {
        status: options.status,
      });
    }
    return new Response(JSON.stringify({
      access_token: options.accessToken ?? 'access-token-1',
      expires_in: options.expiresIn ?? 3599,
      ...(options.refreshToken === null
        ? {} : { refresh_token: options.refreshToken ?? 'refresh-token-1' }),
      scope: options.scope
        ?? 'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly'
          + ' https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly'
          + ' https://www.googleapis.com/auth/googlehealth.sleep.readonly'
          + ' https://www.googleapis.com/auth/googlehealth.location.readonly',
      token_type: 'Bearer',
      refresh_token_expires_in: 604799,
    }), { status: 200 });
  }) as typeof fetch;
}

/** All four scopes, as a granted list. */
export const ALL_SCOPES = [
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
  'https://www.googleapis.com/auth/googlehealth.location.readonly',
];

/** A 32-byte key for the token cipher, fixed so tests are deterministic. */
export const TEST_TOKEN_KEY = Buffer.alloc(32, 7);
