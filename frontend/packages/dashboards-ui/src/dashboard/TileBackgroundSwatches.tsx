/**
 * Fixed background palette for text/image/button tiles, as two hue-matched
 * rows: eight light tints and their eight deep counterparts.
 *
 * Literal hex values (not var() references) because the chosen color is
 * persisted verbatim in the layout doc and must render identically for every
 * viewer/theme — same doctrine as PageTabs' PAGE_COLORS. That is exactly why
 * the DEEP row exists: a theme-blind palette of eight near-whites gave a
 * dark-mode author nothing but a white block on a #09090b page, and the one
 * dark swatch (#1a1a19) had no mid-tone company. Tiles derive their text color
 * from whichever fill is chosen (see TextTile's specStyle / ButtonVisual), so
 * both rows stay legible in both themes.
 *
 * Column n of DEEP is the counterpart of column n of LIGHT (neutral, warm
 * grey, blue, peach, green, amber, pink, violet). Every deep value sits below
 * the WCAG contrast switch point, so each carries white text.
 */
export const TILE_BACKGROUNDS_LIGHT = [
  '#ffffff',
  '#f1f1ee',
  '#dce9f9',
  '#fbe7dc',
  '#dcf2e9',
  '#fdf3d0',
  '#fbe3ee',
  '#e7e3f8',
];

export const TILE_BACKGROUNDS_DEEP = [
  '#1a1a19',
  '#3f3f46',
  '#1e3a5f',
  '#7c2d12',
  '#14532d',
  '#713f12',
  '#831843',
  '#4c1d95',
];

const TILE_BACKGROUND_ROWS = [TILE_BACKGROUNDS_LIGHT, TILE_BACKGROUNDS_DEEP];

export interface TileBackgroundSwatchesProps {
  value: string | null;
  onChange: (color: string | null) => void;
}

/**
 * Swatch rows + "None", used by the text/image/button tile config cards. The
 * light and deep rows render separately (gap-1 keeps eight swatches on one
 * line inside the w-56 config card) so hue counterparts line up in columns.
 */
export function TileBackgroundSwatches({ value, onChange }: TileBackgroundSwatchesProps) {
  return (
    <div className="flex flex-col gap-1.5 px-3 pb-1.5">
      {TILE_BACKGROUND_ROWS.map((row) => (
        <div key={row[0]} className="flex flex-wrap items-center gap-1">
          {row.map((color) => (
            <button
              key={color}
              type="button"
              role="menuitem"
              aria-label={`Set background ${color}`}
              title={color}
              onClick={() => onChange(color)}
              style={{ backgroundColor: color }}
              className={`h-5 w-5 shrink-0 rounded-full ${
                value === color
                  ? 'border-2 border-rcd-text'
                  : 'border border-rcd-border hover:border-rcd-text-2'
              }`}
            />
          ))}
        </div>
      ))}
      <div className="flex items-center">
        <button
          type="button"
          role="menuitem"
          onClick={() => onChange(null)}
          className={`rounded-md border px-1.5 py-0.5 text-[11px] ${
            value == null
              ? 'border-rcd-text text-rcd-text'
              : 'border-rcd-border text-rcd-text-2 hover:border-rcd-text-2 hover:text-rcd-text'
          }`}
        >
          None
        </button>
      </div>
    </div>
  );
}
