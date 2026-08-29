/**
 * Email confirmation landing.
 *
 * The link in Supabase's email is the request that turns a pending account into
 * a usable one, so the session it produces has to survive the redirect to the
 * dashboard. NextResponse.redirect() builds a fresh response, so cookies have to
 * be copied onto it deliberately - the same trap the middleware fix covers, and
 * the reason a confirmed user would otherwise land back on /login.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

/** A session, as @supabase/ssr writes it once confirmation succeeds. */
const SESSION_COOKIES = [
  {
    name: 'sb-projectref-auth-token',
    value: 'confirmed-session',
    options: { path: '/', sameSite: 'lax' as const, maxAge: 400 * 24 * 60 * 60 },
  },
];

const auth = vi.hoisted(() => ({
  exchangeCodeForSession: vi.fn(),
  verifyOtp: vi.fn(),
  /** Cookies the library writes during the call, or null for none. */
  writes: null as null | { name: string; value: string; options: object }[],
  /** Cookies the incoming request carried, for the code-verifier assertion. */
  seen: null as null | { name: string; value: string }[],
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: (
    _url: string,
    _key: string,
    opts: {
      cookies: {
        getAll: () => { name: string; value: string }[];
        setAll: (c: unknown[]) => void;
      };
    },
  ) => {
    const run = async () => {
      auth.seen = opts.cookies.getAll();
      if (auth.writes) opts.cookies.setAll(auth.writes);
    };
    return {
      auth: {
        exchangeCodeForSession: async (code: string) => {
          await run();
          return auth.exchangeCodeForSession(code);
        },
        verifyOtp: async (params: unknown) => {
          await run();
          return auth.verifyOtp(params);
        },
      },
    };
  },
}));

const { GET } = await import('@/app/auth/confirm/route');

function confirmationLink(query: string, cookies: Record<string, string> = {}) {
  const request = new NextRequest(`https://cutos.local/auth/confirm${query}`);
  for (const [name, value] of Object.entries(cookies)) {
    request.cookies.set(name, value);
  }
  return request;
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://projectref.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
  auth.exchangeCodeForSession.mockReset().mockResolvedValue({ error: null });
  auth.verifyOtp.mockReset().mockResolvedValue({ error: null });
  auth.writes = null;
  auth.seen = null;
});

describe('confirmation by PKCE code (the default email template)', () => {
  it('exchanges the code and lands the visitor on /dashboard', async () => {
    const response = await GET(confirmationLink('?code=auth-code-123'));

    expect(auth.exchangeCodeForSession).toHaveBeenCalledWith('auth-code-123');
    expect(new URL(response.headers.get('location')!).pathname).toBe('/dashboard');
  });

  it('returns the session cookies on the redirect rather than dropping them', async () => {
    auth.writes = SESSION_COOKIES;

    const response = await GET(confirmationLink('?code=auth-code-123'));

    const cookie = response.cookies.get('sb-projectref-auth-token');
    expect(cookie?.value).toBe('confirmed-session');
    expect(cookie?.maxAge).toBe(400 * 24 * 60 * 60);
  });

  it('offers the code verifier stored at sign-up back to the exchange', async () => {
    await GET(
      confirmationLink('?code=auth-code-123', {
        'sb-projectref-auth-token-code-verifier': 'verifier-abc',
      }),
    );

    expect(auth.seen).toContainEqual({
      name: 'sb-projectref-auth-token-code-verifier',
      value: 'verifier-abc',
    });
  });

  it('drops the query string so the code does not survive in the URL', async () => {
    const response = await GET(confirmationLink('?code=auth-code-123'));

    expect(new URL(response.headers.get('location')!).search).toBe('');
  });
});

describe('confirmation by token hash (a customised email template)', () => {
  it('verifies the token and lands the visitor on /dashboard', async () => {
    const response = await GET(
      confirmationLink('?token_hash=hash-abc&type=signup'),
    );

    expect(auth.verifyOtp).toHaveBeenCalledWith({
      token_hash: 'hash-abc',
      type: 'signup',
    });
    expect(new URL(response.headers.get('location')!).pathname).toBe('/dashboard');
  });

  it('returns the session cookies on the redirect', async () => {
    auth.writes = SESSION_COOKIES;

    const response = await GET(confirmationLink('?token_hash=hash-abc&type=email'));

    expect(response.cookies.get('sb-projectref-auth-token')?.value).toBe(
      'confirmed-session',
    );
  });
});

describe('a link that does not work', () => {
  it('sends an expired code back to /login with a reason', async () => {
    auth.exchangeCodeForSession.mockResolvedValue({
      error: { message: 'invalid flow state' },
    });

    const response = await GET(confirmationLink('?code=stale-code'));

    const location = new URL(response.headers.get('location')!);
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('error')).toBe('confirmation_link');
  });

  it('sends a rejected token hash back to /login with a reason', async () => {
    auth.verifyOtp.mockResolvedValue({ error: { message: 'token expired' } });

    const response = await GET(confirmationLink('?token_hash=stale&type=signup'));

    const location = new URL(response.headers.get('location')!);
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('error')).toBe('confirmation_link');
  });

  it('rejects a link carrying neither a code nor a token hash', async () => {
    const response = await GET(confirmationLink(''));

    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(auth.verifyOtp).not.toHaveBeenCalled();
    expect(new URL(response.headers.get('location')!).pathname).toBe('/login');
  });

  it('rejects a token hash with no type rather than guessing one', async () => {
    const response = await GET(confirmationLink('?token_hash=hash-abc'));

    expect(auth.verifyOtp).not.toHaveBeenCalled();
    expect(new URL(response.headers.get('location')!).pathname).toBe('/login');
  });

  it('says so when Supabase is not configured at all', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    const response = await GET(confirmationLink('?code=auth-code-123'));

    const location = new URL(response.headers.get('location')!);
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('error')).toBe('unconfigured');
  });
});
