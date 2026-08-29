/**
 * The sign-up response contract, over a real HTTP round trip.
 *
 * This is the regression test for the reported failure: /signup rendered
 *
 *     Unexpected token '<', "<!DOCTYPE "... is not valid JSON
 *
 * after "Create account". The Server Action itself was never at fault - the
 * POST to /signup answered 200 with content-type: text/x-component, and the
 * dev server logged nothing at all. The HTML was one hop further out: the
 * Supabase auth endpoint answered with a document, @supabase/auth-js threw at
 * `result.json()` inside _handleRequest, and the SyntaxError's own text came
 * back as `error.message`. app/actions/auth.ts passed that straight into
 * SignUpResult.message, and SignUpForm rendered it as the sign-up verdict.
 *
 * So the real client is exercised here rather than a mock of it: @supabase/ssr
 * runs unmocked against a local server that answers however each test needs.
 * Only Next's request-scoped APIs are stubbed, because there is no request.
 * A mocked Supabase could not reproduce this - the bug lives in what the
 * library does with a body it cannot parse.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

vi.mock('server-only', () => ({}));

/** A cookie jar the real @supabase/ssr client can read and write. */
const cookieStore = vi.hoisted(() => {
  const jar = new Map<string, string>();
  return {
    jar,
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string) => void jar.set(name, value),
  };
});

const nav = vi.hoisted(() => ({ revalidatePath: vi.fn(), redirect: vi.fn() }));

vi.mock('next/headers', () => ({
  cookies: async () => cookieStore,
  headers: async () => new Headers({ origin: 'http://localhost:3000' }),
}));
vi.mock('next/cache', () => ({ revalidatePath: nav.revalidatePath }));
vi.mock('next/navigation', () => ({ redirect: nav.redirect }));

const { signUp } = await import('@/app/actions/auth');
const { AUTH_UNAVAILABLE_MESSAGE } = await import('@/lib/supabase/auth-errors');

/** What the endpoint answers next. Each test sets this before calling signUp. */
let reply: { status: number; contentType: string; body: string };
let server: Server;
/** Where the stand-in endpoint is listening. Restored before every test. */
let endpoint: string;

/** The document a Supabase URL that is not the auth API answers with. */
const HTML_DOCUMENT =
  '<!DOCTYPE html>\n<html lang="en">\n<head><title>404</title></head>\n' +
  '<body><h1>404</h1><p>This page could not be found.</p></body>\n</html>\n';

/** A syntactically valid JWT: the client decodes the payload locally. */
function accessToken(): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return [
    encode({ alg: 'HS256', typ: 'JWT' }),
    encode({
      sub: '00000000-0000-4000-8000-000000000001',
      aud: 'authenticated',
      role: 'authenticated',
      email: 'user@example.com',
      iat: now,
      exp: now + 3600,
      session_id: 'session-1',
    }),
    'signature',
  ].join('.');
}

const USER = {
  id: '00000000-0000-4000-8000-000000000001',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'user@example.com',
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: {},
  identities: [],
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const json = (status: number, body: unknown) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

/** Confirmation off: GoTrue returns the session inline. */
const withSession = json(200, {
  access_token: accessToken(),
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  refresh_token: 'refresh-token-1',
  user: USER,
});

/** Confirmation on: GoTrue returns the user alone, and withholds the session. */
const withoutSession = json(200, { ...USER, confirmation_sent_at: '2026-01-01T00:00:00.000Z' });

function newAccount() {
  const formData = new FormData();
  formData.set('email', 'user@example.com');
  formData.set('password', 'correct-horse');
  formData.set('confirmPassword', 'correct-horse');
  return formData;
}

beforeAll(async () => {
  server = createServer((_request, response) => {
    response.writeHead(reply.status, { 'content-type': reply.contentType });
    response.end(reply.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  // Reset here rather than at the end of the test that changes it, so a failing
  // assertion cannot leave the next test pointed somewhere else.
  process.env.NEXT_PUBLIC_SUPABASE_URL = endpoint;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
  cookieStore.jar.clear();
  nav.revalidatePath.mockClear();
  delete process.env.NEXT_PUBLIC_SITE_URL;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sign-up when the auth endpoint answers with an HTML document', () => {
  beforeEach(() => {
    reply = { status: 404, contentType: 'text/html; charset=utf-8', body: HTML_DOCUMENT };
  });

  // Before asserting the fix, prove the condition that produced the report is
  // actually being reproduced: the library really does hand back the parser's
  // message for this response. Without this the tests below could pass against
  // a failure that never happens.
  it('reproduces the JSON parse failure inside the Supabase client', async () => {
    const { createServerClient } = await import('@supabase/ssr');
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { cookies: { getAll: () => [], setAll: () => {} } },
    );

    const { error } = await supabase.auth.signUp({
      email: 'user@example.com',
      password: 'correct-horse',
    });

    expect(error?.name).toBe('AuthUnknownError');
    expect(error?.message).toContain('<!DOCTYPE');
    expect(error?.message).toContain('is not valid JSON');
  });

  // The original bug, stated as an assertion.
  it('does not put the parser message in front of the user', async () => {
    const result = await signUp(newAccount());

    expect(result.message).not.toContain('<!DOCTYPE');
    expect(result.message).not.toContain('is not valid JSON');
    expect(result.message).not.toContain('Unexpected token');
  });

  it('reports that no auth response came back, and says what to check', async () => {
    const result = await signUp(newAccount());

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unavailable');
    expect(result.message).toBe(AUTH_UNAVAILABLE_MESSAGE);
    expect(result.message).toContain('NEXT_PUBLIC_SUPABASE_URL');
  });

  // The dev server printed nothing while this was failing, which is half of
  // why it was hard to place. The cause belongs in the terminal.
  it('logs the real cause for the operator', async () => {
    await signUp(newAccount());

    const logged = vi.mocked(console.error).mock.calls.flat().join(' ');
    expect(logged).toContain('AuthUnknownError');
    expect(logged).toContain('is not valid JSON');
  });

  it('does not claim a session, and does not revalidate', async () => {
    const result = await signUp(newAccount());

    expect(result.needsEmailConfirmation).toBeUndefined();
    expect(nav.revalidatePath).not.toHaveBeenCalled();
  });

  it('never suggests the address is already taken', async () => {
    const result = await signUp(newAccount());

    expect(result.message).not.toContain('Sign in instead.');
  });
});

describe('sign-up when the endpoint is unreachable', () => {
  it('reports it as unavailable rather than as a rejected sign-up', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:1';

    const result = await signUp(newAccount());

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unavailable');
    expect(result.message).toBe(AUTH_UNAVAILABLE_MESSAGE);
  });
});

// Everything the fix had to leave alone, checked through the same real client.
describe('sign-up outcomes that Supabase actually answered', () => {
  it('keeps the sign-up-disabled message useful', async () => {
    reply = json(422, {
      code: 'signup_disabled',
      error_code: 'signup_disabled',
      msg: 'Signups not allowed for this instance',
    });

    const result = await signUp(newAccount());

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('rejected');
    expect(result.message).toContain('Authentication');
  });

  it('points a duplicate address at sign-in', async () => {
    reply = json(422, {
      code: 'user_already_exists',
      error_code: 'user_already_exists',
      msg: 'User already registered',
    });

    const result = await signUp(newAccount());

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('rejected');
    expect(result.message).toBe('That email already has an account. Sign in instead.');
  });

  it('passes any other refusal through in Supabase’s own words', async () => {
    reply = json(422, {
      code: 'weak_password',
      error_code: 'weak_password',
      msg: 'Password is known to be weak and easy to guess.',
      weak_password: { reasons: ['pwned'] },
    });

    const result = await signUp(newAccount());

    expect(result.ok).toBe(false);
    expect(result.message).toBe('Password is known to be weak and easy to guess.');
  });

  it('asks the user to check their inbox when the session is withheld', async () => {
    reply = withoutSession;

    const result = await signUp(newAccount());

    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.needsEmailConfirmation).toBe(true);
    expect(nav.revalidatePath).not.toHaveBeenCalled();
  });

  it('signs the user straight in when a session comes back', async () => {
    reply = withSession;

    const result = await signUp(newAccount());

    expect(result.ok).toBe(true);
    expect(result.needsEmailConfirmation).toBe(false);
    expect(nav.revalidatePath).toHaveBeenCalledWith('/', 'layout');
  });

  it('writes the session cookies that the /dashboard redirect then travels on', async () => {
    reply = withSession;

    await signUp(newAccount());

    expect([...cookieStore.jar.keys()].some((name) => name.includes('auth-token'))).toBe(true);
  });

  // Validation still runs before any request is made.
  it('rejects a mismatched confirmation without contacting Supabase', async () => {
    reply = { status: 500, contentType: 'text/plain', body: 'should not be reached' };
    const formData = newAccount();
    formData.set('confirmPassword', 'correct-hoarse');

    const result = await signUp(formData);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('validation');
    expect(result.errors?.confirmPassword).toBe('The two passwords do not match.');
  });
});
