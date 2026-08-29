/**
 * Telling a Supabase auth verdict apart from a request that never got one.
 *
 * The failure this guards against: /signup showed
 *
 *     Unexpected token '<', "<!DOCTYPE "... is not valid JSON
 *
 * as its error message. Nothing was wrong with the Server Action - the POST
 * came back 200 with content-type: text/x-component. The auth endpoint had
 * answered with an HTML document, @supabase/auth-js failed at result.json(),
 * and the SyntaxError's own text arrived as error.message on an otherwise
 * ordinary-looking AuthError, which the action then passed through to the form.
 *
 * The errors below are built exactly as @supabase/auth-js builds them, so the
 * classification is pinned to the shapes it actually produces.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyAuthError,
  AUTH_UNAVAILABLE_MESSAGE,
} from '@/lib/supabase/auth-errors';

/** The message V8 produces for JSON.parse of a document beginning "<!DOCTYPE". */
const HTML_PARSE_MESSAGE = `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`;

/** AuthUnknownError, as handleError() raises it when the body will not parse. */
const htmlResponse = { name: 'AuthUnknownError', message: HTML_PARSE_MESSAGE };

/** AuthRetryableFetchError, as _handleRequest() raises it when fetch throws. */
const fetchFailed = { name: 'AuthRetryableFetchError', message: 'fetch failed', status: 0 };

/** AuthRetryableFetchError, as handleError() raises it for a gateway error. */
const badGateway = { name: 'AuthRetryableFetchError', message: 'Bad Gateway', status: 502 };

/** AuthApiError, as handleError() raises it from a parsed JSON body. */
function apiError(message: string, status: number, code?: string) {
  return { name: 'AuthApiError', message, status, code };
}

describe('classifyAuthError: no auth response', () => {
  it('classifies an endpoint answering with a document rather than JSON', () => {
    expect(classifyAuthError(htmlResponse).kind).toBe('unavailable');
  });

  it('never hands the JSON parser complaint back as the message', () => {
    const failure = classifyAuthError(htmlResponse);

    expect(failure.message).toBe(AUTH_UNAVAILABLE_MESSAGE);
    expect(failure.message).not.toContain('<!DOCTYPE');
    expect(failure.message).not.toContain('not valid JSON');
  });

  it('keeps the real cause for the server log', () => {
    expect(classifyAuthError(htmlResponse).detail).toBe(
      `AuthUnknownError: ${HTML_PARSE_MESSAGE}`,
    );
  });

  it('says what to check, so the message is actionable', () => {
    expect(AUTH_UNAVAILABLE_MESSAGE).toContain('NEXT_PUBLIC_SUPABASE_URL');
  });

  it.each([
    ['a failed fetch', fetchFailed],
    ['a gateway error', badGateway],
  ])('classifies %s as unavailable too', (_label, error) => {
    const failure = classifyAuthError(error);

    expect(failure.kind).toBe('unavailable');
    expect(failure.message).toBe(AUTH_UNAVAILABLE_MESSAGE);
  });

  // A future rename of the error class must not silently turn transport text
  // back into a user-facing message: an error built without a parsed body
  // carries neither a status nor a code, and that is checked independently.
  it('classifies an unnamed error with no status and no code as unavailable', () => {
    expect(classifyAuthError({ message: HTML_PARSE_MESSAGE }).kind).toBe('unavailable');
  });
});

describe('classifyAuthError: verdicts', () => {
  it('passes a refusal message through unchanged', () => {
    const failure = classifyAuthError(
      apiError('Signups not allowed for this instance', 422, 'signup_disabled'),
    );

    expect(failure.kind).toBe('rejected');
    expect(failure.message).toBe('Signups not allowed for this instance');
    expect(failure.code).toBe('signup_disabled');
  });

  it('keeps the code the sign-up action branches on', () => {
    expect(
      classifyAuthError(apiError('User already registered', 422, 'user_already_exists')).code,
    ).toBe('user_already_exists');
  });

  it('treats a coded error with no status as a verdict', () => {
    const failure = classifyAuthError({
      name: 'AuthWeakPasswordError',
      message: 'Password is known to be weak.',
      code: 'weak_password',
    });

    expect(failure.kind).toBe('rejected');
    expect(failure.message).toBe('Password is known to be weak.');
  });

  it('treats a status-only error from the API as a verdict', () => {
    expect(classifyAuthError(apiError('Invalid login credentials', 400)).kind).toBe(
      'rejected',
    );
  });
});
