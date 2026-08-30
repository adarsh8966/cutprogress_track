/**
 * Sign in (spec §34).
 *
 * Accounts are created at /signup, which calls Supabase's signUp(). Whether
 * that is open to anyone or closed after the first account is a Supabase
 * project setting, not an application one - see README, step 4.
 */
import Link from 'next/link';
import { isSupabaseConfigured } from '@/lib/supabase/env';
import { LoginForm } from '@/components/ui/LoginForm';
import { SetupNotice } from '@/components/ui/SetupNotice';

export const dynamic = 'force-dynamic';

/** Why /auth/confirm sent someone here instead of to the dashboard. */
const ERRORS: Record<string, string> = {
  confirmation_link:
    'That confirmation link did not work. It may have expired or already been ' +
    'used. Sign in below, or create the account again.',
  unconfigured: 'Supabase is not configured, so the confirmation link could not be checked.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const notice = error ? ERRORS[error] : undefined;

  return (
    <div className="flex min-h-screen items-center justify-center px-5">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-sm font-medium tracking-[0.18em]">CUT OS</h1>
        <p className="mb-8 text-xs text-ink-faint">
          Private fitness measurement and analytics.
        </p>

        {notice && (
          <p
            role="alert"
            className="mb-6 rounded border border-warn/40 bg-warn/5 p-3 text-xs leading-relaxed text-ink-muted"
          >
            {notice}
          </p>
        )}

        {isSupabaseConfigured() ? (
          <>
            <LoginForm />
            {/* min-h-11 is the comfortable touch target. A bare inline link
                measured 14px tall, which is fine with a mouse and a poor target
                on the phone this is most often opened on. */}
            <p className="mt-4 text-xs text-ink-faint">
              No account yet?{' '}
              <Link
                href="/signup"
                className="inline-flex min-h-11 items-center text-ink-muted underline hover:text-ink"
              >
                Create account
              </Link>
            </p>
          </>
        ) : (
          <SetupNotice />
        )}
      </div>
    </div>
  );
}
