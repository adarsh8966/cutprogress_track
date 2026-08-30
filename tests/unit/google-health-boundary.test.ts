/**
 * What the Google Health integration is STRUCTURALLY unable to do.
 *
 * The mirror image of tests/unit/hevy-boundary.test.ts, and deliberately a
 * separate file rather than an edit to it: the two integrations own opposite
 * halves of the model. Hevy owns training and must never touch health; Google
 * Health owns health and activity and must never touch the exercise catalogue
 * or the sets inside a workout.
 *
 * Three claims, each a mechanism rather than a promise:
 *
 *   1. NUTRITION IS UNREACHABLE. No nutrition scope is requested, so an
 *      access token could not read food logs even if something asked. No
 *      nutrition table is named anywhere in the integration, so nothing can
 *      write one by going around the types. Calories CONSUMED and calories
 *      BURNED are different measurements and only the second arrives here.
 *
 *   2. IT CANNOT WRITE TO GOOGLE. No .writeonly scope is requested, and the
 *      client has no create, patch or batchDelete method - so a write is not
 *      something a caller can do wrongly, it is something a caller cannot
 *      express.
 *
 *   3. IT DOES NOT AUTHOR TRAINING CONTENT. Sets and exercises are Hevy's and
 *      the logger's. Google Health may attach physiology to a session and may
 *      record a session of its own, but it never invents an exercise or a set.
 *
 * Comments are stripped before reading, because the files under test explain in
 * prose exactly which tables they never touch - so a grep over raw text would
 * find `nutrition_logs` in the paragraph promising never to write it.
 */
import { describe, it, expect } from 'vitest';
import { codeOf, filesUnder } from '../helpers/source';
import { REQUESTED_SCOPES, scopeParameter } from '@/lib/integrations/googleHealth/scopes';
import { DATA_TYPES } from '@/lib/integrations/googleHealth/registry';

const INTEGRATION_FILES = filesUnder('lib/integrations/googleHealth');

/** Tables this integration must never write. */
const FORBIDDEN_TABLES = [
  'nutrition_logs',
  'nutrition_items',
  'workout_sets',
  'exercises',
  'daily_scores',
  'recommendations',
];

/** Nutrition intake fields, by the name a column or payload would use. */
const FORBIDDEN_FIELDS = [
  'calories_consumed',
  'caloriesconsumed',
  'protein_g',
  'carbs_g',
  'fiber_g',
  'foodDisplayName',
  'mealType',
  'nutritionLog',
];

describe('the Google Health integration cannot reach nutrition intake', () => {
  it('has files to check at all', () => {
    // A guard that silently checks nothing is worse than no guard.
    expect(INTEGRATION_FILES.length).toBeGreaterThan(5);
  });

  /**
   * A table is named the way Supabase names one: as a quoted string.
   *
   * Matching a bare substring would be stricter and wrong - sync.ts holds a
   * local array of normalised sessions called `exercises`, which is a variable
   * and not a table, and failing on it would train the next reader to weaken
   * this test rather than trust it. The quoted form is what `.from()` takes,
   * so it is what a write would have to look like.
   */
  it.each(FORBIDDEN_TABLES)('names no file that writes %s', (table) => {
    for (const file of INTEGRATION_FILES) {
      expect(
        codeOf(file),
        `${file} names the ${table} table. Google Health owns health, activity `
        + 'and recovery; nutrition is entered by hand and training content '
        + 'belongs to Hevy and the logger.',
      ).not.toContain(`'${table}'`);
    }
  });

  it.each(FORBIDDEN_FIELDS)('never names the nutrition field %s', (field) => {
    for (const file of INTEGRATION_FILES) {
      expect(codeOf(file).toLowerCase()).not.toContain(field.toLowerCase());
    }
  });

  it('requests no nutrition scope', () => {
    expect(scopeParameter()).not.toContain('nutrition');
    for (const scope of REQUESTED_SCOPES) {
      expect(scope.scope).not.toContain('nutrition');
    }
  });

  it('has no data type whose destination is nutrition', () => {
    for (const spec of DATA_TYPES) {
      // hydration-log, food and nutrition-log all sit behind .nutrition.readonly,
      // which is not requested - so they must not be in the registry at all.
      expect(spec.dataType).not.toBe('nutrition-log');
      expect(spec.dataType).not.toBe('food');
      expect(spec.dataType).not.toBe('hydration-log');
    }
  });
});

describe('the Google Health integration cannot write to Google', () => {
  it('requests no write scope', () => {
    for (const scope of REQUESTED_SCOPES) {
      expect(scope.scope).not.toContain('writeonly');
    }
    expect(scopeParameter()).not.toContain('writeonly');
  });

  it('has no client method that creates, patches or deletes', () => {
    const client = codeOf('lib/integrations/googleHealth/client.ts');
    for (const forbidden of ['batchDelete', 'method: \'PATCH\'', 'method: \'PUT\'',
      'method: \'DELETE\'']) {
      expect(client).not.toContain(forbidden);
    }
  });

  it('issues a POST only to the read-only rollup endpoint', () => {
    const client = codeOf('lib/integrations/googleHealth/client.ts');
    // dailyRollUp is a POST because its range does not fit a query string. It
    // is still a read, and it is the only one.
    const posts = client.match(/method: 'POST'/g) ?? [];
    expect(posts.length).toBeLessThanOrEqual(2);
    expect(client).toContain('dailyRollUp');
  });
});

describe('the Google Health integration does not author training content', () => {
  it('creates no exercise and no set', () => {
    for (const file of INTEGRATION_FILES) {
      const code = codeOf(file);
      expect(code).not.toContain("'workout_sets'");
      expect(code).not.toContain("'exercises'");
      // Not even the column. An exercise's identity is the catalogue's, and
      // this integration has no business resolving one.
      expect(code).not.toContain('exercise_id');
    }
  });

  it('every credential-reading module is server-only', () => {
    for (const file of [
      'lib/integrations/googleHealth/env.ts',
      'lib/integrations/googleHealth/oauth.ts',
      'lib/integrations/googleHealth/sync.ts',
      'lib/integrations/googleHealth/writer.ts',
      'lib/integrations/googleHealth/telemetry.ts',
    ]) {
      expect(codeOf(file), `${file} must be server-only`).toContain("import 'server-only'");
    }
  });

  it('constructs no Supabase client anywhere', () => {
    // The engine is handed a client by its caller. Building one here would make
    // a privileged client possible to introduce - the thing
    // tests/unit/service-role-absence.test.ts exists to prevent.
    for (const file of INTEGRATION_FILES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/create(Client|ServerClient|BrowserClient)\s*[(<]/);
      expect(code).not.toContain('auth.getUser()');
    }
  });

  it('scopes every user-owned write by user_id', () => {
    for (const file of [
      'lib/integrations/googleHealth/writer.ts',
      'lib/integrations/googleHealth/sync.ts',
      'lib/integrations/googleHealth/telemetry.ts',
    ]) {
      const code = codeOf(file);
      for (const table of ['external_observations', 'sleep_records', 'cardio_sessions',
        'workout_sessions', 'sync_runs', 'session_telemetry']) {
        if (!code.includes(`'${table}'`)) continue;
        expect(code, `${file} touches ${table} without ever naming user_id`)
          .toMatch(/user_id|userId/);
      }
    }
  });
});
