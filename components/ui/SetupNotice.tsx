/**
 * Shown on the auth screens when Supabase credentials are absent, so the app
 * explains itself instead of failing at the first query. Shared by /login and
 * /signup rather than duplicated, since both are reachable before setup.
 */
export function SetupNotice() {
  return (
    <div className="rounded-lg border border-warn/40 bg-surface p-5 text-sm">
      <p className="mb-3 font-medium text-warn">Supabase is not configured</p>
      <p className="mb-3 leading-relaxed text-ink-muted">
        Copy <code className="text-ink">.env.example</code> to{' '}
        <code className="text-ink">.env.local</code> and fill in your project URL
        and anon key, then run the migrations:
      </p>
      <pre className="overflow-x-auto rounded border border-line bg-ground p-3 text-[11px] text-ink-muted">
        supabase db push
      </pre>
      <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
        Full setup steps are in the README.
      </p>
    </div>
  );
}
