/**
 * Session refresh and route protection (spec §34).
 *
 * Runs on every matched request: refreshes the Supabase session cookie, then
 * redirects signed-out traffic to /login. RLS is still the real boundary - this
 * only decides which page renders - but it keeps unauthenticated users from
 * reaching pages that would fail confusingly.
 *
 * The session lives in cookies written by @supabase/ssr, which sets them with a
 * 400-day max-age rather than as session cookies. That is what makes sign-in
 * survive a browser restart or a reboot: the browser still holds the refresh
 * token on the next visit, and the block below trades it for a fresh access
 * token before any page renders.
 *
 * That only holds if every response actually carries the cookies Supabase
 * writes. When getUser() rotates the refresh token, the old one is spent the
 * moment Supabase answers; if the response that triggered the rotation does not
 * hand the new tokens back, the browser keeps replaying a consumed token and the
 * next request signs the user out. NextResponse.redirect() builds a fresh
 * response, so the redirects below must copy those cookies across explicitly -
 * see withSessionCookies(). The /login -> /dashboard bypass is exactly the
 * request a returning visitor makes with an expired access token, so dropping
 * them there logs the user out on precisely the visit that should be seamless.
 *
 * When Supabase is not configured at all, requests are passed through so the
 * app can boot and show the setup instructions rather than redirect-looping.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import type { User } from '@supabase/supabase-js';
import { isSupabaseConfigured } from '@/lib/supabase/env';

/**
 * Reachable without a session. Everything else requires one.
 *
 * /auth covers the email-confirmation landing, which has to run while the
 * visitor is still signed out - that request is what creates the session.
 */
const PUBLIC_PATHS = ['/login', '/signup', '/auth'];

/** Where a signed-in visitor has no reason to be. */
const AUTH_PATHS = ['/login', '/signup'];

/** Exact match or a sub-path, so that /login-decoy is not treated as public. */
function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

export async function middleware(request: NextRequest) {
  if (!isSupabaseConfigured()) return NextResponse.next();

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  /**
   * Carry whatever Supabase just wrote onto a response we are about to return
   * instead of `response`. This moves refreshed tokens - and, for a session
   * Supabase has rejected, the cookie deletions that retire the dead ones -
   * rather than stranding them on a response that never gets sent.
   */
  function withSessionCookies(target: NextResponse): NextResponse {
    for (const cookie of response.cookies.getAll()) {
      target.cookies.set(cookie);
    }
    return target;
  }

  function redirectTo(pathname: string, next?: string): NextResponse {
    const url = request.nextUrl.clone();
    url.pathname = pathname;
    url.search = '';
    if (next) url.searchParams.set('next', next);
    return withSessionCookies(NextResponse.redirect(url));
  }

  // getUser() revalidates against Supabase rather than trusting the cookie.
  // An expired or revoked session comes back as an error with a null user, not
  // as a throw, so it falls through to the redirect below. A throw means
  // Supabase itself was unreachable: treat that as unverified rather than
  // serving a 500 for every route, and leave the cookies alone so a transient
  // outage costs a trip to /login and not the stored session.
  let user: User | null = null;
  try {
    const { data } = await supabase.auth.getUser();
    user = data.user;
  } catch {
    user = null;
  }

  const pathname = request.nextUrl.pathname;

  if (!user && !isPublicPath(pathname)) {
    return redirectTo('/login', pathname);
  }

  if (user && AUTH_PATHS.includes(pathname)) {
    return redirectTo('/dashboard');
  }

  return response;
}

export const config = {
  matcher: [
    // Everything except static assets and image optimisation.
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
