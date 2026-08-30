/**
 * One set, written the way it was performed: `120 × 12 @ 7`.
 *
 * Presentation, not calculation - which is why it lives here and not in lib/,
 * where a function is expected to return Derived<T>. It is still pure and
 * still tested on its own, the same arrangement components/quick/groups.ts
 * already uses.
 *
 * THE RULE THROUGHOUT: state a measurement or omit it. Never a placeholder
 * that reads as a value. `120 × —` puts a dash where a rep count goes, next to
 * a number, and a dash beside a number reads as zero; a set that recorded a
 * load and no reps is written `120` and says nothing it does not know.
 *
 * Two glyphs carry meaning and are not interchangeable:
 *
 *   `@ 7`      RPE. Hevy records this.
 *   `RIR 2`    Reps in reserve, spelled out. Logging by hand records this.
 *
 * They measure the same thing from opposite ends, and this codebase is
 * emphatic that they are never conflated - so RIR never borrows the `@`, and a
 * set carrying both prints both.
 */
import type { ExerciseBlock, LoggedSet } from '@/lib/analytics/training';
import {
  displayDistance, displayWeight, unitLabels, type DisplayUnits,
} from '@/lib/normalization/units';
import { formatNumber } from '@/components/ui/primitives';

export interface SetLine {
  /**
   * `120 × 12 @ 7`. NULL when the set recorded no measurement at all - the row
   * exists in the database and the caller says so, rather than printing an
   * empty line or a row of dashes.
   */
  text: string | null;
  /**
   * `warm-up`, or the source's own set type verbatim. NULL when neither
   * applies. Hevy's set-type vocabulary is not published, so anything that is
   * not the exact string "warmup" is displayed uninterpreted.
   */
  qualifier: string | null;
}

/**
 * A recorded figure: one decimal place, and none when it would be a zero.
 *
 * formatNumber's own default widens to two places below 10, which turns an
 * RPE of 7.5 into "7.50" and a 2.5 kg plate into "2.50". Loads and intensities
 * are recorded to one decimal in the schema, so they are written to one.
 *
 * The rounding happens BEFORE the decision, not after: 20.4 kg read in pounds
 * is 44.97, which is not a whole number but rounds to one, and "45.0 lb" in a
 * column beside "130.1 lb" reads as a precision that was never measured.
 */
function figure(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return formatNumber(rounded, Number.isInteger(rounded) ? 0 : 1);
}

/**
 * The load unit for a block, hoisted so its set lines can be bare numbers.
 * NULL when no set in the block recorded a load, in which case there is no
 * unit to name.
 */
export function blockLoadUnit(block: ExerciseBlock, units: DisplayUnits): string | null {
  const loaded = block.sets.some((set) => set.weightKg !== null);
  return loaded ? unitLabels(units).weight : null;
}

/** Seconds as `m:ss`, or `h:mm:ss` once past an hour. */
export function formatSetDuration(seconds: number): string {
  const whole = Math.round(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole - hours * 3600) / 60);
  const rest = whole - hours * 3600 - minutes * 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(rest)}`
    : `${minutes}:${pad(rest)}`;
}

export function setLine(set: LoggedSet, units: DisplayUnits): SetLine {
  const qualifier = qualifierOf(set);
  const parts: string[] = [];

  // Load and reps. A zero load is a MEASUREMENT - a bodyweight movement adds
  // no external load, and migration 0004 says so explicitly - so it prints as
  // 0. Only null means unrecorded. Writing "bodyweight" here would be an
  // inference the application has not earned.
  if (set.weightKg !== null && set.reps !== null) {
    parts.push(`${figure(displayWeight(set.weightKg, units.weight))} × ${set.reps}`);
  } else if (set.weightKg !== null) {
    parts.push(figure(displayWeight(set.weightKg, units.weight)));
  } else if (set.reps !== null) {
    // The word is load-bearing: a bare "12" under a load column reads as a
    // weight. "12 reps" cannot.
    parts.push(`${set.reps} reps`);
  }

  // Distance and duration belong to the SET - a loaded carry, a machine
  // interval - and are training data, never cardio. They carry their unit
  // inline rather than hoisted, because most sets have neither and a header
  // naming a unit nothing below it uses is worse than a repeated word.
  if (set.distanceKm !== null) {
    const labels = unitLabels(units);
    parts.push(`${figure(displayDistance(set.distanceKm, units.distance))} ${labels.distance}`);
  }
  if (set.durationSeconds !== null) {
    parts.push(formatSetDuration(set.durationSeconds));
  }

  if (parts.length === 0) return { text: null, qualifier };

  let text = parts.join(' · ');
  if (set.rpe !== null) text += ` @ ${figure(set.rpe)}`;
  if (set.rir !== null) text += ` · RIR ${figure(set.rir)}`;

  return { text, qualifier };
}

function qualifierOf(set: LoggedSet): string | null {
  if (set.warmup) return 'warm-up';
  if (set.setType === null) return null;
  // "normal" is the source saying nothing in particular; anything else is
  // shown exactly as it was recorded.
  return set.setType.trim().toLowerCase() === 'normal' ? null : set.setType;
}
