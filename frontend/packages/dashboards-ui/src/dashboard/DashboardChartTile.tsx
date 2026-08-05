import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronsDown } from 'lucide-react';
import {
  stableStringify,
  type ChartPointEvent,
  type ChartSpec,
  type DimensionRef,
  type FilterClause,
  type FilterValue,
} from '@recon/dashboards-core';
import { ChartTile, type ChartLegendSelectEvent } from '../chart/ChartTile';
import type { ChartDatumClickInfo } from '../chart/ChartRenderer';
import { RcdIconButton } from '../primitives';
import { TileFrame } from './TileFrame';

/**
 * One traversed drill step. A concrete entry filters the deeper level to the
 * clicked value (null value = the blank category -> isNull clause); a null
 * SLOT means the level was entered via "go to next level" (axis swaps, no
 * filter) — the DrillState contract's path entries, extended with that
 * filterless case. Transient component state, NEVER persisted.
 */
type DrillPathSlot = { value: FilterValue | null; label: string } | null;

interface TileDrill {
  level: number;
  path: DrillPathSlot[];
}

const DRILL_ROOT: TileDrill = { level: 0, path: [] };

export interface DashboardChartTileProps {
  tileId: string;
  /** BASE chart spec from the layout doc (drill derivation happens here). */
  chart: ChartSpec;
  modelId: number | null;
  editable: boolean;
  selected: boolean;
  /**
   * Refresh token from the dashboard/tile refresh counters. Passed to
   * ChartTile as a PROP (not a React key): the tile stays mounted and keeps
   * its previous chart visible (dimmed, updating bar) while the refetch runs.
   */
  refreshKey: string;
  /** Dashboard-level filters (slicers + cards + cross-filter + drillthrough). */
  filters: FilterClause[];
  /** Category label while this tile is the AXIS cross-filter source (dims others). */
  activeCategoryLabel: string | null;
  /** Legend label while this tile is the LEGEND cross-filter source (emphasis). */
  selectedLegendLabel: string | null;
  onSelect: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  /** Edit-mode right-click on the tile (opens the chart context card). */
  onTileContextMenu?: (position: { x: number; y: number }) => void;
  /** Cross-filter datum click, called with the EFFECTIVE (drilled) chart. */
  onCrossFilter: (chart: ChartSpec, info: ChartDatumClickInfo) => void;
  /**
   * Legend cross-filter selection (legendMode 'crossFilter'), called with the
   * EFFECTIVE (drilled) chart; null event = clear the page-wide filter.
   */
  onLegendSelect: (chart: ChartSpec, e: ChartLegendSelectEvent | null) => void;
  /** Point right-click (view mode): the EFFECTIVE chart + point payload. */
  onPointMenu?: (payload: { tileId: string; chart: ChartSpec; event: ChartPointEvent }) => void;
  /**
   * Ref-style report of what this tile is CURRENTLY showing (effective spec +
   * filters) — the export menus build the exact wire spec from it.
   */
  reportEffective: (tileId: string, effective: { chart: ChartSpec; filters: FilterClause[] }) => void;
}

/**
 * Chart tile with the drill-down runtime: keeps transient per-tile DrillState,
 * derives the effective query (axis swap + traversed-path eq filters) before
 * the wire spec is built, and renders the subtle Power BI-style drill controls
 * in the tile header (or the frameless hover strip). Fresh derived spec
 * objects per render are fine — ChartTile keys its fetch effect on the cache
 * key STRING, never on object identity.
 */
export function DashboardChartTile({
  tileId,
  chart,
  modelId,
  editable,
  selected,
  refreshKey,
  filters,
  activeCategoryLabel,
  selectedLegendLabel,
  onSelect,
  onEdit,
  onDuplicate,
  onDelete,
  onTileContextMenu,
  onCrossFilter,
  onLegendSelect,
  onPointMenu,
  reportEffective,
}: DashboardChartTileProps) {
  const [drill, setDrill] = useState<TileDrill>(DRILL_ROOT);
  const [drillMode, setDrillMode] = useState(false);

  // Transient drill position resets whenever the chart's query changes (spec
  // edits redefine the hierarchy); keyed on content, not object identity.
  const queryKey = useMemo(() => stableStringify(chart.query), [chart.query]);
  useEffect(() => {
    setDrill(DRILL_ROOT);
    setDrillMode(false);
  }, [queryKey]);

  const drillLevels = chart.query.drillLevels ?? [];
  const hasHierarchy = drillLevels.length > 0 && chart.query.axis != null;
  const maxLevel = hasHierarchy ? drillLevels.length : 0;
  // Defensive clamp: a mid-edit spec swap can briefly outpace the reset effect.
  const level = Math.min(drill.level, maxLevel);

  /** Dimension shown as the axis at a drill level (0 = the chart's own axis). */
  const dimensionAt = (lvl: number): DimensionRef =>
    lvl === 0 ? chart.query.axis! : drillLevels[lvl - 1]!;

  // Effective query: level 0 is the base spec untouched; deeper levels swap
  // the axis to the level's dimension and append one eq/isNull clause per
  // FILTERED traversed step ("go to next level" slots contribute none).
  const effectiveChart = useMemo<ChartSpec>(() => {
    if (!hasHierarchy || level === 0) return chart;
    const pathFilters: FilterClause[] = [];
    drill.path.slice(0, level).forEach((slot, i) => {
      if (slot === null) return;
      const dim = dimensionAt(i);
      pathFilters.push(
        slot.value === null
          ? { table: dim.table, column: dim.column, operator: 'isNull', values: [] }
          : { table: dim.table, column: dim.column, operator: 'eq', values: [slot.value] },
      );
    });
    return {
      ...chart,
      query: {
        ...chart.query,
        axis: drillLevels[level - 1],
        filters: [...chart.query.filters, ...pathFilters],
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dimensionAt/drillLevels derive from chart
  }, [chart, hasHierarchy, level, drill.path]);

  // Ref-style report (assignment only, mirrors ChartTile's wireSpecRef): the
  // export menus read the freshest effective spec without extra renders.
  reportEffective(tileId, { chart: effectiveChart, filters });

  const canDrillDeeper = hasHierarchy && level < maxLevel;

  const drillDown = (e: ChartPointEvent) => {
    setDrill((prev) => {
      const lvl = Math.min(prev.level, maxLevel);
      if (lvl >= maxLevel) return prev;
      return {
        level: lvl + 1,
        path: [
          ...prev.path.slice(0, lvl),
          { value: e.axisValue as FilterValue | null, label: e.axisLabel },
        ],
      };
    });
  };

  const drillUp = () => {
    setDrill((prev) => {
      const lvl = Math.min(prev.level, maxLevel);
      return lvl === 0 ? prev : { level: lvl - 1, path: prev.path.slice(0, lvl - 1) };
    });
  };

  /** "Go to next level": axis swaps, no path filter (a filterless slot). */
  const nextLevel = () => {
    setDrill((prev) => {
      const lvl = Math.min(prev.level, maxLevel);
      if (lvl >= maxLevel) return prev;
      return { level: lvl + 1, path: [...prev.path.slice(0, lvl), null] };
    });
  };

  const popToLevel = (target: number) => {
    setDrill((prev) => {
      const lvl = Math.min(prev.level, maxLevel);
      if (target >= lvl || target < 0) return prev;
      return { level: target, path: prev.path.slice(0, target) };
    });
  };

  // Breadcrumb: one crumb per traversed level; filtered steps show the clicked
  // label, filterless steps show the level's dimension column. Clicking a
  // crumb pops back to that level (the last crumb is the current position).
  const crumbs = hasHierarchy
    ? Array.from({ length: level }, (_, i) => ({
        level: i + 1,
        label: drill.path[i]?.label ?? dimensionAt(i + 1).column,
      }))
    : [];

  const drillControls = hasHierarchy ? (
    <div className="flex min-w-0 shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
      {crumbs.length > 0 && (
        <span className="flex max-w-[12rem] items-center gap-0.5 truncate text-[11px] leading-none text-rcd-muted">
          {crumbs.map((crumb, i) => (
            <span key={crumb.level} className="flex min-w-0 items-center gap-0.5">
              {i > 0 && <span aria-hidden className="opacity-70">▸</span>}
              {crumb.level === level ? (
                <span className="truncate font-medium text-rcd-text-2" title={crumb.label}>
                  {crumb.label}
                </span>
              ) : (
                <button
                  type="button"
                  title={`Back to ${crumb.label}`}
                  onClick={() => popToLevel(crumb.level)}
                  className="truncate rounded px-0.5 py-0.5 transition-colors hover:bg-black/5 hover:text-rcd-text dark:hover:bg-white/10"
                >
                  {crumb.label}
                </button>
              )}
            </span>
          ))}
        </span>
      )}
      <span className="flex items-center gap-0.5">
        <RcdIconButton
          aria-label="Drill up"
          title="Drill up"
          disabled={level === 0}
          onClick={drillUp}
          className="!p-1"
        >
          <ArrowUp size={13} />
        </RcdIconButton>
        <RcdIconButton
          aria-label="Go to the next level in the hierarchy"
          title="Go to the next level in the hierarchy"
          disabled={!canDrillDeeper}
          onClick={nextLevel}
          className="!p-1"
        >
          <ChevronsDown size={13} />
        </RcdIconButton>
        <RcdIconButton
          aria-label={drillMode ? 'Drill mode on (clicks drill down)' : 'Drill mode off (clicks cross-filter)'}
          title={drillMode ? 'Drill mode on: clicks drill down' : 'Turn on drill mode'}
          aria-pressed={drillMode}
          onClick={() => setDrillMode((on) => !on)}
          className={`!p-1 ${drillMode ? 'bg-black/5 text-rcd-accent dark:bg-white/10' : ''}`}
        >
          <ArrowDown size={13} />
        </RcdIconButton>
      </span>
    </div>
  ) : null;

  return (
    <div
      className={`h-full rounded-lg ${editable && selected ? 'ring-2 ring-rcd-accent' : ''}`}
      onClick={editable ? onSelect : undefined}
    >
      <TileFrame
        title={chart.title}
        editable={editable}
        container={chart.format.container ?? null}
        headerExtra={drillControls}
        onEdit={onEdit}
        onDuplicate={onDuplicate}
        onDelete={onDelete}
        onContextMenu={
          onTileContextMenu
            ? (event) => {
                event.preventDefault();
                event.stopPropagation();
                onTileContextMenu({ x: event.clientX, y: event.clientY });
              }
            : undefined
        }
      >
        {modelId === null ? (
          <div className="flex h-full items-center justify-center p-4 text-center text-sm text-rcd-muted">
            No model attached to this dashboard.
          </div>
        ) : (
          <ChartTile
            refreshKey={refreshKey}
            spec={effectiveChart}
            modelId={modelId}
            filters={filters}
            // Drill mode owns clicks exclusively: on, clicks drill (never
            // cross-filter); off, clicks cross-filter exactly as before.
            onDatumClick={
              drillMode ? undefined : (info) => onCrossFilter(effectiveChart, info)
            }
            onPointClick={drillMode && canDrillDeeper ? drillDown : undefined}
            onPointContextMenu={
              onPointMenu
                ? (event) => onPointMenu({ tileId, chart: effectiveChart, event })
                : undefined
            }
            // Legend clicks are never drill clicks — they cross-filter (or
            // clear) regardless of drill mode.
            onLegendSelect={(e) => onLegendSelect(effectiveChart, e)}
            selectedLegendLabel={selectedLegendLabel}
            activeCategory={activeCategoryLabel !== null ? { label: activeCategoryLabel } : null}
          />
        )}
      </TileFrame>
    </div>
  );
}
