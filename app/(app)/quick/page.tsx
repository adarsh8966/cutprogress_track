/**
 * Quick Entry (spec §6, §8).
 *
 * The manual counterpart to Import: one day, every field the system accepts, in
 * one place. It exists so that entering data by hand does not mean visiting four
 * pages, and so that the answer to "where did this go?" is printed next to the
 * field before it is even submitted.
 *
 * It shares the importer's write path exactly - the same server actions, the
 * same validation, the same canonical rebuild - so a value entered here and the
 * same value imported end up in the same row of the same table.
 */
import { QuickEntryForm } from '@/components/quick/QuickEntryForm';
import { getProfile, getRecordedDates } from '@/lib/data/queries';
import { DEFAULT_PROFILE } from '@/lib/defaults';
import { todayForUser } from '@/app/actions/log';
import { addDays, isLocalDate } from '@/lib/normalization/dates';
import {
  WEIGHT_UNIT_LABEL, LENGTH_UNIT_LABEL, DISTANCE_UNIT_LABEL,
} from '@/lib/normalization/units';

export const dynamic = 'force-dynamic';

export default async function QuickEntryPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const [profileRow, today, query, recorded] = await Promise.all([
    getProfile(), todayForUser(), searchParams, getRecordedDates(1),
  ]);
  const profile = profileRow ?? DEFAULT_PROFILE;
  // "Add to this day" on the day view arrives here with a date. Anything that
  // is not a real date falls back to today rather than being trusted into a
  // form field that would then fail validation on submit.
  const startDate =
    query.date && isLocalDate(query.date) ? query.date : today;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-light">Quick entry</h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-muted">
          One day, every field, one save. Each group says where its values land.
          A blank field is recorded as not logged — never as a zero — and groups
          you leave empty are skipped entirely. Folding a group away keeps what
          you have typed in it.
        </p>
      </header>

      <QuickEntryForm
        today={today}
        yesterday={addDays(today, -1)}
        initialDate={startDate}
        lastLoggedDate={recorded[0] ?? null}
        weightUnit={WEIGHT_UNIT_LABEL[profile.weightDisplayUnit]}
        lengthUnit={LENGTH_UNIT_LABEL[profile.lengthDisplayUnit]}
        distanceUnit={DISTANCE_UNIT_LABEL[profile.distanceDisplayUnit]}
      />
    </div>
  );
}
