/**
 * Create account (spec §34).
 *
 * CUT OS is still single-user in intent: this exists so the owner can create
 * their one account without opening the Supabase dashboard, not to invite
 * anyone else. Whether a stranger who finds this URL can use it is decided in
 * the Supabase project, not here - see README, step 4.
 */
import Link from 'next/link';
import { isSupabaseConfigured } from '@/lib/supabase/env';
import { SignUpForm } from '@/components/ui/SignUpForm';
import { SetupNotice } from '@/components/ui/SetupNotice';

export const dynamic = 'force-dynamic';

export default function SignUpPage() {
  return (
    <div className="flex min-h-screen items-center justify-center px-5">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-sm font-medium tracking-[0.18em]">CUT OS</h1>
        <p className="mb-8 text-xs text-ink-faint">
          Private fitness measurement and analytics.
        </p>

        {isSupabaseConfigured() ? (
          <>
            <SignUpForm />
            <p className="mt-4 text-xs text-ink-faint">
              Already have an account?{' '}
              <Link
                href="/login"
                className="inline-flex min-h-11 items-center text-ink-muted underline hover:text-ink"
              >
                Sign in
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
