/**
 * The registry, the filters, and the client's error classification.
 *
 * The registry is the one place a data type is described, so most of what could
 * go wrong with it is a coherence problem: a filter name that does not match
 * the path name, a scope that is not one of the four, a destination with no
 * metric. Each of those produces a 400 or a silently-dropped measurement at
 * runtime, and each is checkable here for nothing.
 */
import { describe, it, expect } from 'vitest';
import {
  DATA_TYPES, DATA_TYPE_BY_ID, dataTypesForScopes, windowDaysFor,
} from '@/lib/integrations/googleHealth/registry';
import { windowFilter, instantFilter, filterFieldFor } from '@/lib/integrations/googleHealth/filters';
import {
  createGoogleHealthClient, GoogleHealthError, retryDelayMs,
} from '@/lib/integrations/googleHealth/client';
import { ALL_SCOPES, fakeGoogleHealth, interval } from '../helpers/googleHealthFixtures';
import { REQUESTED_SCOPES } from '@/lib/integrations/googleHealth/scopes';

describe('the registry is internally coherent', () => {
  it('describes a useful number of data types', () => {
    // A guard that silently checks nothing is worse than no guard.
    expect(DATA_TYPES.length).toBeGreaterThan(15);
  });

  it('has a unique id for every entry', () => {
    const ids = DATA_TYPES.map((s) => s.dataType);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('uses kebab case in the path and snake case in the filter', () => {
    // Getting these the wrong way round is a 400 with INVALID_DATA_POINT_FILTER,
    // which is why they are separate fields rather than one derived from the
    // other at a call site.
    for (const spec of DATA_TYPES) {
      expect(spec.dataType).toMatch(/^[a-z0-9-]+$/);
      expect(spec.filterField).toMatch(/^[a-z0-9_]+$/);
      expect(spec.filterField).toBe(spec.dataType.replaceAll('-', '_'));
    }
  });

  it('names only scopes this application actually requests', () => {
    const requested = new Set(REQUESTED_SCOPES.map((s) => s.scope));
    for (const spec of DATA_TYPES) {
      expect(requested.has(spec.scope), `${spec.dataType} names an unrequested scope`)
        .toBe(true);
    }
  });

  it('gives every entry a human label', () => {
    for (const spec of DATA_TYPES) {
      expect(spec.label.length).toBeGreaterThan(2);
    }
  });

  it('gives every unmapped entry a note saying what it would take to map it', () => {
    for (const spec of DATA_TYPES) {
      if (spec.destination.kind !== 'UNMAPPED') continue;
      expect(spec.destination.note.length).toBeGreaterThan(30);
    }
  });

  it('applies the documented 14-day ceiling to the four short-range types', () => {
    for (const id of ['heart-rate', 'active-minutes', 'total-calories']) {
      expect(DATA_TYPE_BY_ID[id]!.maxRangeDays, id).toBe(14);
    }
  });

  it('never lets a window exceed 90 days, even with no documented ceiling', () => {
    for (const spec of DATA_TYPES) {
      expect(windowDaysFor(spec)).toBeLessThanOrEqual(90);
    }
  });

  it('caps exercise and sleep at the documented page size of 25', () => {
    expect(DATA_TYPE_BY_ID['exercise']!.pageSize).toBe(25);
    expect(DATA_TYPE_BY_ID['sleep']!.pageSize).toBe(25);
  });

  it('offers only the data types the granted scopes permit', () => {
    const sleepOnly = dataTypesForScopes([ALL_SCOPES[2]!]);
    expect(sleepOnly.map((s) => s.dataType)).toEqual(['sleep']);
    expect(dataTypesForScopes([])).toHaveLength(0);
    expect(dataTypesForScopes(ALL_SCOPES).length).toBeGreaterThan(15);
  });
});

describe('filter expressions', () => {
  it('uses the field the record type requires', () => {
    expect(filterFieldFor(DATA_TYPE_BY_ID['steps']!))
      .toBe('steps.interval.civil_start_time');
    expect(filterFieldFor(DATA_TYPE_BY_ID['weight']!))
      .toBe('weight.sample_time.civil_time');
    expect(filterFieldFor(DATA_TYPE_BY_ID['daily-resting-heart-rate']!))
      .toBe('daily_resting_heart_rate.date');
  });

  it('filters sleep on when it ENDED', () => {
    // A night that starts on the 3rd ends on the 4th, and the 4th is the day it
    // belongs to - which is also what sleep_records.local_date has always meant.
    expect(filterFieldFor(DATA_TYPE_BY_ID['sleep']!))
      .toBe('sleep.interval.civil_end_time');
  });

  it('builds a closed-open window with only the two supported operators', () => {
    const filter = windowFilter(DATA_TYPE_BY_ID['steps']!, '2026-08-01', '2026-08-15');
    expect(filter).toBe(
      'steps.interval.civil_start_time >= "2026-08-01" '
      + 'AND steps.interval.civil_start_time < "2026-08-15"',
    );
    // Anything but >= and < is INVALID_DATA_POINT_FILTER_RESTRICTION_COMPARATOR.
    expect(filter).not.toMatch(/[^>]=[^"]|<=|>[^=]/);
    // OR is INVALID_DATA_POINT_FILTER_EXPRESSION_STRUCTURE.
    expect(filter).not.toContain(' OR ');
  });

  it('never mixes civil and physical time in one expression', () => {
    // Mixing them is INVALID_DATA_POINT_FILTER_MIXED_TIME_RESTRICTIONS - a
    // documented 400 that most readers have not met.
    const civil = windowFilter(DATA_TYPE_BY_ID['steps']!, '2026-08-01', '2026-08-15');
    expect(civil).not.toContain('Z"');
    const physical = instantFilter(
      DATA_TYPE_BY_ID['heart-rate']!,
      '2026-08-29T10:00:00Z', '2026-08-29T11:00:00Z',
    );
    expect(physical).not.toContain('civil');
    expect(physical).toContain('Z"');
  });

  it('names the data type in the path form nowhere in a filter', () => {
    for (const spec of DATA_TYPES) {
      if (!spec.dataType.includes('-')) continue;
      expect(windowFilter(spec, '2026-08-01', '2026-08-02')).not.toContain(spec.dataType);
    }
  });
});

describe('the client', () => {
  const client = (fetchImpl: typeof fetch, maxAttempts = 3) => createGoogleHealthClient({
    accessToken: async () => 'access-token',
    baseUrl: 'https://health.googleapis.com',
    fetch: fetchImpl,
    sleep: async () => {},
    maxAttempts,
  });

  it('sends the data type kebab-cased in the path', async () => {
    const seen: string[] = [];
    await client(fakeGoogleHealth({
      points: { 'daily-resting-heart-rate': [] },
      onRequest: (url) => seen.push(url),
    })).list({ dataType: 'daily-resting-heart-rate' });
    expect(seen[0]).toContain('/dataTypes/daily-resting-heart-rate/dataPoints');
  });

  it('follows nextPageToken to the end', async () => {
    const points = Array.from({ length: 7 }, (_, i) =>
      interval('steps', `s${i}`, '2026-08-29T00:00:00Z', '2026-08-29T01:00:00Z', { count: 10 }));
    const api = client(fakeGoogleHealth({ points: { steps: points }, pageSize: 3 }));

    const collected: unknown[] = [];
    let token: string | null = null;
    do {
      const page: Awaited<ReturnType<typeof api.list>> =
        await api.list({ dataType: 'steps', pageToken: token });
      collected.push(...page.dataPoints);
      token = page.nextPageToken;
    } while (token !== null);

    expect(collected).toHaveLength(7);
  });

  it('treats an empty nextPageToken as the end, not as another page', async () => {
    const page = await client(fakeGoogleHealth({ points: { steps: [] } }))
      .list({ dataType: 'steps' });
    expect(page.nextPageToken).toBeNull();
  });

  it('retries a 429 and then succeeds', async () => {
    const page = await client(fakeGoogleHealth({
      points: { steps: [] }, rateLimitFirst: 2,
    })).list({ dataType: 'steps' });
    expect(page.dataPoints).toEqual([]);
  });

  it('gives up on a 429 after the attempt limit, without losing the reason', async () => {
    await expect(
      client(fakeGoogleHealth({ points: { steps: [] }, rateLimitFirst: 99 }))
        .list({ dataType: 'steps' }),
    ).rejects.toMatchObject({ kind: 'RATE_LIMIT' });
  });

  it('separates a missing scope from a refused token', async () => {
    // Both are 403. One is fixed by reconnecting and costs one data type; the
    // other is not, and telling the user to reconnect would waste their time.
    await expect(client(fakeGoogleHealth({
      fail: { sleep: { status: 403, body: '{"reason":"MISSING_OAUTH_SCOPE"}' } },
    })).list({ dataType: 'sleep' })).rejects.toMatchObject({ kind: 'SCOPE' });

    await expect(client(fakeGoogleHealth({
      fail: { sleep: { status: 403, body: '{"message":"caller has no permission"}' } },
    })).list({ dataType: 'sleep' })).rejects.toMatchObject({ kind: 'AUTH' });
  });

  it('treats an expired token as AUTH, which does not retry', async () => {
    await expect(client(fakeGoogleHealth({
      fail: { steps: { status: 401 } },
    })).list({ dataType: 'steps' })).rejects.toMatchObject({
      kind: 'AUTH', retryable: false,
    });
  });

  it('isolates the failures that cost one data type from those that cost all', () => {
    expect(new GoogleHealthError('SCOPE', '').isolated).toBe(true);
    expect(new GoogleHealthError('BAD_REQUEST', '').isolated).toBe(true);
    // A refused credential would fail every remaining data type the same way.
    expect(new GoogleHealthError('AUTH', '').isolated).toBe(false);
    expect(new GoogleHealthError('SERVER', '').isolated).toBe(false);
  });

  it('retries only what could plausibly work on a second attempt', () => {
    expect(new GoogleHealthError('RATE_LIMIT', '').retryable).toBe(true);
    expect(new GoogleHealthError('SERVER', '').retryable).toBe(true);
    expect(new GoogleHealthError('NETWORK', '').retryable).toBe(true);
    expect(new GoogleHealthError('AUTH', '').retryable).toBe(false);
    expect(new GoogleHealthError('MALFORMED', '').retryable).toBe(false);
  });

  it('honours Retry-After, capped, and backs off otherwise', () => {
    expect(retryDelayMs(1, '5')).toBe(5000);
    // A header asking for ten minutes should end the run, not hold a server
    // action open.
    expect(retryDelayMs(1, '600')).toBe(30_000);
    expect(retryDelayMs(1, null)).toBe(500);
    expect(retryDelayMs(3, null)).toBe(2000);
  });

  it('never puts a token in an error message', () => {
    for (const kind of ['AUTH', 'SCOPE', 'RATE_LIMIT', 'NETWORK', 'SERVER',
      'MALFORMED', 'NOT_FOUND', 'BAD_REQUEST'] as const) {
      const message = new GoogleHealthError(kind, 'detail').userMessage;
      expect(message).not.toContain('Bearer');
      expect(message.length).toBeGreaterThan(15);
    }
  });

  it('reports an answer that is not JSON as malformed, and does not retry it', async () => {
    const html = (async () => new Response('<!DOCTYPE html>', { status: 200 })) as typeof fetch;
    await expect(client(html).list({ dataType: 'steps' }))
      .rejects.toMatchObject({ kind: 'MALFORMED' });
  });

  it('requires alt=media on a TCX export, or the server sends JSON instead', async () => {
    const seen: string[] = [];
    await client((async (url: RequestInfo | URL) => {
      seen.push(String(url));
      return new Response('<TrainingCenterDatabase/>', { status: 200 });
    }) as typeof fetch).exportExerciseTcx('users/1/dataTypes/exercise/dataPoints/abc');
    expect(seen[0]).toContain('exportExerciseTcx');
    expect(seen[0]).toContain('alt=media');
  });
});
