/**
 * What the review screen shows must be what the import writes.
 *
 * This is the property the importer exists to keep, and the one place it can
 * break invisibly: the review screen renders a display value, the confirm sends
 * a canonical one, and nothing in the UI ever reports a mismatch. So the whole
 * mapping lives in lib/health/importPayload.ts, pure, and is pinned here.
 *
 * These are the assertions a browser click-through would be making, minus the
 * browser: parse the fixture, seed the review state from it, read back the
 * payload, and check it against what the parser found.
 */
import { describe, it, expect } from 'vitest';
import { parseText, type ParsedRecord } from '@/lib/health/parser';
import { toCardioType, toSessionType } from '@/lib/health/sessionTypes';
import {
  DAY_FIELD_ORDER, dayRow, sessionFieldRow, dayPath, sessionPath, sessionTypePath,
  editsFromPreview, buildConfirmPayload, summariseWrites, storableFields,
  unstorableFields, forDisplay,
  type DisplayUnits, type PayloadRecord, type EditState,
} from '@/lib/health/importPayload';
import { canonicalWeight } from '@/lib/normalization/units';
import { SEVEN_DAY_REPORT } from '../helpers/importFixtures';

const IMPERIAL: DisplayUnits = { weight: 'LB', length: 'IN', distance: 'MI' };
const METRIC: DisplayUnits = { weight: 'KG', length: 'CM', distance: 'KM' };

/** The shape the review screen hands the builder, built from a parse. */
function toPayloadRecords(records: ParsedRecord[]): PayloadRecord[] {
  return records.map((record) => ({
    fields: record.fields,
    sessions: record.sessions.map((session) => ({
      kind: session.kind,
      rawLabel: session.rawLabel,
      sessionType: toSessionType(session.rawLabel).value,
      cardioType: toCardioType(session.rawLabel).value,
      fields: session.fields,
    })),
    rawText: record.rawText,
    targetDate: record.localDate,
  }));
}

function review(text: string, units: DisplayUnits = IMPERIAL) {
  const parsed = parseText(text, 2026);
  const records = toPayloadRecords(parsed.records);
  const edits = editsFromPreview(records, units, '2026-01-01');
  return { parsed, records, edits, units };
}

function payloadFor(text: string, units: DisplayUnits = IMPERIAL) {
  const { records, edits } = review(text, units);
  return buildConfirmPayload(records, edits, units, '2026-01-01');
}

describe('every parsed value survives to the payload unchanged', () => {
  const day = [
    'Date: 2026-09-01',
    'Weight: 203.7 lb',
    'Waist: 35.4 in',
    'Calories: 2,001',
    'Protein: 172g',
    'Carbs: 198g',
    'Fat: 67g',
    'Fiber: 29g',
    'Steps: 15,000',
    'Active calories: 640',
    'Sleep: 7h 30m',
    'Resting HR: 58 bpm',
    'HRV: 71 ms',
  ].join('\n');

  it('carries the parser’s canonical number, not the rounded display value', () => {
    const { parsed } = review(day);
    const record = payloadFor(day).records[0]!;
    for (const key of DAY_FIELD_ORDER) {
      const parsedValue = parsed.records[0]!.fields.find((f) => f.key === key)?.value ?? null;
      expect(record[key], key).toBe(parsedValue);
    }
  });

  it('survives a lossy display round trip', () => {
    // 92.4 kg shows as 203.71 lb; converting that rounded string back gives
    // 92.4046 kg. An untouched field must submit 92.4 exactly.
    const { edits } = review('Weight: 92.4 kg');
    const shown = Number(edits.values[dayPath(0, 'weightKg')]);
    const roundTripped = canonicalWeight(shown, 'LB');
    expect(roundTripped).not.toBe(92.4);

    const record = payloadFor('Weight: 92.4 kg').records[0]!;
    expect(record.weightKg).toBe(92.4);
    expect(record.weightKg).not.toBe(roundTripped);
  });

  it('shows the value in the reader’s units without changing what is stored', () => {
    const imperial = review('Weight: 92.4 kg', IMPERIAL);
    expect(imperial.edits.values[dayPath(0, 'weightKg')]).toBe('203.71');
    const metric = review('Weight: 92.4 kg', METRIC);
    expect(metric.edits.values[dayPath(0, 'weightKg')]).toBe('92.4');

    expect(payloadFor('Weight: 92.4 kg', IMPERIAL).records[0]!.weightKg).toBe(92.4);
    expect(payloadFor('Weight: 92.4 kg', METRIC).records[0]!.weightKg).toBe(92.4);
  });

  it('converts an edited field back from the reader’s units', () => {
    const { records, edits, units } = review('Weight: 203.7 lb');
    edits.values[dayPath(0, 'weightKg')] = '200';
    edits.dirty[dayPath(0, 'weightKg')] = true;

    const record = buildConfirmPayload(records, edits, units, '2026-01-01').records[0]!;
    expect(record.weightKg).toBeCloseTo(90.718474, 6);
  });

  it('sends null, never zero, for a field left blank', () => {
    const record = payloadFor('Date: 2026-09-01\nSteps: 15000').records[0]!;
    expect(record.steps).toBe(15000);
    expect(record.weightKg).toBeNull();
    expect(record.proteinG).toBeNull();
    expect(record.sleepMinutes).toBeNull();
  });

  it('sends null when a value is cleared, and keeps a typed zero', () => {
    const { records, edits, units } = review('Steps: 15000');
    edits.values[dayPath(0, 'steps')] = '';
    edits.dirty[dayPath(0, 'steps')] = true;
    expect(buildConfirmPayload(records, edits, units, '2026-01-01').records[0]!.steps).toBeNull();

    edits.values[dayPath(0, 'steps')] = '0';
    expect(buildConfirmPayload(records, edits, units, '2026-01-01').records[0]!.steps).toBe(0);
  });

  it('seeds each record with its own parsed date, not one shared fallback', () => {
    const { edits } = review(SEVEN_DAY_REPORT);
    expect(edits.dates).toEqual([
      '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04',
      '2026-09-05', '2026-09-06', '2026-09-07',
    ]);
  });

  it('uses the date the reviewer chose', () => {
    const { records, edits, units } = review('Steps: 15000');
    expect(edits.dates[0]).toBe('2026-01-01');
    edits.dates[0] = '2026-09-04';
    expect(buildConfirmPayload(records, edits, units, '2026-01-01').records[0]!.date)
      .toBe('2026-09-04');
  });

  it('keeps each day’s raw text with its own record', () => {
    const payload = payloadFor(SEVEN_DAY_REPORT);
    expect(payload.records).toHaveLength(7);
    expect(payload.records[0]!.rawText).toContain('2026-09-01');
    expect(payload.records[0]!.rawText).not.toContain('2026-09-02');
  });
});

describe('sessions reach the payload', () => {
  const text = [
    'Date: 2026-09-01',
    'Workout: Push',
    'Duration: 55 min',
    'Avg HR: 128 bpm',
    'Max HR: 161 bpm',
    'Calories burned: 430',
    'Cardio: Running',
    'Duration: 38 min',
    'Distance: 3.1 mi',
    'Zone: 3',
  ].join('\n');

  it('carries a workout with its mapped type and every stored field', () => {
    const session = payloadFor(text).records[0]!.sessions[0]!;
    expect(session).toMatchObject({
      kind: 'WORKOUT', sessionType: 'PUSH', rawLabel: 'Push',
      sessionMinutes: 55, averageHeartRate: 128, maxHeartRate: 161,
      sessionCalories: 430,
    });
    // A workout has no distance or zone column, so those must be null.
    expect(session.distanceKm).toBeNull();
    expect(session.hrZone).toBeNull();
  });

  it('carries cardio with its canonical distance', () => {
    const session = payloadFor(text).records[0]!.sessions[1]!;
    expect(session.kind).toBe('CARDIO');
    expect(session.cardioType).toBe('RUNNING');
    expect(session.sessionMinutes).toBe(38);
    expect(session.distanceKm).toBeCloseTo(4.9889664, 6);
    expect(session.hrZone).toBe(3);
  });

  it('honours a type the reviewer corrected', () => {
    const { records, edits, units } = review('Workout: Arms and abs\nDuration: 40 min');
    expect(records[0]!.sessions[0]!.sessionType).toBe('OTHER');
    edits.types[sessionTypePath(0, 0)] = 'UPPER';
    const session = buildConfirmPayload(records, edits, units, '2026-01-01')
      .records[0]!.sessions[0]!;
    expect(session.sessionType).toBe('UPPER');
    // The label the user actually wrote still goes to the notes column.
    expect(session.rawLabel).toBe('Arms and abs');
  });

  it('drops a session the reviewer removed', () => {
    // One unfixable session must not block the whole paste, and the review has
    // to be able to say "not this one".
    const { records, edits, units } = review(
      'Workout: Push\nDuration: 45 min\nCardio: Walk\nDuration: 25 min',
    );
    expect(buildConfirmPayload(records, edits, units, 'x').records[0]!.sessions)
      .toHaveLength(2);

    edits.removed[sessionTypePath(0, 0)] = true;
    const after = buildConfirmPayload(records, edits, units, 'x').records[0]!;
    expect(after.sessions).toHaveLength(1);
    expect(after.sessions[0]!.kind).toBe('CARDIO');
    expect(summariseWrites(after)).toEqual(['1 cardio session']);
  });

  it('names a session field the table cannot store instead of dropping it', () => {
    const { records } = review('Workout: Push\nDuration: 45 min\nDistance: 2 km');
    const dropped = unstorableFields(records[0]!.sessions[0]!);
    expect(dropped.map((f) => f.key)).toEqual(['distanceKm']);
    // And it does not sneak into the payload.
    const session = payloadFor('Workout: Push\nDuration: 45 min\nDistance: 2 km')
      .records[0]!.sessions[0]!;
    expect(session.distanceKm).toBeNull();
  });

  it('keeps several sessions on one day distinct', () => {
    const sessions = payloadFor([
      'Workout: Push', 'Duration: 45 min',
      'Cardio: Walk', 'Duration: 25 min',
      'Cardio: Cycling', 'Duration: 40 min',
    ].join('\n')).records[0]!.sessions;

    expect(sessions.map((s) => s.kind)).toEqual(['WORKOUT', 'CARDIO', 'CARDIO']);
    expect(sessions.map((s) => s.sessionMinutes)).toEqual([45, 25, 40]);
  });
});

describe('the "will be saved" line matches the payload', () => {
  it('names every table a full day writes to', () => {
    const record = payloadFor([
      'Date: 2026-09-01', 'Weight: 203.7 lb', 'Calories: 2001', 'Steps: 15000',
      'Active calories: 640', 'Sleep: 7h 30m', 'Workout: Push', 'Duration: 55 min',
    ].join('\n')).records[0]!;

    expect(summariseWrites(record)).toEqual([
      '1 body measurement', '1 nutrition log', '2 metric observations',
      '1 sleep record', '1 workout',
    ]);
  });

  it('says nothing for a day with no values', () => {
    const record = payloadFor('Date: 2026-09-01\nMood: fine').records[0]!;
    expect(summariseWrites(record)).toEqual([]);
  });

  it('counts several sessions', () => {
    const record = payloadFor([
      'Date: 2026-09-01',
      'Workout: Push', 'Duration: 45 min',
      'Workout: Legs', 'Duration: 50 min',
      'Cardio: Walk', 'Duration: 25 min',
    ].join('\n')).records[0]!;
    expect(summariseWrites(record)).toEqual(['2 workouts', '1 cardio session']);
  });

  it('stops naming a row once its field is cleared', () => {
    const { records, edits, units } = review('Date: 2026-09-01\nWeight: 203.7 lb');
    expect(summariseWrites(buildConfirmPayload(records, edits, units, 'x').records[0]!))
      .toEqual(['1 body measurement']);
    edits.values[dayPath(0, 'weightKg')] = '';
    edits.dirty[dayPath(0, 'weightKg')] = true;
    expect(summariseWrites(buildConfirmPayload(records, edits, units, 'x').records[0]!))
      .toEqual([]);
  });
});

describe('the whole fixture round-trips', () => {
  const { parsed, records, edits, units } = review(SEVEN_DAY_REPORT);
  const payload = buildConfirmPayload(records, edits, units, '2026-01-01');

  it('produces one payload record per parsed day', () => {
    expect(payload.records).toHaveLength(parsed.records.length);
    expect(payload.records.map((r) => r.date)).toEqual(
      parsed.records.map((r) => r.localDate),
    );
  });

  it('agrees with the parser on every day-level field of every day', () => {
    parsed.records.forEach((record, r) => {
      for (const key of DAY_FIELD_ORDER) {
        const expected = record.fields.find((f) => f.key === key)?.value ?? null;
        expect(payload.records[r]![key], `${record.localDate} ${key}`).toBe(expected);
      }
    });
  });

  it('agrees with the parser on every storable session field', () => {
    parsed.records.forEach((record, r) => {
      record.sessions.forEach((session, s) => {
        const built = payload.records[r]!.sessions[s]!;
        for (const key of storableFields(session.kind)) {
          const expected = session.fields.find((f) => f.key === key)?.value ?? null;
          expect(built[key], `${record.localDate} session ${s} ${key}`).toBe(expected);
        }
      });
    });
  });

  it('displays every seeded value in a form that reads back to itself', () => {
    for (const key of DAY_FIELD_ORDER) {
      const path = dayPath(0, key);
      const seeded = edits.values[path];
      if (seeded === undefined) continue;
      const row = dayRow(key, units);
      expect(seeded).toBe(forDisplay(edits.canonical[path]!, row));
    }
  });

  it('seeds a display value for every session field it will submit', () => {
    parsed.records.forEach((record, r) => {
      record.sessions.forEach((session, s) => {
        for (const key of storableFields(session.kind)) {
          const path = sessionPath(r, s, key);
          const built = payload.records[r]!.sessions[s]![key];
          if (built === null) {
            expect(edits.values[path] ?? '').toBe('');
          } else {
            expect(edits.values[path]).toBe(
              forDisplay(built, sessionFieldRow(key, units)),
            );
          }
        }
      });
    });
  });
});

describe('edit state helpers', () => {
  it('builds a stable path for every field', () => {
    expect(dayPath(2, 'weightKg')).toBe('2.weightKg');
    expect(sessionPath(2, 1, 'averageHeartRate')).toBe('2.s1.averageHeartRate');
    expect(sessionTypePath(2, 1)).toBe('2.s1');
  });

  it('seeds nothing for a day that parsed nothing', () => {
    const empty: EditState = editsFromPreview([], IMPERIAL, '2026-01-01');
    expect(empty.values).toEqual({});
    expect(empty.dates).toEqual([]);
  });
});
