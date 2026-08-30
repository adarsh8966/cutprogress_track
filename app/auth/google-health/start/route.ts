/**
 * Begins the Google Health OAuth flow (spec §34).
 *
 * WHY A ROUTE HANDLER AND NOT A SERVER ACTION. The flow ends in a redirect to
 * accounts.google.com and has to set a cookie on the way - the state nonce that
 * the callback compares against. A server action can do neither cleanly, and a
 * client component holding the authorisation URL would mean building it in the
 * browser, which means the client id in the bundle and the scope list somewhere
 * a user could edit before consenting.
 *
 * WHY UNDER /auth. middleware.ts treats /auth as public, so the callback is
 * reachable without a session - which it has to be, because Google redirects a
 * browser here and carries no cookie of ours. This route is public by that same
 * rule and guards itself: no signed-in user, no authorisation.
 *
 * IT CONSTRUCTS NO SUPABASE CLIENT. createActionClient() is used, so the
 * "exactly these four files may build a client" rule in
 * tests/unit/service-role-absence.test.ts stays exactly as it is.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createActionClient } from '@/lib/supabase/server';
import {
  isGoogleHealthConfigured, readGoogleHealthEnv,
} from '@/lib/integrations/googleHealth/env';
import { authorisationUrl, createState } from '@/lib/integrations/googleHealth/oauth';

export const dynamic = 'force-dynamic';

/** The cookie the callback compares the returned state against. */
export const STATE_COOKIE = 'gh_oauth_state';

function back(request: NextRequest, reason: string): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = '/settings';
  url.search = '';
  url.searchParams.set('google_health', reason);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!isGoogleHealthConfigured()) return back(request, 'unconfigured');

  const supabase = await createActionClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    // Not signed in. The consent would have nobody to belong to.
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    url.searchParams.set('next', '/settings');
    return NextResponse.redirect(url);
  }

  const env = readGoogleHealthEnv();
  const state = createState();
  const response = NextResponse.redirect(authorisationUrl(env, state));

  /**
   * httpOnly, sameSite lax, and short-lived.
   *
   * httpOnly so no script can read it; lax because the callback arrives as a
   * top-level navigation from Google and `strict` would withhold the cookie on
   * exactly that request, breaking the check it exists for. Ten minutes is
   * longer than a consent screen takes and short enough that a nonce left in a
   * closed tab is not still valid tomorrow.
   */
  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: request.nextUrl.protocol === 'https:',
    path: '/auth/google-health',
    maxAge: 600,
  });

  return response;
}
