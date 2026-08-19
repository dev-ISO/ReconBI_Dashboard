// @vitest-environment jsdom
/**
 * Regression tests for the library's contentEditable surfaces.
 *
 * React 19 re-applies dangerouslySetInnerHTML on EVERY re-render (not only
 * when the value changes) — the first test PINS that React behavior so an
 * upstream change is visible. Because the rich-text editors re-render per
 * keystroke (onInput -> state), seeding a live contentEditable via
 * dangerouslySetInnerHTML meant every keystroke restored the original seed
 * over the user's typing, leaving mixed "remnants" (and, on the text tile,
 * losing typing to ANY store re-render — a real data-loss path under collab).
 * The fix: every editor is the shared RichTextEditingSurface, seeded
 * imperatively and browser-owned afterwards. These suites hold RichTextDialog,
 * the text tile, and the surface itself to that contract, plus the rich-text
 * wave's behaviors: Tab handling, the right-click format menu's dismissal
 * layering, and the sanitizer's list support.
 */
import { useState } from 'react';
import { act } from 'react';

// react-dom requires an explicit opt-in for act() outside its own test renderer.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RcdFetcher } from '@recon/dashboards-core';
// The sanitizer is imported from core SOURCE (not the built dist) so these
// tests exercise the list-support changes without requiring a core build.
import { sanitizeRichHtml } from '../../dashboards-core/src/util/richText';
import { RichTextDialog } from '../src/chart/FormatPanel';
import { DashboardsProvider } from '../src/provider/DashboardsProvider';
import { TextTile } from '../src/dashboard/TextTile';
import { RichTextEditingSurface } from '../src/richtext/RichTextEditingSurface';
import { TAB_SPACES } from '../src/richtext/richTextCommands';

const ORIGINAL = '<p><b>Systems by Plant Area</b> <span>— how the estate splits</span></p>';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const editor = (): HTMLElement => document.querySelector<HTMLElement>('[contenteditable]')!;

/** Browser-realistic edit: contentEditable mutates DOM directly, then fires input. */
const userTypes = (el: HTMLElement, replacement: string) => {
  el.innerHTML = replacement;
  act(() => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('React 19 dangerouslySetInnerHTML behavior (pinned)', () => {
  function Naive({ seed }: { seed: string }) {
    const [, setHtml] = useState(seed);
    return (
      <div
        contentEditable
        onInput={(event) => setHtml((event.target as HTMLElement).innerHTML)}
        dangerouslySetInnerHTML={{ __html: seed }}
      />
    );
  }

  it('re-applies the seed on re-render — the pattern RichTextDialog must NOT use', () => {
    act(() => root.render(<Naive seed={ORIGINAL} />));
    userTypes(editor(), '<p>My new title</p>');
    // The onInput re-render alone restores the seed under React 19. If this
    // ever starts KEEPING the typed content, React changed behavior upstream —
    // revisit whether the mount-only seeding workaround is still needed.
    expect(editor().innerHTML).toBe(ORIGINAL);
  });
});

describe('RichTextDialog editor DOM ownership', () => {
  const noop = () => {};

  it('keeps typed content across its own per-keystroke re-renders', () => {
    act(() =>
      root.render(
        <RichTextDialog title="Inner title" initialHtml={ORIGINAL} onApply={noop} onCancel={noop} />,
      ),
    );
    expect(editor().innerHTML).toBe(ORIGINAL);

    userTypes(editor(), '<p>My new title</p>');
    expect(editor().innerHTML).toBe('<p>My new title</p>');

    userTypes(editor(), '<p>My new title!!</p>');
    expect(editor().innerHTML).toBe('<p>My new title!!</p>');
  });

  it('keeps typed content when the PARENT re-renders (builder preview refreshes)', () => {
    function Parent({ tick }: { tick: number }) {
      return (
        <div data-tick={tick}>
          <RichTextDialog
            title="Inner title"
            initialHtml={ORIGINAL}
            onApply={noop}
            onCancel={noop}
          />
        </div>
      );
    }
    act(() => root.render(<Parent tick={0} />));
    userTypes(editor(), '<p>My new title</p>');
    act(() => root.render(<Parent tick={1} />));
    act(() => root.render(<Parent tick={2} />));
    expect(editor().innerHTML).toBe('<p>My new title</p>');
  });

  it('Apply hands back the SANITIZED typed content', () => {
    let applied: string | undefined | null = null;
    act(() =>
      root.render(
        <RichTextDialog
          title="Inner title"
          initialHtml={ORIGINAL}
          onApply={(html) => {
            applied = html;
          }}
          onCancel={noop}
        />,
      ),
    );
    userTypes(editor(), '<p>My new title <script>alert(1)</script></p>');
    const buttons = Array.from(document.querySelectorAll('button'));
    const apply = buttons.find((b) => b.textContent === 'Apply')!;
    act(() => apply.click());
    expect(applied).toBe('<p>My new title </p>');
  });
});

/* ------------------------------------------------------------------------ */
/* Shared helpers for the rich-text wave's suites.                           */

/** Collapsed caret at (node, offset) — where Tab decisions are made. */
const setCaret = (node: Node, offset: number) => {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
};

/** Select an element's full contents (the right-click menu's selection mode). */
const selectContents = (el: HTMLElement) => {
  const range = document.createRange();
  range.selectNodeContents(el);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
};

/** Dispatch a cancelable keydown; returns true when it was preventDefaulted. */
const pressKey = (el: HTMLElement, key: string, init: KeyboardEventInit = {}): boolean => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  let proceeded = true;
  act(() => {
    proceeded = el.dispatchEvent(event);
  });
  return !proceeded;
};

const rightClick = (el: HTMLElement) => {
  act(() => {
    el.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }),
    );
  });
};

const focusIn = (el: HTMLElement) => {
  act(() => {
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  });
};

const focusOut = (el: HTMLElement) => {
  act(() => {
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
};

const formatMenu = () => document.querySelector('[role="menu"][aria-label="Text formatting"]');

/* ------------------------------------------------------------------------ */

describe('RichTextEditingSurface Tab handling', () => {
  /** Recorded execCommand invocations (jsdom has no execCommand — the stub
   *  both enables the code path and records the exact command sequence). */
  let execCalls: { command: string; value?: string }[];

  beforeEach(() => {
    execCalls = [];
    document.execCommand = ((command: string, _showUI?: boolean, value?: string) => {
      execCalls.push(value === undefined ? { command } : { command, value });
      return true;
    }) as typeof document.execCommand;
  });

  afterEach(() => {
    Reflect.deleteProperty(document, 'execCommand');
  });

  const mountSurface = (seedHtml: string, props: Record<string, unknown> = {}) =>
    act(() =>
      root.render(
        <RichTextEditingSurface seedHtml={seedHtml} ariaLabel="Editor under test" {...props} />,
      ),
    );

  it('Tab inside a <li> indents as nested-list structure with styleWithCSS forced off', () => {
    mountSurface('<ul><li>one</li><li>two</li></ul>');
    setCaret(editor().querySelector('li')!.firstChild!, 1);
    const prevented = pressKey(editor(), 'Tab');
    expect(prevented).toBe(true);
    // styleWithCSS OFF around the structural command, restored after —
    // Chromium otherwise emits margin-left spans the sanitizer strips.
    expect(execCalls).toEqual([
      { command: 'styleWithCSS', value: 'false' },
      { command: 'indent' },
      { command: 'styleWithCSS', value: 'true' },
    ]);
  });

  it('Shift+Tab inside a <li> outdents', () => {
    mountSurface('<ul><li>one</li></ul>');
    setCaret(editor().querySelector('li')!.firstChild!, 1);
    const prevented = pressKey(editor(), 'Tab', { shiftKey: true });
    expect(prevented).toBe(true);
    expect(execCalls).toEqual([
      { command: 'styleWithCSS', value: 'false' },
      { command: 'outdent' },
      { command: 'styleWithCSS', value: 'true' },
    ]);
  });

  it('Tab outside a list inserts four no-break spaces (never tab-focuses away)', () => {
    mountSurface('<p>hello</p>');
    setCaret(editor().querySelector('p')!.firstChild!, 2);
    const prevented = pressKey(editor(), 'Tab');
    expect(prevented).toBe(true);
    expect(TAB_SPACES).toBe('    ');
    expect(execCalls).toEqual([{ command: 'insertText', value: TAB_SPACES }]);
  });

  it('Shift+Tab outside a list is a consumed no-op', () => {
    mountSurface('<p>hello</p>');
    setCaret(editor().querySelector('p')!.firstChild!, 2);
    const prevented = pressKey(editor(), 'Tab', { shiftKey: true });
    expect(prevented).toBe(true);
    expect(execCalls).toEqual([]);
  });

  it('with lists disabled, Tab in a (pasted) list still just inserts spaces', () => {
    mountSurface('<ul><li>one</li></ul>', { features: { lists: false } });
    setCaret(editor().querySelector('li')!.firstChild!, 1);
    const prevented = pressKey(editor(), 'Tab');
    expect(prevented).toBe(true);
    expect(execCalls).toEqual([{ command: 'insertText', value: TAB_SPACES }]);
  });

  it('multiline=false consumes Enter; multiline (default) leaves it to the editor', () => {
    mountSurface('<p>label</p>', { multiline: false });
    setCaret(editor().querySelector('p')!.firstChild!, 2);
    expect(pressKey(editor(), 'Enter')).toBe(true);

    mountSurface('<p>body</p>');
    setCaret(editor().querySelector('p')!.firstChild!, 2);
    expect(pressKey(editor(), 'Enter')).toBe(false);
  });

  it('never consumes Escape (dialogs keep their close behaviour)', () => {
    mountSurface('<p>hello</p>');
    setCaret(editor().querySelector('p')!.firstChild!, 2);
    expect(pressKey(editor(), 'Escape')).toBe(false);
  });
});

describe('RichTextEditingSurface session contract', () => {
  it('onFocus at session start; onCommit fires BEFORE onBlur at session end', () => {
    // The text tile relies on this exact ordering: commit updateTextTile
    // FIRST, release the soft lock SECOND — a held remote op must stay
    // superseded by the newer local write.
    const calls: string[] = [];
    act(() =>
      root.render(
        <RichTextEditingSurface
          seedHtml="<p>x</p>"
          ariaLabel="Editor under test"
          onFocus={() => calls.push('focus')}
          onCommit={(html) => calls.push(`commit:${html}`)}
          onBlur={() => calls.push('blur')}
        />,
      ),
    );
    focusIn(editor());
    focusOut(editor());
    expect(calls).toEqual(['focus', 'commit:<p>x</p>', 'blur']);
  });
});

describe('format menu dismissal layering', () => {
  it('Escape closes the menu only — the RcdDialog hosting the editor stays open', () => {
    const onCancel = vi.fn();
    act(() =>
      root.render(
        <RichTextDialog title="Inner title" initialHtml={ORIGINAL} onApply={() => {}} onCancel={onCancel} />,
      ),
    );
    const ed = editor();
    act(() => selectContents(ed));
    rightClick(ed);
    expect(formatMenu()).not.toBeNull();

    // First Escape: the menu's capture-phase listener consumes it — the menu
    // unmounts and the dialog's own Escape handler never sees the keypress.
    pressKey(ed, 'Escape');
    expect(formatMenu()).toBeNull();
    expect(onCancel).not.toHaveBeenCalled();

    // Second Escape: nothing left to peel — the dialog closes as usual.
    pressKey(ed, 'Escape');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('right-click without a selection inside the editor still opens (caret mode)', () => {
    act(() =>
      root.render(
        <RichTextDialog title="Inner title" initialHtml={ORIGINAL} onApply={() => {}} onCancel={() => {}} />,
      ),
    );
    const ed = editor();
    act(() => setCaret(ed.querySelector('b')!.firstChild!, 2));
    rightClick(ed);
    expect(formatMenu()).not.toBeNull();
    pressKey(ed, 'Escape'); // cleanup: peel the menu again
  });
});

describe('TextTile editor DOM ownership (B4) and right-click routing', () => {
  const stubFetcher = (<T,>(): Promise<T> => Promise.resolve(undefined as unknown as T)) as RcdFetcher;

  const mountTile = (html: string) =>
    act(() =>
      root.render(
        <DashboardsProvider baseUrl="/api/rcd/v1" fetcher={stubFetcher}>
          <TextTile tileId="tile-1" spec={{ html }} editable />
        </DashboardsProvider>,
      ),
    );

  it('keeps typing across store re-renders while editing — same OR changed spec html', () => {
    // The old editor rendered dangerouslySetInnerHTML on the LIVE element:
    // any store re-render mid-typing (collab op, lock notice, tile refresh,
    // undo) stomped the user's typing back to spec.html. Pin the fix.
    mountTile('<p>Seed text</p>');
    const ed = editor();
    expect(ed.innerHTML).toBe('<p>Seed text</p>');
    focusIn(ed); // editing session begins (soft lock territory)
    userTypes(ed, '<p>My typing</p>');
    mountTile('<p>Seed text</p>'); // store echo — identical spec re-render
    expect(ed.innerHTML).toBe('<p>My typing</p>');
    mountTile('<p>Remote edit</p>'); // remote value arriving mid-edit
    expect(ed.innerHTML).toBe('<p>My typing</p>');
  });

  it('adopts remote spec.html while idle (no editing session)', () => {
    mountTile('<p>Seed text</p>');
    expect(editor().innerHTML).toBe('<p>Seed text</p>');
    mountTile('<p>Remote edit</p>');
    expect(editor().innerHTML).toBe('<p>Remote edit</p>');
  });

  it('right-click INSIDE the editor opens the format menu; OUTSIDE opens the config card', () => {
    mountTile('<p>Seed text</p>');
    const ed = editor();
    act(() => selectContents(ed));
    rightClick(ed);
    expect(formatMenu()).not.toBeNull();
    expect(document.querySelector('[aria-label="Configure text tile"]')).toBeNull();
    pressKey(ed, 'Escape'); // peel the menu before the second gesture

    // Outside the editor (the frame's title span): the tile config card.
    const frameTitle = document.querySelector<HTMLElement>('span[title="Text"]')!;
    rightClick(frameTitle);
    expect(document.querySelector('[aria-label="Configure text tile"]')).not.toBeNull();
    expect(formatMenu()).toBeNull();
  });
});

describe('sanitizeRichHtml list support', () => {
  it('keeps an explicit marker (circle) on a list — idempotently', () => {
    const once = sanitizeRichHtml('<ul style="list-style-type: circle;"><li>a</li></ul>');
    expect(once).toContain('list-style-type: circle');
    expect(sanitizeRichHtml(once)).toBe(once);
  });

  it('keeps the numbering families on <ol>', () => {
    for (const marker of ['decimal', 'lower-alpha', 'upper-alpha', 'lower-roman', 'upper-roman']) {
      const out = sanitizeRichHtml(`<ol style="list-style-type: ${marker};"><li>a</li></ol>`);
      expect(out).toContain(`list-style-type: ${marker}`);
    }
  });

  it('blocks list-style-image (and any url payload) while keeping the safe marker', () => {
    const out = sanitizeRichHtml(
      '<ul style="list-style-image: url(javascript:alert(1)); list-style-type: square;"><li>a</li></ul>',
    );
    expect(out).not.toContain('list-style-image');
    expect(out).not.toContain('url(');
    expect(out).toContain('list-style-type: square');
  });

  it('drops margin/padding indentation styles — indentation is nested lists', () => {
    const out = sanitizeRichHtml('<ul style="margin-left: 40px; padding-left: 60px;"><li>a</li></ul>');
    expect(out).not.toContain('margin');
    expect(out).not.toContain('padding');
    expect(out).toBe('<ul><li>a</li></ul>');
  });

  it('round-trips a Word-like nested list (marker + styled li) unchanged', () => {
    const once = sanitizeRichHtml(
      '<ul style="list-style-type: square;"><li>one<ul><li style="color: red;">nested</li></ul></li></ul>',
    );
    expect(once).toContain('<ul><li style="color: red;">nested</li></ul>');
    expect(sanitizeRichHtml(once)).toBe(once);
  });
});
