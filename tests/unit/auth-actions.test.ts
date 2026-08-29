/**
 * Sign-in and sign-out.
 *
 * Two things are being pinned here. The write path has to hand the cookie store
 * the options @supabase/ssr asks for, not just a name and a value - drop the
 * max-age and the session silently becomes a session cookie, which survives a
 * refresh but not closing the browser. And the failure path has to stay generic:
 * it must not echo the submitted credentials back, or distinguish a wrong
 * password from an unknown address.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const cookieStore = vi.hoisted(() => ({
  set: vi.fn(),
  getAll: vi.fn(() => [] as { name: string; value: string }[]),
}));

const nav = vi.hoisted(() => ({ revalidatePath: vi.fn(), redirect: vi.fn() }));

const ssr = vi.hoisted(() => ({
  /** Captured so the cookie handlers can be driven directly. */
  options: null as null | {
    cookies: {
      getAll: () => unknown;
      setAll: (c: { name: string; value: string; options: object }[]) => void;
    };
  },
}));

vi.mock('next/headers', () => ({ cookies: async () => cookieStore }));
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
  signOut: vi.fn(),
};

const { createActionClient } = await import('@/lib/supabase/server');
const { signIn, signOut } = await import('@/app/actions/auth');

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
  supabaseAuth.signInWithPassword.mockReset().mockResolvedValue({ error: null });
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

  it('does not say whether the address or the password was wrong', async () => {
    supabaseAuth.signInWithPassword.mockResolvedValue({
      error: { message: 'Invalid login credentials' },
    });

    const result = await signIn(credentials('user@example.com', 'wrong-password'));

    expect(result.ok).toBe(false);
    expect(result.message).toBe('Those credentials were not accepted.');
  });

  it('never echoes the submitted password back to the caller', async () => {
    supabaseAuth.signInWithPassword.mockResolvedValue({
      error: { message: 'Invalid login credentials' },
    });

    const result = await signIn(credentials('user@example.com', 'hunter2-secret'));

    expect(JSON.stringify(result)).not.toContain('hunter2-secret');
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
