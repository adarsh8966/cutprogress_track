/**
 * PURE: matching a training session to the exercise session a wearable recorded
 * during it.
 *
 * THE PROBLEM. Hevy knows what was performed - the exercises, the sets, the
 * reps - and knows nothing about the body performing them. Google Health knows
 * the heart rate, the calories and the zones, and knows nothing about what was
 * being done. They are two halves of one workout and neither has the other's
 * identifier, so the only thing that can join them is time.
 *
 * DETERMINISTIC, AND DELIBERATELY NOT A LANGUAGE MODEL. "Did these two records
 * describe the same workout?" is a question about overlapping intervals. It has
 * an arithmetic answer that is the same every time it is asked, can be
 * explained to the user in one sentence, and costs nothing to run. Handing it
 * to a model would make it non-deterministic, unexplainable and expensive, and
 * would not make it more correct.
 *
 * WHAT THE SCORE IS BUILT FROM, in order of weight:
 *
 *   OVERLAP     How much of the shorter session the two share. This dominates,
 *               because it is the only signal that actually means "these
 *               happened at the same time". Below the floor, nothing else can
 *               rescue a pair.
 *   EDGES       How closely the starts and ends line up. Two devices started by
 *               hand a minute apart is the normal case, so this is a bonus for
 *               a tight match rather than a requirement.
 *   DURATION    How similar the lengths are. Separates a 60-minute lift that
 *               contains a 10-minute walk from one that IS the walk.
 *   TYPE        Whether the activity types agree. Weakest, and never sufficient:
 *               a type match cannot rescue a pair that does not overlap.
 *
 * WHAT IT REFUSES TO DO. Two workouts on the same day are two workouts. The
 * matcher never merges on date - only overlap gets a pair past the floor - and
 * each side is used at most once, so a morning push and an evening run cannot
 * both claim the same heart-rate session. Getting that wrong would fuse two
 * sessions' physiology permanently, which is the same class of mistake as
 * fuzzy-matching two exercises into one movement's history.
 */
import type { SessionTypeEnum } from '@/lib/supabase/types';

export interface MatchCandidate {
  id: string;
  startMs: number;
  /** Null when the source recorded no end. Such a session cannot be matched. */
  endMs: number | null;
  /** The activity type, where one is known. */
  activityType?: string | null;
  sessionType?: SessionTypeEnum | null;
}

export interface MatchScore {
  score: number;
  overlapRatio: number;
  overlapSeconds: number;
  startDriftSeconds: number;
  endDriftSeconds: number;
  durationSimilarity: number;
  typeAgreement: number;
}

export interface Match<A, B> {
  left: A;
  right: B;
  score: MatchScore;
}

/**
 * The overlap floor.
 *
 * A pair must share at least half of the SHORTER session. That is what makes
 * "10:00–11:05 and 10:01–11:04" a match (98%) while "a 60-minute lift and a
 * 10-minute walk inside it" is not (the walk overlaps 100% of itself, but see
 * the duration term, which is what actually separates those two).
 */
export const MIN_OVERLAP_RATIO = 0.5;

/** The total score a pair must reach to be accepted. */
export const MIN_MATCH_SCORE = 0.55;

/**
 * How far apart two starts can be and still count as "the same moment".
 *
 * Five minutes. Two devices are started by hand, seconds to a couple of minutes
 * apart; a watch auto-detects a workout that began before the user pressed
 * anything. Requiring exact timestamps would match almost nothing.
 */
export const EDGE_TOLERANCE_SECONDS = 5 * 60;

const WEIGHTS = { overlap: 0.60, edges: 0.20, duration: 0.15, type: 0.05 };

/** Milliseconds the two intervals share. Zero when they do not touch. */
export function overlapMs(
  a: { startMs: number; endMs: number },
  b: { startMs: number; endMs: number },
): number {
  return Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));
}

/**
 * Activity-type agreement, 0..1.
 *
 * A weak signal, weighted accordingly. Google's exercise types and CUT OS's
 * session types are different vocabularies for different purposes - one
 * describes the movement, the other describes the training split - so this
 * looks only for the cases where they clearly agree or clearly do not, and
 * returns a neutral 0.5 for the (common) case of no opinion.
 */
export function typeAgreement(
  activityType: string | null | undefined,
  sessionType: SessionTypeEnum | null | undefined,
): number {
  if (!activityType || !sessionType) return 0.5;
  const activity = activityType.toUpperCase();
  const strengthish = /WEIGHT|STRENGTH|WORKOUT|TRAINING|CIRCUIT|CALISTHENIC/.test(activity);
  const cardioish = /RUN|WALK|BIKE|CYCL|SWIM|ROW|ELLIPT|HIK|AEROBIC|TREADMILL/.test(activity);

  if (sessionType === 'CARDIO') return cardioish ? 1 : strengthish ? 0 : 0.5;
  if (sessionType === 'OTHER') return 0.5;
  // Every other session type is a resistance-training split.
  return strengthish ? 1 : cardioish ? 0 : 0.5;
}

/**
 * Scores one pair.
 *
 * Returns null when the pair cannot be a match at all: either side missing an
 * end time, or an overlap below the floor. Returning null rather than a low
 * score keeps "not a match" and "a weak match" apart, which matters because a
 * weak match is worth showing with its confidence and a non-match is not.
 */
export function scorePair(a: MatchCandidate, b: MatchCandidate): MatchScore | null {
  if (a.endMs === null || b.endMs === null) return null;

  const left = { startMs: a.startMs, endMs: a.endMs };
  const right = { startMs: b.startMs, endMs: b.endMs };

  const aMs = left.endMs - left.startMs;
  const bMs = right.endMs - right.startMs;
  if (aMs <= 0 || bMs <= 0) return null;

  const shared = overlapMs(left, right);
  const overlapRatio = shared / Math.min(aMs, bMs);
  if (overlapRatio < MIN_OVERLAP_RATIO) return null;

  const startDriftSeconds = Math.abs(left.startMs - right.startMs) / 1000;
  const endDriftSeconds = Math.abs(left.endMs - right.endMs) / 1000;
  const edgeScore = (
    Math.max(0, 1 - startDriftSeconds / EDGE_TOLERANCE_SECONDS)
    + Math.max(0, 1 - endDriftSeconds / EDGE_TOLERANCE_SECONDS)
  ) / 2;

  const durationSimilarity = Math.min(aMs, bMs) / Math.max(aMs, bMs);
  const agreement = typeAgreement(b.activityType ?? a.activityType, a.sessionType ?? b.sessionType);

  return {
    score:
      WEIGHTS.overlap * overlapRatio
      + WEIGHTS.edges * edgeScore
      + WEIGHTS.duration * durationSimilarity
      + WEIGHTS.type * agreement,
    overlapRatio,
    overlapSeconds: Math.round(shared / 1000),
    startDriftSeconds: Math.round(startDriftSeconds),
    endDriftSeconds: Math.round(endDriftSeconds),
    durationSimilarity,
    typeAgreement: agreement,
  };
}

/**
 * Matches two sets of sessions, one-to-one, best pair first.
 *
 * GREEDY, AND THAT IS THE RIGHT SHAPE HERE. The globally-optimal assignment is
 * a different and more expensive problem, and it only diverges from "take the
 * best pair, remove both sides, repeat" when two sessions overlap each other -
 * which for one person's training day means back-to-back or nested workouts,
 * where the highest-scoring pair is the one a human would pick too.
 *
 * The one-use rule is what stops a day's single heart-rate session being
 * attached to both of that day's workouts.
 */
export function matchSessions<A extends MatchCandidate, B extends MatchCandidate>(
  left: readonly A[],
  right: readonly B[],
  options: { minScore?: number } = {},
): { matched: Match<A, B>[]; unmatchedLeft: A[]; unmatchedRight: B[] } {
  const minScore = options.minScore ?? MIN_MATCH_SCORE;

  const scored: Match<A, B>[] = [];
  for (const a of left) {
    for (const b of right) {
      const score = scorePair(a, b);
      if (score !== null && score.score >= minScore) scored.push({ left: a, right: b, score });
    }
  }

  // Highest score first; ties broken by overlap, then by id, so the result is
  // stable rather than dependent on input order.
  scored.sort((x, y) =>
    y.score.score - x.score.score
    || y.score.overlapSeconds - x.score.overlapSeconds
    || x.left.id.localeCompare(y.left.id));

  const usedLeft = new Set<string>();
  const usedRight = new Set<string>();
  const matched: Match<A, B>[] = [];

  for (const candidate of scored) {
    if (usedLeft.has(candidate.left.id) || usedRight.has(candidate.right.id)) continue;
    usedLeft.add(candidate.left.id);
    usedRight.add(candidate.right.id);
    matched.push(candidate);
  }

  return {
    matched,
    unmatchedLeft: left.filter((a) => !usedLeft.has(a.id)),
    unmatchedRight: right.filter((b) => !usedRight.has(b.id)),
  };
}

/**
 * A sentence explaining a match, for the UI and the audit trail.
 *
 * A correlation the user cannot interrogate is a correlation they have to take
 * on faith, and this one occasionally will be wrong.
 */
export function explainMatch(score: MatchScore): string {
  const percent = Math.round(score.overlapRatio * 100);
  const minutes = Math.round(score.overlapSeconds / 60);
  return `${percent}% of the session overlaps (${minutes} min), starting within `
    + `${score.startDriftSeconds}s and ending within ${score.endDriftSeconds}s.`;
}
