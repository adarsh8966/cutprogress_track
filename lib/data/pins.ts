import 'server-only';

/**
 * Pinning the fields a person authored by hand (spec §16, §33).
 *
 * WHY THIS EXISTS. Canonical resolution is recency-first: the newest
 * observation for a day wins, and source priority only breaks a tie between two
 * readings of the same instant. That rule is right, and it was arrived at the
 * hard way - priority used to win outright, which meant a hand-typed value
 * outranked every later correction from any source, forever.
 *
 * But it has a consequence nobody wants once a provider is connected. An
 * imported measurement recorded LATER IN THE DAY than a manual correction is,
 * by that rule, the newer observation. So a sync arriving afterwards would move
 * the number the user had just fixed, silently, and the only trace would be a
 * changed figure on a page nobody was looking at.
 *
 * A pin says: this field, on this day, was authored by hand - resolve it among
 * the hand-authored observations. The imported one is still written, still
 * carries its provenance, and is still shown; it just does not become the
 * canonical value until the pin is lifted.
 *
 * WHAT A PIN IS NOT. It is not a lock on the raw layer, it does not stop an
 * import, and it does not hide anything. Everything Google Health sends is
 * stored either way. A pin changes which observation is canonical and nothing
 * else.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/supabase/types';
import type { LocalDate } from '@/lib/types';

type Client = SupabaseClient<Database>;

/**
 * Which canonical fields each manual form writes.
 *
 * Keyed by form rather than by table because that is the unit the user acts in:
 * pressing Save on the recovery form is a statement about the fields that form
 * carries, and only the ones actually filled in.
 */
export const PINNABLE_FIELDS = {
  weightKg: 'weight',
  waistCm: 'waist',
  steps: 'steps',
  activeCalories: 'active calories',
  totalCaloriesBurned: 'total calories burned',
  restingHeartRate: 'resting heart rate',
  hrvMs: 'HRV',
  sleepDurationMinutes: 'sleep duration',
  sleepScore: 'sleep score',
  bodyFatPct: 'body fat',
  vo2Max: 'VO2 max',
  respiratoryRate: 'respiratory rate',
  oxygenSaturationPct: 'blood oxygen',
} as const;

export type PinnableField = keyof typeof PINNABLE_FIELDS;

export function isPinnableField(value: string): value is PinnableField {
  return Object.prototype.hasOwnProperty.call(PINNABLE_FIELDS, value);
}

/**
 * Pins the fields a manual write actually carried.
 *
 * Best-effort by design: a pin that could not be written must not fail the
 * write it was protecting. The measurement is the thing that matters, and an
 * unpinned field is merely back to the old behaviour rather than lost.
 *
 * Idempotent - a live pin for the same (day, field) is left alone rather than
 * re-created, so re-saving a form does not churn pinned_at and lose the record
 * of when the user first took ownership of the field.
 */
export async function pinManualFields(
  supabase: Client,
  userId: string,
  date: LocalDate,
  fields: readonly PinnableField[],
  observationId: string | null = null,
): Promise<void> {
  if (fields.length === 0) return;

  const existing = await supabase
    .from('canonical_field_pins')
    .select('field')
    .eq('user_id', userId)
    .eq('local_date', date)
    .is('cleared_at', null);
  if (existing.error) return;

  const held = new Set((existing.data ?? []).map((row) => row.field));
  const missing = fields.filter((field) => !held.has(field));
  if (missing.length === 0) return;

  await supabase.from('canonical_field_pins').insert(
    missing.map((field) => ({
      user_id: userId,
      local_date: date,
      field,
      pinned_observation_id: observationId,
      cleared_at: null,
      reason: 'You entered this value yourself.',
    })),
  );
}

/**
 * Lifts a pin, letting imported readings resolve the field again.
 *
 * Cleared, not deleted: which fields were protected and when they stopped being
 * is exactly the history that explains why a number changed on a day the user
 * has since forgotten about.
 */
export async function clearFieldPin(
  supabase: Client,
  userId: string,
  date: LocalDate,
  field: string,
): Promise<{ ok: boolean; message: string }> {
  const { error } = await supabase
    .from('canonical_field_pins')
    .update({ cleared_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('local_date', date)
    .eq('field', field)
    .is('cleared_at', null);

  if (error) return { ok: false, message: `Could not lift the pin: ${error.message}` };
  return {
    ok: true,
    message: 'Lifted. This field now resolves to whichever reading is most recent, '
      + 'including imported ones.',
  };
}
