/**
 * Stable per-relationship colors for the model canvas: each relationship's
 * line and its endpoint column markers share one hue so links are visually
 * traceable across the diagram.
 *
 * The palette is fixed (not the --rcd chart tokens — those carry chart-series
 * semantics) and curated so every hue reads on both the light and dark
 * surfaces: mid-value, saturated colors around the wheel with no near
 * neighbours. Assignment hashes the relationship id, so a relationship keeps
 * its color across rerenders, reloads and sessions (ids persist in the saved
 * definition) while the overall distribution looks random.
 */
export const RELATIONSHIP_COLORS: readonly string[] = [
  '#2563eb', // blue
  '#ea580c', // orange
  '#059669', // emerald
  '#7c3aed', // violet
  '#db2777', // pink
  '#0d9488', // teal
  '#d97706', // amber
  '#4f46e5', // indigo
  '#65a30d', // olive
  '#0891b2', // cyan
  '#c026d3', // fuchsia
  '#dc2626', // red
];

/** FNV-1a 32-bit over the id, folded into the palette. Deterministic + well dispersed. */
export const relationshipColor = (relationshipId: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < relationshipId.length; i++) {
    hash ^= relationshipId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return RELATIONSHIP_COLORS[(hash >>> 0) % RELATIONSHIP_COLORS.length]!;
};
