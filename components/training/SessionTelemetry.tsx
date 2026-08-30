/**
 * The physiology recorded during a session, and what it says about zones.
 *
 * A SERVER COMPONENT inside a Disclosure, so none of this crosses to the
 * browser until it is opened - and even then it is markup, not data.
 *
 * WHAT THIS IS CAREFUL ABOUT. Heart rate arrives from a device that was
 * sometimes on the wrist and sometimes not, so every figure here is qualified
 * by how much of the session it actually covers. An average heart rate over 12%
 * of a workout is not the workout's average heart rate, and printing it flat
 * beside one measured over 98% would make the two look alike.
 *
 * AND WHAT IT REFUSES TO DO. No heart rate means no zone minutes - not zero.
 * A session with no telemetry did not contain zero minutes of Zone 2; nobody
 * knows what it contained, and this component says so.
 */
import { Card, Figure, formatNumber } from '@/components/ui/primitives';
import { Disclosure } from '@/components/ui/Disclosure';
import type { SessionTelemetryRow } from '@/lib/supabase/types';
import { ZONES, type ZoneNumber } from '@/lib/analytics/zones';

/** Zone names as the training literature uses them. */
const ZONE_LABEL: Record<ZoneNumber, string> = {
  1: 'Zone 1 · recovery',
  2: 'Zone 2 · aerobic base',
  3: 'Zone 3 · tempo',
  4: 'Zone 4 · threshold',
  5: 'Zone 5 · maximal',
};

function minutes(value: number | null): string {
  if (value === null) return 'not measured';
  const whole = Math.floor(value);
  const rest = Math.round((value - whole) * 60);
  return whole >= 60
    ? `${Math.floor(whole / 60)}h ${whole % 60}m`
    : rest > 0 && whole < 10 ? `${whole}m ${rest}s` : `${whole} min`;
}

export function SessionTelemetry({ telemetry }: { telemetry: SessionTelemetryRow | null }) {
  if (telemetry === null) {
    return (
      <Card title="Heart rate during this session">
        <p className="text-sm text-ink-faint">
          No heart-rate data has been matched to this session. That is not the
          same as a session without effort — it means nothing was recording, or
          the connected source has not been synced since.
        </p>
      </Card>
    );
  }

  const zones = (telemetry.zone_minutes ?? {}) as Record<string, unknown>;
  const zoneMinutes = ZONES.map((zone) => ({
    zone,
    value: typeof zones[String(zone)] === 'number' ? (zones[String(zone)] as number) : null,
  }));
  const anyZone = zoneMinutes.some((z) => z.value !== null && z.value > 0);
  const zone2 = zoneMinutes.find((z) => z.zone === 2)?.value ?? null;

  const coverage = telemetry.hr_coverage_pct === null
    ? null
    : Number(telemetry.hr_coverage_pct);

  return (
    <Card title="Heart rate during this session">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Figure
          value={telemetry.average_hr === null ? null : formatNumber(Number(telemetry.average_hr), 0)}
          unit="bpm"
          label="Average"
          size="sm"
        />
        <Figure
          value={telemetry.min_hr === null ? null : formatNumber(Number(telemetry.min_hr), 0)}
          unit="bpm"
          label="Minimum"
          size="sm"
        />
        <Figure
          value={telemetry.max_hr === null ? null : formatNumber(Number(telemetry.max_hr), 0)}
          unit="bpm"
          label="Maximum"
          size="sm"
        />
        {/* Zone 2 gets a figure of its own because it is the question people
            actually ask of a session, and burying it in a list would make it
            something you have to go looking for. */}
        <Figure
          value={zone2 === null ? null : minutes(zone2)}
          label="Zone 2"
          size="sm"
          sub={zone2 === null ? 'no heart-rate data' : undefined}
        />
      </div>

      {/* The caveat, stated where the numbers are rather than in a footnote.
          An average over a fifth of a session is a different claim from one
          over all of it, and the reader should not have to work that out. */}
      <p className="mt-4 text-[11px] leading-relaxed text-ink-faint">
        {telemetry.hr_sample_count === 0 || telemetry.hr_sample_count === null ? (
          <>
            These figures come from the connected source&rsquo;s own summary of
            the session, not from individual readings.
          </>
        ) : (
          <>
            From {telemetry.hr_sample_count} reading
            {telemetry.hr_sample_count === 1 ? '' : 's'}
            {coverage === null ? '' : `, covering ${formatNumber(coverage, 0)}% of the session`}.
            {coverage !== null && coverage < 80 && (
              <> The rest was not recorded, so these minutes are a floor rather
              than a total.</>
            )}
          </>
        )}
        {telemetry.match_method === 'INTERVAL_ONLY' && (
          <> The source recorded no workout of its own for this time, so the
          heart rate was taken from the session&rsquo;s own start and end.</>
        )}
        {telemetry.match_confidence !== null && Number(telemetry.match_confidence) < 0.75 && (
          <> This session was matched to the source&rsquo;s recording with low
          confidence — check the times if the numbers look wrong.</>
        )}
      </p>

      {anyZone && (
        <Disclosure summary="Time in each zone">
          <dl className="space-y-1">
            {zoneMinutes.map(({ zone, value }) => (
              <div key={zone} className="flex items-baseline justify-between gap-4 text-sm">
                <dt className={zone === 2 ? 'text-ink' : 'text-ink-muted'}>
                  {ZONE_LABEL[zone]}
                </dt>
                <dd className="tabular text-ink-faint">{minutes(value)}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
            Computed from the recorded heart rate against your zone settings.
            Change them in Settings and this recalculates — the readings
            themselves are never rewritten.
          </p>
        </Disclosure>
      )}
    </Card>
  );
}
