import { describe, it, expect } from 'vitest';
import {
  resolveObservations, resolveFields, conflicts, DEFAULT_SOURCE_PRIORITY,
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
