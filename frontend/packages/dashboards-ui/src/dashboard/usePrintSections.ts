// Shared source for WHAT a print job contains: the included dashboard pages
// (current / all / custom pick), their per-section header titles + filter
// summaries, and the per-tile filter clauses. PrintConfigDialog (live
// thumbnail) and DashboardPrintView (actual print) both consume this hook, so
// the preview and the printed job can never disagree about content — the same
// doctrine computePrintLayout enforces for geometry.
import { useMemo } from 'react';
import { isChartTile, type DashboardPage, type FilterClause } from '@recon/dashboards-core';
import { useDashboardState, useRuntime } from '../provider/DashboardsProvider';
import { filterSummaryFor, type PrintSectionInput } from './printLayout';
import type { PrintOptions } from './PrintConfigDialog';

export interface PrintSectionsData {
  /** Sections in dashboard tab order — never empty (synthetic when no doc). */
  sections: PrintSectionInput[];
  /** Per-chart-tile filters across EVERY included page (same store call the
   *  on-screen tiles use; filtersForTile resolves tiles on any page). */
  filtersByTile: Map<string, FilterClause[]>;
  modelId: number | null;
  /** All page tabs (id/name, tab order) for the config dialog's checklist. */
  pageTabs: { id: string; name: string }[];
  activePageId: string | null;
}

/**
 * Builds the print-job sections for the given options. Section titles mirror
 * the pre-workbook behavior exactly: multi-page dashboards title each section
 * "Dashboard — Page", single-page dashboards use the bare dashboard name — so
 * the default current-page job renders the identical header it always has.
 *
 * Print is always the DESKTOP layout: per-page mobileLayout is deliberately
 * ignored (paper has no narrow-container mode).
 */
export function usePrintSections(
  options: Pick<PrintOptions, 'pagesMode' | 'customPageIds'>,
): PrintSectionsData {
  const runtime = useRuntime();
  const current = useDashboardState((state) => state.current);
  const activePageId = useDashboardState((state) => state.activePageId);
  const slicerValues = useDashboardState((state) => state.slicerValues);
  const crossFilters = useDashboardState((state) => state.crossFilters);
  // Subscribed purely as recompute triggers for filtersForTile (same doctrine
  // as DashboardView's filtersByTile memo — the store call reads this state).
  const drillthrough = useDashboardState((state) => state.drillthrough);
  const filterCardOverrides = useDashboardState((state) => state.filterCardOverrides);

  const pages = useMemo(() => current?.layout.pages ?? [], [current]);
  const activePage = pages.find((page) => page.id === activePageId) ?? pages[0] ?? null;
  const { pagesMode, customPageIds } = options;

  // Which dashboard pages the job includes, in TAB ORDER. Custom picks are
  // intersected with the real tabs (session-remembered ids can belong to a
  // previously printed dashboard); an empty intersection falls back to the
  // current page so the job is never silently empty.
  const included: DashboardPage[] = useMemo(() => {
    if (pagesMode === 'all' && pages.length > 0) return pages;
    if (pagesMode === 'custom') {
      const chosen = pages.filter((page) => customPageIds.includes(page.id));
      if (chosen.length > 0) return chosen;
    }
    return activePage ? [activePage] : [];
  }, [pagesMode, customPageIds, pages, activePage]);

  const sections = useMemo<PrintSectionInput[]>(() => {
    const name = current?.name ?? 'Dashboard';
    if (included.length === 0) {
      return [{ pageId: '', title: name, tiles: [], filterSummary: [] }];
    }
    const multiPage = pages.length > 1;
    return included.map((page) => ({
      pageId: page.id,
      title: multiPage ? `${name} — ${page.name}` : name,
      tiles: page.tiles,
      filterSummary: filterSummaryFor(page.tiles, slicerValues, crossFilters),
    }));
  }, [current, included, pages.length, slicerValues, crossFilters]);

  const filtersByTile = useMemo(() => {
    const map = new Map<string, FilterClause[]>();
    for (const section of sections) {
      for (const tile of section.tiles) {
        // Only chart tiles consume filters (text/image/slicer tiles ignore them).
        if (!isChartTile(tile)) continue;
        map.set(tile.id, runtime.dashboards.filtersForTile(tile.id));
      }
    }
    return map;
  }, [runtime, sections, slicerValues, crossFilters, drillthrough, filterCardOverrides]);

  const pageTabs = useMemo(
    () => pages.map((page) => ({ id: page.id, name: page.name })),
    [pages],
  );

  return {
    sections,
    filtersByTile,
    modelId: current?.modelId ?? null,
    pageTabs,
    activePageId: activePage?.id ?? null,
  };
}
