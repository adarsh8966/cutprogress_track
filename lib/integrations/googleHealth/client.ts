/**
 * The Google Health API client.
 *
 * READ-ONLY BY CONSTRUCTION, NOT BY DISCIPLINE. The API supports writing:
 * exercise, weight, body fat, sleep and profile all have create, patch and
 * batchDelete methods, and nutrition-log has a POST that would let this app
 * write food into someone's Fitbit account. None of them has a method here. The
 * only POSTs this file can issue are to the `:dailyRollUp` aggregation endpoint,
 * which is a read that takes its range in a body because the range is too big
 * for a URL. Writing back to Google Health is not something a caller can do
 * wrongly; it is something a caller cannot express.
 *
 * That is reinforced by the scopes: this integration requests no `.writeonly`
 * scope at all, so even a call that got past the missing method would be
 * refused by Google.
 *
 * NOTHING IS READ FROM THE ENVIRONMENT HERE. The access token is handed in by a
 * provider function, and `fetch` and `sleep` are injectable, so every path -
 * including 429 handling, backoff and token expiry - is exercised by tests with
 * no network and no credentials. env.ts is where the environment is read and it
 * is `server-only`; this file is deliberately not, because it is plumbing over
 * an injected transport.
 *
 * A FAILURE IS CLASSIFIED, NOT FLATTENED. "Reauthorise", "you did not grant
 * that scope", "Google is rate limiting you" and "Google is down" lead to four
 * different actions, and a sync that reports them all as "sync failed" leaves
 * the user with nowhere to go.
 */
import {
  listResponseSchema, identitySchema, parseDataPoints,
  type GoogleDataPointPage, type GoogleIdentity,
} from './types';

export type GoogleHealthErrorKind =
  /** The token was refused or has expired. A refresh, or a reconnection. */
  | 'AUTH'
  /** Authenticated, but the user never granted the scope this needs. */
  | 'SCOPE'
  /** Too many requests. Retryable, and the client already tried. */
  | 'RATE_LIMIT'
  /** Nothing there. Usually not an error - an empty window looks like this. */
  | 'NOT_FOUND'
  /** The request was malformed: a bug here, not a condition to wait out. */
  | 'BAD_REQUEST'
  /** Google failed. Retryable. */
  | 'SERVER'
  /** The request never got an answer. Retryable. */
  | 'NETWORK'
  /** An answer arrived that does not match the documented shape. */
  | 'MALFORMED';

export class GoogleHealthError extends Error {
  readonly kind: GoogleHealthErrorKind;
  readonly status: number | null;
  /** The data type being read, so a partial failure can name what it lost. */
  readonly dataType: string | null;

  constructor(
    kind: GoogleHealthErrorKind,
    message: string,
    status: number | null = null,
    dataType: string | null = null,
  ) {
    super(message);
    this.name = 'GoogleHealthError';
    this.kind = kind;
    this.status = status;
    this.dataType = dataType;
  }

  get retryable(): boolean {
    return this.kind === 'RATE_LIMIT' || this.kind === 'SERVER' || this.kind === 'NETWORK';
  }

  /**
   * True when the failure is about this one data type rather than the whole
   * connection. A missing scope loses one data type; a refused token loses
   * everything, and carrying on through the remaining twenty would be twenty
   * more failures saying the same thing.
   */
  get isolated(): boolean {
    return this.kind === 'SCOPE' || this.kind === 'NOT_FOUND'
      || this.kind === 'BAD_REQUEST' || this.kind === 'MALFORMED';
  }

  /** A sentence for the person who pressed Sync. Never carries a token. */
  get userMessage(): string {
    switch (this.kind) {
      case 'AUTH':
        return 'Google refused the stored authorisation. Reconnect Google Health '
          + 'to grant it again. (While the OAuth app is in Testing, Google '
          + 'expires refresh tokens after seven days.)';
      case 'SCOPE':
        return 'Google Health has data here that this app was not given '
          + 'permission to read. Reconnect and accept the permission to include it.';
      case 'RATE_LIMIT':
        return 'Google is rate limiting this account. Nothing was lost; '
          + 'the next sync picks up where this one stopped.';
      case 'NETWORK':
        return 'Could not reach Google Health. Nothing was changed; try again.';
      case 'SERVER':
        return 'Google Health returned a server error. Nothing was changed; '
          + 'try again later.';
      case 'MALFORMED':
        return `Google Health sent a response this app does not understand: ${this.message}`;
      case 'NOT_FOUND':
        return 'Google Health has no such record.';
      case 'BAD_REQUEST':
        return `Google Health rejected the request: ${this.message}`;
    }
  }
}

export interface GoogleHealthClientOptions {
  /**
   * Returns a valid access token, refreshing if needed.
   *
   * A FUNCTION RATHER THAN A STRING because a backfill can outlive an access
   * token: they last an hour, and a 365-day sync across twenty data types makes
   * hundreds of requests. Asking for the token per request lets the refresh
   * happen exactly when it is needed, which is what Google's documentation
   * advises over refreshing on a schedule.
   */
  accessToken: () => Promise<string>;
  baseUrl: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * How long to wait before retrying.
 *
 * `Retry-After` is honoured when Google sends one, because the service saying
 * how long beats this code guessing. It is capped at 30 seconds: a header
 * asking for ten minutes should end the run and let the next one resume, not
 * hold a server action open. Otherwise it backs off 500ms, 1s, 2s - the
 * exponential backoff the rate-limit guidance explicitly asks for.
 */
export function retryDelayMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  }
  return 500 * 2 ** (attempt - 1);
}

/** A civil date, for the dailyRollUp body's google.type.Date. */
function civilDate(date: string): { year: number; month: number; day: number } {
  const [year, month, day] = date.split('-').map(Number);
  return { year: year ?? 1970, month: month ?? 1, day: day ?? 1 };
}

export interface ListOptions {
  dataType: string;
  /** A complete filter expression, already built by filters.ts. */
  filter?: string | null;
  pageSize?: number;
  pageToken?: string | null;
}

export function createGoogleHealthClient(options: GoogleHealthClientOptions) {
  const doFetch = options.fetch ?? fetch;
  const doSleep = options.sleep
    ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const base = options.baseUrl.replace(/\/+$/, '');

  /**
   * Turns an HTTP status into a kind.
   *
   * 403 IS SPLIT ON THE BODY, deliberately. The troubleshooting guide gives 403
   * two quite different meanings: a missing OAuth scope (MISSING_OAUTH_SCOPE,
   * which the filters guide names explicitly) and a caller permission problem.
   * The first is recoverable by reconnecting and losing one data type; the
   * second is not, and telling the user to reconnect would waste their time.
   */
  function classify(status: number, body: string, dataType: string | null): GoogleHealthError {
    if (status === 401) return new GoogleHealthError('AUTH', body, status, dataType);
    if (status === 403) {
      return /MISSING_OAUTH_SCOPE|insufficient|scope/i.test(body)
        ? new GoogleHealthError('SCOPE', body, status, dataType)
        : new GoogleHealthError('AUTH', body, status, dataType);
    }
    if (status === 429) return new GoogleHealthError('RATE_LIMIT', body, status, dataType);
    if (status === 404) return new GoogleHealthError('NOT_FOUND', body, status, dataType);
    if (status >= 500) return new GoogleHealthError('SERVER', body, status, dataType);
    return new GoogleHealthError('BAD_REQUEST', body, status, dataType);
  }

  /**
   * One request, with retries.
   *
   * The token is fetched per attempt rather than once: if the first attempt
   * failed because the access token expired mid-run, the second gets a fresh
   * one instead of replaying the same rejected credential three times.
   */
  async function request(
    path: string,
    init: { method: 'GET' | 'POST'; body?: unknown; accept?: string },
    dataType: string | null,
  ): Promise<{ text: string; response: Response }> {
    let lastError: GoogleHealthError | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response: Response;
      try {
        const token = await options.accessToken();
        response = await doFetch(`${base}${path}`, {
          method: init.method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: init.accept ?? 'application/json',
            ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        });
      } catch (error) {
        lastError = new GoogleHealthError(
          'NETWORK',
          error instanceof Error ? error.message : String(error),
          null,
          dataType,
        );
        if (attempt < maxAttempts) {
          await doSleep(retryDelayMs(attempt, null));
          continue;
        }
        throw lastError;
      }

      if (response.ok) {
        return { text: await response.text(), response };
      }

      const body = (await response.text().catch(() => '')).slice(0, 300);
      const error = classify(response.status, body, dataType);
      lastError = error;
      if (error.retryable && attempt < maxAttempts) {
        await doSleep(retryDelayMs(attempt, response.headers.get('retry-after')));
        continue;
      }
      throw error;
    }

    throw lastError ?? new GoogleHealthError('NETWORK', 'no attempt was made', null, dataType);
  }

  function parseJson(text: string, dataType: string | null): unknown {
    try {
      return JSON.parse(text);
    } catch {
      throw new GoogleHealthError(
        'MALFORMED', 'the response was not JSON', null, dataType,
      );
    }
  }

  /**
   * The envelope, then each point on its own.
   *
   * MALFORMED is now reserved for a response that is not a page at all - no
   * `dataPoints` array, a `nextPageToken` that is not a string. A point this
   * code cannot read is reported beside the ones it could, because the
   * alternative is what the first real sync did: throw, lose the window, and
   * skip the rest of the data type over one element.
   */
  function parsePage(text: string, dataType: string | null): GoogleDataPointPage {
    const parsed = listResponseSchema.safeParse(parseJson(text, dataType));
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new GoogleHealthError(
        'MALFORMED',
        first === undefined
          ? 'the response was not a page of data points'
          : `${first.path.join('.') || 'the response'}: ${first.message}`,
        null,
        dataType,
      );
    }
    const { points, rejected } = parseDataPoints(parsed.data.dataPoints);
    return { dataPoints: points, nextPageToken: parsed.data.nextPageToken, rejected };
  }

  return {
    /**
     * The Fitbit and Google ids for the authorised account.
     *
     * Called once at connect time. The documentation recommends storing both
     * immediately after consent for backward and forward compatibility, and
     * states the mapping never changes - so it is cached rather than re-fetched.
     */
    async getIdentity(): Promise<GoogleIdentity> {
      const { text } = await request('/v4/users/me/identity', { method: 'GET' }, null);
      const parsed = identitySchema.safeParse(parseJson(text, null));
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw new GoogleHealthError(
          'MALFORMED',
          first === undefined
            ? 'the identity response could not be read'
            : `${first.path.join('.') || 'the response'}: ${first.message}`,
        );
      }
      return parsed.data;
    },

    /**
     * One page of data points.
     *
     * The data type goes into the path in KEBAB case; a filter naming it must
     * use SNAKE case. Getting that backwards is a 400 with
     * INVALID_DATA_POINT_FILTER, which is why the two forms are separate fields
     * on the registry entry rather than one derived from the other here.
     */
    async list(listOptions: ListOptions): Promise<GoogleDataPointPage> {
      const params = new URLSearchParams();
      if (listOptions.filter) params.set('filter', listOptions.filter);
      if (listOptions.pageSize) params.set('pageSize', String(listOptions.pageSize));
      if (listOptions.pageToken) params.set('pageToken', listOptions.pageToken);
      const query = params.toString();
      const path = `/v4/users/me/dataTypes/${encodeURIComponent(listOptions.dataType)}`
        + `/dataPoints${query ? `?${query}` : ''}`;

      const { text } = await request(path, { method: 'GET' }, listOptions.dataType);
      return parsePage(text, listOptions.dataType);
    },

    /**
     * Daily aggregates over a closed-open civil range.
     *
     * A POST, and the only one in this file. It is a read: the range is a
     * nested structure that does not fit a query string, which is why the API
     * puts it in a body. The steps guide is explicit that this - not
     * client-side summing of intervals - is how a daily total is obtained
     * correctly across travel and daylight saving, because the endpoint
     * reconciles the UTC offsets itself.
     */
    async dailyRollUp(
      dataType: string,
      from: string,
      to: string,
      pageToken: string | null = null,
    ): Promise<GoogleDataPointPage> {
      const params = new URLSearchParams();
      if (pageToken) params.set('pageToken', pageToken);
      const query = params.toString();
      const path = `/v4/users/me/dataTypes/${encodeURIComponent(dataType)}`
        + `/dataPoints:dailyRollUp${query ? `?${query}` : ''}`;

      const { text } = await request(path, {
        method: 'POST',
        body: {
          range: {
            start: { date: civilDate(from), time: { hours: 0, minutes: 0, seconds: 0, nanos: 0 } },
            end: { date: civilDate(to), time: { hours: 0, minutes: 0, seconds: 0, nanos: 0 } },
          },
          windowSizeDays: 1,
        },
      }, dataType);

      return parsePage(text, dataType);
    },

    /**
     * The GPS track for an exercise, as TCX.
     *
     * `?alt=media` is required: without it the server answers with a JSON
     * envelope instead of the file. Needs the location scope, and returns an
     * authorisation error without it - which is a SCOPE failure and so isolated
     * to this one call, leaving the session's own summary intact.
     */
    async exportExerciseTcx(dataPointName: string): Promise<string> {
      const id = dataPointName.split('/').pop() ?? dataPointName;
      const path = `/v4/users/me/dataTypes/exercise/dataPoints/${encodeURIComponent(id)}`
        + ':exportExerciseTcx?alt=media';
      const { text } = await request(
        path, { method: 'GET', accept: 'application/vnd.garmin.tcx+xml' }, 'exercise',
      );
      return text;
    },
  };
}

export type GoogleHealthClient = ReturnType<typeof createGoogleHealthClient>;
