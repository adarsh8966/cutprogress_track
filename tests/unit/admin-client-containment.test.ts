/**
 * The service-role key stays behind one door.
 *
 * lib/supabase/admin.ts holds the only client in this application that BYPASSES
 * ROW LEVEL SECURITY - the boundary every other query relies on. A scheduled
 * run needs it, because a cron request carries no cookie session and so has no
 * user for RLS to key on. That is a real widening of the security surface, and
 * the whole of its containment is this: exactly one file may import it, and
 * every query on that path filters by an explicit user id instead.
 *
 * "Exactly one file" is a claim that decays the moment someone needs a
 * privileged client for something else and finds one already written. So it is
 * a test rather than a comment.
 */
import { describe, it, expect } from 'vitest';
import { codeOf, filesUnder } from '../helpers/source';

/** The one caller. */
const PERMITTED = 'app/api/hevy/sync/route.ts';

/** Everywhere application code lives. Tests are excluded deliberately. */
const SOURCE_DIRS = ['app', 'components', 'lib'];

const ALL_FILES = SOURCE_DIRS.flatMap((dir) => filesUnder(dir));

function importsAdmin(file: string): boolean {
  const code = codeOf(file);
  return /from\s+['"](@\/lib\/supabase\/admin|\.\.?\/[^'"]*supabase\/admin)['"]/.test(code)
    || code.includes("supabase/admin'");
}

describe('the service-role client has exactly one importer', () => {
  it('is checking a real set of files', () => {
    // A guard that silently checks nothing is worse than no guard at all.
    expect(ALL_FILES.length).toBeGreaterThan(30);
    expect(ALL_FILES).toContain(PERMITTED);
    expect(ALL_FILES).toContain('lib/supabase/admin.ts');
  });

  it('is imported by the scheduled sync route and by nothing else', () => {
    const importers = ALL_FILES.filter((file) => file !== 'lib/supabase/admin.ts')
      .filter(importsAdmin);

    expect(
      importers,
      'lib/supabase/admin.ts bypasses row-level security. Exactly one file may '
      + `import it (${PERMITTED}). If a second caller genuinely needs a `
      + 'privileged client, that is a change to this application\'s security '
      + 'model and belongs in review, not in an import.',
    ).toEqual([PERMITTED]);
  });

  it('is not imported by the Hevy sync engine, which must stay client-agnostic', () => {
    // runHevySync and writeWorkout take whichever client the caller is entitled
    // to use. That is what lets ONE sync engine serve both the RLS-backed
    // button and the scheduled path - and what stops a future caller reaching a
    // privileged client by importing the sync engine.
    for (const file of filesUnder('lib/integrations/hevy')) {
      expect(importsAdmin(file), `${file} imports the service-role client`).toBe(false);
      expect(codeOf(file)).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    }
  });

  it('is not imported by any server action, which all run under RLS', () => {
    for (const file of filesUnder('app/actions')) {
      expect(importsAdmin(file), `${file} imports the service-role client`).toBe(false);
    }
  });

  it('never lets the key near a NEXT_PUBLIC_ variable', () => {
    // Anything so prefixed is inlined into the browser bundle by Next.
    for (const file of ALL_FILES) {
      expect(codeOf(file)).not.toContain('NEXT_PUBLIC_SUPABASE_SERVICE');
      expect(codeOf(file)).not.toContain('NEXT_PUBLIC_HEVY');
    }
  });

  it('keeps every privileged module server-only', () => {
    for (const file of [
      'lib/supabase/admin.ts',
      'lib/integrations/hevy/env.ts',
      'lib/integrations/hevy/sync.ts',
      'lib/integrations/hevy/writer.ts',
      'lib/integrations/hevy/exerciseResolver.ts',
    ]) {
      expect(codeOf(file), `${file} must be server-only`).toContain("import 'server-only'");
    }
  });
});

describe('the scheduled path scopes every query by user', () => {
  /**
   * With the service-role client there is no RLS behind the query, so the
   * `user_id` filter IS the isolation. These modules are the ones that run
   * under it.
   */
  const SCOPED = ['lib/integrations/hevy/sync.ts', 'lib/integrations/hevy/writer.ts'];

  it.each(SCOPED)('%s filters user-owned reads and writes by user_id', (file) => {
    const code = codeOf(file);

    // Every user-owned table this path touches must appear beside a user_id
    // filter or a user_id column in the row being written.
    for (const table of ['workout_sessions', 'workout_sets', 'health_imports', 'sync_runs']) {
      if (!code.includes(`'${table}'`)) continue;
      expect(
        code,
        `${file} touches ${table} without ever naming user_id. On the scheduled `
        + 'path there is no RLS behind the query, so that filter is the isolation.',
      ).toMatch(/user_id/);
    }
  });

  it('takes the user id as an argument rather than resolving one itself', () => {
    for (const file of SCOPED) {
      const code = codeOf(file);
      // Resolving the "current user" would be meaningless here - there is no
      // session - and would quietly make the scheduled path act for nobody.
      expect(code).not.toContain('auth.getUser()');
      expect(code).toContain('userId');
    }
  });
});
