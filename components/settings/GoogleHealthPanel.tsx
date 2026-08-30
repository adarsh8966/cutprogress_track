'use client';

/**
 * Google Health, in Settings.
 *
 * WHAT IT HAS TO SAY, AND WHY EACH IS SEPARATE. "Not configured", "not
 * connected", "connected but you declined a permission", "the authorisation
 * expired" and "the last sync partly failed" are five different states leading
 * to five different actions. Collapsing them into a spinner and a red message
 * is how someone ends up re-pressing a button that was never going to work.
 *
 * NOTHING SENSITIVE CROSSES THIS BOUNDARY. The server actions return counts,
 * timestamps, scope names and warnings. The client secret, the token key and
 * the refresh token are read server-side and never leave it - the connection
 * shape this component receives has no field that could carry one.
 */
import { useState, useTransition } from 'react';
import {
  syncGoogleHealth, testGoogleHealthConnection, disconnectGoogleHealth,
  saveHeartRateZones,
} from '@/app/actions/googleHealth';
import type { ConnectionState } from '@/lib/integrations/googleHealth/oauth';
import type { GoogleHealthSyncSummary, DataTypeOutcome } from '@/lib/integrations/googleHealth/sync';
import { REQUESTED_SCOPES } from '@/lib/integrations/googleHealth/scopes';
import type { SyncRunRow } from '@/lib/supabase/types';

const STATUS_TONE: Record<string, string> = {
  SUCCEEDED: 'text-good',
  PARTIAL: 'text-warn',
  FAILED: 'text-bad',
  RUNNING: 'text-ink-faint',
};

function when(iso: string | null): string {
  if (iso === null) return 'never';
  return iso.slice(0, 16).replace('T', ' ');
}

function counts(run: SyncRunRow): string {
  const parts: string[] = [];
  if (run.records_created > 0) parts.push(`${run.records_created} imported`);
  if (run.records_updated > 0) parts.push(`${run.records_updated} updated`);
  // Named rather than hidden: "nothing was duplicated" is the guarantee this
  // integration makes, and seeing it hold is how you come to trust it.
  if (run.records_unchanged > 0) parts.push(`${run.records_unchanged} unchanged`);
  if (run.records_withdrawn > 0) parts.push(`${run.records_withdrawn} withdrawn`);
  if (run.records_failed > 0) parts.push(`${run.records_failed} could not be saved`);
  return parts.length > 0 ? parts.join(' · ') : 'nothing changed';
}

/** Per-data-type coverage, so "sleep is missing" is answerable at a glance. */
function Coverage({ rows }: { rows: DataTypeOutcome[] }) {
  if (rows.length === 0) return null;
  return (
    <details className="rounded border border-line bg-raised px-3 py-2">
      <summary className="cursor-pointer text-[11px] uppercase tracking-[0.12em] text-ink-faint">
        What arrived, by data type
      </summary>
      <ul className="mt-2 space-y-1">
        {rows.map((row) => (
          <li key={row.dataType} className="flex flex-wrap items-baseline gap-x-2 text-xs">
            <span className="text-ink-muted">{row.label}</span>
            <span className="text-ink-faint">
              {row.created + row.updated + row.unchanged + row.skipped === 0
                ? 'nothing recorded'
                : [
                  row.created > 0 ? `${row.created} new` : null,
                  row.updated > 0 ? `${row.updated} updated` : null,
                  row.unchanged > 0 ? `${row.unchanged} unchanged` : null,
                  row.skipped > 0 ? `${row.skipped} stored, not yet mapped` : null,
                ].filter(Boolean).join(' · ')}
            </span>
            {row.backfilledTo && (
              <span className="text-ink-faint">· back to {row.backfilledTo}</span>
            )}
            {row.error && <span className="w-full text-bad">{row.error}</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function GoogleHealthPanel({
  configured,
  connection,
  runs,
  suggestedMax,
  currentMax,
  notice,
}: {
  /** Whether the OAuth credentials are set at all. Never their values. */
  configured: boolean;
  connection: ConnectionState;
  runs: SyncRunRow[];
  suggestedMax: { value: number | null; method: string | null; note: string };
  currentMax: number | null;
  /** The outcome of a just-completed OAuth round trip, from the query string. */
  notice: { kind: string; detail: string | null; missing: string[] } | null;
}) {
  const [result, setResult] = useState<GoogleHealthSyncSummary | null>(null);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [zoneResult, setZoneResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const lastRun = runs[0] ?? null;
  const granted = new Set(connection.grantedScopes);
  const missing = REQUESTED_SCOPES.filter((s) => !granted.has(s.scope));

  const status = !configured
    ? { label: 'not configured', tone: 'text-ink-faint' }
    : connection.revokedAt !== null
      ? { label: 'disconnected', tone: 'text-ink-faint' }
      : connection.connected
        ? { label: missing.length > 0 ? 'connected · partial' : 'connected', tone: 'text-good' }
        : { label: 'not connected', tone: 'text-ink-faint' };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm text-ink">Google Health</span>
        <span className={`text-[11px] uppercase tracking-[0.12em] ${status.tone}`}>
          {status.label}
        </span>
        {lastRun && (
          <span className="ml-auto text-xs text-ink-faint">
            Last sync: {when(lastRun.finished_at ?? lastRun.started_at)}
          </span>
        )}
      </div>

      {notice && (
        <p
          role="status"
          className={`text-xs ${
            notice.kind === 'connected' ? 'text-good'
              : notice.kind === 'connected_partial' ? 'text-warn' : 'text-bad'
          }`}
        >
          {{
            connected: 'Connected. Google Health data will arrive on the next sync.',
            connected_partial:
              'Connected, but some permissions were declined: '
              + `${notice.missing.join(', ')}. Everything the granted permissions `
              + 'cover will still sync.',
            declined: 'You declined the request, so nothing was connected.',
            state_mismatch:
              'That sign-in could not be verified and was refused. Nothing was '
              + 'stored. Start the connection again from this page.',
            no_scopes: 'No permissions were granted, so there would be nothing to read.',
            no_refresh_token:
              'Google did not return a long-term authorisation, so the connection '
              + 'would have stopped working within the hour. Nothing was stored — '
              + 'try connecting again.',
            exchange_failed: 'The connection could not be completed.',
            save_failed: 'The connection could not be saved.',
            unconfigured: 'Google Health is not configured on this deployment.',
            error: 'Google returned an error.',
          }[notice.kind] ?? 'Something unexpected happened.'}
          {notice.detail && <span className="text-ink-faint"> {notice.detail}</span>}
        </p>
      )}

      {!configured && (
        <p className="text-[11px] leading-relaxed text-ink-faint">
          Set <code className="text-ink-muted">GOOGLE_HEALTH_CLIENT_ID</code>,{' '}
          <code className="text-ink-muted">GOOGLE_HEALTH_CLIENT_SECRET</code> and{' '}
          <code className="text-ink-muted">GOOGLE_HEALTH_TOKEN_KEY</code> in{' '}
          <code className="text-ink-muted">.env.local</code> and in your deployment.
          None may be prefixed <code className="text-ink-muted">NEXT_PUBLIC_</code>:
          anything so prefixed is sent to the browser. See docs/google-health.md.
        </p>
      )}

      {/* Consent, explained BEFORE it is asked for. These are restricted health
          scopes, and a permission prompt with no explanation behind it is a
          prompt nobody can consent to meaningfully. */}
      <details className="rounded border border-line bg-raised px-3 py-2">
        <summary className="cursor-pointer text-[11px] uppercase tracking-[0.12em] text-ink-faint">
          What each permission is for
        </summary>
        <ul className="mt-2 space-y-2">
          {REQUESTED_SCOPES.map((scope) => (
            <li key={scope.scope} className="text-xs">
              <span className="text-ink-muted">{scope.short}</span>
              {connection.connected && (
                <span className={granted.has(scope.scope) ? 'text-good' : 'text-warn'}>
                  {granted.has(scope.scope) ? ' · granted' : ' · not granted'}
                </span>
              )}
              <span className="block text-ink-faint">{scope.reason}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
          Nutrition is deliberately not requested. Calories and macros are yours
          to enter, and nothing here can write to them.
        </p>
      </details>

      <div className="flex flex-wrap gap-2">
        {configured && !connection.connected && (
          <a
            href="/auth/google-health/start"
            className="inline-flex min-h-11 items-center rounded border border-line-strong px-3 text-sm text-ink hover:border-accent"
          >
            Connect Google Health
          </a>
        )}
        {connection.connected && (
          <>
            <button
              type="button"
              disabled={pending}
              onClick={() => startTransition(async () => { setResult(await syncGoogleHealth()); })}
              className="inline-flex min-h-11 items-center rounded border border-line-strong px-3 text-sm text-ink hover:border-accent disabled:opacity-50"
            >
              {pending ? 'Syncing…' : 'Sync now'}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => startTransition(async () => {
                setTest(await testGoogleHealthConnection());
              })}
              className="inline-flex min-h-11 items-center rounded border border-line px-3 text-sm text-ink-muted hover:border-accent disabled:opacity-50"
            >
              Test connection
            </button>
            <a
              href="/auth/google-health/start"
              className="inline-flex min-h-11 items-center rounded border border-line px-3 text-sm text-ink-muted hover:border-accent"
            >
              Reconnect
            </a>
            <button
              type="button"
              disabled={pending}
              onClick={() => startTransition(async () => {
                setTest(await disconnectGoogleHealth());
              })}
              className="inline-flex min-h-11 items-center rounded border border-line px-3 text-sm text-ink-faint hover:border-bad disabled:opacity-50"
            >
              Disconnect
            </button>
          </>
        )}
      </div>

      {test && (
        <p role="status" className={`text-xs ${test.ok ? 'text-good' : 'text-bad'}`}>
          {test.message}
        </p>
      )}

      {connection.lastError && !test && (
        <p className="text-xs text-bad">
          Last error: {connection.lastError}
        </p>
      )}

      {result && (
        <div className="space-y-2">
          <p className={`text-sm ${STATUS_TONE[result.status] ?? 'text-ink'}`}>
            {result.message}
          </p>
          {result.backfillComplete === false && result.status === 'SUCCEEDED' && (
            <p className="text-xs text-ink-faint">
              History is still being read. Sync again to continue from where this
              run stopped — nothing is re-imported.
            </p>
          )}
          {result.unmappedTypes.length > 0 && (
            <p className="text-xs text-ink-faint">
              Stored but not yet shown anywhere: {result.unmappedTypes.join(', ')}.
              These are kept in full, so mapping them later needs no re-import.
            </p>
          )}
          <Coverage rows={result.byDataType} />
          {/* Warnings are listed, never replaced by a bare count: a count tells
              you something went wrong and not what. They arrive already grouped
              by data type, each carrying one example and how many records it
              stands for (lib/integrations/googleHealth/warnings.ts) - so a
              systematic failure reads as one sentence rather than the same
              validation error repeated once per data type.

              Keyed by index, not by text. Two groups can render identically
              once the counts are equal, and a duplicate React key silently
              drops the second. */}
          {result.warnings.length > 0 && (
            <ul className="space-y-1">
              {result.warnings.map((warning, index) => (
                <li key={index} className="text-xs text-warn">{warning}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Zones live here because they are a setting, not a result: they change
          what every Zone 2 figure in the app means. */}
      <form
        action={(formData) => startTransition(async () => {
          setZoneResult(await saveHeartRateZones(formData));
        })}
        className="space-y-2 border-t border-line pt-4"
      >
        <label className="block text-[11px] uppercase tracking-[0.12em] text-ink-faint">
          Maximum heart rate
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            name="maxHeartRate"
            type="number"
            min={100}
            max={250}
            defaultValue={currentMax ?? ''}
            placeholder={suggestedMax.value ? String(suggestedMax.value) : 'not set'}
            className="min-h-11 w-28 rounded border border-line bg-ground px-3 text-base text-ink sm:text-sm"
          />
          <label className="flex items-center gap-2 text-xs text-ink-muted">
            <input name="measured" type="checkbox" className="size-4" />
            I measured this
          </label>
          <button
            type="submit"
            disabled={pending}
            className="inline-flex min-h-11 items-center rounded border border-line-strong px-3 text-sm text-ink hover:border-accent disabled:opacity-50"
          >
            Save zones
          </button>
        </div>
        <p className="text-[11px] leading-relaxed text-ink-faint">
          {suggestedMax.note}
          {' '}Zone 2 is 60–70% of this. Leave it empty to have zones derived
          automatically — every figure says which method produced it.
        </p>
        {zoneResult && (
          <p role="status" className={`text-xs ${zoneResult.ok ? 'text-good' : 'text-bad'}`}>
            {zoneResult.message}
          </p>
        )}
      </form>

      {runs.length > 0 && (
        <div className="space-y-1 border-t border-line pt-4">
          <p className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">
            Recent syncs
          </p>
          <ul className="space-y-1">
            {runs.map((run) => (
              <li key={run.id} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                <span className="text-ink-faint">{when(run.started_at)}</span>
                <span className={STATUS_TONE[run.status] ?? 'text-ink'}>
                  {run.status.toLowerCase()}
                </span>
                <span className="text-ink-faint">{counts(run)}</span>
                {run.error && <span className="w-full text-bad">{run.error}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
