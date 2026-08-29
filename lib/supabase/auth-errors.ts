/**
 * Telling a Supabase auth verdict apart from a failed request (spec §34).
 *
 * `supabase.auth.*` returns a single `error` for two situations that are not
 * alike at all, and collapsing them is what produced the sign-up bug this
 * module exists to prevent:
 *
 *  - **A verdict.** The auth API answered, in JSON, with a reason: signups are
 *    disabled, the address is taken, the password is weak. `error.message` is a
 *    sentence written for the person who submitted the form, so passing it
 *    through is exactly right.
 *  - **No answer at all.** The request never produced an auth response -
 *    unreachable host, a gateway error, or an endpoint that replied with
 *    something other than JSON. @supabase/auth-js still surfaces this as an
 *    `error`, but `message` is now a transport detail. When the endpoint
 *    answers with an HTML document, `_handleRequest` calls `result.json()`, the
 *    parse throws, and the SyntaxError's own text becomes the message:
 *
 *        Unexpected token '<', "<!DOCTYPE "... is not valid JSON
 *
 *    Render that and the form reports a JSON parser error as though Supabase
 *    had judged the submission.
 *
 * Classification is structural - the error's shape, never its wording. Two
 * independent signals agree on the second case: @supabase/auth-js raises one of
 * two named error types when it could not obtain an auth answer, and an error
 * built without a parsed body carries neither a status nor a code.
 *
 * Pure: no Supabase import, no I/O. The input is described structurally so an
 * `AuthError` satisfies it, which keeps this testable without credentials.
 */

/** The shape of a Supabase `AuthError`, without importing the library. */
export interface AuthErrorLike {
  name?: string;
  message: string;
  status?: number;
  code?: string;
}

export type AuthFailureKind =
  /** The auth API answered and refused. `message` is Supabase's own wording. */
  | 'rejected'
  /** No auth answer came back. `message` is ours; Supabase's is transport noise. */
  | 'unavailable';

export interface ClassifiedAuthError {
  kind: AuthFailureKind;
  /** Safe to show a person. Never the transport failure's own text. */
  message: string;
  /** Supabase's error code, when the API answered with one. */
  code?: string;
  /** What actually went wrong. For the server log - never rendered. */
  detail: string;
}

/**
 * The error types @supabase/auth-js raises when no auth response was obtained:
 * the fetch failed or the status was a gateway error (retryable), or the body
 * would not parse as JSON (unknown).
 */
const NO_ANSWER_ERROR_NAMES = new Set(['AuthRetryableFetchError', 'AuthUnknownError']);

/**
 * What the operator needs to check, given the request never reached an auth
 * API. Deliberately concrete: this is a single-user system, so the person
 * reading it is also the person who configured the project.
 */
export const AUTH_UNAVAILABLE_MESSAGE =
  'Could not reach Supabase Auth, so nothing was changed. The endpoint did not ' +
  'return an auth response - check that NEXT_PUBLIC_SUPABASE_URL is your ' +
  "project's API URL and that the project is running.";

export function classifyAuthError(error: AuthErrorLike): ClassifiedAuthError {
  const name = typeof error.name === 'string' && error.name ? error.name : 'AuthError';
  const message = typeof error.message === 'string' ? error.message : '';
  const status = typeof error.status === 'number' ? error.status : undefined;
  const code = typeof error.code === 'string' && error.code ? error.code : undefined;
  const detail = `${name}: ${message}`;

  const noAnswer =
    NO_ANSWER_ERROR_NAMES.has(name) || (status === undefined && code === undefined);

  if (noAnswer) {
    return { kind: 'unavailable', message: AUTH_UNAVAILABLE_MESSAGE, detail };
  }

  return { kind: 'rejected', message, code, detail };
}
