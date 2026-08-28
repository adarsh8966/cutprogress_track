/**
 * Conflict resolution and canonicalisation (spec §16, §17).
 *
 * Three sources can disagree about this morning's weight. None of them is
 * deleted and none silently wins: every observation stays in the raw layer, and
 * this module decides which one becomes the canonical value for the day,
 * recording WHICH source won and HOW CONFIDENT that resolution is.
 *
 * Resolution rules, in order:
 *   1. Higher-priority source wins (priority is per-user configurable).
 *   2. Within a source, the most recent observation for the day wins.
 *
 * Confidence reflects agreement, not source rank:
 *   HIGH      one source, or all candidates agree within tolerance
 *   MODERATE  candidates disagree slightly
 *   LOW       candidates disagree materially - worth the user looking
 */
import type { ConfidenceLevel, DataSource, LocalDate } from '@/lib/types';

/** Spec §16's default ordering. Lower number wins. */
export const DEFAULT_SOURCE_PRIORITY: Record<DataSource, number> = {
  MANUAL: 1,
  HEALTH_CONNECT: 2,
  GOOGLE_HEALTH: 3,
  BEVEL: 4,
  IMPORT_TEXT: 5,
  OTHER: 6,
  ESTIMATED: 99,
};

export interface Observation {
  id: string;
  value: number;
  source: DataSource;
  /** When the observation was recorded, for tie-breaking within a source. */
  recordedAt: string;
  localDate: LocalDate;
}

export interface Resolution {
  value: number;
  source: DataSource;
  confidence: ConfidenceLevel;
  observationId: string;
  /** How many observations competed for this field. */
  candidates: number;
  /** Spread between the highest and lowest candidate, in the field's unit. */
  disagreement: number | null;
}

export interface ProvenanceEntry {
  source: DataSource;
  confidence: ConfidenceLevel;
  observationId: string | null;
  candidates: number;
}

export type ProvenanceMap = Record<string, ProvenanceEntry>;

/**
 * Relative tolerance within which competing observations are treated as
 * agreeing. 0.5% covers scale-to-scale variation on a body weight without
 * masking a genuine conflict.
 */
export const AGREEMENT_TOLERANCE = 0.005;

export function resolveObservations(
  observations: Observation[],
  priority: Partial<Record<DataSource, number>> = {},
): Resolution | null {
  if (observations.length === 0) return null;

  const rank = (source: DataSource): number =>
    priority[source] ?? DEFAULT_SOURCE_PRIORITY[source];

  const sorted = [...observations].sort((a, b) => {
    const byPriority = rank(a.source) - rank(b.source);
    if (byPriority !== 0) return byPriority;
    // Same source: most recently recorded wins.
    return b.recordedAt.localeCompare(a.recordedAt);
  });

  const winner = sorted[0]!;

  const values = observations.map((o) => o.value);
  const spread = Math.max(...values) - Math.min(...values);
  const scale = Math.abs(winner.value) || 1;
  const relativeSpread = spread / scale;

  const confidence: ConfidenceLevel =
    observations.length === 1 || relativeSpread <= AGREEMENT_TOLERANCE
      ? 'HIGH'
      : relativeSpread <= AGREEMENT_TOLERANCE * 4
        ? 'MODERATE'
        : 'LOW';

  return {
    value: winner.value,
    source: winner.source,
    confidence,
    observationId: winner.id,
    candidates: observations.length,
    disagreement: observations.length > 1 ? spread : null,
  };
}

/** Resolves several named fields at once and builds the provenance map. */
export function resolveFields(
  fields: Record<string, Observation[]>,
  priority: Partial<Record<DataSource, number>> = {},
): { values: Record<string, number | null>; provenance: ProvenanceMap } {
  const values: Record<string, number | null> = {};
  const provenance: ProvenanceMap = {};

  for (const [field, observations] of Object.entries(fields)) {
    const resolution = resolveObservations(observations, priority);
    if (resolution === null) {
      // No observation means NOT LOGGED. It does not mean zero, and no
      // provenance entry is written for a field that was never measured.
      values[field] = null;
      continue;
    }
    values[field] = resolution.value;
    provenance[field] = {
      source: resolution.source,
      confidence: resolution.confidence,
      observationId: resolution.observationId,
      candidates: resolution.candidates,
    };
  }

  return { values, provenance };
}

/** Fields whose canonical value came from more than one disagreeing source. */
export function conflicts(provenance: ProvenanceMap): string[] {
  return Object.entries(provenance)
    .filter(([, entry]) => entry.candidates > 1 && entry.confidence !== 'HIGH')
    .map(([field]) => field);
}
