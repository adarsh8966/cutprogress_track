/**
 * Nothing may force the page wider than the narrowest phone (spec §49).
 *
 * WHY THIS TEST EXISTS. Three components carried a fixed minimum width wider
 * than any phone - a five-column exercise table at 560px, the import review's
 * day fields at 540px, a session's sets at 380px - each inside a horizontal
 * scroller. On a 320px screen that meant the last columns were unreachable
 * without sideways scrolling, on the two pages most likely to be open in a gym
 * or at a kitchen counter.
 *
 * They were all found by reading the markup. That is the wrong detector: the
 * pattern is easy to reach for and invisible in review, so it is checked here
 * instead. The rule is not "never scroll sideways" - a deliberately scrollable
 * strip is fine and the navigation is one - it is that a fixed width wider
 * than NARROWEST must be a decision someone wrote down.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The narrowest screen the app supports, per the audit's own list. */
const NARROWEST = 320;

/**
 * Components allowed a fixed width above NARROWEST, each with the reason.
 *
 * An entry here is a claim that sideways scrolling is right for that element
 * specifically - not a way to silence the check.
 */
const ALLOWED: Record<string, string> = {
  // Ten links do not fit across a phone. Wrapping them made three cramped rows
  // of small targets; the row scrolls sideways inside its own container, which
  // never widens the page.
  'components/ui/Nav.tsx': 'the navigation strip scrolls inside itself, by design',
};

function tsxFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) tsxFiles(path, found);
    else if (entry.endsWith('.tsx')) found.push(path);
  }
  return found;
}

const SOURCES = [
  ...tsxFiles(join(ROOT, 'app')),
  ...tsxFiles(join(ROOT, 'components')),
];

/** `min-w-[560px]`, `w-[400px]`, `min-w-[40rem]`. */
const FIXED_WIDTH = /\b(?:min-)?w-\[(\d+(?:\.\d+)?)(px|rem)\]/g;

function pixels(value: string, unit: string): number {
  return unit === 'rem' ? Number(value) * 16 : Number(value);
}

describe('no element forces the page wider than a 320px screen', () => {
  it('finds the source files to check', () => {
    expect(SOURCES.length).toBeGreaterThan(10);
  });

  it.each(SOURCES.map((path) => [path.slice(ROOT.length), path]))(
    '%s',
    (relative, path) => {
      const source = readFileSync(path, 'utf8');
      const offenders: string[] = [];
      for (const match of source.matchAll(FIXED_WIDTH)) {
        if (pixels(match[1]!, match[2]!) > NARROWEST) offenders.push(match[0]);
      }
      if (offenders.length === 0) return;

      const reason = ALLOWED[relative as string];
      expect(
        reason,
        `${relative} sets ${offenders.join(', ')}, wider than a ${NARROWEST}px screen. `
          + 'Stack it instead, or add it to ALLOWED with the reason.',
      ).toBeTruthy();
    },
  );
});

describe('the tables that were widened have been stacked instead', () => {
  /**
   * The three specific regressions, named. A responsive grid that collapses to
   * one column below `sm` is the pattern; a <table> cannot do that, so the
   * absence of one is the check.
   */
  it.each([
    ['components/training/TrainingView.tsx', 'exercise progression'],
    ['app/(app)/training/[sessionId]/page.tsx', 'the session\'s sets'],
    ['components/import/ImportWorkbench.tsx', 'the import review fields'],
  ])('%s lays out %s without a fixed-width table', (file) => {
    const source = readFileSync(join(ROOT, file), 'utf8');
    expect(source).not.toMatch(/<table/);
    // And it does collapse: the grid is only applied from `sm` up.
    expect(source).toMatch(/sm:grid|sm:grid-cols|flex-wrap/);
  });
});

describe('interactive controls are big enough to tap', () => {
  /**
   * 44px is the comfortable touch target. A 28px text button is fine with a
   * mouse and fiddly on a phone, and this application is used on one most
   * nights - so the shared primitives set the floor rather than each caller
   * remembering to.
   */
  it('sets a minimum height on the shared form controls', () => {
    const form = readFileSync(join(ROOT, 'components/ui/Form.tsx'), 'utf8');
    expect(form).toMatch(/min-h-11/);
    // text-base on small screens is what stops iOS zooming the page on focus.
    expect(form).toMatch(/text-base/);
  });

  it('sets one on the buttons that live outside those primitives', () => {
    for (const file of [
      'components/import/ImportWorkbench.tsx',
      'components/quick/QuickEntryForm.tsx',
      'components/day/DayRecords.tsx',
    ]) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      expect(source, `${file} has no minimum tap target`).toMatch(/min-h-(9|11|12)/);
    }
  });
});

/**
 * Quick Add on the day view opens a real section of Quick Entry.
 *
 * The link, the page's validation and the form's sections are three places
 * that have to agree on a string. They share one list so a renamed section
 * cannot silently start opening nothing - this checks they still do.
 */
describe('Quick Add names sections that exist', () => {
  it('builds its links from the shared group list', () => {
    const day = readFileSync(join(ROOT, 'app/(app)/day/[date]/page.tsx'), 'utf8');
    expect(day).toMatch(/QUICK_GROUPS/);
    expect(day).toMatch(/\/quick\?date=\$\{date\}&open=/);
  });

  it('validates the incoming group against the same list', () => {
    const page = readFileSync(join(ROOT, 'app/(app)/quick/page.tsx'), 'utf8');
    expect(page).toMatch(/isQuickGroup/);
  });

  it('renders a section for every group the list names', () => {
    const form = readFileSync(join(ROOT, 'components/quick/QuickEntryForm.tsx'), 'utf8');
    for (const group of [
      'Body', 'Nutrition', 'Activity and vitals', 'Sleep', 'Workout', 'Cardio',
    ]) {
      expect(form, `Quick Entry has no "${group}" section`).toContain(`title="${group}"`);
    }
  });
});
