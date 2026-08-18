// @vitest-environment jsdom
/**
 * Regression tests for the inner-title editor "remnants" bug.
 *
 * React 19 re-applies dangerouslySetInnerHTML on EVERY re-render (not only
 * when the value changes) — the first test PINS that React behavior so an
 * upstream change is visible. Because RichTextDialog re-renders per keystroke
 * (onInput -> setHtml), seeding the contentEditable via
 * dangerouslySetInnerHTML meant every keystroke restored the original seed
 * over the user's typing, leaving mixed "remnants". The fix seeds the DOM
 * once (mount-only useLayoutEffect) and leaves the element browser-owned; the
 * remaining tests hold RichTextDialog to that contract.
 */
import { useState } from 'react';
import { act } from 'react';

// react-dom requires an explicit opt-in for act() outside its own test renderer.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RichTextDialog } from '../src/chart/FormatPanel';

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
