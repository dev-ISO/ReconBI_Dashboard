import { useCallback, useState } from 'react';

/**
 * Controller + pure per-user persistence for the rich-text format menu.
 * The anchor half is the reference implementation's useContextMenu; the
 * persistence half is its richTextMenu.ts trimmed to what this library's
 * menu offers (collapsible sections + recent custom colours — no gradients,
 * no effects: those live outside the sanitizer's model).
 */

/** Viewport coordinates the open menu renders at; null = closed. */
export interface RichTextMenuAnchor {
  x: number;
  y: number;
}

export function useRichTextMenu() {
  const [anchor, setAnchor] = useState<RichTextMenuAnchor | null>(null);

  const open = useCallback(
    (event: { preventDefault: () => void; clientX: number; clientY: number }) => {
      event.preventDefault(); // suppress the native context menu
      setAnchor({ x: event.clientX, y: event.clientY });
    },
    [],
  );

  const close = useCallback(() => setAnchor(null), []);

  return { anchor, open, close };
}

export type UseRichTextMenu = ReturnType<typeof useRichTextMenu>;

/* -------------------------------------------------- persisted menu state */

/** Guarded localStorage (embedded hosts may sandbox or disable storage —
 *  the menu then simply forgets between opens instead of crashing). */
const readStorage = (key: string): unknown => {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
};

const writeStorage = (key: string, value: unknown): void => {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable/full — persistence is best-effort chrome */
  }
};

export type RichTextMenuSectionId = 'lists' | 'size' | 'color' | 'align';

export type RichTextMenuSections = Record<RichTextMenuSectionId, boolean>;

export const MENU_SECTIONS_KEY = 'rcd-richtext-menu-sections';

export function readMenuSections(): RichTextMenuSections {
  const raw = readStorage(MENU_SECTIONS_KEY) as Partial<RichTextMenuSections> | null;
  return {
    lists: raw?.lists === true,
    size: raw?.size === true,
    color: raw?.color === true,
    align: raw?.align === true,
  };
}

export function writeMenuSections(state: RichTextMenuSections): void {
  writeStorage(MENU_SECTIONS_KEY, state);
}

/* ---------------------------------------------------- recent custom colours */

export const RECENT_COLORS_KEY = 'rcd-richtext-recent-colors';
export const MAX_RECENT_COLORS = 10;

/**
 * Parse what a user typed/pasted into a hex field: with or without '#', 3- or
 * 6-digit (3-digit expands). Canonical lowercase `#rrggbb`, undefined for junk.
 */
export function parseHexInput(raw: string): string | undefined {
  const trimmed = raw.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(trimmed)) {
    return `#${trimmed
      .split('')
      .map((ch) => ch + ch)
      .join('')}`.toLowerCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(trimmed)) return `#${trimmed}`.toLowerCase();
  return undefined;
}

export function readRecentColors(): string[] {
  const raw = readStorage(RECENT_COLORS_KEY);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is string => typeof entry === 'string' && parseHexInput(entry) !== undefined)
    .slice(0, MAX_RECENT_COLORS);
}

/** Remember an applied custom colour (most-recent-first, deduped, capped);
 *  returns the updated list for immediate rendering. */
export function rememberRecentColor(hex: string): string[] {
  const canonical = parseHexInput(hex);
  if (!canonical) return readRecentColors();
  const rest = readRecentColors().filter((entry) => entry !== canonical);
  const next = [canonical, ...rest].slice(0, MAX_RECENT_COLORS);
  writeStorage(RECENT_COLORS_KEY, next);
  return next;
}
