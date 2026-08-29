/**
 * Import page (spec §28, §37).
 *
 * V1 is paste-based by design. Spec §36 defers Health Connect to V2 and §37 is
 * explicit that Bevel must not be scraped and its credentials must not be
 * stored, so the honest integration today is copy-and-paste. Nothing on this
 * page claims an integration that does not exist.
 */
import { ImportWorkbench } from '@/components/import/ImportWorkbench';
import { Card } from '@/components/ui/primitives';
import { getProfile, getRecentImports } from '@/lib/data/queries';
import { todayForUser } from '@/app/actions/log';

export const dynamic = 'force-dynamic';

export default async function ImportPage() {
  const [today, imports, profile] = await Promise.all([
    todayForUser(),
    getRecentImports(15),
    getProfile(),
  ]);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-xl font-light">Import</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-muted">
          Paste a summary from Bevel, Google Health or your own notes. The parser
          proposes values; you review and correct them before anything is stored.
          The original text is kept verbatim, so a parsing mistake found later can
          always be traced back.
        </p>
      </header>

      <ImportWorkbench
        today={today}
        weightUnit={profile?.weightDisplayUnit ?? 'LB'}
        lengthUnit={profile?.lengthDisplayUnit ?? 'IN'}
        distanceUnit={profile?.distanceDisplayUnit ?? 'MI'}
      />

      <Card title="Recent imports">
        {imports.length === 0 ? (
          <p className="text-sm text-ink-faint">Nothing imported yet.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {imports.map((row) => (
              <li key={row.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2.5">
                <span className="tabular text-ink">
                  {row.target_local_date ?? row.created_at.slice(0, 10)}
                </span>
                {/*
                  PENDING means the paste was kept but a write did not land.
                  That is worth seeing, so it is not styled as background noise.
                */}
                <span
                  className={`text-[11px] uppercase tracking-wide ${
                    row.status === 'CONFIRMED'
                      ? 'text-good'
                      : row.status === 'DISCARDED'
                        ? 'text-ink-faint'
                        : 'text-warn'
                  }`}
                  title={
                    row.status === 'PENDING'
                      ? 'The paste was saved but its measurements were not written. Import it again.'
                      : undefined
                  }
                >
                  {row.status.toLowerCase()}
                </span>
                <span className="text-[11px] text-ink-faint">
                  parser {row.parser_version}
                </span>
                <span className="ml-auto text-[11px] text-ink-faint">
                  {row.created_at.slice(0, 16).replace('T', ' ')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="On integrations">
        <div className="space-y-3 text-xs leading-relaxed text-ink-muted">
          <p>
            <span className="text-ink">Bevel.</span> There is no Bevel integration
            and no Bevel credentials are stored anywhere in this app. Export or copy
            from Bevel and paste it here. If Bevel publishes an official API, that is
            the point to build a real integration.
          </p>
          <p>
            <span className="text-ink">Health Connect.</span> Not implemented. It is
            planned for a later version and will need Android permissions and a Play
            Store health-data declaration. Until it is built and tested, this app
            will not claim it works.
          </p>
        </div>
      </Card>
    </div>
  );
}
