'use server';

/**
 * Authentication actions (spec §34).
 *
 * Email and password only, and no account management beyond creating the one
 * account and ending its session: CUT OS is a private, single-user system, so
 * there is no profile page, no password reset flow and no user administration
 * here.
 *
 * Sign-up is a real Supabase signUp() call, which means the Supabase project
 * has to allow it - Authentication -> Sign In / Providers -> Email -> "Allow
 * new users to sign up". A project with that switch off answers with a
 * signup_disabled error, which is surfaced verbatim rather than reported as a
 * bad password. See README.
 *
 * Every message returned from here is rendered to the person at the form, so
 * only a message written for a person may go into one. Supabase reports a
 * refused sign-up and a request that never reached an auth API through the same
 * `error`, and the second kind carries transport text - notably the JSON
 * parser's own complaint when the endpoint answers with an HTML document.
 * classifyAuthError() separates them; the transport case is logged for the
 * operator and never quoted at the user. See lib/supabase/auth-errors.ts.
 */
import { z } from 'zod';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createActionClient } from '@/lib/supabase/server';
import { classifyAuthError } from '@/lib/supabase/auth-errors';

const credentialsSchema = z.object({
  email: z.email('Enter a valid email address.'),
  password: z.string().min(8, 'Password must be at least 8 characters.'),
});

/**
 * Confirmation is checked in the schema rather than in the browser so that it
 * cannot be skipped by posting the form directly.
 */
const signUpSchema = credentialsSchema
  .extend({ confirmPassword: z.string().min(1, 'Confirm your password.') })
  .refine((values) => values.password === values.confirmPassword, {
    message: 'The two passwords do not match.',
    path: ['confirmPassword'],
  });

/**
 * Why an attempt failed. `rejected` is a verdict from Supabase; `unavailable`
 * means no verdict was ever reached, which is a different thing to tell a
 * person and a different thing for a caller to retry.
 */
export type AuthFailureReason = 'validation' | 'rejected' | 'unavailable';

export interface AuthResult {
  ok: boolean;
  message: string;
  /** Set when ok is false. Absent on success. */
  reason?: AuthFailureReason;
  /** Keyed by field name, so each input can show its own problem. */
  errors?: Record<string, string>;
}

export interface SignUpResult extends AuthResult {
  /**
   * True when Supabase created the account but withheld a session pending a
   * confirmed email address. The caller must show "check your inbox" instead of
   * navigating to /dashboard - there is no session to navigate with.
   */
  needsEmailConfirmation?: boolean;
}

/** First message per field. Later issues on the same field are redundant. */
function fieldErrors(error: z.ZodError): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = issue.path[0];
    if (typeof field === 'string' && !(field in errors)) {
      errors[field] = issue.message;
    }
  }
  return errors;
}

/**
 * Where Supabase should send the confirmation link back to.
 *
 * NEXT_PUBLIC_SITE_URL wins when set, because a deployment behind a proxy is
 * the case where guessing from headers goes wrong. Whatever this resolves to
 * must also be listed under Authentication -> URL Configuration -> Redirect
 * URLs, or Supabase will refuse the redirect.
 */
async function resolveSiteUrl(): Promise<string> {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  if (configured) return configured.replace(/\/+$/, '');

  const headerList = await headers();
  const origin = headerList.get('origin');
  if (origin) return origin;

  const host = headerList.get('x-forwarded-host') ?? headerList.get('host');
  const protocol = headerList.get('x-forwarded-proto') ?? 'http';
  return host ? `${protocol}://${host}` : 'http://localhost:3000';
}

export async function signIn(formData: FormData): Promise<AuthResult> {
  const parsed = credentialsSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'validation',
      message: parsed.error.issues[0]?.message ?? 'Invalid credentials.',
      errors: fieldErrors(parsed.error),
    };
  }

  const supabase = await createActionClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    const failure = classifyAuthError(error);
    // Supabase never judged the credentials, so saying they were rejected
    // would be a guess. Name what happened, and log the cause for the terminal.
    if (failure.kind === 'unavailable') {
      console.error('[auth] sign-in could not reach Supabase Auth -', failure.detail);
      return { ok: false, reason: 'unavailable', message: failure.message };
    }
    // Deliberately not distinguishing "no such user" from "wrong password".
    return { ok: false, reason: 'rejected', message: 'Those credentials were not accepted.' };
  }

  revalidatePath('/', 'layout');
  return { ok: true, message: 'Signed in.' };
}

export async function signUp(formData: FormData): Promise<SignUpResult> {
  const parsed = signUpSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
    confirmPassword: formData.get('confirmPassword'),
  });
  if (!parsed.success) {
    const errors = fieldErrors(parsed.error);
    return {
      ok: false,
      reason: 'validation',
      message: parsed.error.issues[0]?.message ?? 'Check the details above.',
      errors,
    };
  }

  const supabase = await createActionClient();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: { emailRedirectTo: `${await resolveSiteUrl()}/auth/confirm` },
  });

  if (error) {
    const failure = classifyAuthError(error);

    // No auth response came back, so there is no verdict to report and
    // error.message is transport text rather than a sentence for a person -
    // for an endpoint answering with an HTML document it is the JSON parser's
    // own complaint. The account was not created either way. Say that, and put
    // the real cause where an operator reading the terminal will find it.
    if (failure.kind === 'unavailable') {
      console.error('[auth] sign-up could not reach Supabase Auth -', failure.detail);
      return { ok: false, reason: 'unavailable', message: failure.message };
    }

    // Past this point Supabase answered and refused. Its auth messages are
    // written for end users, so passing them through beats replacing a precise
    // cause with a vague one. The two worth naming explicitly are the ones a
    // person can act on.
    if (failure.code === 'signup_disabled') {
      return {
        ok: false,
        reason: 'rejected',
        message:
          'This Supabase project is not accepting new sign-ups. Enable them ' +
          'under Authentication → Sign In / Providers → Email.',
      };
    }
    if (failure.code === 'user_already_exists') {
      return {
        ok: false,
        reason: 'rejected',
        message: 'That email already has an account. Sign in instead.',
      };
    }
    return {
      ok: false,
      reason: 'rejected',
      message: failure.message || 'Could not create the account.',
    };
  }

  // With email confirmation switched off, Supabase returns a session and the
  // cookies for it have already been written; the caller can go to /dashboard.
  if (data.session) {
    revalidatePath('/', 'layout');
    return { ok: true, message: 'Account created.', needsEmailConfirmation: false };
  }

  // With it switched on there is no session yet, and there must not be one:
  // the account exists but the address is unproven until the link is clicked.
  return {
    ok: true,
    needsEmailConfirmation: true,
    message: 'Account created. Check your email for a confirmation link.',
  };
}

export async function signOut(): Promise<void> {
  const supabase = await createActionClient();
  await supabase.auth.signOut();
  revalidatePath('/', 'layout');
  redirect('/login');
}
