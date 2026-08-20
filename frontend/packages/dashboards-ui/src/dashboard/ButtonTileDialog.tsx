import { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { buttonStyleFromCss, sanitizeRichHtml, type ButtonTileSpec } from '@recon/dashboards-core';
import { RcdButton, RcdDialog, RcdInput, RcdSelect } from '../primitives';
import { RichTextEditingSurface } from '../richtext/RichTextEditingSurface';
import { RICH_TEXT_CLASSES } from '../richtext/richTextClasses';
import { parseHexInput } from '../richtext/useRichTextMenu';
import type { ButtonScale, ButtonVariant } from './buttonLayout';
import { ButtonVisual } from './ButtonVisual';

export interface ButtonTileDialogProps {
  open: boolean;
  /** Dialog title: 'Add button' (new tile) or 'Edit button' (config card). */
  title: string;
  /** Prefill for the edit flow; null starts blank. */
  initial: ButtonTileSpec | null;
  /** The dashboard's pages (id + display name) for the target picker. */
  pages: { id: string; name: string }[];
  onClose: () => void;
  onSave: (spec: ButtonTileSpec) => void;
}

const DEFAULT_RADIUS = 8;
const MIN_RADIUS = 0;
const MAX_RADIUS = 40;

export const DEFAULT_LABEL_HTML = '<p>Button</p>';

/* ------------------------------------------------- per-user recent colors
 * Mirrors the rich-text menu's recents pattern (useRichTextMenu) under a
 * button-scoped key: guarded localStorage, canonical lowercase hex,
 * most-recent-first, deduped, capped. Persistence is best-effort chrome.
 */

const BUTTON_RECENT_COLORS_KEY = 'rcd-button-recent-colors';
const MAX_RECENT_COLORS = 10;

export const readButtonRecentColors = (): string[] => {
  try {
    const raw = window.localStorage.getItem(BUTTON_RECENT_COLORS_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is string => typeof entry === 'string' && parseHexInput(entry) !== undefined)
      .slice(0, MAX_RECENT_COLORS);
  } catch {
    return [];
  }
};

export const rememberButtonRecentColor = (hex: string): string[] => {
  const canonical = parseHexInput(hex);
  if (!canonical) return readButtonRecentColors();
  const next = [canonical, ...readButtonRecentColors().filter((entry) => entry !== canonical)].slice(
    0,
    MAX_RECENT_COLORS,
  );
  try {
    window.localStorage.setItem(BUTTON_RECENT_COLORS_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable/full */
  }
  return next;
};

/* --------------------------------------------------------- shared editor */

/** The dialogs' working state for one button (single tile OR group item). */
export interface ButtonFieldsDraft {
  html: string;
  targetPageId: string;
  background: string | null;
  textColor: string | null;
  /** Radius as the input's raw text; clamped to [0, 40] on blur/save. */
  radiusDraft: string;
  customCss: string;
}

/** Draft seeded from an existing spec (or the blank defaults). */
export const draftFromButtonFields = (
  initial: {
    html?: string;
    targetPageId?: string;
    background?: string | null;
    textColor?: string | null;
    radius?: number;
    customCss?: string;
  } | null,
  fallbackPageId: string,
): ButtonFieldsDraft => ({
  html: initial?.html ?? DEFAULT_LABEL_HTML,
  targetPageId: initial?.targetPageId ?? fallbackPageId,
  background: initial?.background ?? null,
  textColor: initial?.textColor ?? null,
  radiusDraft: String(initial?.radius ?? DEFAULT_RADIUS),
  customCss: initial?.customCss ?? '',
});

export const clampButtonRadius = (raw: string): number => {
  const value = Math.trunc(Number(raw));
  if (!Number.isFinite(value)) return DEFAULT_RADIUS;
  return Math.min(Math.max(value, MIN_RADIUS), MAX_RADIUS);
};

/**
 * A draft compiled to the button fields both spec shapes share. EVERY field is
 * emitted explicitly (null/'' included): the store's update mutations MERGE
 * patches over the existing spec, so an omitted key would silently keep the
 * old value — the reason the old dialog could never turn fullSize back off.
 */
export const buttonFieldsOfDraft = (
  draft: ButtonFieldsDraft,
): {
  html: string;
  targetPageId: string;
  background: string | null;
  textColor: string | null;
  radius: number;
  customCss: string;
} => {
  const sanitized = sanitizeRichHtml(draft.html);
  const isEmpty = sanitized.replace(/<[^>]*>/g, '').trim() === '';
  return {
    html: isEmpty ? DEFAULT_LABEL_HTML : sanitized,
    targetPageId: draft.targetPageId,
    background: draft.background,
    textColor: draft.textColor,
    radius: clampButtonRadius(draft.radiusDraft),
    customCss: draft.customCss.trim(),
  };
};

/** Human summary of the sanitizer's allowlist for the Advanced CSS hint. */
const CSS_HINT =
  'Allowed: background(-color/-image, gradients only), color, border*, ' +
  'border-radius, box-shadow, outline, font-size/weight/style/family, ' +
  'letter-spacing, text-transform, text-decoration, padding, opacity, ' +
  'filter, transform, transition, cursor. Anything else (url(), var(), ' +
  'position, margin, …) is dropped — the preview shows exactly what ships.';

/**
 * True when the sanitized advanced CSS carries a background declaration.
 * Detection rides buttonStyleFromCss — the SAME parse the renderer applies —
 * so the warning appears exactly when the override really lands (A4 ii).
 */
export const cssOverridesBackground = (customCss: string): boolean =>
  Object.keys(buttonStyleFromCss(customCss ?? '')).some((key) => key.startsWith('background'));

/**
 * One custom color control (B1): native picker + typable hex field + Default,
 * with the shared per-user recent swatches underneath. Committing a color
 * lands it in the recents (the rich-text menu's pattern).
 *
 * Exported for the group dialog's "apply to all buttons" control.
 */
export function ButtonColorField({
  label,
  value,
  onChange,
  recents,
  onRemember,
  hint,
  warning,
}: {
  label: string;
  value: string | null;
  onChange: (hex: string | null) => void;
  recents: string[];
  onRemember: (hex: string) => void;
  /** Small caption under the label (what this color paints). */
  hint?: string;
  /** Shown as a chip beside the controls when something outranks this color. */
  warning?: string | null;
}) {
  const canonical = value ? (parseHexInput(value) ?? null) : null;
  const [text, setText] = useState(canonical ?? '');
  const textRef = useRef<HTMLInputElement | null>(null);
  /** The native picker actually changed something this focus session. */
  const previewedRef = useRef(false);

  // Track the applied value unless the user is mid-typing in the hex field.
  useEffect(() => {
    if (document.activeElement === textRef.current) return;
    setText(canonical ?? '');
  }, [canonical]);

  const commit = (hex: string) => {
    const parsed = parseHexInput(hex);
    if (!parsed) {
      setText(canonical ?? '');
      return;
    }
    setText(parsed);
    onChange(parsed);
    onRemember(parsed);
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="text-xs font-medium text-rcd-text-2">{label}</span>
      {hint !== undefined && <span className="text-[10px] leading-snug text-rcd-muted">{hint}</span>}
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          type="color"
          value={canonical ?? '#3b82f6'}
          title={`${label} color picker`}
          aria-label={`${label} color picker`}
          // Live preview while the native picker drags; commit (recents) on
          // settle — the rich-text CustomColorPicker's split.
          onChange={(event) => {
            previewedRef.current = true;
            onChange(event.target.value);
          }}
          onBlur={(event) => {
            if (!previewedRef.current) return;
            previewedRef.current = false;
            const hex = parseHexInput(event.target.value);
            if (hex) onRemember(hex);
          }}
          className="h-6 w-7 flex-shrink-0 cursor-pointer rounded border border-rcd-border bg-transparent p-0"
        />
        <input
          ref={textRef}
          type="text"
          value={text}
          placeholder="#rrggbb"
          spellCheck={false}
          aria-label={`${label} color hex value`}
          onFocus={(event) => event.currentTarget.select()}
          // A4(iii): COMMIT AS SOON AS THE VALUE PARSES. Committing only on
          // Enter/blur is the "finicky" report — typing #ff0000 and then
          // clicking Cancel, or a field that never blurs, silently discarded
          // it. Partial input ("#ff0") keeps the old commit-on-Enter/blur
          // behavior, so typing a full hex one character at a time still works.
          onChange={(event) => {
            const next = event.target.value;
            setText(next);
            const parsed = parseHexInput(next);
            if (parsed) {
              onChange(parsed);
              onRemember(parsed);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit(text);
            }
          }}
          onBlur={() => {
            if (text.trim() === '') onChange(null);
            else commit(text);
          }}
          className="w-[4.6rem] rounded border border-rcd-border bg-transparent px-1 py-0.5 font-mono text-[11px] text-rcd-text outline-none focus:border-rcd-accent"
        />
        <button
          type="button"
          onClick={() => onChange(null)}
          className={`rounded-md border px-1.5 py-0.5 text-[11px] ${
            value == null
              ? 'border-rcd-text text-rcd-text'
              : 'border-rcd-border text-rcd-text-2 hover:border-rcd-text-2 hover:text-rcd-text'
          }`}
        >
          Default
        </button>
        {warning != null && warning !== '' && (
          <span
            className="inline-flex items-center gap-1 rounded-md border border-[var(--rcd-status-warn)] px-1.5 py-0.5 text-[10px] font-medium leading-4 text-[var(--rcd-status-warn)]"
            title={warning}
          >
            <AlertTriangle size={10} aria-hidden />
            {warning}
          </span>
        )}
      </div>
      {recents.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {recents.map((hex) => (
            <button
              key={hex}
              type="button"
              title={hex}
              aria-label={`Recent color ${hex} for ${label.toLowerCase()}`}
              onClick={() => {
                onChange(hex);
                onRemember(hex);
              }}
              className={`h-4 w-4 flex-shrink-0 rounded-full border transition hover:scale-110 ${
                canonical === hex ? 'border-rcd-text' : 'border-rcd-border'
              }`}
              style={{ backgroundColor: hex }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The button fields shared by the single-button dialog and every row of the
 * group dialog: rich label (multiline off, lists off — the rich-text wave's
 * label contract), target page, custom colors, corner radius, and the
 * Advanced CSS override with its live preview.
 */
export function ButtonFieldsEditor({
  draft,
  onChange,
  pages,
  previewSize = null,
  previewVariant = 'default',
}: {
  draft: ButtonFieldsDraft;
  onChange: (patch: Partial<ButtonFieldsDraft>) => void;
  pages: { id: string; name: string }[];
  /** Group hosts pass their size/variant so the preview stays the truth. */
  previewSize?: ButtonScale | null;
  previewVariant?: ButtonVariant;
}) {
  // Recents are shared by both color fields so a color committed on one is
  // immediately offered on the other.
  const [recents, setRecents] = useState<string[]>(() => readButtonRecentColors());
  const remember = (hex: string) => setRecents(rememberButtonRecentColor(hex));

  // A target the pages list no longer contains (broken link being edited):
  // surfaced as an explicit "(missing page)" option so the select never sits
  // silently blank while still holding the stale id.
  const targetMissing =
    draft.targetPageId !== '' && !pages.some((page) => page.id === draft.targetPageId);

  // customCss is the full-control layer and WINS over the fill picker by
  // design (buttonTiles.test.tsx pins it). Rather than break that contract,
  // say so where the author is looking (A4 ii).
  const cssBackground = cssOverridesBackground(draft.customCss);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-rcd-text-2">Label</span>
        {/* This editor mounts fresh whenever its host (re)opens or a group row
            expands, so the mount-only seed always shows the CURRENT html.
            A button LABEL is a single line without list structure:
            multiline off (Enter is consumed) and lists off (no list
            toolbar/menu/Tab-indent — Tab still inserts spaces).
            COLOR OFF (D2 "the dialog owns color"): the rich-text color control
            wrote spans INSIDE the label that always beat the dialog's Text
            picker, so the two controls disagreed three centimetres apart.
            Existing color spans keep rendering — only the control is gone. */}
        <RichTextEditingSurface
          seedHtml={draft.html}
          onChange={(html) => onChange({ html })}
          inDialog
          multiline={false}
          features={{ lists: false, color: false }}
          ariaLabel="Button label rich text"
          className={`${RICH_TEXT_CLASSES} min-h-[3rem] rounded-md border border-rcd-border bg-rcd-surface px-2.5 py-1.5 outline-none focus:border-rcd-accent`}
        />
      </div>

      <label className="flex flex-col gap-1.5 text-xs font-medium text-rcd-text-2">
        Navigates to page
        <RcdSelect
          value={draft.targetPageId}
          onChange={(event) => onChange({ targetPageId: event.target.value })}
        >
          {targetMissing && (
            <option value={draft.targetPageId} disabled>
              (missing page)
            </option>
          )}
          {pages.map((page) => (
            <option key={page.id} value={page.id}>
              {page.name}
            </option>
          ))}
        </RcdSelect>
      </label>

      <div className="flex flex-wrap items-start gap-4">
        {/* A4(i): "Background" meant the CONTAINER fill on the group's config
            card and the BUTTON fill here — the same word for two different
            surfaces was the likeliest cause of "it doesn't change the button".
            This one is the button's own fill. */}
        <ButtonColorField
          label="Button fill"
          hint="This button's own color."
          value={draft.background}
          onChange={(background) => onChange({ background })}
          recents={recents}
          onRemember={remember}
          warning={cssBackground ? 'Advanced CSS is overriding this fill' : null}
        />
        <ButtonColorField
          label="Text"
          hint="Label color for the whole button."
          value={draft.textColor}
          onChange={(textColor) => onChange({ textColor })}
          recents={recents}
          onRemember={remember}
        />
      </div>

      <label className="flex items-center gap-1.5 text-xs font-medium text-rcd-text-2">
        Corner radius (px)
        <RcdInput
          type="number"
          min={MIN_RADIUS}
          max={MAX_RADIUS}
          value={draft.radiusDraft}
          aria-label="Button corner radius in pixels"
          onChange={(event) => onChange({ radiusDraft: event.target.value })}
          // Clamp on BLUR, never mid-type (the NumberRow rule): clamping
          // per keystroke makes typing "12" impossible past "1".
          onBlur={() => onChange({ radiusDraft: String(clampButtonRadius(draft.radiusDraft)) })}
          className="w-20"
        />
      </label>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-rcd-text-2">Advanced CSS</span>
        <textarea
          value={draft.customCss}
          onChange={(event) => onChange({ customCss: event.target.value })}
          spellCheck={false}
          rows={3}
          // A4(ii): the old placeholder SUGGESTED a background gradient, which
          // then silently outranked the fill picker above. The example is a
          // non-background declaration now.
          placeholder={'font-weight: 600;\nletter-spacing: 0.02em;'}
          aria-label="Advanced CSS declarations for the button"
          className="rounded-md border border-rcd-border bg-rcd-surface px-2.5 py-1.5 font-mono text-[11px] leading-snug text-rcd-text outline-none focus:border-rcd-accent"
        />
        {cssBackground && (
          <p className="text-[10px] leading-snug text-[var(--rcd-status-warn)]">
            A background declaration here overrides the Button fill picker above — remove it to use
            the picker.
          </p>
        )}
        <p className="text-[10px] leading-snug text-rcd-muted">{CSS_HINT}</p>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-rcd-text-2">Preview</span>
        {/* The preview renders through the SAME ButtonVisual (and therefore
            the same sanitizer) as the dashboard — invalid/blocked
            declarations are silently dropped, so this IS the truth. */}
        <div className="flex items-center justify-center overflow-hidden rounded-md border border-rcd-border/70 bg-rcd-bg p-3">
          <ButtonVisual
            spec={{
              html: draft.html,
              background: draft.background,
              textColor: draft.textColor,
              radius: clampButtonRadius(draft.radiusDraft),
              customCss: draft.customCss,
            }}
            size={previewSize}
            variant={previewVariant}
          />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------ single-button dialog */

/**
 * Add/edit dialog for navigation-button tiles: the shared button fields
 * (rich label, target page, custom colors, radius, advanced CSS + preview)
 * plus the tile-level fill switch. The config card's swatch row remains as a
 * quick background path; this dialog is the full control surface.
 */
export function ButtonTileDialog({ open, title, initial, pages, onClose, onSave }: ButtonTileDialogProps) {
  const [draft, setDraft] = useState<ButtonFieldsDraft>(() => draftFromButtonFields(null, ''));
  const [fullSize, setFullSize] = useState(false);

  // (Re)initialize from the incoming spec ONLY on the closed→open EDGE —
  // the ImageTileDialog rule: keying on `initial`'s identity too would wipe
  // in-progress drafts whenever undo/redo elsewhere mints a fresh (equal)
  // spec object while the dialog is open.
  const wasOpen = useRef(false);
  useEffect(() => {
    const opening = open && !wasOpen.current;
    wasOpen.current = open;
    if (!opening) return;
    setDraft(draftFromButtonFields(initial, pages[0]?.id ?? ''));
    setFullSize(initial?.fullSize ?? false);
  }, [open, initial, pages]);

  const valid = draft.targetPageId !== '';

  const handleSave = () => {
    if (!valid) return;
    // Every field explicit (see buttonFieldsOfDraft) — updateButtonTile
    // merges, so omissions would resurrect old values.
    onSave({ ...buttonFieldsOfDraft(draft), fullSize });
  };

  return (
    <RcdDialog
      title={title}
      open={open}
      onClose={onClose}
      footer={
        <>
          <RcdButton onClick={onClose}>Cancel</RcdButton>
          <RcdButton variant="primary" onClick={handleSave} disabled={!valid}>
            {title === 'Edit button' ? 'Apply' : 'Add'}
          </RcdButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <ButtonFieldsEditor
          draft={draft}
          onChange={(patch) => setDraft((prev) => ({ ...prev, ...patch }))}
          pages={pages}
        />

        <label className="flex items-center gap-1.5 text-xs font-medium text-rcd-text-2">
          <input
            type="checkbox"
            checked={fullSize}
            onChange={(event) => setFullSize(event.target.checked)}
            className="accent-[var(--rcd-accent)]"
          />
          Fill the whole tile
        </label>
      </div>
    </RcdDialog>
  );
}
