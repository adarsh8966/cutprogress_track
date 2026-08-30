/**
 * There is no privileged Supabase client in this application.
 *
 * The service-role key BYPASSES ROW LEVEL SECURITY - the boundary every query
 * here relies on. For a while one client held it, because a scheduled sync
 * arrives with no cookie session and so has no user for RLS to key on, and that
 * client was kept behind a single-caller rule enforced by this file.
 *
 * The schedule is gone: syncing is a button the signed-in user presses. So the
 * reason for the client is gone too, and the claim this file holds gets simpler
 * and stronger - not "exactly one file may open that door" but "there is no
 * door". Everything now runs as the signed-in user, under the policies.
 *
 * That is worth a test rather than a comment because it is the kind of thing
 * that erodes quietly: the next person who needs to read a table from a context
 * without a session will reach for a service-role client, and if one already
 * exists - or is easy to construct - they will use it. The assertions below are
 * about what CANNOT be written, in the same spirit as hevy-boundary.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { codeOf, filesUnder } from '../helpers/source';

/** Everywhere application code lives. Tests are excluded deliberately. */
const SOURCE_DIRS = ['app', 'components', 'lib'];
const ALL_FILES = [...SOURCE_DIRS.flatMap((dir) => filesUnder(dir)), 'middleware.ts'];

/**
 * The only two modules that may construct a Supabase client.
 *
 * Both use the ANON key, which is exactly what RLS is designed to be handed:
 * lib/supabase/client.ts for the browser, lib/supabase/server.ts for Server
 * Components, Server Actions and Route Handlers. middleware.ts and
 * app/auth/confirm/route.ts build a client too, from `@supabase/ssr`, and are
 * listed here for the same reason - they are anon-key session plumbing, not a
 * way around the policies.
 */
const MAY_CONSTRUCT_A_CLIENT = [
  'lib/supabase/client.ts',
  'lib/supabase/server.ts',
  'middleware.ts',
  'app/auth/confirm/route.ts',
];

describe('no service-role client exists', () => {
  it('is checking a real set of files', () => {
    // A guard that silently checks nothing is worse than no guard.
    expect(ALL_FILES.length).toBeGreaterThan(30);
    expect(ALL_FILES).toContain('lib/supabase/server.ts');
  });

  it('names the service-role key nowhere in the application', () => {
    for (const file of ALL_FILES) {
      expect(
        codeOf(file),
        `${file} reads SUPABASE_SERVICE_ROLE_KEY. That key bypasses every RLS `
        + 'policy, and nothing in this application needs it: every path runs as '
        + 'the signed-in user. Introducing one is a change to the security model '
        + 'and belongs in review, not in an import.',
      ).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    }
  });

  it('constructs a Supabase client in only the sanctioned modules', () => {
    // The assertion that actually stops a privileged client coming back: not
    // "don't read that variable" but "don't build a client here at all".
    const builders = ALL_FILES.filter((file) => {
      const code = codeOf(file);
      return /from\s+'@supabase\/(supabase-js|ssr)'/.test(code)
        && /create(Client|ServerClient|BrowserClient)\s*[(<]/.test(code);
    });
    expect(builders.sort()).toEqual([...MAY_CONSTRUCT_A_CLIENT].sort());
  });

  it('imports createClient from @supabase/supabase-js nowhere at all', () => {
    // createServerClient/createBrowserClient (@supabase/ssr) take the anon key
    // and carry a cookie session. The raw createClient is the one that will
    // accept a service-role key without complaint.
    for (const file of ALL_FILES) {
      const code = codeOf(file);
      const importsRaw = /import\s*\{[^}]*\bcreateClient\b[^}]*\}\s*from\s*'@supabase\/supabase-js'/
        .test(code);
      expect(importsRaw, `${file} imports createClient from @supabase/supabase-js`)
        .toBe(false);
    }
  });

  it('has no module left behind for a privileged client to live in', () => {
    // lib/supabase/admin.ts was deleted with the scheduled sync. An unused
    // module that constructs an RLS-bypassing client is worse than no module:
    // it is a loaded gun with the trigger guard removed.
    expect(ALL_FILES).not.toContain('lib/supabase/admin.ts');
  });

  it('never lets a secret near a NEXT_PUBLIC_ variable', () => {
    // Anything so prefixed is inlined into the browser bundle by Next.
    for (const file of ALL_FILES) {
      const code = codeOf(file);
      expect(code).not.toContain('NEXT_PUBLIC_SUPABASE_SERVICE');
      expect(code).not.toContain('NEXT_PUBLIC_HEVY');
    }
  });

  it('keeps every credential-reading module server-only', () => {
    for (const file of [
      'lib/supabase/server.ts',
      'lib/integrations/hevy/env.ts',
      'lib/integrations/hevy/sync.ts',
      'lib/integrations/hevy/writer.ts',
      'lib/integrations/hevy/exerciseResolver.ts',
    ]) {
      expect(codeOf(file), `${file} must be server-only`).toContain("import 'server-only'");
    }
  });
});

describe('the sync engine scopes every query by user anyway', () => {
  /**
   * RLS is the boundary again now that the only caller is a signed-in user, so
   * these filters are no longer load-bearing on their own. They stay because
   * they are free, because a query that names its user is easier to read than
   * one that relies on ambient context, and because if a sessionless caller
   * ever returns this is the half that would otherwise be missing.
   */
  const SCOPED = ['lib/integrations/hevy/sync.ts', 'lib/integrations/hevy/writer.ts'];

  it.each(SCOPED)('%s filters user-owned reads and writes by user_id', (file) => {
    const code = codeOf(file);
    for (const table of ['workout_sessions', 'workout_sets', 'health_imports', 'sync_runs']) {
      if (!code.includes(`'${table}'`)) continue;
      expect(code, `${file} touches ${table} without ever naming user_id`)
        .toMatch(/user_id/);
    }
  });

  it('takes the user id as an argument rather than resolving one itself', () => {
    for (const file of SCOPED) {
      const code = codeOf(file);
      // The engine is handed a client and a user by its caller. Resolving the
      // "current user" inside it would tie it to one kind of caller.
      expect(code).not.toContain('auth.getUser()');
      expect(code).toContain('userId');
    }
  });
});
