/**
 * Where Google sends the user back to (spec §34).
 *
 * THE EXACT URI THIS RESOLVES TO MUST BE REGISTERED IN GOOGLE CLOUD, character
 * for character, as an Authorized redirect URI:
 *
 *   local        http://localhost:3000/auth/google-health/callback
 *   production   https://<your-domain>/auth/google-health/callback
 *
 * It is derived from GOOGLE_HEALTH_REDIRECT_URI (or NEXT_PUBLIC_SITE_URL)
 * rather than from request headers, because behind a proxy the headers are not
 * a reliable guide to the public URL and a mismatch is refused by Google with
 * an error the user cannot act on.
 *
 * FIVE OUTCOMES, ALL HANDLED, NONE SILENT:
 *   the user declined            -> back to Settings saying so
 *   the state does not match     -> refused, nothing stored (this is the CSRF
 *                                   guard: without it, a link could make a
 *                                   signed-in user store someone else's
 *                                   account credentials)
 *   the exchange failed          -> back with the reason
 *   partial consent              -> STORED, and the missing scopes named. Not a
 *                                   failure: the documentation asks explicitly
 *                                   that an app not break when a user grants a
 *                                   subset, and the data types the granted
 *                                   scopes cover are worth having.
 *   success                      -> credential encrypted and stored
 *
 * CONSTRUCTS NO SUPABASE CLIENT: createActionClient() only.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createActionClient } from '@/lib/supabase/server';
import {
  isGoogleHealthConfigured, readGoogleHealthEnv,
} from '@/lib/integrations/googleHealth/env';
import {
  exchangeCode, sealToken, statesMatch, OAuthExchangeError,
} from '@/lib/integrations/googleHealth/oauth';
import {
  parseGrantedScopes, missingScopes, hasUsableScopes,
} from '@/lib/integrations/googleHealth/scopes';
import { createGoogleHealthClient } from '@/lib/integrations/googleHealth/client';
import { STATE_COOKIE } from '../start/route';

export const dynamic = 'force-dynamic';

function settings(request: NextRequest, params: Record<string, string>): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = '/settings';
  url.search = '';
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = NextResponse.redirect(url);
  // The nonce is spent either way. Leaving it would let a replayed callback
  // pass the check a second time.
  response.cookies.delete(STATE_COOKIE);
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!isGoogleHealthConfigured()) return settings(request, { google_health: 'unconfigured' });

  const params = request.nextUrl.searchParams;

  // Google reports a refusal as ?error=access_denied. It is not a failure of
  // this app and must not be reported as one.
  const denied = params.get('error');
  if (denied !== null) {
    return settings(request, {
      google_health: denied === 'access_denied' ? 'declined' : 'error',
      detail: denied.slice(0, 120),
    });
  }

  const code = params.get('code');
  if (code === null) return settings(request, { google_health: 'error', detail: 'no code' });

  if (!statesMatch(params.get('state') ?? undefined, request.cookies.get(STATE_COOKIE)?.value)) {
    return settings(request, { google_health: 'state_mismatch' });
  }

  const supabase = await createActionClient();
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError || !auth.user) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    url.searchParams.set('next', '/settings');
    return NextResponse.redirect(url);
  }
  const userId = auth.user.id;

  const env = readGoogleHealthEnv();

  let tokens;
  try {
    tokens = await exchangeCode(env, code);
  } catch (error) {
    const message = error instanceof OAuthExchangeError
      ? error.userMessage
      : 'Could not complete the connection.';
    return settings(request, { google_health: 'exchange_failed', detail: message.slice(0, 160) });
  }

  const granted = parseGrantedScopes(tokens.scope);
  if (!hasUsableScopes(granted)) {
    return settings(request, { google_health: 'no_scopes' });
  }

  /**
   * No refresh token means no long-term access.
   *
   * Google issues one only on the first authorisation unless prompt=consent is
   * sent - which it always is here, precisely so a reconnection gets a fresh
   * one. If one still does not arrive, storing the access token alone would
   * produce a connection that works for an hour and then fails mysteriously, so
   * the connection is refused instead and the user is told why.
   */
  if (!tokens.refresh_token) {
    return settings(request, { google_health: 'no_refresh_token' });
  }

  const sealed = sealToken(tokens.refresh_token, env.tokenKey);

  /**
   * The identity call is best-effort.
   *
   * healthUserId is what a webhook notification would name the user by, and the
   * documentation recommends storing it at consent time because the mapping
   * never changes. Nothing today depends on it, so a failure here must not cost
   * the user a working connection.
   */
  let healthUserId: string | null = null;
  let googleUserId: string | null = null;
  try {
    const api = createGoogleHealthClient({
      accessToken: async () => tokens.access_token,
      baseUrl: env.apiBaseUrl,
    });
    const identity = await api.getIdentity();
    healthUserId = identity.healthUserId ?? identity.fitbitUserId ?? null;
    googleUserId = identity.googleUserId ?? null;
  } catch {
    healthUserId = null;
  }

  const nowIso = new Date().toISOString();
  const expiresAt = new Date(
    Date.now() + (tokens.expires_in ?? 3600) * 1000,
  ).toISOString();

  const { error: saved } = await supabase
    .from('google_health_connections')
    .upsert({
      user_id: userId,
      health_user_id: healthUserId,
      google_user_id: googleUserId,
      granted_scopes: granted,
      refresh_token_ciphertext: sealed.ciphertext,
      refresh_token_iv: sealed.iv,
      refresh_token_tag: sealed.tag,
      access_token_expires_at: expiresAt,
      connected_at: nowIso,
      last_refresh_at: nowIso,
      revoked_at: null,
      last_error: null,
      updated_at: nowIso,
    }, { onConflict: 'user_id' });

  if (saved) {
    return settings(request, {
      google_health: 'save_failed', detail: saved.message.slice(0, 160),
    });
  }

  await supabase.from('system_events').insert({
    user_id: userId,
    kind: 'PROVIDER_CONNECTED',
    summary: 'Google Health was connected.',
    detail: { provider: 'google-health', grantedScopes: granted },
    previous_value: null,
    new_value: null,
    reason: null,
    status: 'RECORDED',
  });

  const missing = missingScopes(granted);
  return settings(request, {
    google_health: missing.length > 0 ? 'connected_partial' : 'connected',
    ...(missing.length > 0 ? { missing: missing.map((s) => s.short).join(',') } : {}),
  });
}
