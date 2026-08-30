/**
 * Saying what went wrong once, with a count.
 *
 * THE BEHAVIOUR THIS PINS DOWN. When one assumption is wrong about a whole
 * response shape, every record trips the same warning - and the failing sync
 * reported the resulting three-hundred-character validation dump per data type,
 * in the panel and again in the run history. The information content of the
 * twentieth copy is zero and it pushes everything else off the screen.
 *
 * A warning is therefore a KIND with a count and one worked example, not a
 * line per record. What must not happen in the other direction is a bare count:
 * "48 warnings" tells you something went wrong and not what, which is worse
 * than the wall of text.
 */
import { describe, it, expect } from 'vitest';
import { SyncWarnings } from '@/lib/integrations/googleHealth/warnings';

describe('aggregating warnings', () => {
  it('says a repeated problem once, with how many records it stands for', () => {
    const warnings = new SyncWarnings();
    for (let i = 0; i < 412; i += 1) {
      warnings.add({
        dataType: 'steps',
        label: 'Steps',
        kind: 'parse',
        message: 'a data point could not be read (dataPoints.name: expected string).',
      });
    }

    const list = warnings.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toContain('Steps:');
    expect(list[0]).toContain('and 411 more like it');
    // The count is never lost, only the repetition.
    expect(warnings.total).toBe(412);
    expect(warnings.distinct).toBe(1);
  });

  it('keeps one data type’s problem apart from another’s', () => {
    const warnings = new SyncWarnings();
    for (const [dataType, label] of [['steps', 'Steps'], ['distance', 'Distance']]) {
      for (let i = 0; i < 10; i += 1) {
        warnings.add({ dataType, label, kind: 'parse', message: 'could not be read.' });
      }
    }
    expect(warnings.list()).toHaveLength(2);
    expect(warnings.countFor('steps')).toBe(10);
  });

  it('groups by kind, not by wording, so per-record values still collapse', () => {
    // "A heart rate of 402 is outside the plausible range" is a different
    // sentence every time and the same fact about the sync.
    const warnings = new SyncWarnings();
    for (const bpm of [402, 511, 900]) {
      warnings.add({
        dataType: 'heart-rate',
        label: 'Heart rate',
        kind: 'implausible-value',
        message: `Heart rate of ${bpm} is outside the plausible range 25–250 and was not stored.`,
      });
    }
    const list = warnings.list();
    expect(list).toHaveLength(1);
    // The example is kept whole: a count with no example is not diagnosable.
    expect(list[0]).toContain('402');
    expect(list[0]).toContain('and 2 more like it');
  });

  it('leaves distinct messages distinct when no kind is given', () => {
    const warnings = new SyncWarnings();
    warnings.addAll(['the first thing', 'the second thing']);
    expect(warnings.list()).toHaveLength(2);
  });

  it('does not repeat itself when a warning happens exactly once', () => {
    const warnings = new SyncWarnings();
    warnings.add({ label: 'Sleep', message: 'a stage arrived without both timestamps.' });
    expect(warnings.list()[0]).toBe('Sleep: a stage arrived without both timestamps.');
    expect(warnings.list()[0]).not.toContain('more like it');
  });

  it('stops listing at a limit and says how much it left out', () => {
    const warnings = new SyncWarnings();
    for (let i = 0; i < 30; i += 1) {
      warnings.add({ dataType: `type-${i}`, label: `Type ${i}`, message: 'went wrong.' });
    }
    const list = warnings.list(5);
    expect(list).toHaveLength(6);
    expect(list[5]).toContain('25 further kinds');
    expect(list[5]).toContain('25 records');
  });

  it('fits a run’s failure on one line for the run history', () => {
    const warnings = new SyncWarnings();
    for (let i = 0; i < 50; i += 1) {
      warnings.add({
        dataType: 'steps', label: 'Steps', kind: 'parse',
        message: 'a data point could not be read.',
      });
    }
    warnings.add({ dataType: 'sleep', label: 'Sleep', message: 'a stage was skipped.' });

    const summary = warnings.summary();
    expect(summary).toContain('51 warnings');
    expect(summary).toContain('Steps (50)');
    expect(summary.length).toBeLessThan(300);
  });

  it('has nothing to say when nothing went wrong', () => {
    const warnings = new SyncWarnings();
    expect(warnings.list()).toEqual([]);
    expect(warnings.summary()).toBe('');
    expect(warnings.total).toBe(0);
  });
});
