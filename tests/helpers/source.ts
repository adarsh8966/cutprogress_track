/**
 * Reading a module's SOURCE, for the tests that assert what code does not do.
 *
 * Several rules in this codebase are structural - "this module never touches a
 * health table", "this client issues no writes" - and the honest way to hold
 * them is to read the file and look. The catch is that the same rules are
 * usually explained in a comment at the top of the very file being checked, so
 * a naive grep finds the endpoint name in the paragraph saying why it is never
 * called and fails the test for the wrong reason.
 *
 * So comments are stripped first. What a file SAYS about itself is
 * documentation; what it REFERENCES is the thing under test.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Source with block and line comments removed.
 *
 * String literals are left alone: a path in a string is a path the code can
 * request, which is exactly what these tests are looking for.
 */
export function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** One repository file, comments stripped. Path is repo-relative. */
export function codeOf(relativePath: string): string {
  return withoutComments(readFileSync(join(ROOT, relativePath), 'utf8'));
}

/** Every .ts/.tsx file under a repo-relative directory, recursively. */
export function filesUnder(relativeDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${entry}`;
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry)) found.push(rel);
    }
  };
  walk(relativeDir);
  return found.sort();
}
