/**
 * The Hevy client: what it asks for, and what it does with the answer.
 *
 * `fetch` and `sleep` are injected, so every path here - including rate
 * limiting, retry and backoff - runs with no network, no credentials and no
 * real waiting.
 *
 * The last two tests are not about behaviour at all. They assert what the
 * module CANNOT do: it has no method that writes to Hevy, and none that reads
 * body measurements. Those are §4 and §6 of the brief, and a test is how they
 * stay true after the next person adds a method.
 */
import { describe, it, expect, vi } from 'vitest';
import { createHevyClient, HevyError, retryDelayMs } from '@/lib/integrations/hevy/client';
import { codeOf } from '../helpers/source';

/**
 * Comments stripped, deliberately. This file's own header explains which
 * endpoints it declines to call, by name - so a grep over the raw text would
 * find /v1/body_measurements in the paragraph saying it is never requested.
 * What the module REFERENCES is the thing under test.
 */
const SOURCE = codeOf('lib/integrations/hevy/client.ts');

/** The documented workout payload, verbatim from the API documentation. */
const WORKOUT = {
  id: 'b459cba5-cd6d-463c-abd6-54f8eafcadcb',
  title: 'Morning Workout 💪',
  routine_id: 'b459cba5-cd6d-463c-abd6-54f8eafcadcb',
  description: 'Pushed myself to the limit today!',
  start_time: '2021-09-14T12:00:00Z',
  end_time: '2021-09-14T12:00:00Z',
  updated_at: '2021-09-14T12:00:00Z',
  created_at: '2021-09-14T12:00:00Z',
  exercises: [
    {
      index: 0,
      title: 'Bench Press (Barbell)',
      notes: 'Paid closer attention to form today. Felt great!',
      exercise_template_id: '05293BCA',
      supersets_id: 0,
      sets: [
        {
          index: 0,
          type: 'normal',
          weight_kg: 100,
          reps: 10,
          distance_meters: null,
          duration_seconds: null,
          rpe: 9.5,
          custom_metric: 50,
        },
      ],
    },
  ],
};

function ok(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers });
}

function fail(status: number, body = 'nope', headers: Record<string, string> = {}) {
  return new Response(body, { status, headers });
}

function client(
  responses: (() => Response | Promise<Response>)[],
  overrides: Partial<Parameters<typeof createHevyClient>[0]> = {},
) {
  const calls: string[] = [];
  const queue = [...responses];
  const requests: RequestInit[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(url));
    requests.push(init ?? {});
    const next = queue.shift();
    if (!next) throw new Error(`unexpected request: ${url}`);
    return next();
  }) as unknown as typeof fetch;

  return {
    calls,
    requests,
    api: createHevyClient({
      apiKey: 'test-key',
      baseUrl: 'https://api.example.test',
      fetch: fetchImpl,
      sleep: async () => {},
      ...overrides,
    }),
  };
}

describe('Hevy client', () => {
  it('sends the key in the api-key header, as the documentation specifies', async () => {
    const { api, requests, calls } = client([() => ok({ data: { id: 'u1', name: 'Ada', url: null } })]);
    await api.getUserInfo();

    expect(calls[0]).toBe('https://api.example.test/v1/user/info');
    const headers = requests[0]!.headers as Record<string, string>;
    expect(headers['api-key']).toBe('test-key');
    // Not a bearer token and not a query parameter: both would be a guess.
    expect(calls[0]).not.toContain('test-key');
  });

  it('reads a workout events page, updates and deletions together', async () => {
    const { api, calls } = client([
      () => ok({
        page: 1,
        page_count: 3,
        events: [
          { type: 'updated', workout: WORKOUT },
          { type: 'deleted', id: 'efe6801c', deleted_at: '2021-09-13T12:00:00Z' },
        ],
      }),
    ]);

    const page = await api.listWorkoutEvents({ since: '2026-08-01T00:00:00Z', page: 1 });

    expect(calls[0]).toContain('since=2026-08-01T00%3A00%3A00Z');
    expect(page.page_count).toBe(3);
    expect(page.events).toHaveLength(2);
    expect(page.events[0]).toMatchObject({ type: 'updated' });
    expect(page.events[1]).toMatchObject({ type: 'deleted', id: 'efe6801c' });
  });

  it('clamps pageSize to the documented ceilings rather than earning a 400', async () => {
    const events = client([() => ok({ page: 1, page_count: 1, events: [] })]);
    await events.api.listWorkoutEvents({ since: '1970-01-01T00:00:00Z', pageSize: 500 });
    expect(events.calls[0]).toContain('pageSize=10');

    const templates = client([
      () => ok({ page: 1, page_count: 1, exercise_templates: [] }),
    ]);
    await templates.api.listExerciseTemplates({ pageSize: 500 });
    expect(templates.calls[0]).toContain('pageSize=100');
  });

  it('refuses a page number below 1', async () => {
    const { api, calls } = client([() => ok({ page: 1, page_count: 1, events: [] })]);
    await api.listWorkoutEvents({ since: '1970-01-01T00:00:00Z', page: 0 });
    expect(calls[0]).toContain('page=1');
  });

  it('percent-encodes an id rather than pasting it into the path', async () => {
    const { api, calls } = client([() => ok(WORKOUT)]);
    await api.getWorkout('a b/../c');
    expect(calls[0]).toBe('https://api.example.test/v1/workouts/a%20b%2F..%2Fc');
  });

  it.each([
    [401, 'AUTH'],
    [403, 'AUTH'],
    [404, 'NOT_FOUND'],
    [400, 'BAD_REQUEST'],
  ])('classifies %i as %s and does not retry it', async (status, kind) => {
    const { api, calls } = client([() => fail(status)]);
    await expect(api.getWorkoutCount()).rejects.toMatchObject({ kind });
    // A wrong key does not become right on the second attempt.
    expect(calls).toHaveLength(1);
  });

  it('retries a 500 and succeeds on a later attempt', async () => {
    const { api, calls } = client([
      () => fail(500, 'boom'),
      () => fail(500, 'boom'),
      () => ok({ workout_count: 42 }),
    ]);
    await expect(api.getWorkoutCount()).resolves.toBe(42);
    expect(calls).toHaveLength(3);
  });

  it('gives up after the attempt limit and reports the server failure', async () => {
    const { api, calls } = client([
      () => fail(503), () => fail(503), () => fail(503),
    ]);
    await expect(api.getWorkoutCount()).rejects.toMatchObject({ kind: 'SERVER' });
    expect(calls).toHaveLength(3);
  });

  it('retries a rate limit and honours Retry-After when Hevy sends one', async () => {
    const waits: number[] = [];
    const { api } = client(
      [() => fail(429, 'slow down', { 'retry-after': '2' }), () => ok({ workout_count: 7 })],
      { sleep: async (ms: number) => { waits.push(ms); } },
    );
    await expect(api.getWorkoutCount()).resolves.toBe(7);
    expect(waits).toEqual([2000]);
  });

  it('backs off on its own when no Retry-After is sent', () => {
    // Rate limits are NOT documented for this API, so the fallback is a plain
    // bounded backoff rather than anything tuned to a published limit.
    expect(retryDelayMs(1, null)).toBe(500);
    expect(retryDelayMs(2, null)).toBe(1000);
    expect(retryDelayMs(3, null)).toBe(2000);
    // A header asking for ten minutes should fail the run, not hold it open.
    expect(retryDelayMs(1, '600')).toBe(30_000);
    expect(retryDelayMs(1, 'nonsense')).toBe(500);
  });

  it('retries a network failure, then reports it', async () => {
    const { api, calls } = client([
      () => { throw new Error('ECONNRESET'); },
      () => { throw new Error('ECONNRESET'); },
      () => { throw new Error('ECONNRESET'); },
    ]);
    await expect(api.getWorkoutCount()).rejects.toMatchObject({ kind: 'NETWORK' });
    expect(calls).toHaveLength(3);
  });

  it('reports a non-JSON body as malformed and does not retry it', async () => {
    // An HTML error page from a proxy will be an HTML error page next time too.
    const { api, calls } = client([
      () => new Response('<!DOCTYPE html><h1>Bad Gateway</h1>', { status: 200 }),
    ]);
    await expect(api.getWorkoutCount()).rejects.toMatchObject({ kind: 'MALFORMED' });
    expect(calls).toHaveLength(1);
  });

  it('reports a response that parses but does not match the documented shape', async () => {
    // The failure this prevents: `workout_count` renamed, read as undefined,
    // and reported as a real count of nothing.
    const { api } = client([() => ok({ total: 42 })]);
    await expect(api.getWorkoutCount()).rejects.toMatchObject({ kind: 'MALFORMED' });
  });

  it('never puts the API key in a message a user reads', () => {
    const error = new HevyError('AUTH', 'Invalid api-key: test-key-1234', 401);
    expect(error.userMessage).not.toContain('test-key-1234');
    expect(error.userMessage).toMatch(/HEVY_API_KEY/);
  });

  it('says which failures are worth retrying', () => {
    expect(new HevyError('RATE_LIMIT', '').retryable).toBe(true);
    expect(new HevyError('SERVER', '').retryable).toBe(true);
    expect(new HevyError('NETWORK', '').retryable).toBe(true);
    expect(new HevyError('AUTH', '').retryable).toBe(false);
    expect(new HevyError('MALFORMED', '').retryable).toBe(false);
    expect(new HevyError('BAD_REQUEST', '').retryable).toBe(false);
  });

  // -------------------------------------------------------------------------
  // What the client CANNOT do. Spec §4 and §6 of the integration brief.
  // -------------------------------------------------------------------------

  it('is read-only: it issues no request that is not a GET', () => {
    const methods = [...SOURCE.matchAll(/method:\s*'(\w+)'/g)].map((m) => m[1]);
    expect(methods.length).toBeGreaterThan(0);
    expect(new Set(methods)).toEqual(new Set(['GET']));
    // Hevy offers all four of these. None is reachable from here, so a sync
    // loop or an accidental write-back is not a bug that can be introduced by
    // calling the wrong method - there is no method to call.
    for (const forbidden of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(SOURCE).not.toContain(`method: '${forbidden}'`);
    }
  });

  it('cannot read body measurements at all', () => {
    // Hevy exposes /v1/body_measurements: weight, body fat, waist, hips, limbs.
    // CUT OS owns that data. There is no method here, so importing it is not a
    // mistake someone can make - it is a method someone would have to add.
    expect(SOURCE).not.toContain('body_measurements');
    const api = createHevyClient({ apiKey: 'k', baseUrl: 'https://x.test' });
    const surface = Object.keys(api).join(' ').toLowerCase();
    for (const forbidden of ['measurement', 'weight', 'bodyfat', 'nutrition', 'sleep']) {
      expect(surface).not.toContain(forbidden);
    }
  });
});
