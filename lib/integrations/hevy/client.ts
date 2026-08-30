/**
 * The Hevy API client.
 *
 * READ-ONLY BY CONSTRUCTION, NOT BY DISCIPLINE. Every method here is a GET, and
 * the methods that exist are the ones this integration uses. Hevy's API also
 * offers POST /v1/workouts, PUT /v1/workouts/{id}, POST /v1/routines and
 * POST /v1/exercise_templates; none has a method here, so writing back to Hevy
 * is not something a caller can do wrongly - it is something a caller cannot
 * express. The same holds for /v1/body_measurements, which exposes weight, body
 * fat, waist and limb measurements: CUT OS owns that data and Hevy must never
 * be a source for it (§4), so there is no method to call.
 *
 * NOTHING IS READ FROM THE ENVIRONMENT HERE. The key and base URL are handed in
 * by the caller, and `fetch` and `sleep` are injectable, so every path through
 * this file - including rate limiting and retry - is exercised by tests with no
 * network and no credentials. lib/integrations/hevy/env.ts is where the
 * environment is read, and it is `server-only`; this file is deliberately not,
 * because it is pure plumbing over an injected transport.
 *
 * A FAILURE IS CLASSIFIED, NOT FLATTENED. "Your key is wrong", "Hevy is down"
 * and "Hevy sent something this code does not understand" lead to three
 * different actions, and a sync that reports them all as "sync failed" leaves
 * the user with nowhere to go. HevyError carries which one it was.
 */
import {
  hevyWorkoutSchema, hevyWorkoutEventsPageSchema, hevyWorkoutCountSchema,
  hevyExerciseTemplateSchema, hevyExerciseTemplatesPageSchema, hevyUserInfoSchema,
  MAX_PAGE_SIZE,
  type HevyWorkout, type HevyWorkoutEventsPage, type HevyExerciseTemplate,
  type HevyUserInfo,
} from './types';

export type HevyErrorKind =
  /** The key was refused. Nothing retries past this. */
  | 'AUTH'
  /** Too many requests. Retryable, and the client already tried. */
  | 'RATE_LIMIT'
  /** The thing asked for is not there. Often not an error at all. */
  | 'NOT_FOUND'
  /** The request was malformed - a bug here, not a condition to wait out. */
  | 'BAD_REQUEST'
  /** Hevy failed. Retryable. */
  | 'SERVER'
  /** The request never got an answer. Retryable. */
  | 'NETWORK'
  /** An answer arrived that does not match the documented shape. */
  | 'MALFORMED';

export class HevyError extends Error {
  readonly kind: HevyErrorKind;
  readonly status: number | null;

  constructor(kind: HevyErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = 'HevyError';
    this.kind = kind;
    this.status = status;
  }

  /** True when trying the same request again could plausibly work. */
  get retryable(): boolean {
    return this.kind === 'RATE_LIMIT' || this.kind === 'SERVER' || this.kind === 'NETWORK';
  }

  /** A sentence for the person who pressed Sync. Never carries the key. */
  get userMessage(): string {
    switch (this.kind) {
      case 'AUTH':
        return 'Hevy refused the API key. Check HEVY_API_KEY against the key at '
          + 'hevy.com/settings?developer — the API needs Hevy Pro.';
      case 'RATE_LIMIT':
        return 'Hevy is rate limiting this account. Nothing was lost; try again shortly.';
      case 'NETWORK':
        return 'Could not reach Hevy. Nothing was changed; try again.';
      case 'SERVER':
        return 'Hevy returned a server error. Nothing was changed; try again later.';
      case 'MALFORMED':
        return `Hevy sent a response this app does not understand: ${this.message}`;
      case 'NOT_FOUND':
        return 'Hevy has no such record.';
      case 'BAD_REQUEST':
        return `Hevy rejected the request: ${this.message}`;
    }
  }
}

export interface HevyClientOptions {
  apiKey: string;
  baseUrl: string;
  /** Injected so tests run without a network. */
  fetch?: typeof fetch;
  /** Injected so a retry test does not actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Attempts for a retryable failure, the first included. */
  maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;

function clamp(value: number, max: number): number {
  return Math.max(1, Math.min(Math.trunc(value), max));
}

/**
 * How long to wait before retrying.
 *
 * `Retry-After` is honoured when Hevy sends one, because the service saying how
 * long is better than this code guessing. It is capped: a header asking for ten
 * minutes should fail the run and let the user retry, not hold a server action
 * open. Otherwise it backs off 500ms, 1s, 2s.
 */
export function retryDelayMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 30_000);
    }
  }
  return 500 * 2 ** (attempt - 1);
}

export function createHevyClient(options: HevyClientOptions) {
  const doFetch = options.fetch ?? fetch;
  const doSleep = options.sleep
    ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const base = options.baseUrl.replace(/\/+$/, '');

  function classify(status: number, body: string): HevyError {
    // 401 is not in the supplied documentation - it lists 400, 403, 404 and 500
    // - so both of the codes that can mean "this key is not allowed to do that"
    // are treated as an auth problem. Telling the user to check the key when
    // Hevy meant something subtler is a cheap mistake; telling them "sync
    // failed" when the key is wrong is not.
    if (status === 401 || status === 403) return new HevyError('AUTH', body, status);
    if (status === 429) return new HevyError('RATE_LIMIT', body, status);
    if (status === 404) return new HevyError('NOT_FOUND', body, status);
    if (status >= 500) return new HevyError('SERVER', body, status);
    return new HevyError('BAD_REQUEST', body || `Hevy returned ${status}.`, status);
  }

  async function request(path: string, query: Record<string, string | number> = {}) {
    const url = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value));
    }

    let lastError: HevyError | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await doFetch(url.toString(), {
          method: 'GET',
          headers: { 'api-key': options.apiKey, accept: 'application/json' },
        });
      } catch (error) {
        lastError = new HevyError(
          'NETWORK',
          error instanceof Error ? error.message : String(error),
        );
        if (attempt === maxAttempts) throw lastError;
        await doSleep(retryDelayMs(attempt, null));
        continue;
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const error = classify(response.status, body.slice(0, 300));
        if (!error.retryable || attempt === maxAttempts) throw error;
        lastError = error;
        await doSleep(retryDelayMs(attempt, response.headers.get('retry-after')));
        continue;
      }

      const text = await response.text();
      try {
        return JSON.parse(text) as unknown;
      } catch {
        // A body that is not JSON is not retryable: an HTML error page from a
        // proxy will be an HTML error page next time too.
        throw new HevyError(
          'MALFORMED',
          `expected JSON from ${path}, got ${text.slice(0, 120)}`,
          response.status,
        );
      }
    }

    /* c8 ignore next */
    throw lastError ?? new HevyError('NETWORK', `no response from ${path}`);
  }

  /** Parses a response, turning a shape mismatch into a reportable failure. */
  function parse<T>(
    schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: unknown } },
    value: unknown,
    what: string,
  ): T {
    const result = schema.safeParse(value);
    if (!result.success || result.data === undefined) {
      throw new HevyError('MALFORMED', `${what} did not match the documented shape`);
    }
    return result.data;
  }

  return {
    /**
     * Who the key belongs to. Writes nothing, and is the cheapest honest answer
     * to "is this configured correctly?" - which is a different question from
     * "did the last sync work".
     */
    async getUserInfo(): Promise<HevyUserInfo> {
      const body = await request('/v1/user/info');
      return parse(hevyUserInfoSchema, body, 'user info').data;
    },

    /** How many workouts the account holds. Used to sanity-check a backfill. */
    async getWorkoutCount(): Promise<number> {
      const body = await request('/v1/workouts/count');
      return parse(hevyWorkoutCountSchema, body, 'workout count').workout_count;
    },

    /**
     * One page of the change feed.
     *
     * The feed is the synchronisation mechanism: it reports updates AND
     * deletions since a timestamp, so a sync never has to download the whole
     * history to discover that nothing changed. Events come newest first, which
     * is the caller's problem to order - see sync.ts.
     */
    async listWorkoutEvents(
      params: { since: string; page?: number; pageSize?: number },
    ): Promise<HevyWorkoutEventsPage & { raw: unknown }> {
      const body = await request('/v1/workouts/events', {
        since: params.since,
        page: Math.max(1, Math.trunc(params.page ?? 1)),
        pageSize: clamp(params.pageSize ?? MAX_PAGE_SIZE.workoutEvents,
          MAX_PAGE_SIZE.workoutEvents),
      });
      // The UNTOUCHED body comes back alongside the parsed page.
      //
      // Parsing strips unknown keys, which is right for everything downstream -
      // a field Hevy adds must not break a sync, and body-shaped keys must not
      // reach the mapper. But spec §17 is about the other direction: the
      // original input is kept verbatim and forever, so that a mapping found to
      // be wrong in six months can be re-derived from what Hevy actually said,
      // including from a field this version of the code did not know existed.
      // Storing the parsed object instead would keep only what we already
      // understood, which is exactly the part that never needs recovering.
      return { ...parse(hevyWorkoutEventsPageSchema, body, 'workout events'), raw: body };
    },

    /**
     * One workout in full.
     *
     * The feed already carries the whole workout on an update, so this is the
     * repair path: when a feed page fails validation, one workout can be
     * re-read on its own rather than losing the whole page.
     */
    async getWorkout(workoutId: string): Promise<HevyWorkout> {
      const body = await request(`/v1/workouts/${encodeURIComponent(workoutId)}`);
      return parse(hevyWorkoutSchema, body, 'workout');
    },

    /**
     * One page of exercise templates.
     *
     * Where an auto-created exercise gets its muscle group and equipment, which
     * are NOT NULL in the catalog and are not carried on the workout payload.
     */
    async listExerciseTemplates(
      params: { page?: number; pageSize?: number } = {},
    ): Promise<{ page: number; pageCount: number; templates: HevyExerciseTemplate[] }> {
      const body = await request('/v1/exercise_templates', {
        page: Math.max(1, Math.trunc(params.page ?? 1)),
        pageSize: clamp(params.pageSize ?? MAX_PAGE_SIZE.exerciseTemplates,
          MAX_PAGE_SIZE.exerciseTemplates),
      });
      const page = parse(hevyExerciseTemplatesPageSchema, body, 'exercise templates');
      return {
        page: page.page,
        pageCount: page.page_count,
        templates: page.exercise_templates,
      };
    },

    /** One template, when the paged list did not carry it. */
    async getExerciseTemplate(templateId: string): Promise<HevyExerciseTemplate> {
      const body = await request(
        `/v1/exercise_templates/${encodeURIComponent(templateId)}`,
      );
      return parse(hevyExerciseTemplateSchema, body, 'exercise template');
    },
  };
}

export type HevyClient = ReturnType<typeof createHevyClient>;
