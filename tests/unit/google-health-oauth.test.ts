/**
 * The OAuth half: the credential, the CSRF guard, and every way a connection
 * can fail.
 *
 * WHAT THIS FILE IS REALLY ABOUT. A refresh token is the one thing in this
 * database that is a key to somewhere else. Everything below is a check that it
 * is encrypted before it is stored, that a tampered ciphertext is refused
 * rather than half-read, and that the state nonce actually stops a callback
 * that did not come from a flow this app started.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const {
  sealToken, openToken, createState, statesMatch, authorisationUrl,
  exchangeCode, refreshAccessToken, revokeToken, toConnectionState,
  OAuthExchangeError,
} = await import('@/lib/integrations/googleHealth/oauth');
const { parseTokenKey } = await import('@/lib/integrations/googleHealth/env');
const { fakeTokenEndpoint, TEST_TOKEN_KEY, ALL_SCOPES } =
  await import('../helpers/googleHealthFixtures');
const { parseGrantedScopes, missingScopes, hasUsableScopes, REQUESTED_SCOPES } =
  await import('@/lib/integrations/googleHealth/scopes');

const ENV = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  tokenKey: TEST_TOKEN_KEY,
  redirectUri: 'https://cut-os.example.com/auth/google-health/callback',
  apiBaseUrl: 'https://health.googleapis.com',
};

describe('the token cipher', () => {
  it('round-trips a refresh token', () => {
    const sealed = sealToken('1//05EuqYpEXjJCHCgYIA', TEST_TOKEN_KEY);
    expect(openToken(sealed, TEST_TOKEN_KEY)).toBe('1//05EuqYpEXjJCHCgYIA');
  });

  it('never stores the token in readable form', () => {
    const sealed = sealToken('1//05EuqYpEXjJCHCgYIA', TEST_TOKEN_KEY);
    expect(sealed.ciphertext).not.toContain('05EuqYpEXjJCHCgYIA');
    expect(sealed.iv).not.toContain('05EuqYpEXjJCHCgYIA');
  });

  it('uses a fresh nonce every time', () => {
    // Reusing an IV with the same key is the mistake that breaks GCM outright.
    const a = sealToken('same-token', TEST_TOKEN_KEY);
    const b = sealToken('same-token', TEST_TOKEN_KEY);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('refuses a ciphertext encrypted under a different key', () => {
    // Which is what happens when GOOGLE_HEALTH_TOKEN_KEY is rotated: the stored
    // credential becomes unreadable and the user has to reconnect. Better a
    // clear refusal than a mangled token and a confusing error from Google.
    const sealed = sealToken('token', TEST_TOKEN_KEY);
    expect(openToken(sealed, Buffer.alloc(32, 9))).toBeNull();
  });

  it('refuses a tampered ciphertext rather than returning rubbish', () => {
    const sealed = sealToken('token', TEST_TOKEN_KEY);
    const tampered = Buffer.from(sealed.ciphertext, 'base64');
    tampered[0] = tampered[0]! ^ 0xff;
    expect(openToken(
      { ...sealed, ciphertext: tampered.toString('base64') }, TEST_TOKEN_KEY,
    )).toBeNull();
  });

  it('returns null for an absent credential rather than throwing', () => {
    expect(openToken({}, TEST_TOKEN_KEY)).toBeNull();
    expect(openToken({ ciphertext: 'x' }, TEST_TOKEN_KEY)).toBeNull();
  });

  it('refuses a key that is not 32 bytes, rather than padding it', () => {
    // Stretching 16 bytes to 32 would produce a working cipher that is not the
    // algorithm anyone chose.
    expect(() => parseTokenKey(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
  });

  it('accepts a key as base64 or hex', () => {
    expect(parseTokenKey(TEST_TOKEN_KEY.toString('base64'))).toEqual(TEST_TOKEN_KEY);
    expect(parseTokenKey(TEST_TOKEN_KEY.toString('hex'))).toEqual(TEST_TOKEN_KEY);
  });
});

describe('the state nonce', () => {
  it('is long and different every time', () => {
    const a = createState();
    const b = createState();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(32);
  });

  it('matches itself and nothing else', () => {
    const state = createState();
    expect(statesMatch(state, state)).toBe(true);
    expect(statesMatch(state, createState())).toBe(false);
  });

  it('refuses an absent value on either side', () => {
    // A callback with no state, or a browser with no cookie, is not a match.
    expect(statesMatch(undefined, 'x')).toBe(false);
    expect(statesMatch('x', undefined)).toBe(false);
    expect(statesMatch(undefined, undefined)).toBe(false);
  });

  it('refuses values of different lengths without throwing', () => {
    expect(statesMatch('short', 'a-much-longer-value')).toBe(false);
  });
});

describe('the authorisation URL', () => {
  const url = new URL(authorisationUrl(ENV, 'state-value'));

  it('asks for offline access, so a refresh token is issued at all', () => {
    expect(url.searchParams.get('access_type')).toBe('offline');
  });

  it('forces the consent screen, so a reconnection gets a new refresh token', () => {
    // Google issues a refresh token only on the FIRST authorisation by default.
    // Without this, reconnecting after an expiry returns an access token and no
    // way to renew it.
    expect(url.searchParams.get('prompt')).toBe('consent');
  });

  it('carries the state and the exact registered redirect', () => {
    expect(url.searchParams.get('state')).toBe('state-value');
    expect(url.searchParams.get('redirect_uri')).toBe(ENV.redirectUri);
  });

  it('requests exactly the four scopes and no others', () => {
    const scopes = (url.searchParams.get('scope') ?? '').split(' ');
    expect(scopes.sort()).toEqual([...ALL_SCOPES].sort());
    expect(scopes).toHaveLength(4);
  });

  it('carries no secret', () => {
    expect(url.toString()).not.toContain(ENV.clientSecret);
  });
});

describe('exchanging the authorisation code', () => {
  it('returns the tokens and the granted scopes', async () => {
    const tokens = await exchangeCode(ENV, 'auth-code', fakeTokenEndpoint());
    expect(tokens.access_token).toBe('access-token-1');
    expect(tokens.refresh_token).toBe('refresh-token-1');
    expect(parseGrantedScopes(tokens.scope)).toHaveLength(4);
  });

  it('reads the seven-day testing-mode expiry when Google sends it', async () => {
    // While the OAuth app is in Testing, refresh tokens last a week. Reading it
    // is what lets the UI say so instead of presenting an expiry as a failure.
    const tokens = await exchangeCode(ENV, 'auth-code', fakeTokenEndpoint());
    expect(tokens.refresh_token_expires_in).toBe(604799);
  });

  it('classifies a spent or revoked grant as invalid_grant', async () => {
    await expect(exchangeCode(ENV, 'stale', fakeTokenEndpoint({
      status: 400, body: '{"error":"invalid_grant"}',
    }))).rejects.toMatchObject({ reason: 'INVALID_GRANT' });
  });

  it('reports any other refusal as itself rather than guessing', async () => {
    await expect(exchangeCode(ENV, 'x', fakeTokenEndpoint({
      status: 400, body: '{"error":"redirect_uri_mismatch"}',
    }))).rejects.toMatchObject({ reason: 'REFUSED' });
  });

  it('reports an unreachable token endpoint as a network failure', async () => {
    const failing = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
    await expect(exchangeCode(ENV, 'x', failing))
      .rejects.toMatchObject({ reason: 'NETWORK' });
  });

  it('reports a non-JSON response as malformed', async () => {
    const html = (async () => new Response('<!DOCTYPE html>', { status: 200 })) as typeof fetch;
    await expect(exchangeCode(ENV, 'x', html))
      .rejects.toMatchObject({ reason: 'MALFORMED' });
  });

  it('gives every failure a sentence a person can act on', () => {
    for (const reason of ['DENIED', 'INVALID_GRANT', 'NETWORK', 'MALFORMED', 'REFUSED'] as const) {
      const error = new OAuthExchangeError(reason, 'detail');
      expect(error.userMessage.length).toBeGreaterThan(20);
      // Never the raw reason code, which means nothing to a reader.
      expect(error.userMessage).not.toBe(reason);
    }
  });
});

describe('refreshing an access token', () => {
  it('returns a new access token', async () => {
    const refreshed = await refreshAccessToken(ENV, 'refresh-token-1', fakeTokenEndpoint({
      accessToken: 'access-token-2',
    }));
    expect(refreshed.access_token).toBe('access-token-2');
  });

  it('surfaces a revoked authorisation as invalid_grant', async () => {
    await expect(refreshAccessToken(ENV, 'revoked', fakeTokenEndpoint({
      status: 400, body: '{"error":"invalid_grant"}',
    }))).rejects.toMatchObject({ reason: 'INVALID_GRANT' });
  });
});

describe('revoking', () => {
  it('reports success when Google accepts it', async () => {
    const ok = (async () => new Response('', { status: 200 })) as typeof fetch;
    expect(await revokeToken('token', ok)).toBe(true);
  });

  it('never throws when Google is unreachable', async () => {
    // Disconnecting locally must succeed whether or not Google is up. The
    // alternative is a user who cannot remove a connection because a third
    // party is down.
    const down = (async () => { throw new Error('unreachable'); }) as typeof fetch;
    expect(await revokeToken('token', down)).toBe(false);
  });
});

describe('partial consent', () => {
  it('is a supported outcome, not a failure', () => {
    const granted = [ALL_SCOPES[0]!, ALL_SCOPES[1]!];
    expect(hasUsableScopes(granted)).toBe(true);
    expect(missingScopes(granted).map((s) => s.short)).toEqual([
      '.sleep.readonly', '.location.readonly',
    ]);
  });

  it('is a failure only when nothing at all was granted', () => {
    expect(hasUsableScopes([])).toBe(false);
  });

  it('parses whatever Google sends rather than assuming what was asked', () => {
    expect(parseGrantedScopes(null)).toEqual([]);
    expect(parseGrantedScopes('')).toEqual([]);
    expect(parseGrantedScopes('a  b\tc')).toEqual(['a', 'b', 'c']);
  });

  it('explains every scope in words before it is requested', () => {
    for (const scope of REQUESTED_SCOPES) {
      expect(scope.reason.length).toBeGreaterThan(40);
    }
  });
});

describe('the connection shape the UI receives', () => {
  it('cannot carry a credential', () => {
    const state = toConnectionState({
      id: 'c1', user_id: 'u1', created_at: '', updated_at: '',
      health_user_id: 'health-1', google_user_id: 'google-1',
      granted_scopes: ALL_SCOPES,
      refresh_token_ciphertext: 'SECRET-CIPHERTEXT',
      refresh_token_iv: 'SECRET-IV',
      refresh_token_tag: 'SECRET-TAG',
      access_token_expires_at: null, connected_at: '2026-08-29T00:00:00Z',
      last_refresh_at: null, revoked_at: null, last_error: null,
    });
    // A type with no field for it cannot leak one, which is a better guarantee
    // than remembering to strip fields at every call site.
    expect(JSON.stringify(state)).not.toContain('SECRET');
    expect(state.hasCredential).toBe(true);
    expect(state.connected).toBe(true);
  });

  it('reports a revoked connection as disconnected', () => {
    const state = toConnectionState({
      id: 'c1', user_id: 'u1', created_at: '', updated_at: '',
      health_user_id: null, google_user_id: null, granted_scopes: [],
      refresh_token_ciphertext: null, refresh_token_iv: null, refresh_token_tag: null,
      access_token_expires_at: null, connected_at: '2026-08-29T00:00:00Z',
      last_refresh_at: null, revoked_at: '2026-08-30T00:00:00Z', last_error: null,
    });
    expect(state.connected).toBe(false);
    expect(state.hasCredential).toBe(false);
  });

  it('reports no connection at all as disconnected', () => {
    expect(toConnectionState(null).connected).toBe(false);
  });
});
