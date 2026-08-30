/**
 * The canonical readers name no provider, and there is only one set of them.
 *
 * WHY THIS TEST EXISTS BEFORE THE AI DOES. The assistant is the next feature,
 * and the way it goes wrong is entirely predictable: it needs a number, the
 * nearest query is a provider query, and six months later a change to Google
 * Health breaks the coaching. The boundary is cheap to draw now and expensive
 * to draw afterwards, so it is drawn now and asserted here.
 *
 * Two claims:
 *
 *   1. NO PROVIDER NAME CROSSES THE LINE. Not in a type, not in a field name,
 *      not in a returned value. The assistant asks CUT OS what is true and gets
 *      an answer in CUT OS's own vocabulary. Swapping the provider changes
 *      nothing above this line.
 *
 *   2. THERE IS NO SECOND STORE. These are functions over the canonical model -
 *      the same readers the pages use - not a copy of the fitness history
 *      shaped for a model. One source of truth means the assistant and the
 *      screen cannot disagree, which they would, within a month, if there were
 *      two.
 */
import { describe, it, expect, vi } from 'vitest';
import { codeOf, filesUnder } from '../helpers/source';

// The readers are server-only by design; the marker package has no runtime
// behaviour, so stubbing it lets the real module be imported here.
vi.mock('server-only', () => ({}));

const CONTEXT_FILES = filesUnder('lib/data/context');

/** Names that must not appear in the shape of an answer. */
const PROVIDER_WORDS = [
  'fitbit', 'googlehealth', 'google_health', 'google-health',
  'hevy', 'bevel', 'healthconnect', 'health_connect',
];

describe('the canonical readers', () => {
  it('exist, and there are enough of them to be worth checking', () => {
    expect(CONTEXT_FILES.length).toBeGreaterThan(1);
  });

  it('names no provider in any type it returns', () => {
    const types = codeOf('lib/data/context/types.ts').toLowerCase();
    for (const word of PROVIDER_WORDS) {
      expect(types, `the reader types name ${word}`).not.toContain(word);
    }
  });

  it('never queries a provider table', () => {
    for (const file of CONTEXT_FILES) {
      const code = codeOf(file);
      // external_observations is the provider's raw ledger. Reading it here
      // would put a provider's record shape into an answer.
      expect(code, `${file} reads the provider ledger`)
        .not.toContain("'external_observations'");
      expect(code).not.toContain("'google_health_connections'");
    }
  });

  it('constructs no Supabase client of its own', () => {
    for (const file of CONTEXT_FILES) {
      expect(codeOf(file)).not.toMatch(/create(Client|ServerClient|BrowserClient)\s*[(<]/);
    }
  });

  it('reuses the readers the pages use rather than a parallel path', () => {
    const readers = codeOf('lib/data/context/readers.ts');
    // If these ever stop being the source, the assistant and the screen will
    // start disagreeing and nobody will know which is right.
    expect(readers).toContain('getAnalyticsWindow');
    expect(readers).toContain('recoverySummary');
  });

  it('offers a reader for each question the brief names', async () => {
    const readers = await import('@/lib/data/context/readers');
    for (const name of [
      'getDailyHealthContext', 'getRecoveryContext', 'getSleepContext',
      'getTrainingContext', 'getWorkoutContext', 'getHeartRateContext',
      'getZone2Context', 'getWeightTrend', 'getNutritionContext',
      'getRecentFitnessContext', 'getFitnessContextForDateRange',
    ]) {
      expect(typeof (readers as Record<string, unknown>)[name], `${name} is missing`)
        .toBe('function');
    }
  });

  it('states that nutrition is manual in the type, not in a comment', async () => {
    // A literal `true`, so a future import path would be a type error rather
    // than a promise somebody forgot.
    const types = codeOf('lib/data/context/types.ts');
    expect(types).toContain('manuallyEntered: true');
  });

  it('names what is missing, so a gap cannot be reasoned past', () => {
    // A model that cannot see an absence fills it.
    expect(codeOf('lib/data/context/types.ts')).toContain('missing');
    expect(codeOf('lib/data/context/readers.ts')).toContain('missing');
  });
});
