import { useCallback, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Eye, EyeOff } from 'lucide-react';
import { isChartTile, type DashboardTile, type PageMobileLayout } from '@recon/dashboards-core';
import { RcdIconButton, RcdInput } from '../primitives';
import { buttonLabelText } from './ButtonTile';

/** Container width (px) below which view mode renders the mobile stack. */
export const MOBILE_BREAKPOINT = 640;

/** Width of the edit-mode phone canvas column. */
const EDITOR_COLUMN_WIDTH = 380;

/**
 * Kind-based default stack height (px). Slicers and text size to content
 * (null = auto); charts get a readable fixed height, KPIs stay short, and
 * navigation buttons are a compact tap target.
 */
export const defaultMobileHeight = (tile: DashboardTile): number | null => {
  if (isChartTile(tile)) return tile.chart.type === 'kpi' ? 120 : 260;
  if (tile.kind === 'image') return 200;
  if (tile.kind === 'button') return 56;
  // A button GROUP had no default at all (auto), so a column of buttons
  // collapsed on a phone. Size it to what it holds: one row per button when
  // stacked, plus the header bar when the group shows its container.
  if (tile.kind === 'buttonGroup' && tile.buttonGroup) {
    const group = tile.buttonGroup;
    const rows = group.direction === 'column' ? Math.max(1, group.buttons.length) : 1;
    const framed = group.container != null && group.container.hideHeader !== true;
    return (framed ? 32 : 0) + 16 + rows * 36 + Math.max(0, rows - 1) * (group.gap ?? 8);
  }
  return null; // slicer / text: auto
};

/**
 * The page's tiles in mobile stack order: explicit order first (ids that
 * still exist), then any unlisted tiles in grid order (top-left → bottom-right
 * by y, then x). Hidden tiles are filtered by the callers that want that —
 * the editor still lists them (with the eye toggle off).
 */
export const mobileOrderedTiles = (
  tiles: DashboardTile[],
  layout: PageMobileLayout | null | undefined,
): DashboardTile[] => {
  const byId = new Map(tiles.map((tile) => [tile.id, tile]));
  const ordered: DashboardTile[] = [];
  for (const id of layout?.order ?? []) {
    const tile = byId.get(id);
    if (tile) {
      ordered.push(tile);
      byId.delete(id);
    }
  }
  const rest = [...byId.values()].sort(
    (a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x,
  );
  return [...ordered, ...rest];
};

export interface MobileStackProps {
  tiles: DashboardTile[];
  layout: PageMobileLayout | null | undefined;
  renderTile: (id: string) => ReactNode;
}

/**
 * View-mode phone rendering: the page's tiles as a single column in the
 * configured order, each at its height override (kind-based default
 * otherwise), hidden tiles skipped. No dragging — plain flow.
 */
export function MobileStack({ tiles, layout, renderTile }: MobileStackProps) {
  const hidden = new Set(layout?.hidden ?? []);
  const ordered = mobileOrderedTiles(tiles, layout).filter((tile) => !hidden.has(tile.id));
  return (
    <div className="flex flex-col gap-3 p-3">
      {ordered.map((tile) => {
        const height = layout?.heights?.[tile.id] ?? defaultMobileHeight(tile);
        return (
          <div key={tile.id} style={height !== null ? { height } : undefined}>
            {renderTile(tile.id)}
          </div>
        );
      })}
      {ordered.length === 0 && (
        <p className="p-6 text-center text-sm text-rcd-muted">
          Every tile on this page is hidden on phones.
        </p>
      )}
    </div>
  );
}

export interface MobileLayoutEditorProps {
  tiles: DashboardTile[];
  layout: PageMobileLayout | null | undefined;
  /** Commits the page's whole mobile layout (store: setPageMobileLayout). */
  onChange: (layout: PageMobileLayout) => void;
  renderTile: (id: string) => ReactNode;
}

/**
 * Edit-mode phone canvas: a centered ~380px column where tiles are reordered
 * with up/down buttons, vertically resized via a height input, and hidden or
 * shown with an eye toggle. Robust by construction — no drag engine, every
 * action is a plain button writing the full PageMobileLayout into the doc.
 */
export function MobileLayoutEditor({ tiles, layout, onChange, renderTile }: MobileLayoutEditorProps) {
  const ordered = mobileOrderedTiles(tiles, layout);
  const hidden = new Set(layout?.hidden ?? []);

  const commit = useCallback(
    (nextOrder: DashboardTile[], nextHidden: Set<string>, nextHeights: Record<string, number>) => {
      onChange({
        order: nextOrder.map((tile) => tile.id),
        ...(Object.keys(nextHeights).length > 0 ? { heights: nextHeights } : {}),
        ...(nextHidden.size > 0 ? { hidden: [...nextHidden] } : {}),
      });
    },
    [onChange],
  );

  const heights = layout?.heights ?? {};

  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= ordered.length) return;
    const next = [...ordered];
    const [tile] = next.splice(index, 1);
    if (!tile) return;
    next.splice(target, 0, tile);
    commit(next, hidden, heights);
  };

  const toggleHidden = (id: string) => {
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    commit(ordered, next, heights);
  };

  const setHeight = (tile: DashboardTile, raw: string) => {
    const next = { ...heights };
    const value = Math.trunc(Number(raw));
    const fallback = defaultMobileHeight(tile);
    if (!Number.isFinite(value) || value <= 0 || value === fallback) {
      delete next[tile.id];
    } else {
      next[tile.id] = Math.min(Math.max(value, 60), 1200);
    }
    commit(ordered, hidden, next);
  };

  const titleOf = (tile: DashboardTile): string => {
    if (isChartTile(tile)) return tile.chart.title;
    if (tile.kind === 'slicer' && tile.slicer) return tile.slicer.label;
    // Author-given text-tile name (0.11.1); generic label when unset.
    if (tile.kind === 'text') return tile.text?.title?.trim() || 'Text';
    if (tile.kind === 'image') return 'Image';
    // Plain-text of the rich button label; generic fallback for empty labels.
    if (tile.kind === 'button' && tile.button) return buttonLabelText(tile.button) || 'Button';
    // Author-given group name (0.14.1); generic label when unset.
    if (tile.kind === 'buttonGroup') return tile.buttonGroup?.title?.trim() || 'Button group';
    return tile.id;
  };

  return (
    <div className="flex justify-center p-3">
      <div className="flex w-full flex-col gap-3" style={{ maxWidth: EDITOR_COLUMN_WIDTH }}>
        <p className="text-center text-xs text-rcd-muted">
          Phone layout — reorder, resize, and hide tiles for viewports narrower
          than {MOBILE_BREAKPOINT}px. Saved with the dashboard.
        </p>
        {ordered.map((tile, index) => {
          const isHidden = hidden.has(tile.id);
          const height = heights[tile.id] ?? defaultMobileHeight(tile);
          return (
            <div
              key={tile.id}
              className={`flex flex-col overflow-hidden rounded-lg border ${
                isHidden ? 'border-dashed border-rcd-border opacity-60' : 'border-rcd-border'
              }`}
            >
              <div className="flex items-center gap-1 border-b border-rcd-border bg-rcd-surface px-2 py-1">
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-rcd-text" title={titleOf(tile)}>
                  {titleOf(tile)}
                </span>
                <RcdInput
                  type="number"
                  min={60}
                  max={1200}
                  step={20}
                  value={height ?? ''}
                  placeholder="auto"
                  aria-label={`Height of ${titleOf(tile)} on phones (px)`}
                  title="Tile height on phones (px)"
                  onChange={(event) => setHeight(tile, event.target.value)}
                  className="h-6 w-16 !px-1.5 !py-0 text-xs"
                />
                <RcdIconButton
                  aria-label={`Move ${titleOf(tile)} up`}
                  title="Move up"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                  className="!p-1"
                >
                  <ArrowUp size={13} />
                </RcdIconButton>
                <RcdIconButton
                  aria-label={`Move ${titleOf(tile)} down`}
                  title="Move down"
                  disabled={index === ordered.length - 1}
                  onClick={() => move(index, 1)}
                  className="!p-1"
                >
                  <ArrowDown size={13} />
                </RcdIconButton>
                <RcdIconButton
                  aria-label={isHidden ? `Show ${titleOf(tile)} on phones` : `Hide ${titleOf(tile)} on phones`}
                  title={isHidden ? 'Hidden on phones — click to show' : 'Shown on phones — click to hide'}
                  aria-pressed={isHidden}
                  onClick={() => toggleHidden(tile.id)}
                  className="!p-1"
                >
                  {isHidden ? <EyeOff size={13} /> : <Eye size={13} />}
                </RcdIconButton>
              </div>
              {!isHidden && (
                <div style={height !== null ? { height } : undefined}>{renderTile(tile.id)}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
