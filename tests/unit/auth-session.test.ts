/**
 * Authentication: route protection and session persistence.
 *
 * Sign-in is meant to survive a refresh, a browser restart and a reboot, which
 * means two things have to hold. The session cookies @supabase/ssr writes must
 * reach the browser on *every* response, including redirects; and the options
 * that make them long-lived rather than session-scoped must survive the trip.
 *
 * The redirect case is the one that bites. getUser() rotates the refresh token,
 * spending the old one at Supabase; a redirect that drops the new cookies leaves
 * the browser replaying a consumed token, and the next request signs the user
 * out. /login -> /dashboard is exactly the request a returning visitor makes, so
 * the regression shows up as "it forgets me every time" rather than as an error.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

/** Long-lived auth cookies, as @supabase/ssr writes them (400 days). */
const ROTATED_COOKIES = [
  {
    name: 'sb-projectref-auth-token',
    value: 'rotated-access-token',
    options: { path: '/', sameSite: 'lax' as const, maxAge: 400 * 24 * 60 * 60 },
  },
  {
    name: 'sb-projectref-auth-token.1',
    value: 'rotated-refresh-token',
    options: { path: '/', sameSite: 'lax' as const, maxAge: 400 * 24 * 60 * 60 },
  },
];

/** How @supabase/ssr retires the cookies of a session it has rejected. */
const CLEARED_COOKIES = [
  {
    name: 'sb-projectref-auth-token',
    value: '',
    options: { path: '/', sameSite: 'lax' as const, maxAge: 0 },
  },
];

const supabase = vi.hoisted(() => ({
  /** Resolves the getUser() result, or throws to simulate an unreachable API. */
  getUser: (): Promise<unknown> => Promise.resolve({ data: { user: null }, error: null }),
  /** Cookies the library writes during getUser(), or null for no write. */
  writes: null as null | { name: string; value: string; options: object }[],
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: (
    _url: string,
    _key: string,
    opts: { cookies: { setAll: (c: unknown[]) => void } },
  ) => ({
    auth: {
      getUser: async () => {
        if (supabase.writes) opts.cookies.setAll(supabase.writes);
        return supabase.getUser();
      },
    },
  }),
}));

const { middleware } = await import('@/middleware');

const signedIn = { data: { user: { id: 'user-1' } }, error: null };
const signedOut = { data: { user: null }, error: null };
const expired = {
  data: { user: null },
  error: { name: 'AuthApiError', message: 'refresh_token_not_found' },
};

function request(path: string) {
  return new NextRequest(`https://cutos.local${path}`);
}

/**
 * A Server Action call, as Next issues it: a POST to the page the form is on,
 * carrying the action id in `next-action`.
 */
function actionRequest(path: string) {
  return new NextRequest(`https://cutos.local${path}`, {
    method: 'POST',
    headers: { 'next-action': '40f3e1f47a17003fe6acc473931e2661feefcd16ae' },
  });
}

/** Parsed Set-Cookie names on a response, in order. */
function cookieNames(response: NextResponse) {
  return response.cookies.getAll().map((cookie) => cookie.name);
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://projectref.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
  supabase.getUser = () => Promise.resolve(signedOut);
  supabase.writes = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('middleware: protected routes', () => {
  const protectedPaths = [
    '/',
    '/dashboard',
    '/progress',
    '/training',
    '/nutrition',
    '/recovery',
    '/review',
    '/import',
    '/context',
    '/settings',
  ];

  it.each(protectedPaths)('sends a signed-out visitor at %s to /login', async (path) => {
    supabase.getUser = () => Promise.resolve(signedOut);

    const response = await middleware(request(path));

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get('location')!);
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('next')).toBe(path);
  });

  it.each(['/login', '/signup'])(
    'lets a signed-out visitor reach %s',
    async (path) => {
      supabase.getUser = () => Promise.resolve(signedOut);

      const response = await middleware(request(path));

      expect(response.headers.get('location')).toBeNull();
    },
  );

  // The confirmation link is clicked while still signed out - that request is
  // what creates the session, so bouncing it to /login would break sign-up.
  it('lets the email confirmation landing run while signed out', async () => {
    supabase.getUser = () => Promise.resolve(signedOut);

    const response = await middleware(request('/auth/confirm?code=auth-code'));

    expect(response.headers.get('location')).toBeNull();
  });

  it('lets a signed-in user through to a protected page', async () => {
    supabase.getUser = () => Promise.resolve(signedIn);

    const response = await middleware(request('/dashboard'));

    expect(response.headers.get('location')).toBeNull();
  });

  it.each(['/login', '/signup'])(
    'bypasses %s for a signed-in user and lands them on /dashboard',
    async (path) => {
      supabase.getUser = () => Promise.resolve(signedIn);

      const response = await middleware(request(path));

      expect(response.status).toBe(307);
      const location = new URL(response.headers.get('location')!);
      expect(location.pathname).toBe('/dashboard');
      expect(location.search).toBe('');
    },
  );

  it('drops the next parameter when bouncing a signed-in user off /login', async () => {
    supabase.getUser = () => Promise.resolve(signedIn);

    const response = await middleware(
      new NextRequest('https://cutos.local/login?next=%2Fsettings'),
    );

    expect(new URL(response.headers.get('location')!).search).toBe('');
  });

  it.each(['/login-decoy', '/signup-decoy', '/authorise'])(
    'treats %s as protected rather than public by prefix',
    async (path) => {
      supabase.getUser = () => Promise.resolve(signedOut);

      const response = await middleware(request(path));

      expect(new URL(response.headers.get('location')!).pathname).toBe('/login');
    },
  );

  it('passes everything through when Supabase is not configured', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    const response = await middleware(request('/dashboard'));

    expect(response.headers.get('location')).toBeNull();
  });
});

/**
 * A Server Action call expects the action's return value back. Redirecting it
 * makes the browser replay the POST at the redirect target, where the action
 * never runs - so the form awaits a result that was never produced.
 *
 * On /signup this is reachable from the browser: sign up with confirmation off,
 * land on /dashboard, then go back. The restored page still shows the form, the
 * browser now holds a session, and "Create account" is answered with a 307 to
 * /dashboard instead of a sign-up outcome.
 */
describe('middleware: Server Action calls', () => {
  it.each(['/login', '/signup'])(
    'does not bounce a Server Action posted to %s by a signed-in visitor',
    async (path) => {
      supabase.getUser = () => Promise.resolve(signedIn);

      const response = await middleware(actionRequest(path));

      expect(response.headers.get('location')).toBeNull();
      expect(response.status).toBe(200);
    },
  );

  // Redirecting this one replays the POST at /login, against a page that has no
  // reason to receive it. The action guards itself and RLS is the boundary.
  it('does not bounce a Server Action posted by a signed-out visitor', async () => {
    supabase.getUser = () => Promise.resolve(signedOut);

    const response = await middleware(actionRequest('/dashboard'));

    expect(response.headers.get('location')).toBeNull();
  });

  it('still refreshes the session on a Server Action call', async () => {
    supabase.getUser = () => Promise.resolve(signedIn);
    supabase.writes = ROTATED_COOKIES;

    const response = await middleware(actionRequest('/signup'));

    expect(cookieNames(response)).toEqual([
      'sb-projectref-auth-token',
      'sb-projectref-auth-token.1',
    ]);
  });

  // The exemption is for Server Actions, not for POSTs in general.
  it('still bounces a plain POST with no action header', async () => {
    supabase.getUser = () => Promise.resolve(signedIn);

    const response = await middleware(
      new NextRequest('https://cutos.local/signup', { method: 'POST' }),
    );

    expect(new URL(response.headers.get('location')!).pathname).toBe('/dashboard');
  });

  it('still bounces the page request for the same path', async () => {
    supabase.getUser = () => Promise.resolve(signedIn);

    const response = await middleware(request('/signup'));

    expect(new URL(response.headers.get('location')!).pathname).toBe('/dashboard');
  });
});

describe('middleware: session persistence', () => {
  it('returns refreshed cookies on a pass-through', async () => {
    supabase.getUser = () => Promise.resolve(signedIn);
    supabase.writes = ROTATED_COOKIES;

    const response = await middleware(request('/dashboard'));

    expect(cookieNames(response)).toEqual([
      'sb-projectref-auth-token',
      'sb-projectref-auth-token.1',
    ]);
  });

  // The regression: a rotation committed at Supabase but never handed back.
  it('returns refreshed cookies on the /login -> /dashboard bypass', async () => {
    supabase.getUser = () => Promise.resolve(signedIn);
    supabase.writes = ROTATED_COOKIES;

    const response = await middleware(request('/login'));

    expect(response.status).toBe(307);
    expect(cookieNames(response)).toEqual([
      'sb-projectref-auth-token',
      'sb-projectref-auth-token.1',
    ]);
    expect(response.cookies.get('sb-projectref-auth-token')?.value).toBe(
      'rotated-access-token',
    );
    expect(response.cookies.get('sb-projectref-auth-token.1')?.value).toBe(
      'rotated-refresh-token',
    );
  });

  it('returns refreshed cookies on the /signup -> /dashboard bypass', async () => {
    supabase.getUser = () => Promise.resolve(signedIn);
    supabase.writes = ROTATED_COOKIES;

    const response = await middleware(request('/signup'));

    expect(cookieNames(response)).toEqual([
      'sb-projectref-auth-token',
      'sb-projectref-auth-token.1',
    ]);
  });

  it('keeps cookies long-lived through a redirect rather than session-scoped', async () => {
    supabase.getUser = () => Promise.resolve(signedIn);
    supabase.writes = ROTATED_COOKIES;

    const response = await middleware(request('/login'));
    const cookie = response.cookies.get('sb-projectref-auth-token');

    // A missing max-age would make this a session cookie: sign-in would then
    // survive a refresh but not closing the browser.
    expect(cookie?.maxAge).toBe(400 * 24 * 60 * 60);
    expect(cookie?.path).toBe('/');
    expect(cookie?.sameSite).toBe('lax');
  });

  it('returns refreshed cookies on the redirect to /login', async () => {
    supabase.getUser = () => Promise.resolve(signedOut);
    supabase.writes = ROTATED_COOKIES;

    const response = await middleware(request('/dashboard'));

    expect(cookieNames(response)).toEqual([
      'sb-projectref-auth-token',
      'sb-projectref-auth-token.1',
    ]);
  });
});

describe('middleware: expired sessions', () => {
  it('returns an expired session to /login', async () => {
    supabase.getUser = () => Promise.resolve(expired);

    const response = await middleware(request('/dashboard'));

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get('location')!).pathname).toBe('/login');
  });

  it('retires the dead cookies instead of stranding them on the browser', async () => {
    supabase.getUser = () => Promise.resolve(expired);
    supabase.writes = CLEARED_COOKIES;

    const response = await middleware(request('/dashboard'));

    expect(response.cookies.get('sb-projectref-auth-token')?.maxAge).toBe(0);
  });

  it('sends the visitor to /login rather than erroring when Supabase is unreachable', async () => {
    supabase.getUser = () => Promise.reject(new Error('fetch failed'));

    const response = await middleware(request('/dashboard'));

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get('location')!).pathname).toBe('/login');
  });

  it('leaves the stored session alone during an outage so it can resume', async () => {
    supabase.getUser = () => Promise.reject(new Error('fetch failed'));

    const response = await middleware(request('/dashboard'));

    expect(response.cookies.getAll()).toHaveLength(0);
  });
});
