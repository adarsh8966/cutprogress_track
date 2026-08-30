/**
 * Conflict resolution and canonicalisation (spec §16, §17).
 *
 * Three sources can disagree about this morning's weight. None of them is
 * deleted and none silently wins: every observation stays in the raw layer, and
 * this module decides which one becomes the canonical value for the day,
 * recording WHICH source won and HOW CONFIDENT that resolution is.
 *
 * Resolution rules, in order:
 *   1. The most recently recorded observation for the day wins.
 *   2. A tie between observations recorded at the same instant is broken by
 *      source priority (per-user configurable).
 *
 * RECENCY BEFORE PRIORITY, AND WHY IT CHANGED. Priority used to win outright,
 * which meant a value typed by hand outranked every later correction from any
 * other source, forever. Logging a weight by hand and then importing a
 * corrected one for that day wrote the import faithfully, reported it as
 * imported - and left the day showing the old number, with nothing anywhere
 * saying so. Stored, confirmed, and invisible: the one failure this system
 * exists to prevent. A correction is always the newer observation, so recency
 * is what "which of these is current?" actually means. Priority still decides
 * between two readings of the same moment, which is the question it answers.
 *
 * CORRECTIONS ARE NOT DISAGREEMENTS. Confidence and disagreement are measured
 * across ONE VALUE PER SOURCE - that source's own latest. Comparing every
 * observation would read a corrected weight (92.4 then 93.2, same source) as
 * two sources at odds and quietly downgrade a day the user had just fixed.
 * Two readings from one source are a correction; two sources that disagree are
 * a conflict, and only the second is worth interrupting anyone about.
 *
 * Confidence reflects agreement between SOURCES, not source rank:
 *   HIGH      one source, or every source's latest agrees within tolerance
 *   MODERATE  sources disagree slightly
 *   LOW       sources disagree materially - worth the user looking
 */
import type { ConfidenceLevel, DataSource, LocalDate } from '@/lib/types';

/**
 * Spec §16's default ordering. Lower number wins.
 *
 * HEVY sits just below MANUAL because it is a deliberate, first-party record of
 * a training session rather than a summary parsed out of text. In practice the
 * rank barely matters: this table only breaks a tie between two observations
 * recorded at the SAME INSTANT (recency decides everything else, see the header
 * above), and no training field is resolved through here at all - sessions are
 * summed, not resolved. The entry exists because Record<DataSource, number>
 * requires it, which is the point: adding a source cannot leave a hole here.
 */
export const DEFAULT_SOURCE_PRIORITY: Record<DataSource, number> = {
  MANUAL: 1,
  HEVY: 2,
  HEALTH_CONNECT: 3,
  GOOGLE_HEALTH: 4,
  BEVEL: 5,
  IMPORT_TEXT: 6,
  OTHER: 7,
  ESTIMATED: 99,
};

export interface Observation {
  id: string;
  value: number;
  source: DataSource;
  /** When the observation was recorded. The newest wins the day. */
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
  /**
   * How many DISTINCT sources competed. `candidates` above it means at least
   * one source was recorded more than once, which is a correction rather than
   * a disagreement - the difference conflicts() below turns on.
   */
  sources: number;
  /**
   * Spread between the highest and lowest of the per-source latest values, in
   * the field's unit. Null when only one source reported, however many times.
   */
  disagreement: number | null;
}

export interface ProvenanceEntry {
  source: DataSource;
  confidence: ConfidenceLevel;
  observationId: string | null;
  candidates: number;
  /**
   * Distinct sources behind this value. Optional because provenance rows
   * written before this field existed are still on disk and still readable -
   * daily_metrics is a cache, but an old row stays valid until it is rebuilt.
   */
  sources?: number;
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
    // The newest observation is the current one.
    //
    // Compared with < and >, not localeCompare: ISO-8601 timestamps sort
    // correctly either way, and this one cannot throw if a caller hands over
    // something that is not a string. A driver returning `timestamptz` as a
    // Date object used to crash the sort here, which failed the rebuild for the
    // whole day - a far worse outcome than an odd ordering. The conversion
    // belongs at the boundary (lib/data/canonicalise.ts) and is done there; this
    // is the belt to that pair of braces.
    const byRecency =
      a.recordedAt < b.recordedAt ? 1 : a.recordedAt > b.recordedAt ? -1 : 0;
    if (byRecency !== 0) return byRecency;
    // Recorded at the same instant: the higher-priority source wins.
    return rank(a.source) - rank(b.source);
  });

  const winner = sorted[0]!;

  // One value per source - its own latest, which `sorted` puts first. This is
  // what keeps a correction from reading as a conflict.
  const latestPerSource = new Map<DataSource, Observation>();
  for (const observation of sorted) {
    if (!latestPerSource.has(observation.source)) {
      latestPerSource.set(observation.source, observation);
    }
  }

  const values = [...latestPerSource.values()].map((o) => o.value);
  const spread = Math.max(...values) - Math.min(...values);
  const scale = Math.abs(winner.value) || 1;
  const relativeSpread = spread / scale;

  const confidence: ConfidenceLevel =
    latestPerSource.size === 1 || relativeSpread <= AGREEMENT_TOLERANCE
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
    sources: latestPerSource.size,
    disagreement: latestPerSource.size > 1 ? spread : null,
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
      sources: resolution.sources,
    };
  }

  return { values, provenance };
}

/**
 * Restricts pinned fields to the observations their owner actually authored.
 *
 * THE PROBLEM. Resolution is recency-first, and that is right for corrections -
 * it is the rule that stopped a hand-typed value outranking every later fix
 * forever. But an imported measurement recorded LATER IN THE DAY than a manual
 * correction is, by that rule, the newer observation. So a sync arriving
 * afterwards would move the number the user had just set, silently, and the
 * only trace would be a changed figure on a page nobody was looking at.
 *
 * A pin says: this (day, field) was authored by hand, so resolve it among the
 * hand-authored observations. The imported observation is still stored, still
 * carries its provenance, and is still shown - as available, not applied.
 *
 * A PIN NEVER BLANKS A DAY. If a pinned field has no manual observation left -
 * the user withdrew it, or the pin outlived the row that set it - the pin is
 * inert and the full candidate list stands. Suppressing every candidate would
 * turn a measured day into "not logged", which is a worse lie than the one the
 * pin exists to prevent.
 */
export function applyPins(
  fields: Record<string, Observation[]>,
  pinned: ReadonlySet<string>,
): Record<string, Observation[]> {
  if (pinned.size === 0) return fields;
  const out: Record<string, Observation[]> = {};
  for (const [field, observations] of Object.entries(fields)) {
    if (!pinned.has(field)) {
      out[field] = observations;
      continue;
    }
    const manual = observations.filter((o) => o.source === 'MANUAL');
    out[field] = manual.length > 0 ? manual : observations;
  }
  return out;
}

/**
 * Fields where a pin is actually doing something: the day holds an observation
 * the pin is keeping out of the canonical value. A pin over a field nobody else
 * reported is real but inert, and saying so on screen would be noise.
 */
export function pinsInEffect(
  fields: Record<string, Observation[]>,
  pinned: ReadonlySet<string>,
): string[] {
  return [...pinned].filter((field) => {
    const observations = fields[field] ?? [];
    const manual = observations.filter((o) => o.source === 'MANUAL');
    return manual.length > 0 && manual.length < observations.length;
  }).sort();
}

/**
 * Fields whose canonical value came from more than one DISAGREEING source.
 *
 * Deliberately not "more than one observation": correcting a weight by logging
 * it again leaves two observations for the day, and calling that a conflict
 * would interrupt the user every time they fixed a typo. `sources` is what
 * separates the two; a provenance row written before that field existed falls
 * back to `candidates`, which is the old, stricter reading.
 */
export function conflicts(provenance: ProvenanceMap): string[] {
  return Object.entries(provenance)
    .filter(([, entry]) => (entry.sources ?? entry.candidates) > 1
      && entry.confidence !== 'HIGH')
    .map(([field]) => field);
}

/**
 * Fields the day holds more observations of than sources - a value that was
 * recorded and then recorded again by the same source. That is a correction,
 * and it is worth being able to say so on screen rather than leaving the user
 * to wonder which of their two entries the app is showing.
 */
export function corrections(provenance: ProvenanceMap): string[] {
  return Object.entries(provenance)
    .filter(([, entry]) => entry.sources !== undefined
      && entry.candidates > entry.sources)
    .map(([field]) => field);
}
