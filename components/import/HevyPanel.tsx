'use client';

/**
 * Hevy, on the page where external data already arrives.
 *
 * WHAT IT HAS TO SAY, AND WHY EACH IS SEPARATE. "Not configured", "connected",
 * "the last sync failed" and "nothing has changed" are four different states
 * that lead to four different actions, and collapsing them into a spinner and
 * a red message is how a user ends up re-pressing a button that was never
 * going to work. So the panel reports the credential state, the last run, and
 * the current run separately.
 *
 * Nothing sensitive crosses this boundary: the server action returns counts,
 * timestamps and warnings. The key is read server-side and never leaves.
 */
import { useState, useTransition } from 'react';
import { syncHevy, testHevyConnection, type ConnectionResult } from '@/app/actions/hevy';
import type { SyncSummary } from '@/lib/integrations/hevy/sync';
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

/** "3 imported, 1 updated, 8 exercises processed" - what a run actually did. */
function counts(run: {
  workouts_created: number; workouts_updated: number; workouts_unchanged: number;
  workouts_deleted: number; exercises_created: number; exercises_matched: number;
  records_failed: number;
}): string {
  const parts: string[] = [];
  if (run.workouts_created > 0) parts.push(`${run.workouts_created} imported`);
  if (run.workouts_updated > 0) parts.push(`${run.workouts_updated} updated`);
  if (run.workouts_deleted > 0) parts.push(`${run.workouts_deleted} withdrawn`);
  // Named rather than hidden: "nothing was duplicated" is the guarantee this
  // integration makes, and seeing it hold is how you come to trust it.
  if (run.workouts_unchanged > 0) parts.push(`${run.workouts_unchanged} unchanged`);
  const exercises = run.exercises_created + run.exercises_matched;
  if (exercises > 0) parts.push(`${exercises} exercises processed`);
  if (run.exercises_created > 0) parts.push(`${run.exercises_created} newly added`);
  if (run.records_failed > 0) parts.push(`${run.records_failed} could not be saved`);
  return parts.length > 0 ? parts.join(' · ') : 'nothing changed';
}

export function HevyPanel({
  configured,
  runs,
}: {
  /** Whether HEVY_API_KEY is set at all. Read server-side; never its value. */
  configured: boolean;
  runs: SyncRunRow[];
}) {
  const [result, setResult] = useState<SyncSummary | null>(null);
  const [connection, setConnection] = useState<ConnectionResult | null>(null);
  const [pending, startTransition] = useTransition();

  const lastRun = runs[0] ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm text-ink">Hevy</span>
        <span className={`text-[11px] uppercase tracking-[0.12em] ${
          configured ? 'text-good' : 'text-ink-faint'
        }`}>
          {configured ? 'connected' : 'not configured'}
        </span>
        {lastRun && (
          <span className="ml-auto text-xs text-ink-faint">
            Last sync: {when(lastRun.finished_at ?? lastRun.started_at)}
          </span>
        )}
      </div>

      {!configured && (
        <p className="text-[11px] leading-relaxed text-ink-faint">
          Set <code className="text-ink-muted">HEVY_API_KEY</code> to the key from
          hevy.com/settings?developer — the API needs Hevy Pro — in{' '}
          <code className="text-ink-muted">.env.local</code> and in your deployment.
          It must not be prefixed <code className="text-ink-muted">NEXT_PUBLIC_</code>:
          anything so prefixed is sent to the browser.
        </p>
      )}

      <p className="max-w-2xl text-[11px] leading-relaxed text-ink-faint">
        Imports workouts, exercises, sets, reps, load, RPE and notes. It reads
        only — nothing is ever written back to Hevy — and it is the source for
        training alone: body weight, measurements, steps, heart rate, sleep and
        nutrition stay yours and are never touched by a sync.
      </p>

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={pending || !configured}
          onClick={() => {
            setResult(null);
            setConnection(null);
            startTransition(async () => setResult(await syncHevy()));
          }}
          className="min-h-11 rounded border border-line px-4 text-sm text-ink transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
        >
          {pending ? 'Syncing…' : 'Sync Hevy'}
        </button>

        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setResult(null);
            setConnection(null);
            startTransition(async () => setConnection(await testHevyConnection()));
          }}
          className="min-h-11 rounded border border-line px-4 text-sm text-ink-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
        >
          Test connection
        </button>
      </div>

      {connection && (
        <p className={`text-sm ${connection.ok ? 'text-good' : 'text-warn'}`} role="status">
          {connection.ok
            ? `Connected as ${connection.name}.${
              connection.workoutCount === null
                ? ''
                : ` Hevy reports ${connection.workoutCount} workouts on the account.`
            }`
            : connection.message}
        </p>
      )}

      {result && (
        <div role="status" className="space-y-2">
          <p className={`text-sm ${STATUS_TONE[result.status] ?? 'text-ink'}`}>
            {result.message}
          </p>
          {/*
            Warnings are shown, not counted. Every one of them names something
            the sync could not carry cleanly - a dropped RPE, an exercise added
            that may duplicate one you had - and a count would tell the user
            there is a problem without telling them which.
          */}
          {result.warnings.length > 0 && (
            <ul className="space-y-1 text-[11px] leading-relaxed text-ink-muted">
              {result.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
          {result.setTypes.length > 0 && (
            <p className="text-[11px] text-ink-faint">
              Set types seen: {result.setTypes.join(', ')}. Only “warmup” is treated
              as a warm-up; every other type is recorded exactly as Hevy sent it.
            </p>
          )}
        </div>
      )}

      {runs.length > 0 && (
        <div>
          <h3 className="mb-2 text-[11px] uppercase tracking-[0.12em] text-ink-faint">
            Recent syncs
          </h3>
          <ul className="divide-y divide-line/60 text-xs">
            {runs.map((run) => (
              <li key={run.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                <span className="tabular text-ink-muted">
                  {when(run.finished_at ?? run.started_at)}
                </span>
                <span className={STATUS_TONE[run.status] ?? 'text-ink-faint'}>
                  {run.status.toLowerCase()}
                </span>
                <span className="text-ink-faint">{counts(run)}</span>
                {run.triggered_by === 'SCHEDULED' && (
                  <span className="text-ink-faint">scheduled</span>
                )}
                {run.error && (
                  <span className="w-full break-words text-warn">{run.error}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
