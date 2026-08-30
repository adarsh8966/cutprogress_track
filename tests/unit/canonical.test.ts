import { describe, it, expect } from 'vitest';
import {
  resolveObservations, resolveFields, conflicts, corrections,
  DEFAULT_SOURCE_PRIORITY,
  type Observation,
} from '@/lib/normalization/canonical';

function obs(overrides: Partial<Observation>): Observation {
  return {
    id: 'o1',
    value: 92.9,
    source: 'MANUAL',
    recordedAt: '2026-08-28T12:00:00Z',
    localDate: '2026-08-28',
    ...overrides,
  };
}

describe('conflict resolution (spec §16)', () => {
  it('resolves the spec\'s own three-source example by priority', () => {
    // Bevel 205.1, Manual 205.4, Health Connect 205.2 -> Manual wins.
    const resolution = resolveObservations([
      obs({ id: 'bevel', value: 93.03, source: 'BEVEL' }),
      obs({ id: 'manual', value: 93.17, source: 'MANUAL' }),
      obs({ id: 'hc', value: 93.08, source: 'HEALTH_CONNECT' }),
    ]);
    expect(resolution!.source).toBe('MANUAL');
    expect(resolution!.observationId).toBe('manual');
    expect(resolution!.candidates).toBe(3);
  });

  it('reports HIGH confidence when sources agree closely', () => {
    const resolution = resolveObservations([
      obs({ id: 'a', value: 93.0, source: 'MANUAL' }),
      obs({ id: 'b', value: 93.1, source: 'BEVEL' }),
    ]);
    expect(resolution!.confidence).toBe('HIGH');
  });

  it('drops confidence when sources disagree materially', () => {
    const resolution = resolveObservations([
      obs({ id: 'a', value: 93.0, source: 'MANUAL' }),
      obs({ id: 'b', value: 96.0, source: 'BEVEL' }),
    ]);
    expect(resolution!.confidence).toBe('LOW');
    expect(resolution!.disagreement).toBeCloseTo(3, 6);
  });

  it('breaks ties within a source by recency', () => {
    const resolution = resolveObservations([
      obs({ id: 'older', value: 93.0, recordedAt: '2026-08-28T07:00:00Z' }),
      obs({ id: 'newer', value: 92.8, recordedAt: '2026-08-28T19:00:00Z' }),
    ]);
    expect(resolution!.observationId).toBe('newer');
  });

  it('honours a reconfigured source priority', () => {
    const resolution = resolveObservations(
      [
        obs({ id: 'manual', value: 93.17, source: 'MANUAL' }),
        obs({ id: 'hc', value: 93.08, source: 'HEALTH_CONNECT' }),
      ],
      { HEALTH_CONNECT: 0 },
    );
    expect(resolution!.source).toBe('HEALTH_CONNECT');
  });

  it('ranks estimated data below everything measured', () => {
    expect(DEFAULT_SOURCE_PRIORITY.ESTIMATED).toBeGreaterThan(
      DEFAULT_SOURCE_PRIORITY.IMPORT_TEXT,
    );
  });

  it('returns null, not zero, when a field has no observations', () => {
    expect(resolveObservations([])).toBeNull();
    const { values, provenance } = resolveFields({ steps: [] });
    expect(values.steps).toBeNull();
    // A field never measured gets no provenance entry at all.
    expect(provenance.steps).toBeUndefined();
  });

  it('builds a provenance entry per resolved field', () => {
    const { values, provenance } = resolveFields({
      weightKg: [obs({ id: 'w', value: 92.9 })],
      steps: [obs({ id: 's', value: 10421, source: 'HEALTH_CONNECT' })],
    });
    expect(values).toEqual({ weightKg: 92.9, steps: 10421 });
    expect(provenance.weightKg).toMatchObject({ source: 'MANUAL', confidence: 'HIGH' });
    expect(provenance.steps).toMatchObject({ source: 'HEALTH_CONNECT' });
  });

  it('surfaces which fields had a disagreement worth reviewing', () => {
    const { provenance } = resolveFields({
      weightKg: [
        obs({ id: 'a', value: 93.0, source: 'MANUAL' }),
        obs({ id: 'b', value: 96.0, source: 'BEVEL' }),
      ],
      steps: [obs({ id: 's', value: 10421 })],
    });
    expect(conflicts(provenance)).toEqual(['weightKg']);
  });
});

/**
 * The rule that changed, and the bug it fixes.
 *
 * Priority used to beat recency outright, so a hand-logged value outranked
 * every later correction from any other source forever: the corrected import
 * was written, reported as imported, and never displayed. These pin the new
 * ordering and the correction/conflict distinction that rides on it.
 */
describe('recency before priority (the corrected-import bug)', () => {
  it('lets a later import correct an earlier manual value', () => {
    const resolution = resolveObservations([
      obs({
        id: 'typed', value: 92.4, source: 'MANUAL',
        recordedAt: '2026-08-28T07:00:00Z',
      }),
      obs({
        id: 'imported', value: 93.2, source: 'IMPORT_TEXT',
        recordedAt: '2026-08-28T19:00:00Z',
      }),
    ]);
    expect(resolution!.observationId).toBe('imported');
    expect(resolution!.value).toBe(93.2);
    expect(resolution!.source).toBe('IMPORT_TEXT');
  });

  it('still lets a later manual entry correct an earlier import', () => {
    const resolution = resolveObservations([
      obs({
        id: 'imported', value: 93.2, source: 'IMPORT_TEXT',
        recordedAt: '2026-08-28T07:00:00Z',
      }),
      obs({
        id: 'typed', value: 92.4, source: 'MANUAL',
        recordedAt: '2026-08-28T19:00:00Z',
      }),
    ]);
    expect(resolution!.observationId).toBe('typed');
  });

  it('breaks a same-instant tie by source priority', () => {
    const at = '2026-08-28T12:00:00Z';
    const resolution = resolveObservations([
      obs({ id: 'imported', value: 93.2, source: 'IMPORT_TEXT', recordedAt: at }),
      obs({ id: 'typed', value: 92.4, source: 'MANUAL', recordedAt: at }),
    ]);
    expect(resolution!.observationId).toBe('typed');
  });
});

describe('a correction is not a conflict', () => {
  /** Two readings from one source, materially apart: a corrected typo. */
  const corrected = [
    obs({
      id: 'wrong', value: 92.4, source: 'MANUAL',
      recordedAt: '2026-08-28T07:00:00Z',
    }),
    obs({
      id: 'right', value: 96.0, source: 'MANUAL',
      recordedAt: '2026-08-28T19:00:00Z',
    }),
  ];

  it('keeps HIGH confidence when one source recorded twice', () => {
    const resolution = resolveObservations(corrected);
    expect(resolution!.value).toBe(96.0);
    expect(resolution!.confidence).toBe('HIGH');
    expect(resolution!.disagreement).toBeNull();
    expect(resolution!.candidates).toBe(2);
    expect(resolution!.sources).toBe(1);
  });

  it('does not report a corrected field as a conflict', () => {
    const { provenance } = resolveFields({ weightKg: corrected });
    expect(conflicts(provenance)).toEqual([]);
    expect(corrections(provenance)).toEqual(['weightKg']);
  });

  it('still reports two disagreeing sources as a conflict', () => {
    const { provenance } = resolveFields({
      weightKg: [
        obs({ id: 'a', value: 93.0, source: 'MANUAL' }),
        obs({ id: 'b', value: 96.0, source: 'BEVEL' }),
      ],
    });
    expect(conflicts(provenance)).toEqual(['weightKg']);
    // Two sources, one observation each: nothing was corrected.
    expect(corrections(provenance)).toEqual([]);
  });

  it('compares each source\'s latest, not every observation', () => {
    // MANUAL corrected 92.4 -> 95.8; BEVEL reported 96.0 once. The sources
    // agree closely NOW, and the superseded 92.4 must not drag that down.
    const resolution = resolveObservations([
      obs({
        id: 'old-manual', value: 92.4, source: 'MANUAL',
        recordedAt: '2026-08-28T07:00:00Z',
      }),
      obs({
        id: 'new-manual', value: 95.8, source: 'MANUAL',
        recordedAt: '2026-08-28T19:00:00Z',
      }),
      obs({
        id: 'bevel', value: 96.0, source: 'BEVEL',
        recordedAt: '2026-08-28T08:00:00Z',
      }),
    ]);
    expect(resolution!.observationId).toBe('new-manual');
    expect(resolution!.sources).toBe(2);
    expect(resolution!.candidates).toBe(3);
    expect(resolution!.confidence).toBe('HIGH');
    expect(resolution!.disagreement).toBeCloseTo(0.2, 6);
  });

  it('reads a pre-existing provenance row without a sources field', () => {
    // daily_metrics is a cache, but a row written before `sources` existed is
    // still on disk until it is rebuilt, and must still be readable.
    expect(
      conflicts({
        weightKg: {
          source: 'MANUAL', confidence: 'LOW',
          observationId: 'a', candidates: 2,
        },
      }),
    ).toEqual(['weightKg']);
  });
});
