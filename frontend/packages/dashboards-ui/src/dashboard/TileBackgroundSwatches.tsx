/**
 * Fixed background palette for text/image tiles: soft tints + neutral white and
 * a dark-surface swatch. Literal hex values (not var() references) because the
 * chosen color is persisted verbatim in the layout doc and must render
 * identically for every viewer/theme — same doctrine as PageTabs' PAGE_COLORS.
 */
const TILE_BACKGROUNDS = [
  '#ffffff',
  '#f1f1ee',
  '#dce9f9',
  '#fbe7dc',
  '#dcf2e9',
  '#fdf3d0',
  '#fbe3ee',
  '#e7e3f8',
  '#1a1a19',
];

export interface TileBackgroundSwatchesProps {
  value: string | null;
  onChange: (color: string | null) => void;
}

/** Swatch row + "None" used by the text/image tile config cards. */
export function TileBackgroundSwatches({ value, onChange }: TileBackgroundSwatchesProps) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-3 pb-1.5">
      {TILE_BACKGROUNDS.map((color) => (
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
  );
}
