/**
 * saveSettings, at the boundary where a display unit becomes a stored number.
 *
 * THE BUG THESE PIN. saveSettings converts the weights it receives using the
 * unit selected on the Settings form, and the form rendered those weights
 * through kgToLb() and labelled them "lb" no matter what was selected. With
 * Kilograms chosen, every save read 203.7 pounds as 203.7 kilograms and stored
 * it - the user's starting and target weight multiplied by 2.2, silently, on a
 * screen that had just told them which unit it wanted.
 *
 * Height was worse: saveSettings reads a `heightCm` field when the length unit
 * is CM and the form only ever rendered feet and inches, so choosing
 * Centimetres and saving set height to null and took the BMR and TDEE priors
 * with it.
 *
 * The form half is what changed (the fields are controlled and convert on
 * switch). These fix the server half in place, so the contract the form has to
 * meet is written down: what arrives in `startingWeight` is a number in
 * `weightDisplayUnit`, and what arrives as height is the pair matching
 * `lengthDisplayUnit`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { lbToKg, feetInchesToCm } from '@/lib/normalization/units';

vi.mock('server-only', () => ({}));

const USER = '11111111-1111-1111-1111-111111111111';

const db = vi.hoisted(() => ({
  upserted: [] as Record<string, unknown>[],
  inserted: {} as Record<string, Record<string, unknown>[]>,
  user: null as { id: string } | null,
  reset() {
    this.upserted = [];
    this.inserted = {};
    this.user = { id: USER };
  },
}));

function fakeClient() {
  return {
    auth: {
      getUser: async () => ({
        data: { user: db.user },
        error: db.user ? null : { message: 'no session' },
      }),
    },
    from(table: string) {
      return {
        upsert: async (values: Record<string, unknown>) => {
          db.upserted.push(values);
          return { error: null };
        },
        insert: async (values: Record<string, unknown>) => {
          (db.inserted[table] ??= []).push(values);
          return { error: null };
        },
      };
    },
  };
}

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createActionClient: async () => fakeClient() as never,
}));
vi.mock('@/lib/data/queries', () => ({ getProfile: async () => null }));

const { saveSettings } = await import('@/app/actions/settings');

/** The fields every save needs, so each test states only what it is about. */
function form(values: Record<string, string>): FormData {
  const data = new FormData();
  const base: Record<string, string> = {
    sex: 'MALE',
    timezone: 'America/New_York',
    phase: 'CUT',
    maxWeeklyLossRatePct: '1',
    weightDisplayUnit: 'LB',
    distanceDisplayUnit: 'MI',
    lengthDisplayUnit: 'IN',
  };
  for (const [key, value] of Object.entries({ ...base, ...values })) {
    data.set(key, value);
  }
  return data;
}

const saved = () => db.upserted[0]!;

beforeEach(() => db.reset());

describe('weights are stored in the unit that was selected', () => {
  it('reads pounds as pounds', async () => {
    const result = await saveSettings(
      form({ weightDisplayUnit: 'LB', startingWeight: '203.7', targetWeight: '185' }),
    );

    expect(result.ok).toBe(true);
    expect(saved().starting_weight_kg).toBeCloseTo(lbToKg(203.7), 6);
    expect(saved().target_weight_kg).toBeCloseTo(lbToKg(185), 6);
  });

  it('reads kilograms as kilograms, not as pounds', async () => {
    const result = await saveSettings(
      form({ weightDisplayUnit: 'KG', startingWeight: '92.4', targetWeight: '84' }),
    );

    expect(result.ok).toBe(true);
    // The whole bug in one assertion: 92.4 must not become lbToKg(92.4) = 41.9,
    // and it must not become 203.7 either.
    expect(saved().starting_weight_kg).toBe(92.4);
    expect(saved().target_weight_kg).toBe(84);
  });

  it('leaves a blank weight unset rather than storing a zero', async () => {
    await saveSettings(form({ startingWeight: '', targetWeight: '' }));

    expect(saved().starting_weight_kg).toBeNull();
    expect(saved().target_weight_kg).toBeNull();
  });
});

describe('height survives the length unit it was entered in', () => {
  it('reads feet and inches when the unit is inches', async () => {
    await saveSettings(
      form({ lengthDisplayUnit: 'IN', heightFeet: '5', heightInches: '10' }),
    );

    expect(saved().height_cm).toBeCloseTo(feetInchesToCm(5, 10), 6);
  });

  /**
   * The erasure. With CM selected the action reads `heightCm`, which the form
   * did not render - so a save wiped the height it had just displayed.
   */
  it('reads centimetres when the unit is centimetres', async () => {
    await saveSettings(form({ lengthDisplayUnit: 'CM', heightCm: '178' }));

    expect(saved().height_cm).toBe(178);
  });

  it('does not silently keep feet and inches when the unit is centimetres', async () => {
    // If both ever reach the action, the selected unit decides. A stale
    // imperial pair must not overwrite the metric height.
    await saveSettings(
      form({
        lengthDisplayUnit: 'CM', heightCm: '178', heightFeet: '5', heightInches: '10',
      }),
    );

    expect(saved().height_cm).toBe(178);
  });

  it('leaves height unset when nothing was entered', async () => {
    await saveSettings(form({ lengthDisplayUnit: 'CM' }));

    expect(saved().height_cm).toBeNull();
  });
});

describe('the display units themselves are stored', () => {
  it('records the three units as chosen', async () => {
    await saveSettings(
      form({ weightDisplayUnit: 'KG', distanceDisplayUnit: 'KM', lengthDisplayUnit: 'CM' }),
    );

    expect(saved().weight_display_unit).toBe('KG');
    expect(saved().distance_display_unit).toBe('KM');
    expect(saved().length_display_unit).toBe('CM');
  });
});

describe('the safety review still runs first', () => {
  it('refuses a target that would be blocked, and writes nothing', async () => {
    const result = await saveSettings(
      form({
        weightDisplayUnit: 'KG', lengthDisplayUnit: 'CM',
        heightCm: '180', targetWeight: '40',
      }),
    );

    expect(result.ok).toBe(false);
    expect(db.upserted).toHaveLength(0);
    // Quoted back in the unit the user typed in.
    expect(result.findings?.some((f) => f.message.includes('40.0 kg'))).toBe(true);
  });
});
