import { describe, it, expect } from 'vitest';
import { parseText } from '@/lib/health/parser';
import { toSessionType } from '@/lib/health/sessionTypes';
import { editsFromPreview, buildConfirmPayload, summariseWrites } from '@/lib/health/importPayload';
import { kgToLb } from '@/lib/normalization/units';

const REPORTED = `Date: 2026-09-01
Weight: 203.7 lb
Waist: 35.4 in
Calories: 2,001
Protein: 172g
Carbs: 198g
Fat: 67g
Fiber: 29g
Steps: 15,000
Sleep: 7h 30m
Workout: Push
Duration: 55 min

Date: 2026-09-02
Weight: 203.1 lb
Calories: 1,950
Protein: 180g
Steps: 11,250
Workout: Pull
Duration: 61 min`;

describe('the exact input that was reported as broken', () => {
  const parsed = parseText(REPORTED, 2026);
  const records = parsed.records.map((r) => ({
    fields: r.fields, rawText: r.rawText, targetDate: r.localDate,
    sessions: r.sessions.map((s) => ({
      kind: s.kind, rawLabel: s.rawLabel,
      sessionType: toSessionType(s.rawLabel).value,
      cardioType: 'OTHER' as const, fields: s.fields,
    })),
  }));
  const units = { weight: 'LB', length: 'IN', distance: 'MI' } as const;
  const payload = buildConfirmPayload(records, editsFromPreview(records, units, 'x'), units, 'x');

  it('produces both days, not just the first', () => {
    expect(payload.records.map((r) => r.date)).toEqual(['2026-09-01', '2026-09-02']);
    expect(parsed.unrecognisedLines).toHaveLength(0);
  });

  it('carries day one whole, including the workout', () => {
    const day = payload.records[0]!;
    expect(kgToLb(day.weightKg!)).toBeCloseTo(203.7, 6);
    expect(day.calories).toBe(2001);
    expect(day.fiberG).toBe(29);
    expect(day.sleepMinutes).toBe(450);
    expect(day.sessions[0]).toMatchObject({ sessionType: 'PUSH', sessionMinutes: 55 });
    expect(summariseWrites(day)).toEqual([
      '1 body measurement', '1 nutrition log', '1 metric observation',
      '1 sleep record', '1 workout',
    ]);
  });

  it('carries day two whole, and does not inherit day one', () => {
    const day = payload.records[1]!;
    expect(kgToLb(day.weightKg!)).toBeCloseTo(203.1, 6);
    expect(day.calories).toBe(1950);
    expect(day.waistCm).toBeNull();
    expect(day.fiberG).toBeNull();
    expect(day.sessions[0]).toMatchObject({ sessionType: 'PULL', sessionMinutes: 61 });
  });

  it('agrees field for field with what the parser read', () => {
    parsed.records.forEach((record, i) => {
      for (const field of record.fields) {
        expect(payload.records[i]![field.key as 'calories']).toBe(field.value);
      }
      record.sessions.forEach((session, s) => {
        for (const field of session.fields) {
          expect(payload.records[i]!.sessions[s]![field.key as 'sessionMinutes'])
            .toBe(field.value);
        }
      });
    });
  });
});
