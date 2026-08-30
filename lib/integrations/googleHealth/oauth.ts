import 'server-only';

/**
 * The OAuth 2.0 half: authorisation URLs, token exchange, refresh, revocation,
 * and the encryption that lets a refresh token be stored at all.
 *
 * SERVER-ONLY, AND THAT IS LOAD-BEARING. `import 'server-only'` at the top
 * means a client component that imports this file fails the build rather than
 * shipping a client secret to a browser. Nothing here is ever returned from a
 * server action, written into a sync_runs row, or put in a message a user
 * reads.
 *
 * THIS FILE CONSTRUCTS NO SUPABASE CLIENT. It is handed one, exactly as
 * ../hevy/sync.ts is, so it cannot be the route by which a privileged client
 * arrives (asserted in tests/unit/service-role-absence.test.ts).
 *
 * WHY AES-256-GCM AND NOT SOMETHING SIMPLER. The token has to come back out
 * again, so hashing is not an option. GCM is authenticated: a ciphertext that
 * has been tampered with fails to decrypt rather than yielding plausible
 * rubbish, which matters because the plaintext is a credential and the failure
 * mode of a silent corruption is an authorisation attempt with a mangled token
 * and a confusing error. Node's crypto module has it built in, so this costs no
 * dependency.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, GoogleHealthConnectionRow } from '@/lib/supabase/types';
import {
  GOOGLE_AUTH_URL, GOOGLE_TOKEN_URL, GOOGLE_REVOKE_URL,
  readGoogleHealthEnv, type GoogleHealthEnv,
} from './env';
import { scopeParameter, parseGrantedScopes } from './scopes';
import { tokenResponseSchema, type GoogleTokenResponse } from './types';

type Client = SupabaseClient<Database>;

export const GOOGLE_HEALTH_PROVIDER = 'google-health';

/** How long before an access token expires we treat it as already expired. */
export const TOKEN_REFRESH_MARGIN_MS = 60_000;

/* ------------------------------------------------------------------ crypto */

export interface SealedToken {
  ciphertext: string;
  iv: string;
  tag: string;
}

/**
 * Encrypts a refresh token for storage.
 *
 * A fresh 12-byte IV per call, which GCM requires: reusing one with the same
 * key is the mistake that breaks the mode outright, and generating it here
 * rather than accepting one means a caller cannot make it.
 */
export function sealToken(plaintext: string, key: Buffer): SealedToken {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

/**
 * Decrypts a stored refresh token.
 *
 * Returns null rather than throwing on any failure - a wrong key, a truncated
 * ciphertext, a tampered tag. The caller's response to all three is the same
 * ("this connection needs reauthorising"), and a thrown error here would
 * surface as a stack trace on a settings page instead.
 */
export function openToken(sealed: Partial<SealedToken>, key: Buffer): string | null {
  if (!sealed.ciphertext || !sealed.iv || !sealed.tag) return null;
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------- state/CSRF */

/**
 * A one-time state value, and the constant-time check that validates it.
 *
 * The state parameter is what stops a third party from tricking a signed-in
 * user into completing an OAuth flow the third party started - the callback
 * would arrive with a valid code for someone else's Google account and this app
 * would happily store it. The nonce is put in an httpOnly cookie by the start
 * route and compared here.
 *
 * timingSafeEqual rather than ===: the comparison is on a secret, and while a
 * timing attack on a per-request nonce is a stretch, using the safe comparison
 * costs one import and removes the question.
 */
export function createState(): string {
  return randomBytes(32).toString('base64url');
}

export function statesMatch(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/* ---------------------------------------------------------------- the flow */

/**
 * Where to send the user to consent.
 *
 * `access_type=offline` is what makes Google issue a refresh token at all -
 * without it the app can read for an hour and then stops. `prompt=consent`
 * forces the consent screen every time, which is how a refresh token is
 * reissued: Google only sends one on the FIRST authorisation by default, so a
 * reconnection after an expiry would otherwise return an access token and no
 * way to renew it. The documentation says to include it only when necessary,
 * and here it always is - a reconnection is exactly the case it names.
 */
export function authorisationUrl(env: GoogleHealthEnv, state: string): string {
  const params = new URLSearchParams({
    client_id: env.clientId,
    redirect_uri: env.redirectUri,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    scope: scopeParameter(),
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export class OAuthExchangeError extends Error {
  readonly reason: 'DENIED' | 'INVALID_GRANT' | 'NETWORK' | 'MALFORMED' | 'REFUSED';

  constructor(reason: OAuthExchangeError['reason'], message: string) {
    super(message);
    this.name = 'OAuthExchangeError';
    this.reason = reason;
  }

  get userMessage(): string {
    switch (this.reason) {
      case 'DENIED':
        return 'You declined the request, so nothing was connected.';
      case 'INVALID_GRANT':
        return 'Google would not accept that authorisation. It may have already '
          + 'been used, or expired. Try connecting again.';
      case 'NETWORK':
        return 'Could not reach Google to complete the connection. Try again.';
      case 'MALFORMED':
        return 'Google sent a response this app does not understand. Nothing was stored.';
      case 'REFUSED':
        return `Google refused the connection: ${this.message}`;
    }
  }
}

async function postToken(
  body: Record<string, string>,
  doFetch: typeof fetch,
): Promise<GoogleTokenResponse> {
  let response: Response;
  try {
    response = await doFetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
  } catch (error) {
    throw new OAuthExchangeError(
      'NETWORK', error instanceof Error ? error.message : String(error),
    );
  }

  const text = await response.text().catch(() => '');
  if (!response.ok) {
    // invalid_grant is the specific, actionable one: the refresh token has been
    // revoked, has expired (seven days, in Testing), or has already been spent.
    // Everything else is reported as-is rather than guessed at.
    const invalid = /invalid_grant/i.test(text);
    throw new OAuthExchangeError(
      invalid ? 'INVALID_GRANT' : 'REFUSED', text.slice(0, 300),
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch {
    throw new OAuthExchangeError('MALFORMED', 'the token response was not JSON');
  }

  const parsed = tokenResponseSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new OAuthExchangeError('MALFORMED', parsed.error.message.slice(0, 300));
  }
  return parsed.data;
}

/** Exchanges the authorisation code for tokens. */
export function exchangeCode(
  env: GoogleHealthEnv,
  code: string,
  doFetch: typeof fetch = fetch,
): Promise<GoogleTokenResponse> {
  return postToken({
    code,
    client_id: env.clientId,
    client_secret: env.clientSecret,
    redirect_uri: env.redirectUri,
    grant_type: 'authorization_code',
  }, doFetch);
}

/** Trades a refresh token for a new access token. */
export function refreshAccessToken(
  env: GoogleHealthEnv,
  refreshToken: string,
  doFetch: typeof fetch = fetch,
): Promise<GoogleTokenResponse> {
  return postToken({
    client_id: env.clientId,
    client_secret: env.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  }, doFetch);
}

/**
 * Asks Google to forget the authorisation.
 *
 * Best-effort by design: disconnecting locally must succeed whether or not
 * Google is reachable, because the alternative is a user who cannot remove a
 * connection because a third party is down. The local credential is destroyed
 * either way.
 */
export async function revokeToken(
  token: string,
  doFetch: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await doFetch(GOOGLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------- the store */

export interface ConnectionState {
  connected: boolean;
  healthUserId: string | null;
  googleUserId: string | null;
  grantedScopes: string[];
  connectedAt: string | null;
  lastRefreshAt: string | null;
  revokedAt: string | null;
  lastError: string | null;
  /** True when a refresh token is on file. Never the token itself. */
  hasCredential: boolean;
}

/**
 * The connection as the UI is allowed to see it.
 *
 * Note what is NOT here: no ciphertext, no IV, no tag. A shape that cannot
 * carry a credential cannot leak one, which is a better guarantee than
 * remembering to strip fields at every call site.
 */
export function toConnectionState(row: GoogleHealthConnectionRow | null): ConnectionState {
  if (row === null) {
    return {
      connected: false, healthUserId: null, googleUserId: null, grantedScopes: [],
      connectedAt: null, lastRefreshAt: null, revokedAt: null, lastError: null,
      hasCredential: false,
    };
  }
  return {
    connected: row.revoked_at === null && row.refresh_token_ciphertext !== null,
    healthUserId: row.health_user_id,
    googleUserId: row.google_user_id,
    grantedScopes: row.granted_scopes ?? [],
    connectedAt: row.connected_at,
    lastRefreshAt: row.last_refresh_at,
    revokedAt: row.revoked_at,
    lastError: row.last_error,
    hasCredential: row.refresh_token_ciphertext !== null,
  };
}

export class NotConnectedError extends Error {
  constructor(message = 'Google Health is not connected.') {
    super(message);
    this.name = 'NotConnectedError';
  }
}

/**
 * An access-token provider bound to one user's stored credential.
 *
 * REFRESHES ON DEMAND, ONCE PER RUN. The token is cached in the closure for as
 * long as it is valid, so a backfill making three hundred requests refreshes
 * once rather than three hundred times - and it refreshes at the moment a
 * request needs a valid token, which is what the documentation asks for
 * instead of a scheduled batch.
 *
 * A REFUSED REFRESH IS RECORDED. `invalid_grant` means the authorisation is
 * gone - revoked by the user, or expired, which in Testing mode happens after
 * seven days - and the connection is marked so the UI can say exactly that
 * rather than showing a sync that mysteriously stops working.
 */
export function createAccessTokenProvider(
  supabase: Client,
  userId: string,
  options: { fetch?: typeof fetch; now?: () => Date } = {},
): () => Promise<string> {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  let cached: { token: string; expiresAt: number } | null = null;

  return async () => {
    if (cached !== null && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > now().getTime()) {
      return cached.token;
    }

    const env = readGoogleHealthEnv();
    const { data, error } = await supabase
      .from('google_health_connections')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw new NotConnectedError(`Could not read the connection: ${error.message}`);
    if (!data || data.revoked_at !== null) throw new NotConnectedError();

    const refreshToken = openToken({
      ciphertext: data.refresh_token_ciphertext ?? undefined,
      iv: data.refresh_token_iv ?? undefined,
      tag: data.refresh_token_tag ?? undefined,
    }, env.tokenKey);

    if (refreshToken === null) {
      throw new NotConnectedError(
        'The stored Google Health credential could not be read. This happens if '
        + 'GOOGLE_HEALTH_TOKEN_KEY changed since it was saved. Reconnect to store a new one.',
      );
    }

    let refreshed: GoogleTokenResponse;
    try {
      refreshed = await refreshAccessToken(env, refreshToken, doFetch);
    } catch (thrown) {
      const message = thrown instanceof OAuthExchangeError
        ? thrown.userMessage
        : String(thrown);
      // Only a definitively-dead grant marks the connection revoked. A network
      // blip must not disconnect a working integration.
      const dead = thrown instanceof OAuthExchangeError && thrown.reason === 'INVALID_GRANT';
      await supabase
        .from('google_health_connections')
        .update({
          last_error: message,
          updated_at: now().toISOString(),
          ...(dead ? { revoked_at: now().toISOString() } : {}),
        })
        .eq('user_id', userId);
      throw thrown;
    }

    const lifetimeMs = (refreshed.expires_in ?? 3600) * 1000;
    cached = { token: refreshed.access_token, expiresAt: now().getTime() + lifetimeMs };

    await supabase
      .from('google_health_connections')
      .update({
        last_refresh_at: now().toISOString(),
        access_token_expires_at: new Date(now().getTime() + lifetimeMs).toISOString(),
        last_error: null,
        updated_at: now().toISOString(),
        // Google sometimes issues a NEW refresh token on refresh. Storing it
        // when it arrives is what keeps a long-lived connection alive; ignoring
        // it would leave the old one in place until it stopped working.
        ...(refreshed.refresh_token
          ? (() => {
            const sealed = sealToken(refreshed.refresh_token!, env.tokenKey);
            return {
              refresh_token_ciphertext: sealed.ciphertext,
              refresh_token_iv: sealed.iv,
              refresh_token_tag: sealed.tag,
            };
          })()
          : {}),
        ...(refreshed.scope
          ? { granted_scopes: parseGrantedScopes(refreshed.scope) }
          : {}),
      })
      .eq('user_id', userId);

    return refreshed.access_token;
  };
}
