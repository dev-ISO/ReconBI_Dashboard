// Catalog column-type resolution for dashboard tiles.
//
// Charts learn a column's type from their query RESULT columns, which slicers
// never have — a slicer only knows table + column. The type still matters to
// them, because a date range's inclusive upper bound is rendered differently
// for `date` and `timestamp` columns (see `inclusiveDateUpperBound`), so this
// resolves it from the model's data-source catalog instead.
//
// The catalog is already fetched and cached once per data source by
// ModelStore (DashboardView calls `models.openModel`, which loads it); these
// helpers only READ that cache, never trigger a fetch of their own.
import { DATE_TABLE_COLUMNS, type Catalog, type ColumnType } from '@recon/dashboards-core';
import { columnTypeOf } from '../chart-builder/wellConfig';
import { useModelState } from '../provider/DashboardsProvider';

/** Engine date tables are synthesized by the query engine, never catalogued. */
const DATE_TABLE_PREFIX = '#date.';

/**
 * The catalog type of `table`.`column`, or null when it cannot be resolved
 * (catalog still loading or failed, table/column absent, unattached model).
 *
 * Null means UNKNOWN, never "not temporal" — every caller must degrade to the
 * conservative behaviour rather than assume a type.
 */
export const resolveColumnType = (
  catalog: Catalog | null,
  table: string,
  column: string,
): ColumnType | null =>
  table.startsWith(DATE_TABLE_PREFIX)
    ? (DATE_TABLE_COLUMNS.find((c) => c.name === column)?.type ?? null)
    : columnTypeOf(catalog, table, column);

/**
 * The loaded catalog, but ONLY when it is the one describing this model's
 * data source — ModelStore holds a single catalog slot, so a stale catalog
 * from a previously opened model must not be read as this model's schema.
 */
export function useModelCatalog(modelId: number | null): Catalog | null {
  // Selected slice-by-slice: returning a fresh object per snapshot would spin
  // useSyncExternalStore.
  const openModel = useModelState((state) => state.current);
  const catalog = useModelState((state) => state.catalog);
  const catalogStatus = useModelState((state) => state.catalogStatus);
  if (modelId === null || openModel === null || openModel.id !== modelId) return null;
  if (catalogStatus !== 'ok' || catalog === null) return null;
  return catalog.connection === openModel.dataSourceName ? catalog : null;
}

/**
 * Resolved column type plus whether the resolution has SETTLED — i.e. the
 * catalog finished loading (or failed, or is not coming at all). Callers that
 * emit a clause once, on mount, wait for `settled` so they do not bake an
 * unknown type into a filter that is never recomputed.
 */
export interface ColumnTypeResolution {
  type: ColumnType | null;
  settled: boolean;
}

export function useColumnType(
  modelId: number | null,
  table: string,
  column: string,
): ColumnTypeResolution {
  const catalogStatus = useModelState((state) => state.catalogStatus);
  const catalog = useModelCatalog(modelId);
  const type = resolveColumnType(catalog, table, column);
  const settled =
    modelId === null ||
    table.startsWith(DATE_TABLE_PREFIX) ||
    catalogStatus === 'ok' ||
    catalogStatus === 'error';
  return { type, settled };
}
