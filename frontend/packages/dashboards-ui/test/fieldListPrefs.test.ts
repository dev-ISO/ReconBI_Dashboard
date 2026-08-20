/**
 * THE PREFERENCE DOCUMENT — the part of wave 4 a daily user actually feels.
 *
 * Scout finding, verbatim: "Expansion state is EPHEMERAL: lazy useState seeded
 * once, never re-synced, reset on every builder open. No per-user persistence
 * exists." Collapse the ten tables you are not using, edit a chart, come back —
 * all ten open again.
 *
 * The store that carries this deliberately does NOT interpret sections, so the
 * sanitizer below is the only thing standing between a document written by
 * another machine (or an older build, or a newer one) and the builder. It must
 * degrade, never throw.
 */
import { describe, expect, it } from 'vitest';
import {
  defaultFieldListPrefs,
  readFieldListPrefs,
  setGroupHidden,
  setGroupOpen,
} from '../src/chart-builder/fieldListPrefs';

describe('field-list preference document', () => {
  it('defaults to today’s behaviour: grouped by table, nothing overridden', () => {
    const prefs = defaultFieldListPrefs();
    expect(prefs).toEqual({ grouping: 'table', expanded: [], collapsed: [], hidden: [] });
  });

  it('round-trips a well-formed document', () => {
    const stored = {
      grouping: 'category',
      expanded: ['public.orders'],
      collapsed: ['#date.dates'],
      hidden: ['#type/text'],
    };
    expect(readFieldListPrefs(stored)).toEqual(stored);
  });

  it('degrades every malformed shape to the default rather than throwing', () => {
    for (const junk of [undefined, null, 42, 'nope', [], [1, 2, 3]]) {
      expect(readFieldListPrefs(junk)).toEqual(defaultFieldListPrefs());
    }
    // A grouping this build does not know about (a newer client wrote it).
    expect(readFieldListPrefs({ grouping: 'constellation' }).grouping).toBe('table');
    // Non-string / empty keys are dropped, not carried into the DOM.
    expect(readFieldListPrefs({ expanded: ['a', '', 7, null, 'a'] }).expanded).toEqual(['a']);
  });

  it('caps each list so one user cannot grow the document without bound', () => {
    const many = Array.from({ length: 900 }, (_, i) => `key-${i}`);
    const kept = readFieldListPrefs({ hidden: many }).hidden;
    expect(kept).toHaveLength(400);
    // The RECENT keys survive — they are the ones in use.
    expect(kept[kept.length - 1]).toBe('key-899');
  });

  it('records only a DEPARTURE from the default, and un-records a return to it', () => {
    const base = defaultFieldListPrefs();
    // A group that defaults OPEN, closed by the user.
    const closed = setGroupOpen(base, 'public.orders', false, true);
    expect(closed.collapsed).toEqual(['public.orders']);
    expect(closed.expanded).toEqual([]);

    // Re-opened: back to the default, so nothing is stored. This is what lets
    // an improved default still reach everyone who never overrode it.
    const reopened = setGroupOpen(closed, 'public.orders', true, true);
    expect(reopened.collapsed).toEqual([]);
    expect(reopened.expanded).toEqual([]);

    // A group that defaults CLOSED, opened by the user — the mirror case.
    const opened = setGroupOpen(base, 'public.big', true, false);
    expect(opened.expanded).toEqual(['public.big']);
    expect(setGroupOpen(opened, 'public.big', false, false).expanded).toEqual([]);
  });

  it('never holds a key in both lists at once', () => {
    let prefs = setGroupOpen(defaultFieldListPrefs(), 'k', false, true);
    prefs = setGroupOpen(prefs, 'k', true, false);
    expect(prefs.expanded).toEqual(['k']);
    expect(prefs.collapsed).toEqual([]);
  });

  it('hiding is reversible and idempotent', () => {
    const hidden = setGroupHidden(defaultFieldListPrefs(), '#type/text', true);
    expect(hidden.hidden).toEqual(['#type/text']);
    expect(setGroupHidden(hidden, '#type/text', true).hidden).toEqual(['#type/text']);
    expect(setGroupHidden(hidden, '#type/text', false).hidden).toEqual([]);
  });
});
