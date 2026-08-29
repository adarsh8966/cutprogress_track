/**
 * Sign-in and sign-out.
 *
 * Two things are being pinned here. The write path has to hand the cookie store
 * the options @supabase/ssr asks for, not just a name and a value - drop the
 * max-age and the session silently becomes a session cookie, which survives a
 * refresh but not closing the browser. And the failure path has to stay generic:
 * it must not echo the submitted credentials back, or distinguish a wrong
 * password from an unknown address.
 *
 * The third thing, added after /signup reported a JSON parse error as its
 * sign-up verdict: a Supabase error that never came from an auth response must
 * not be quoted at the user. tests/integration/auth-transport.test.ts drives
 * that through the real client and a real socket; here it is pinned at the
 * shapes the action branches on.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const cookieStore = vi.hoisted(() => ({
  set: vi.fn(),
  getAll: vi.fn(() => [] as { name: string; value: string }[]),
}));

const nav = vi.hoisted(() => ({ revalidatePath: vi.fn(), redirect: vi.fn() }));

/** Stands in for the incoming request headers when resolving the site URL. */
const requestHeaders = vi.hoisted(() => new Headers({ origin: 'https://cut-os.example.com' }));

const ssr = vi.hoisted(() => ({
  /** Captured so the cookie handlers can be driven directly. */
  options: null as null | {
    cookies: {
      getAll: () => unknown;
      setAll: (c: { name: string; value: string; options: object }[]) => void;
    };
  },
}));

vi.mock('next/headers', () => ({
  cookies: async () => cookieStore,
  headers: async () => requestHeaders,
}));
vi.mock('next/cache', () => ({ revalidatePath: nav.revalidatePath }));
vi.mock('next/navigation', () => ({ redirect: nav.redirect }));

vi.mock('@supabase/ssr', () => ({
  createServerClient: (_url: string, _key: string, options: typeof ssr.options) => {
    ssr.options = options;
    return { auth: supabaseAuth };
  },
}));

const supabaseAuth = {
  signInWithPassword: vi.fn(),
  signUp: vi.fn(),
  signOut: vi.fn(),
};

const { createActionClient } = await import('@/lib/supabase/server');
const { signIn, signUp, signOut } = await import('@/app/actions/auth');

function credentials(email: string, password: string) {
  const formData = new FormData();
  formData.set('email', email);
  formData.set('password', password);
  return formData;
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://projectref.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
  cookieStore.set.mockClear();
  nav.revalidatePath.mockClear();
  nav.redirect.mockClear();
  delete process.env.NEXT_PUBLIC_SITE_URL;
  supabaseAuth.signInWithPassword.mockReset().mockResolvedValue({ error: null });
  supabaseAuth.signUp
    .mockReset()
    .mockResolvedValue({ data: { user: { id: 'user-1' }, session: null }, error: null });
  supabaseAuth.signOut.mockReset().mockResolvedValue({ error: null });
});

describe('action client cookie persistence', () => {
  it('forwards the cookie options that keep a session across restarts', async () => {
    await createActionClient();
    const maxAge = 400 * 24 * 60 * 60;

    ssr.options!.cookies.setAll([
      {
        name: 'sb-projectref-auth-token',
        value: 'access-token',
        options: { path: '/', sameSite: 'lax', maxAge },
      },
    ]);

    expect(cookieStore.set).toHaveBeenCalledWith(
      'sb-projectref-auth-token',
      'access-token',
      { path: '/', sameSite: 'lax', maxAge },
    );
  });

  it('reads existing cookies back so a stored session is found', async () => {
    cookieStore.getAll.mockReturnValueOnce([
      { name: 'sb-projectref-auth-token', value: 'stored' },
    ]);
    await createActionClient();

    expect(ssr.options!.cookies.getAll()).toEqual([
      { name: 'sb-projectref-auth-token', value: 'stored' },
    ]);
  });
});

describe('signIn', () => {
  it('signs in with the submitted credentials', async () => {
    const result = await signIn(credentials('user@example.com', 'correct-horse'));

    expect(result.ok).toBe(true);
    expect(supabaseAuth.signInWithPassword).toHaveBeenCalledWith({
      email: 'user@example.com',
      password: 'correct-horse',
    });
  });

  it('revalidates the layout so the signed-in shell renders', async () => {
    await signIn(credentials('user@example.com', 'correct-horse'));

    expect(nav.revalidatePath).toHaveBeenCalledWith('/', 'layout');
  });

  it('rejects a malformed address without contacting Supabase', async () => {
    const result = await signIn(credentials('not-an-email', 'correct-horse'));

    expect(result.ok).toBe(false);
    expect(supabaseAuth.signInWithPassword).not.toHaveBeenCalled();
  });

  it('rejects a too-short password without contacting Supabase', async () => {
    const result = await signIn(credentials('user@example.com', 'short'));

    expect(result.ok).toBe(false);
    expect(supabaseAuth.signInWithPassword).not.toHaveBeenCalled();
  });

  // The shape Supabase actually answers with: an AuthApiError built from a
  // parsed JSON body, so it carries a status and a code. That is what marks it
  // as a verdict rather than a request that never reached the auth API.
  it('does not say whether the address or the password was wrong', async () => {
    supabaseAuth.signInWithPassword.mockResolvedValue({
      error: {
        name: 'AuthApiError',
        message: 'Invalid login credentials',
        status: 400,
        code: 'invalid_credentials',
      },
    });

    const result = await signIn(credentials('user@example.com', 'wrong-password'));

    expect(result.ok).toBe(false);
    expect(result.message).toBe('Those credentials were not accepted.');
  });

  it('never echoes the submitted password back to the caller', async () => {
    supabaseAuth.signInWithPassword.mockResolvedValue({
      error: {
        name: 'AuthApiError',
        message: 'Invalid login credentials',
        status: 400,
        code: 'invalid_credentials',
      },
    });

    const result = await signIn(credentials('user@example.com', 'hunter2-secret'));

    expect(JSON.stringify(result)).not.toContain('hunter2-secret');
  });
});

function newAccount(
  email = 'user@example.com',
  password = 'correct-horse',
  confirmPassword = password,
) {
  const formData = new FormData();
  formData.set('email', email);
  formData.set('password', password);
  formData.set('confirmPassword', confirmPassword);
  return formData;
}

describe('signUp validation', () => {
  it('rejects a malformed address and names the field', async () => {
    const result = await signUp(newAccount('not-an-email'));

    expect(result.ok).toBe(false);
    expect(result.errors?.email).toBe('Enter a valid email address.');
    expect(supabaseAuth.signUp).not.toHaveBeenCalled();
  });

  it('rejects a password under eight characters', async () => {
    const result = await signUp(newAccount('user@example.com', 'short12'));

    expect(result.ok).toBe(false);
    expect(result.errors?.password).toBe('Password must be at least 8 characters.');
    expect(supabaseAuth.signUp).not.toHaveBeenCalled();
  });

  // The browser can be bypassed by posting the form directly, so the mismatch
  // has to be caught on the server or it is not caught at all.
  it('rejects a confirmation that does not match', async () => {
    const result = await signUp(
      newAccount('user@example.com', 'correct-horse', 'correct-hoarse'),
    );

    expect(result.ok).toBe(false);
    expect(result.errors?.confirmPassword).toBe('The two passwords do not match.');
    expect(supabaseAuth.signUp).not.toHaveBeenCalled();
  });

  it('rejects an empty confirmation', async () => {
    const result = await signUp(newAccount('user@example.com', 'correct-horse', ''));

    expect(result.ok).toBe(false);
    expect(supabaseAuth.signUp).not.toHaveBeenCalled();
  });

  it('reports every bad field at once rather than one at a time', async () => {
    const result = await signUp(newAccount('not-an-email', 'short', 'mismatch'));

    expect(Object.keys(result.errors ?? {}).sort()).toEqual([
      'confirmPassword',
      'email',
      'password',
    ]);
  });

  it('never echoes the submitted password back to the caller', async () => {
    const result = await signUp(
      newAccount('user@example.com', 'hunter2-secret', 'different-secret'),
    );

    expect(JSON.stringify(result)).not.toContain('hunter2-secret');
  });
});

describe('signUp success', () => {
  it('creates the account with the submitted credentials', async () => {
    await signUp(newAccount());

    expect(supabaseAuth.signUp).toHaveBeenCalledWith({
      email: 'user@example.com',
      password: 'correct-horse',
      options: { emailRedirectTo: 'https://cut-os.example.com/auth/confirm' },
    });
  });

  it('prefers a configured site URL over the request headers', async () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://cutos.app/';

    await signUp(newAccount());

    expect(supabaseAuth.signUp).toHaveBeenCalledWith(
      expect.objectContaining({
        options: { emailRedirectTo: 'https://cutos.app/auth/confirm' },
      }),
    );
  });

  // Confirmation on: Supabase withholds the session until the address is
  // proven, so there is nothing to navigate to yet.
  it('asks for email confirmation when no session comes back', async () => {
    supabaseAuth.signUp.mockResolvedValue({
      data: { user: { id: 'user-1' }, session: null },
      error: null,
    });

    const result = await signUp(newAccount());

    expect(result.ok).toBe(true);
    expect(result.needsEmailConfirmation).toBe(true);
    expect(result.message).toContain('confirmation link');
  });

  it('does not revalidate when there is no session to render with', async () => {
    supabaseAuth.signUp.mockResolvedValue({
      data: { user: { id: 'user-1' }, session: null },
      error: null,
    });

    await signUp(newAccount());

    expect(nav.revalidatePath).not.toHaveBeenCalled();
  });

  // Confirmation off: the session cookies are already written, so the caller
  // can go straight to the dashboard.
  it('signs the user straight in when a session comes back', async () => {
    supabaseAuth.signUp.mockResolvedValue({
      data: { user: { id: 'user-1' }, session: { access_token: 'token' } },
      error: null,
    });

    const result = await signUp(newAccount());

    expect(result.ok).toBe(true);
    expect(result.needsEmailConfirmation).toBe(false);
    expect(nav.revalidatePath).toHaveBeenCalledWith('/', 'layout');
  });
});

describe('signUp failure', () => {
  it('explains a project that is not accepting sign-ups', async () => {
    supabaseAuth.signUp.mockResolvedValue({
      data: { user: null, session: null },
      error: { code: 'signup_disabled', message: 'Signups not allowed' },
    });

    const result = await signUp(newAccount());

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Authentication');
  });

  it('points an existing account at the sign-in page', async () => {
    supabaseAuth.signUp.mockResolvedValue({
      data: { user: null, session: null },
      error: { code: 'user_already_exists', message: 'User already registered' },
    });

    const result = await signUp(newAccount());

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Sign in instead.');
  });

  it('passes any other Supabase message through unchanged', async () => {
    supabaseAuth.signUp.mockResolvedValue({
      data: { user: null, session: null },
      error: { code: 'weak_password', message: 'Password is known to be weak.' },
    });

    const result = await signUp(newAccount());

    expect(result.ok).toBe(false);
    expect(result.message).toBe('Password is known to be weak.');
  });
});

/**
 * How @supabase/auth-js reports a request that produced no auth response.
 * AuthUnknownError carries the JSON parser's own message when the endpoint
 * answered with a document; AuthRetryableFetchError carries the network's.
 */
const noAuthResponse = {
  name: 'AuthUnknownError',
  message: `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`,
};
const unreachable = { name: 'AuthRetryableFetchError', message: 'fetch failed', status: 0 };

describe('signUp when no auth response came back', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('does not render the JSON parser message as the sign-up outcome', async () => {
    supabaseAuth.signUp.mockResolvedValue({
      data: { user: null, session: null },
      error: noAuthResponse,
    });

    const result = await signUp(newAccount());

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unavailable');
    expect(result.message).not.toContain('<!DOCTYPE');
    expect(result.message).not.toContain('is not valid JSON');
  });

  it('logs the cause rather than leaving the terminal silent', async () => {
    supabaseAuth.signUp.mockResolvedValue({
      data: { user: null, session: null },
      error: noAuthResponse,
    });

    await signUp(newAccount());

    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toContain(
      'AuthUnknownError',
    );
  });

  it('reports an unreachable endpoint the same way', async () => {
    supabaseAuth.signUp.mockResolvedValue({
      data: { user: null, session: null },
      error: unreachable,
    });

    const result = await signUp(newAccount());

    expect(result.reason).toBe('unavailable');
    expect(result.message).not.toBe('fetch failed');
  });
});

describe('signIn when no auth response came back', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  // Saying the credentials were refused would be a guess: nothing judged them.
  it('does not blame the credentials for a failed request', async () => {
    supabaseAuth.signInWithPassword.mockResolvedValue({ error: unreachable });

    const result = await signIn(credentials('user@example.com', 'correct-horse'));

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unavailable');
    expect(result.message).not.toBe('Those credentials were not accepted.');
  });

  it('still refuses bad credentials generically when Supabase answered', async () => {
    supabaseAuth.signInWithPassword.mockResolvedValue({
      error: { name: 'AuthApiError', message: 'Invalid login credentials', status: 400 },
    });

    const result = await signIn(credentials('user@example.com', 'wrong-password'));

    expect(result.reason).toBe('rejected');
    expect(result.message).toBe('Those credentials were not accepted.');
  });
});

describe('signOut', () => {
  it('ends the session and returns to /login', async () => {
    await signOut();

    expect(supabaseAuth.signOut).toHaveBeenCalled();
    expect(nav.revalidatePath).toHaveBeenCalledWith('/', 'layout');
    expect(nav.redirect).toHaveBeenCalledWith('/login');
  });
});
