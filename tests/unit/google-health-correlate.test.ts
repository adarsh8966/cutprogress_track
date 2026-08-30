/**
 * Deciding whether a Hevy workout and a Fitbit recording are the same workout.
 *
 * The brief's own example is the first case below: a session logged
 * 10:00 → 11:05 and a recording of 10:01:14 → 11:04:37 are obviously the same
 * hour, and requiring exact timestamps would match almost nothing. The rest of
 * this file is the other half of the problem - the pairs that must NOT be
 * merged, because fusing two sessions' physiology is not something a user can
 * unpick afterwards.
 */
import { describe, it, expect } from 'vitest';
import {
  scorePair, matchSessions, overlapMs, typeAgreement, explainMatch,
  MIN_OVERLAP_RATIO, type MatchCandidate,
} from '@/lib/integrations/googleHealth/correlate';

const at = (iso: string) => Date.parse(iso);

function candidate(
  id: string, start: string, end: string | null, extra: Partial<MatchCandidate> = {},
): MatchCandidate {
  return { id, startMs: at(start), endMs: end === null ? null : at(end), ...extra };
}

describe('overlap', () => {
  it('is zero for intervals that do not touch', () => {
    expect(overlapMs(
      { startMs: at('2026-08-29T10:00:00Z'), endMs: at('2026-08-29T11:00:00Z') },
      { startMs: at('2026-08-29T12:00:00Z'), endMs: at('2026-08-29T13:00:00Z') },
    )).toBe(0);
  });

  it('is the shared span for intervals that do', () => {
    expect(overlapMs(
      { startMs: at('2026-08-29T10:00:00Z'), endMs: at('2026-08-29T11:00:00Z') },
      { startMs: at('2026-08-29T10:30:00Z'), endMs: at('2026-08-29T12:00:00Z') },
    )).toBe(30 * 60_000);
  });
});

describe('scoring one pair', () => {
  it("matches the brief's example: 10:00-11:05 against 10:01:14-11:04:37", () => {
    const score = scorePair(
      candidate('hevy', '2026-08-29T10:00:00Z', '2026-08-29T11:05:00Z'),
      candidate('google', '2026-08-29T10:01:14Z', '2026-08-29T11:04:37Z'),
    )!;
    expect(score).not.toBeNull();
    expect(score.overlapRatio).toBeGreaterThan(0.97);
    expect(score.score).toBeGreaterThan(0.8);
    expect(score.startDriftSeconds).toBe(74);
    expect(score.endDriftSeconds).toBe(23);
  });

  it('refuses a pair that barely overlaps', () => {
    // A ten-minute walk inside a sixty-minute lift overlaps 100% of ITSELF,
    // which is why the ratio is against the shorter of the two - and why the
    // duration term exists to separate them even when the ratio is high.
    expect(scorePair(
      candidate('a', '2026-08-29T10:00:00Z', '2026-08-29T11:00:00Z'),
      candidate('b', '2026-08-29T10:50:00Z', '2026-08-29T12:00:00Z'),
    )).toBeNull();
  });

  it('refuses a pair on the same day that does not overlap at all', () => {
    // The rule the brief is emphatic about: same date is not same workout.
    expect(scorePair(
      candidate('morning', '2026-08-29T07:00:00Z', '2026-08-29T08:00:00Z'),
      candidate('evening', '2026-08-29T18:00:00Z', '2026-08-29T19:00:00Z'),
    )).toBeNull();
  });

  it('refuses a pair when either side has no end time', () => {
    // A session with no end has no interval, and everything here is interval
    // arithmetic. Guessing a duration would be inventing the evidence.
    expect(scorePair(
      candidate('a', '2026-08-29T10:00:00Z', null),
      candidate('b', '2026-08-29T10:00:00Z', '2026-08-29T11:00:00Z'),
    )).toBeNull();
  });

  it('scores a tighter match above a looser one', () => {
    const tight = scorePair(
      candidate('a', '2026-08-29T10:00:00Z', '2026-08-29T11:00:00Z'),
      candidate('b', '2026-08-29T10:01:00Z', '2026-08-29T10:59:00Z'),
    )!;
    const loose = scorePair(
      candidate('a', '2026-08-29T10:00:00Z', '2026-08-29T11:00:00Z'),
      candidate('c', '2026-08-29T10:20:00Z', '2026-08-29T11:20:00Z'),
    )!;
    expect(tight.score).toBeGreaterThan(loose.score);
  });

  it('cannot be rescued by a type match alone', () => {
    // Type agreement is worth 5% of the score and the overlap floor is checked
    // first, so two runs on opposite sides of the day stay two runs.
    expect(scorePair(
      candidate('a', '2026-08-29T07:00:00Z', '2026-08-29T08:00:00Z', { sessionType: 'CARDIO' }),
      candidate('b', '2026-08-29T18:00:00Z', '2026-08-29T19:00:00Z', { activityType: 'RUNNING' }),
    )).toBeNull();
  });
});

describe('type agreement', () => {
  it('is neutral when either side has no opinion', () => {
    expect(typeAgreement(null, 'PUSH')).toBe(0.5);
    expect(typeAgreement('RUNNING', null)).toBe(0.5);
    expect(typeAgreement('SOMETHING_UNKNOWN', 'PUSH')).toBe(0.5);
  });

  it('agrees a run with a cardio session and disagrees with a push day', () => {
    expect(typeAgreement('RUNNING', 'CARDIO')).toBe(1);
    expect(typeAgreement('RUNNING', 'PUSH')).toBe(0);
  });

  it('agrees weightlifting with any resistance split', () => {
    expect(typeAgreement('WEIGHTLIFTING', 'PUSH')).toBe(1);
    expect(typeAgreement('WEIGHTLIFTING', 'CARDIO')).toBe(0);
  });
});

describe('matching two sets of sessions', () => {
  it('keeps two workouts on one day separate', () => {
    const sessions = [
      candidate('morning', '2026-08-29T07:00:00Z', '2026-08-29T08:00:00Z'),
      candidate('evening', '2026-08-29T18:00:00Z', '2026-08-29T19:00:00Z'),
    ];
    const recordings = [
      candidate('rec-morning', '2026-08-29T07:01:00Z', '2026-08-29T07:58:00Z'),
      candidate('rec-evening', '2026-08-29T18:02:00Z', '2026-08-29T19:01:00Z'),
    ];
    const { matched } = matchSessions(sessions, recordings);
    expect(matched).toHaveLength(2);
    expect(matched.find((m) => m.left.id === 'morning')!.right.id).toBe('rec-morning');
    expect(matched.find((m) => m.left.id === 'evening')!.right.id).toBe('rec-evening');
  });

  it('uses each recording at most once', () => {
    // Two back-to-back sessions and one recording: the better pair wins and the
    // other session is left unmatched, rather than both claiming the same
    // physiology and double-counting it.
    const sessions = [
      candidate('a', '2026-08-29T10:00:00Z', '2026-08-29T11:00:00Z'),
      candidate('b', '2026-08-29T10:05:00Z', '2026-08-29T11:05:00Z'),
    ];
    const recordings = [candidate('rec', '2026-08-29T10:04:00Z', '2026-08-29T11:04:00Z')];
    const { matched, unmatchedLeft } = matchSessions(sessions, recordings);
    expect(matched).toHaveLength(1);
    expect(matched[0]!.left.id).toBe('b');
    expect(unmatchedLeft.map((s) => s.id)).toEqual(['a']);
  });

  it('reports a workout with no recording as unmatched', () => {
    const { matched, unmatchedLeft } = matchSessions(
      [candidate('lift', '2026-08-29T10:00:00Z', '2026-08-29T11:00:00Z')],
      [],
    );
    expect(matched).toHaveLength(0);
    expect(unmatchedLeft).toHaveLength(1);
  });

  it('reports a recording with no workout as unmatched', () => {
    // This is the branch that becomes a cardio session of its own: a walk that
    // was never in Hevy must not vanish.
    const { matched, unmatchedRight } = matchSessions(
      [],
      [candidate('walk', '2026-08-29T12:00:00Z', '2026-08-29T12:40:00Z')],
    );
    expect(matched).toHaveLength(0);
    expect(unmatchedRight).toHaveLength(1);
  });

  it('matches a session that crosses midnight', () => {
    // Compared as instants, never as dates: a session from 23:30 to 00:40 spans
    // two calendar days and is still one workout.
    const { matched } = matchSessions(
      [candidate('late', '2026-08-29T23:30:00Z', '2026-08-30T00:40:00Z')],
      [candidate('rec', '2026-08-29T23:31:00Z', '2026-08-30T00:39:00Z')],
    );
    expect(matched).toHaveLength(1);
  });

  it('is stable regardless of input order', () => {
    const sessions = [
      candidate('a', '2026-08-29T07:00:00Z', '2026-08-29T08:00:00Z'),
      candidate('b', '2026-08-29T18:00:00Z', '2026-08-29T19:00:00Z'),
    ];
    const recordings = [
      candidate('ra', '2026-08-29T07:01:00Z', '2026-08-29T07:59:00Z'),
      candidate('rb', '2026-08-29T18:01:00Z', '2026-08-29T18:59:00Z'),
    ];
    const forward = matchSessions(sessions, recordings).matched
      .map((m) => `${m.left.id}:${m.right.id}`).sort();
    const backward = matchSessions([...sessions].reverse(), [...recordings].reverse()).matched
      .map((m) => `${m.left.id}:${m.right.id}`).sort();
    expect(forward).toEqual(backward);
  });

  it('explains a match in a sentence a person can check', () => {
    const score = scorePair(
      candidate('a', '2026-08-29T10:00:00Z', '2026-08-29T11:05:00Z'),
      candidate('b', '2026-08-29T10:01:14Z', '2026-08-29T11:04:37Z'),
    )!;
    const explanation = explainMatch(score);
    expect(explanation).toMatch(/overlaps/);
    expect(explanation).toMatch(/74s/);
  });
});

describe('the overlap floor', () => {
  it('is stated as a constant rather than buried in the score', () => {
    expect(MIN_OVERLAP_RATIO).toBe(0.5);
  });
});
