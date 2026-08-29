/**
 * Sign in (spec §34).
 *
 * There is no sign-up form. CUT OS is a private, single-user system: the one
 * account is created in the Supabase dashboard and public signup is disabled
 * there. See README.
 */
import { isSupabaseConfigured } from '@/lib/supabase/env';
import { LoginForm } from '@/components/ui/LoginForm';

export const dynamic = 'force-dynamic';

export default function LoginPage() {
  const configured = isSupabaseConfigured();

  return (
    <div className="flex min-h-screen items-center justify-center px-5">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-sm font-medium tracking-[0.18em]">CUT OS</h1>
        <p className="mb-8 text-xs text-ink-faint">
          Private fitness measurement and analytics.
        </p>

        {configured ? (
          <LoginForm />
        ) : (
          <div className="rounded-lg border border-warn/40 bg-surface p-5 text-sm">
            <p className="mb-3 font-medium text-warn">Supabase is not configured</p>
            <p className="mb-3 leading-relaxed text-ink-muted">
              Copy <code className="text-ink">.env.example</code> to{' '}
              <code className="text-ink">.env.local</code> and fill in your project
              URL and anon key, then run the migrations:
            </p>
            <pre className="overflow-x-auto rounded border border-line bg-ground p-3 text-[11px] text-ink-muted">
              supabase db push
            </pre>
            <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
              Full setup steps are in the README.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
