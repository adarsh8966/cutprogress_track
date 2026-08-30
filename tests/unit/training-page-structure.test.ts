/**
 * What the Training page must still be, after it stopped being a wall of cards.
 *
 * These are source-level checks, which is the honest instrument available
 * here: vitest runs in a node environment with no DOM, so there is nothing to
 * render into. What can be held this way is structure, and structure is what
 * the restructure is: which section is open, what toggles it, and where the
 * one implementation of a set line lives.
 *
 * Comments are stripped first (tests/helpers/source.ts), so a file explaining
 * in prose that it never does something cannot satisfy its own check.
 */
import { describe, it, expect } from 'vitest';
import { codeOf } from '../helpers/source';

const DISCLOSURE = 'components/ui/Disclosure.tsx';
const TRAINING_VIEW = 'components/training/TrainingView.tsx';
const SESSION_HISTORY = 'components/training/SessionHistory.tsx';
const WORKOUT_DETAIL = 'components/training/WorkoutDetail.tsx';

describe('a disclosure is closed until it is asked to open', () => {
  const source = codeOf(DISCLOSURE);

  it('is a native details/summary, not a hand-rolled toggle', () => {
    expect(source).toMatch(/<details/);
    expect(source).toMatch(/<summary/);
    // Which is what lets every page using it stay a server component.
    expect(source).not.toContain("'use client'");
    expect(source).not.toContain('useState');
  });

  it('has no way to start open', () => {
    // Closed by default is the point of the component, so it is a property of
    // the component rather than a convention every caller must remember.
    expect(source).not.toMatch(/<details[^>]*\sopen/);
    expect(source).not.toMatch(/defaultOpen/);
    expect(source).not.toMatch(/\bopen=/);
  });

  it('does not close the section you were reading', () => {
    // <details name="..."> is the exclusive accordion. Comparing two workouts
    // side by side is a real thing to want.
    expect(source).not.toMatch(/<details[^>]*\sname=/);
  });

  it('is big enough to tap and hides the native marker on both engines', () => {
    expect(source).toMatch(/min-h-(9|11|12)/);
    // list-none covers Chrome and Firefox; the webkit pseudo-element covers
    // Safari. Either alone leaves a stray triangle beside the chevron.
    expect(source).toContain('list-none');
    expect(source).toContain('webkit-details-marker');
  });
});

describe('the Training page opens on what was trained', () => {
  const source = codeOf(TRAINING_VIEW);

  it('puts session history before the cross-workout analysis', () => {
    const history = source.indexOf('Session history');
    const progression = source.indexOf('Exercise progression');
    const records = source.indexOf('Personal records');

    expect(history).toBeGreaterThan(-1);
    expect(progression).toBeGreaterThan(history);
    expect(records).toBeGreaterThan(history);
  });

  it('keeps progression and records, collapsed rather than removed', () => {
    expect(source).toContain('DisclosureSection');
    expect(source).toContain('Exercise progression');
    expect(source).toContain('Personal records');
  });

  it('opens nothing below the history by default', () => {
    // The primitive has no `open` prop; this is the other half of that - no
    // caller here reaches for one either.
    expect(source).not.toMatch(/\bopen(=|\s*[},])/);
  });

  it('still shows the working behind every figure it prints', () => {
    // Collapsing a section must not quietly drop its Evidence panel: a figure
    // on screen that cannot be questioned does not belong on screen.
    expect(source).toContain('Evidence');
  });

  it('still lays the progression table out as a stacking grid', () => {
    expect(source).not.toMatch(/<table/);
    expect(source).toMatch(/sm:grid-cols/);
  });
});

describe('session history and the workout it opens onto', () => {
  const history = codeOf(SESSION_HISTORY);
  const detail = codeOf(WORKOUT_DETAIL);

  it('renders on the server, with no client state to hydrate', () => {
    for (const [name, source] of [[SESSION_HISTORY, history], [WORKOUT_DETAIL, detail]] as const) {
      expect(source, `${name} became a client component`).not.toContain("'use client'");
      expect(source, `${name} took on client state`).not.toContain('useState');
    }
  });

  it('says where an imported session came from', () => {
    // spec §15: a record that came from somewhere else says so, at the point
    // the user is looking at it.
    expect(history).toContain('externalSource');
    expect(history).toContain('from Hevy');
  });

  it('keeps the full session one link away', () => {
    // Correcting a session, and adding exercises to one, still live there.
    expect(detail).toMatch(/\/training\/\$\{/);
  });

  it('shows the Hevy fields the workout view exists to surface', () => {
    expect(detail).toContain('supersets');
    expect(detail).toContain('block.notes');
    expect(detail).toContain('setLine');
  });

  it('formats a set in exactly one place', () => {
    // Both read setLine. If either starts assembling "120 × 12 @ 7" itself,
    // the null rules it encodes stop being one rule.
    expect(history).not.toContain(' × ');
    expect(detail).not.toContain(' × ');
    expect(detail).not.toContain(' @ ');
  });

  it('is not a table', () => {
    expect(history).not.toMatch(/<table/);
    expect(detail).not.toMatch(/<table/);
  });
});
