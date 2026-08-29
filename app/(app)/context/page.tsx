/**
 * Context page (spec §29, §30, §54).
 *
 * This is the app's whole purpose: produce a structured, honest snapshot of the
 * user's fitness state that ChatGPT can reason over. The app measures; ChatGPT
 * coaches.
 */
import { ContextPanel } from '@/components/context/ContextPanel';
import { Card } from '@/components/ui/primitives';
import { getContextExports } from '@/lib/data/queries';
import { CONTEXT_VERSION } from '@/lib/context/generate';

export const dynamic = 'force-dynamic';

export default async function ContextPage() {
  const exports = await getContextExports(8);
  const latest = exports[0]?.body ?? null;

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-xl font-light">Context pack</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-muted">
          A structured snapshot of measured data, derived trends and the evidence
          behind them, formatted for pasting into a ChatGPT project. It states its
          own data quality first, so the coaching you get back is calibrated to how
          much of the picture actually exists.
        </p>
      </header>

      <ContextPanel initialPack={latest} />

      <Card title="Previous exports">
        {exports.length === 0 ? (
          <p className="text-sm text-ink-faint">Nothing exported yet.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {exports.map((row) => (
              <li key={row.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2.5">
                <span className="tabular text-ink">{row.generated_for_date}</span>
                <span className="text-[11px] text-ink-faint">v{row.context_version}</span>
                <span className="text-[11px] text-ink-faint">
                  analytics {row.analytics_version}
                </span>
                <span className="tabular text-[11px] text-ink-muted">
                  {row.data_quality_score === null
                    ? 'quality not computable'
                    : `quality ${Math.round(Number(row.data_quality_score))}/100`}
                </span>
                <span className="ml-auto font-mono text-[11px] text-ink-faint">
                  {row.content_hash.slice(0, 12)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-4 border-t border-line pt-4 text-[11px] leading-relaxed text-ink-faint">
          Every export is stored with its schema version ({CONTEXT_VERSION}) and a
          content hash, so a pack handed over months ago stays reproducible and
          interpretable.
        </p>
      </Card>
    </div>
  );
}
