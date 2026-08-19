import { useEffect, useRef, type RefObject } from 'react';

export interface UseRcdDismissableOptions {
  /** Listeners are registered only while true (pass the popover's open state). */
  enabled?: boolean;
  /**
   * Distinct Escape behaviour for surfaces where Escape must NOT mean the same
   * as clicking outside (the format menu closes-and-refocuses-the-editor on
   * Escape but may end the editing session on an outside click). Defaults to
   * `onDismiss(null)`.
   */
  onEscape?: () => void;
}

/**
 * Shared dismissal mechanism for the rich-text popover layer (NOT for modals —
 * RcdDialog owns those). Ported from the reference implementation's
 * useDismissable with one extension: the outside pointerdown's TARGET is
 * handed to `onDismiss`, so the editing surface can distinguish "clicked into
 * the menu's editor" (keep the editing session alive) from "clicked away
 * entirely" (commit and end the session).
 *
 * Why CAPTURE `pointerdown` (not bubble `mousedown`/`click`): it is the
 * earliest gesture event (mouse/touch/pen alike), so the popover closes before
 * any underlying control reacts, and a stopPropagation inside some component's
 * bubble handler can never silently disable outside-click dismissal.
 *
 * Escape contract: the Escape listener is registered in the CAPTURE phase on
 * `document` and calls `event.stopPropagation()` BEFORE acting — one Escape
 * peels exactly THIS layer. RcdDialog's own Escape handler lives on
 * `document` in the BUBBLE phase, so stopping propagation during capture
 * guarantees the menu's Escape never also closes the dialog hosting the
 * editor (the event never reaches document's bubble-phase listeners).
 */
export function useRcdDismissable(
  ref: RefObject<HTMLElement | null>,
  onDismiss: (outsideTarget: Node | null) => void,
  options: UseRcdDismissableOptions = {},
): void {
  const { enabled = true } = options;

  // Latest callbacks in a ref: the document listeners are registered once per
  // open, never re-bound per render, and never close over stale state.
  const latest = useRef({ onDismiss, onEscape: options.onEscape });
  latest.current = { onDismiss, onEscape: options.onEscape };

  useEffect(() => {
    if (!enabled) return undefined;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (ref.current?.contains(target)) return;
      latest.current.onDismiss(target);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Consume the Escape entirely: nothing beneath (the surrounding
      // RcdDialog's close-on-Escape above all) may also react to the keypress
      // that closed this popover.
      event.stopPropagation();
      const { onEscape, onDismiss } = latest.current;
      if (onEscape) onEscape();
      else onDismiss(null);
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [ref, enabled]);
}
