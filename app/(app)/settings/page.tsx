/**
 * Settings (spec §4, §41, §45).
 *
 * Also surfaces the audit log, because spec §41 requires that automated changes
 * are visible: "Don't silently change someone's target."
 */
import { getProfile, getSystemEvents } from '@/lib/data/queries';
import { signOut } from '@/app/actions/auth';
import { DEFAULT_PROFILE } from '@/lib/defaults';
import { SettingsForm } from '@/components/dashboard/SettingsForm';
import { RebuildCanonical } from '@/components/dashboard/RebuildCanonical';
import { Card } from '@/components/ui/primitives';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const [profile, events] = await Promise.all([getProfile(), getSystemEvents(25)]);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-xl font-light">Settings</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-muted">
          Your baseline and targets. Nothing here is inferred on your behalf: a
          field you leave blank stays unset, and analytics that depend on it will
          say so rather than guess.
        </p>
      </header>

      <Card>
        <SettingsForm profile={profile ?? DEFAULT_PROFILE} />
      </Card>

      <Card title="Maintenance">
        <RebuildCanonical />
      </Card>

      <Card title="Audit log">
        <p className="mb-4 text-[11px] leading-relaxed text-ink-faint">
          Every automated change and every import is recorded here with the reason
          behind it. Nothing changes your targets without appearing in this list.
        </p>
        {events.length === 0 ? (
          <p className="text-sm text-ink-faint">No events yet.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {events.map((event) => (
              <li key={event.id} className="py-3">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-[11px] uppercase tracking-wide text-ink-faint">
                    {event.kind.replaceAll('_', ' ').toLowerCase()}
                  </span>
                  <span className="text-ink">{event.summary}</span>
                  <span className="ml-auto text-[11px] text-ink-faint">
                    {event.created_at.slice(0, 16).replace('T', ' ')}
                  </span>
                </div>
                {(event.previous_value || event.new_value) && (
                  <p className="tabular mt-1 text-xs text-ink-muted">
                    {event.previous_value} → {event.new_value}
                  </p>
                )}
                {event.reason && (
                  <p className="mt-1 text-[11px] text-ink-faint">{event.reason}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Session">
        <p className="mb-4 text-xs leading-relaxed text-ink-muted">
          You stay signed in on this device across refreshes, restarts and future
          visits - the session is held in a long-lived cookie and renewed in the
          background. Signing out ends it immediately on this device and returns
          you to the sign-in screen.
        </p>
        <form action={signOut}>
          <button
            type="submit"
            className="rounded border border-line-strong px-4 py-2 text-sm transition-colors hover:border-bad hover:text-bad"
          >
            Sign out
          </button>
        </form>
      </Card>

      <Card title="Privacy">
        <ul className="space-y-2 text-xs leading-relaxed text-ink-muted">
          <li>
            Every table is protected by row-level security keyed to your user id.
            Historical observations cannot be deleted or overwritten through the
            API at all - the database grants no such permission.
          </li>
          <li>
            No photos of any kind are stored, requested or supported. There is no
            image upload and no computer vision anywhere in this app.
          </li>
          <li>
            No third-party credentials are stored. Data arrives by manual entry or
            by pasting text you copied yourself.
          </li>
        </ul>
      </Card>
    </div>
  );
}
