/**
 * THE ONE FOLDER TREE — the reconciliation of two renderers that disagreed.
 *
 * Scout finding, verbatim: "MeasuresPanel renders folders FLAT and
 * alphabetically (the whole 'Stage Tracker\Stage 1 …' string as one header)
 * while FieldList renders a NESTED tree in insertion order. Same data, two
 * mental models — and the tracker now ships a 10-folder Stage Tracker
 * hierarchy through both."
 *
 * These pin the shared answer: one separator, one sort rule, one shape, and a
 * flattening that yields the SAME sequence the nested renderer draws so a
 * narrow rail can agree without nesting.
 */
import { describe, expect, it } from 'vitest';
import {
  buildFolderTree,
  collectFolderKeys,
  flattenFolderTree,
  FOLDER_SEPARATOR,
  folderItemCount,
  joinFolderPath,
  splitFolderPath,
} from '../src/util/folderTree';

interface Item {
  name: string;
  folder: string | null;
}

const item = (name: string, folder: string | null = null): Item => ({ name, folder });
const tree = (items: Item[]) => buildFolderTree(items, (i) => i.folder, joinFolderPath);
const names = <T extends { name: string }>(items: readonly T[]): string[] => items.map((i) => i.name);

describe('folder tree', () => {
  it('splits on backslash ONLY — a forward slash is part of the folder NAME', () => {
    expect(splitFolderPath('Finance\\Core')).toEqual(['Finance', 'Core']);
    // THE DECISION: 'Finance/Core' is ONE folder. Teaching the splitter about
    // '/' would silently re-shape every already-authored folder whose name
    // contains one — a data change disguised as a rendering change.
    expect(splitFolderPath('Finance/Core')).toEqual(['Finance/Core']);
    expect(FOLDER_SEPARATOR).toBe('\\');
  });

  it('treats blank, whitespace and empty segments as no folder at all', () => {
    expect(splitFolderPath(null)).toEqual([]);
    expect(splitFolderPath('   ')).toEqual([]);
    expect(splitFolderPath('\\A\\\\B\\')).toEqual(['A', 'B']);
    expect(splitFolderPath(' A \\ B ')).toEqual(['A', 'B']);
  });

  it('sorts folders alphabetically at EVERY level, but keeps items in source order', () => {
    const built = tree([
      item('z-first', 'Zulu'),
      item('a-second', 'Alpha'),
      item('deep-b', 'Alpha\\Zeta'),
      item('deep-a', 'Alpha\\Beta'),
      item('second-in-alpha', 'Alpha'),
    ]);

    expect(names(built.folders)).toEqual(['Alpha', 'Zulu']);
    expect(names(built.folders[0]!.folders)).toEqual(['Beta', 'Zeta']);
    // Items are AUTHORED order — a model's measure order is a decision.
    expect(built.folders[0]!.items.map((i) => i.name)).toEqual(['a-second', 'second-in-alpha']);
  });

  it('sorts case-insensitively, so "alpha" and "Beta" do not interleave by ASCII', () => {
    const built = tree([item('a', 'beta'), item('b', 'Alpha')]);
    expect(names(built.folders)).toEqual(['Alpha', 'beta']);
  });

  it('files unfoldered items in root — the bucket both surfaces render LAST', () => {
    const built = tree([item('loose'), item('filed', 'Ops')]);
    expect(built.root.map((i) => i.name)).toEqual(['loose']);
    expect(names(built.folders)).toEqual(['Ops']);
  });

  it('keys every folder by its full PATH, so two folders named alike stay apart', () => {
    const built = tree([item('a', 'One\\Shared'), item('b', 'Two\\Shared')]);
    const keys = collectFolderKeys(built.folders);
    expect(keys).toEqual(['One', 'One\\Shared', 'Two', 'Two\\Shared']);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('counts a subtree including descendants', () => {
    const built = tree([item('a', 'Top'), item('b', 'Top\\Mid'), item('c', 'Top\\Mid\\Deep')]);
    expect(folderItemCount(built.folders[0]!)).toBe(3);
  });

  it('flattens in the SAME order the nested renderer draws, parents included', () => {
    const built = tree([
      item('leaf', 'Stage Tracker\\Stage 1\\Received'),
      item('other', 'Stage Tracker\\Stage 2'),
    ]);
    // A parent that holds no items of its own is still yielded: it is the
    // header its children are indented under.
    expect(flattenFolderTree(built.folders).map((n) => joinFolderPath(n.path))).toEqual([
      'Stage Tracker',
      'Stage Tracker\\Stage 1',
      'Stage Tracker\\Stage 1\\Received',
      'Stage Tracker\\Stage 2',
    ]);
  });
});
