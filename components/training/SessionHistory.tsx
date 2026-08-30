/**
 * The training you actually did, workout by workout.
 *
 * This is the primary content of the Training page, and each row opens onto
 * what was performed inside it - exercises in the order the source recorded
 * them, and the sets on each. It used to be a link to another page and a set
 * count, so the answer to "what did I do on Aug 29?" lived one navigation
 * away from the page named after it.
 *
 * A session appears here because a workout_sessions row exists, full stop -
 * not because anything was logged inside it. What the row does not know, it
 * says it does not know: a summary import has no exercises, and both the
 * collapsed row and the opened panel state that rather than leaving a gap the
 * reader has to interpret.
 *
 * The row is a <summary>, so it opens on click, tap, Enter and Space, with no
 * hover anywhere and no JavaScript of ours. The link to the full session -
 * where a workout can be corrected or added to - is inside the panel: an
 * anchor nested in a summary makes Enter ambiguous for anyone navigating by
 * keyboard.
 */
import { Disclosure } from '@/components/ui/Disclosure';
import { formatNumber } from '@/components/ui/primitives';
import { WorkoutDetail } from '@/components/training/WorkoutDetail';
import { formatShortDate } from '@/lib/normalization/dates';
import type { DisplayUnits } from '@/lib/normalization/units';
import type { Workout } from '@/lib/analytics/training';

export function SessionHistory({
  workouts,
  units,
}: {
  workouts: Workout[];
  units: DisplayUnits;
}) {
  if (workouts.length === 0) {
    return <p className="py-6 text-sm text-ink-faint">No training sessions recorded yet.</p>;
  }

  return (
    <ul className="divide-y divide-line/60">
      {workouts.map((workout) => (
        <li key={workout.session.id}>
          <Disclosure summary={<SessionLine workout={workout} />}>
            <WorkoutDetail workout={workout} units={units} />
          </Disclosure>
        </li>
      ))}
    </ul>
  );
}

/** The collapsed row: enough to recognise the workout without opening it. */
function SessionLine({ workout }: { workout: Workout }) {
  const { session } = workout;
  const type = session.sessionType.replaceAll('_', ' ').toLowerCase();

  const facts: string[] = [formatShortDate(session.date)];
  facts.push(
    session.durationMinutes === null
      ? 'duration not logged'
      : `${formatNumber(session.durationMinutes, 0)} min`,
  );
  // The count of sets RECORDED, warm-ups included - what the source says it
  // holds. The working-set figure every average is taken over is reconciled
  // inside the panel, where there is room to name the difference.
  facts.push(
    workout.setsLogged === 0
      ? 'no exercises logged'
      : `${workout.setsLogged} set${workout.setsLogged === 1 ? '' : 's'}`,
  );

  // RPE and RIR are the same question asked from opposite ends, and different
  // sources record different ones. Whichever exists is shown, named, and never
  // silently swapped for the other.
  const summary = workout.summary.value;
  if (summary?.averageRpe != null) {
    facts.push(`Avg RPE ${formatNumber(summary.averageRpe, 1)}`);
  } else if (summary?.averageRir != null) {
    facts.push(`Avg RIR ${formatNumber(summary.averageRir, 1)}`);
  }

  return (
    <>
      <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm text-ink">
          {/* The name the source gave it, when it gave one. A title that
              mapped to OTHER is still worth reading. */}
          {session.title ?? type}
        </span>
        {session.title !== null && (
          <span className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">
            {type}
          </span>
        )}
        {/* Provenance, where the user is looking at the session - spec §15:
            an imported record says so. */}
        {session.externalSource === 'HEVY' && (
          <span className="text-[11px] text-ink-faint">from Hevy</span>
        )}
      </span>
      <span className="tabular mt-0.5 block text-xs text-ink-faint">
        {facts.join(' · ')}
      </span>
    </>
  );
}
