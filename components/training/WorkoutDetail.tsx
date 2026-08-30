/**
 * What was performed inside one workout.
 *
 * THE REPORT THIS ANSWERS. Everything below - exercise order, the note on an
 * exercise, the superset two movements were paired in, RPE on the set it was
 * felt at - has been arriving from Hevy and landing in the database since
 * migration 0014, and the Training page showed none of it. The only exercise
 * detail on the page was one global progression table that flattened every
 * workout into per-exercise rows, so "what did I do in that Pull session?" was
 * unanswerable without leaving the page named after it.
 *
 * WHAT THIS DOES NOT RENDER. Name, date, duration, set count and average RPE
 * are in the row above, which stays on screen while this is open. Repeating
 * them here would be the same fact in two places on one screen.
 *
 * A summary import has no exercises, and this says so in a sentence rather
 * than leaving an empty panel - the row is a real, complete, session-level
 * observation, and none of it is invented from the absence of sets.
 */
import Link from 'next/link';
import { formatNumber } from '@/components/ui/primitives';
import { blockLoadUnit, setLine } from '@/components/training/setLine';
import type { DisplayUnits } from '@/lib/normalization/units';
import type { ExerciseBlock, SupersetGroup, Workout } from '@/lib/analytics/training';

export function WorkoutDetail({
  workout,
  units,
}: {
  workout: Workout;
  units: DisplayUnits;
}) {
  const { session, exercises, supersets } = workout;
  const rows = layOut(exercises, supersets);

  const intensity: string[] = [];
  if (session.averageHeartRate !== null) {
    intensity.push(`avg ${formatNumber(session.averageHeartRate, 0)} bpm`);
  }
  if (session.maxHeartRate !== null) {
    intensity.push(`max ${formatNumber(session.maxHeartRate, 0)} bpm`);
  }
  if (session.calories !== null) {
    intensity.push(`${formatNumber(session.calories, 0)} kcal`);
  }

  return (
    <div className="space-y-4">
      {/* Heart rate and calories, when the source recorded them. Hevy sends
          none, so on a synced workout this is simply absent rather than a row
          of "not logged" that says nothing. */}
      {intensity.length > 0 && (
        <p className="tabular flex flex-wrap gap-x-3 text-xs text-ink-faint">
          {intensity.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </p>
      )}

      {session.notes && (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">
          {session.notes}
        </p>
      )}

      {exercises.length === 0 ? (
        <p className="text-sm leading-relaxed text-ink-faint">
          No exercises or sets logged for this session. A summary import records
          that the session happened and how hard it was, but not what was
          performed — so none is assumed here.
        </p>
      ) : (
        <ol className="list-none divide-y divide-line/60">
          {rows.map((row) =>
            row.kind === 'single' ? (
              <ExerciseItem key={row.block.key} block={row.block} units={units} />
            ) : (
              <li key={`superset-${row.ordinal}`} className="py-3">
                <section
                  aria-labelledby={`${session.id}-ss-${row.ordinal}`}
                  className="border-l border-line-strong pl-3"
                >
                  {/* The WORD, not only the rule. A left border says nothing
                      to a screen reader and little at a glance, and this app
                      never lets a visual carry meaning by itself. The ordinal
                      is the position in this workout, not the source's own id:
                      Hevy's superset ids are opaque, and printing "Superset 7"
                      would be noise dressed as information. */}
                  <p
                    id={`${session.id}-ss-${row.ordinal}`}
                    className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-faint"
                  >
                    Superset{supersets.length > 1 ? ` ${row.ordinal}` : ''}
                  </p>
                  <ol className="list-none">
                    {row.blocks.map((block) => (
                      <ExerciseItem key={block.key} block={block} units={units} />
                    ))}
                  </ol>
                </section>
              </li>
            ),
          )}
        </ol>
      )}

      <div className="space-y-1 text-[11px] leading-relaxed text-ink-faint">
        {workout.setsLogged > workout.workingSets && (
          <p className="tabular">
            {workout.setsLogged} set{workout.setsLogged === 1 ? '' : 's'} logged ·{' '}
            {workout.workingSets} working — warm-ups are recorded and excluded from
            volume, bests and average RPE.
          </p>
        )}
        {exercises.length > 0 && <p>@ is RPE. RIR is written out.</p>}
        {supersets.length > 0 && <p>Superset grouping is the source&rsquo;s own.</p>}
      </div>

      <Link
        href={`/training/${session.id}`}
        className="inline-flex min-h-11 items-center text-xs text-ink-faint transition-colors hover:text-accent"
      >
        Open session to correct it or add exercises →
      </Link>
    </div>
  );
}

type Row =
  | { kind: 'single'; block: ExerciseBlock }
  | { kind: 'superset'; ordinal: number; blocks: ExerciseBlock[] };

/**
 * The exercises in source order, with each superset's members gathered under
 * the position where the run begins.
 *
 * One pass, and the order is never recomputed: a block that belongs to a group
 * is emitted with that group, and every other block stands alone exactly where
 * the source put it.
 */
function layOut(blocks: ExerciseBlock[], groups: SupersetGroup[]): Row[] {
  const groupOf = new Map<string, number>();
  groups.forEach((group, index) => {
    for (const key of group.blockKeys) groupOf.set(key, index);
  });

  const rows: Row[] = [];
  const emitted = new Set<number>();

  for (const block of blocks) {
    const group = groupOf.get(block.key);
    if (group === undefined) {
      rows.push({ kind: 'single', block });
      continue;
    }
    if (emitted.has(group)) continue;
    emitted.add(group);
    rows.push({
      kind: 'superset',
      ordinal: group + 1,
      blocks: blocks.filter((member) => groupOf.get(member.key) === group),
    });
  }

  return rows;
}

/** One exercise: its name, its note, and the sets performed on it. */
function ExerciseItem({
  block,
  units,
}: {
  block: ExerciseBlock;
  units: DisplayUnits;
}) {
  const unit = blockLoadUnit(block, units);
  const working = block.sets.filter((set) => !set.warmup).length;

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h4 className="text-sm text-ink">{block.exerciseName}</h4>
        <span className="tabular text-[11px] text-ink-faint">
          {working} working set{working === 1 ? '' : 's'}
          {unit && ` · ${unit}`}
        </span>
      </div>

      {/* The note belongs to the exercise, not to any one set. It is carried
          on every set of the block and shown once. */}
      {block.notes && (
        <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-ink-muted">
          {block.notes}
        </p>
      )}

      <ol className="mt-1.5 list-none space-y-0.5">
        {block.sets.map((set) => {
          const line = setLine(set, units);
          return (
            <li
              key={`${set.sessionId}-${set.exerciseId}-${set.setNumber}`}
              className="flex flex-wrap items-baseline gap-x-2"
            >
              {line.text === null ? (
                <span className="text-sm text-ink-faint">
                  nothing recorded for this set
                </span>
              ) : (
                <span className="tabular text-sm text-ink-muted">{line.text}</span>
              )}
              {line.qualifier && (
                <span className="text-[11px] text-ink-faint">{line.qualifier}</span>
              )}
            </li>
          );
        })}
      </ol>
    </li>
  );
}
