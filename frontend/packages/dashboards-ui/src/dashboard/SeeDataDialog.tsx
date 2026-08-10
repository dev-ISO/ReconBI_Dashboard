import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
} from 'react';
import { AlertTriangle, FileDown, FileSpreadsheet, RefreshCw } from 'lucide-react';
import {
  downloadXlsx,
  RcdApiError,
  toWireSpec,
  type CellValue,
  type ChartQuerySpec,
  type ChartSpec,
  type FilterClause,
  type QueryColumn,
  type QueryResult,
  type UnderlyingQueryResult,
} from '@recon/dashboards-core';
import { useRuntime } from '../provider/DashboardsProvider';
import { RcdButton, RcdDialog, RcdSpinner } from '../primitives';
// Type-only imports (same doctrine as ChartTile): the lazy chunk split survives.
import type { ChartRendererProps, TableColumnFilter, TableSortState } from '../chart/ChartRenderer';
import type { ChartHavingClause } from '../chart/ChartTile';

const ChartRenderer = lazy(() => import('../chart/ChartRenderer')) as ComponentType<ChartRendererProps>;

/** What the "See data" dialog shows — set by the chart/point context menus. */
export type SeeDataRequest =
  | {
      /** The tile's CURRENT aggregated result rendered as a real table. */
      kind: 'aggregated';
      tileId: string;
      /** EFFECTIVE chart spec (param-substituted + drilled). */
      chart: ChartSpec;
      /** The tile's merged dashboard + table-column filters. */
      filters: FilterClause[];
      /** Table measure-column filters (wire HAVING); null = none. */
      having: ChartHavingClause[] | null;
    }
  | {
      /** UNDERLYING source rows behind one clicked point. */
      kind: 'underlying';
      tileId: string;
      /** Chart title (dialog header). */
      title: string;
      /** Formatted point label, e.g. "Gulf Coast". */
      contextLabel: string;
      /** Prebuilt wire spec: the tile's effective filters + point eq clauses. */
      spec: ChartQuerySpec;
    };

type FetchState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'aggregated'; result: QueryResult }
  | { status: 'underlying'; result: UnderlyingQueryResult };

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Filesystem-safe download name (mirrors DashboardView's csvFileName). */
const csvFileName = (title: string): string => {
  const cleaned = title.replace(/[\\/:*?"<>|]/g, '_').trim();
  return cleaned === '' ? 'chart' : cleaned;
};

/* ------------------------------------------------ client-side filter/sort */

/** Stable identity for a distinct cell value (mirrors TableChart.valueKey). */
const valueKeyOf = (value: CellValue): string =>
  value === null ? ' null' : `${typeof value}:${String(value)}`;

/**
 * Compiles one committed header-menu filter into a row predicate over the
 * LOADED rows (these dialogs hold the whole fetched result, so filters run
 * client-side — no requery). Value lists match by raw-value identity and
 * honor the `inverted` (excluded-values) form; conditions compare
 * numerically when both sides parse as numbers, textually otherwise.
 */
const buildMatcher = (
  filter: TableColumnFilter,
  columns: QueryColumn[],
): ((row: CellValue[]) => boolean) | null => {
  const index = columns.findIndex((c) => c.name === filter.column);
  if (index === -1) return null;
  if (filter.kind === 'values') {
    const keys = new Set(filter.values.map(valueKeyOf));
    const inverted = (filter as { inverted?: boolean }).inverted === true;
    return (row) => keys.has(valueKeyOf(row[index] ?? null)) !== inverted;
  }
  const [a, b] = filter.values;
  if (a === undefined) return null;
  const text = (v: CellValue): string => (v === null ? '' : String(v)).toLowerCase();
  switch (filter.operator) {
    case 'contains':
      return (row) => text(row[index] ?? null).includes(String(a).toLowerCase());
    case 'startsWith':
      return (row) => text(row[index] ?? null).startsWith(String(a).toLowerCase());
    default:
      break;
  }
  const compare = (v: CellValue): number | null => {
    if (v === null) return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isNaN(n) ? null : n;
  };
  const na = Number(a);
  const numeric = !Number.isNaN(na);
  return (row) => {
    const raw = row[index] ?? null;
    if (filter.operator === 'eq' || filter.operator === 'neq') {
      const equal = numeric
        ? compare(raw) !== null && compare(raw) === na
        : text(raw) === String(a).toLowerCase();
      return filter.operator === 'eq' ? equal : !equal;
    }
    const n = compare(raw);
    if (n === null || !numeric) return false;
    switch (filter.operator) {
      case 'gt':
        return n > na;
      case 'gte':
        return n >= na;
      case 'lt':
        return n < na;
      case 'lte':
        return n <= na;
      case 'between': {
        const nb = Number(b);
        return !Number.isNaN(nb) && n >= na && n <= nb;
      }
      default:
        return true;
    }
  };
};

/** Ascending value order: numbers numerically, text by locale, blanks last. */
const compareCells = (a: CellValue, b: CellValue): number => {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
};

/** Everything centered — the dialog's requested default for headers AND cells. */
const centeredTable = (columns: QueryColumn[]) => ({
  borders: 'rows' as const,
  density: 'compact' as const,
  stripes: true,
  filterable: true,
  sortable: true,
  headerAlign: 'center' as const,
  verticalAlign: 'middle' as const,
  columnAlign: Object.fromEntries(columns.map((c) => [c.name, 'center' as const])),
});

export interface SeeDataDialogProps {
  request: SeeDataRequest | null;
  modelId: number | null;
  onClose: () => void;
  /** Summarized CSV through the tile's standard export path. */
  onExportSummarized: (tileId: string) => void;
  /** Transient toolbar notice (API missing / export failures). */
  onNotice: (message: string) => void;
}

/**
 * "See data" dialog (view mode): either the tile's current AGGREGATED result
 * or the UNDERLYING source rows behind one clicked point — both rendered
 * through the real table renderer (formatting and the Excel-style header
 * menus come free). Header + cells default to center/middle here (explicit
 * user request for these dialogs). Filters and sorting run CLIENT-SIDE over
 * the loaded rows and reset when the dialog closes. Same draggable/resizable
 * dialog pattern as the chart builder.
 */
export function SeeDataDialog({
  request,
  modelId,
  onClose,
  onExportSummarized,
  onNotice,
}: SeeDataDialogProps) {
  const runtime = useRuntime();
  const [fetchState, setFetchState] = useState<FetchState>({ status: 'loading' });
  const [retryToken, setRetryToken] = useState(0);
  /** Dialog-scoped Excel-style column filters + sort (client-side, transient). */
  const [clientFilters, setClientFilters] = useState<TableColumnFilter[]>([]);
  const [clientSort, setClientSort] = useState<TableSortState | null>(null);

  // A new request (each open mints a fresh object) starts with a clean view.
  useEffect(() => {
    setClientFilters([]);
    setClientSort(null);
  }, [request]);

  useEffect(() => {
    if (!request) return;
    let cancelled = false;
    setFetchState({ status: 'loading' });
    const load = async () => {
      try {
        if (request.kind === 'aggregated') {
          if (modelId === null) throw new Error('No model attached to this dashboard.');
          const base = toWireSpec(request.chart, modelId, request.filters);
          const spec =
            request.having !== null && request.having.length > 0
              ? { ...base, having: request.having }
              : base;
          // Shared query cache: usually an instant hit on the tile's own key.
          const result = await runtime.queries.run(spec);
          if (!cancelled) setFetchState({ status: 'aggregated', result });
        } else {
          const result = await runtime.api.queryUnderlying({ spec: request.spec, maxRows: 1000 });
          if (!cancelled) setFetchState({ status: 'underlying', result });
        }
      } catch (error) {
        if (cancelled) return;
        if (error instanceof RcdApiError && error.status === 404) {
          // Endpoint not deployed yet — surface the standard notice chip.
          onNotice('This needs the updated API (POST /query/underlying) — restart the API service.');
          setFetchState({
            status: 'error',
            message: 'The running API build does not expose underlying rows yet. Restart the API service and try again.',
          });
          return;
        }
        setFetchState({ status: 'error', message: messageOf(error) });
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [runtime, request, modelId, retryToken, onNotice]);

  /** The loaded result as a renderer-ready QueryResult (underlying included). */
  const baseResult = useMemo<QueryResult | null>(() => {
    if (fetchState.status === 'aggregated') return fetchState.result;
    if (fetchState.status === 'underlying') {
      const { columns, rows, meta } = fetchState.result;
      return { columns, rows, meta: { ...meta, elapsedMs: 0, warnings: [], sql: null } };
    }
    return null;
  }, [fetchState]);

  /** Loaded rows with the dialog's client-side filters + sort applied. */
  const displayResult = useMemo<QueryResult | null>(() => {
    if (!baseResult) return null;
    let rows = baseResult.rows;
    if (clientFilters.length > 0) {
      const matchers = clientFilters
        .map((filter) => buildMatcher(filter, baseResult.columns))
        .filter((m): m is (row: CellValue[]) => boolean => m !== null);
      if (matchers.length > 0) rows = rows.filter((row) => matchers.every((m) => m(row)));
    }
    if (clientSort !== null) {
      const index = baseResult.columns.findIndex((c) => c.name === clientSort.column);
      if (index !== -1) {
        const sign = clientSort.direction === 'desc' ? -1 : 1;
        rows = [...rows].sort(
          (ra, rb) => sign * compareCells(ra[index] ?? null, rb[index] ?? null),
        );
      }
    }
    return rows === baseResult.rows ? baseResult : { ...baseResult, rows };
  }, [baseResult, clientFilters, clientSort]);

  /**
   * Distinct values for a column's checklist, computed from the loaded rows
   * under the OTHER columns' filters (Excel semantics), blanks last, capped
   * at the renderer's 200-value note threshold.
   */
  const handleRequestColumnValues = useCallback(
    async (column: string): Promise<CellValue[]> => {
      if (!baseResult) return [];
      const index = baseResult.columns.findIndex((c) => c.name === column);
      if (index === -1) return [];
      const matchers = clientFilters
        .filter((f) => f.column !== column)
        .map((filter) => buildMatcher(filter, baseResult.columns))
        .filter((m): m is (row: CellValue[]) => boolean => m !== null);
      const seen = new Map<string, CellValue>();
      for (const row of baseResult.rows) {
        if (!matchers.every((m) => m(row))) continue;
        const value = row[index] ?? null;
        const key = valueKeyOf(value);
        if (!seen.has(key)) seen.set(key, value);
      }
      return [...seen.values()].sort(compareCells).slice(0, 200);
    },
    [baseResult, clientFilters],
  );

  /**
   * Synthetic table spec over the SAME query: the real table renderer shows
   * the rows with the chart's value/date formatting riding along. Center/
   * middle everywhere is the dialog default the user asked for (the usual
   * numeric-right rule deliberately does not apply here).
   */
  const tableSpec = useMemo<ChartSpec | null>(() => {
    if (!request || !baseResult) return null;
    if (request.kind === 'aggregated') {
      const { chart } = request;
      return {
        id: `${chart.id}::see-data`,
        type: 'table',
        title: chart.title,
        query: chart.query,
        format: {
          theme: chart.format.theme,
          valueFormat: chart.format.valueFormat,
          dateFormat: chart.format.dateFormat,
          dateFormatPattern: chart.format.dateFormatPattern,
          seriesLabels: chart.format.seriesLabels,
          table: centeredTable(baseResult.columns),
        },
      };
    }
    return {
      id: `${request.tileId}::see-records`,
      type: 'table',
      title: request.title,
      query: { measures: [], filters: [] },
      format: { table: centeredTable(baseResult.columns) },
    };
  }, [request, baseResult]);

  if (!request) return null;

  const totalCount = baseResult?.rows.length ?? null;
  const shownCount = displayResult?.rows.length ?? null;
  const filtered = totalCount !== null && shownCount !== null && shownCount < totalCount;

  const baseTitle =
    request.kind === 'aggregated'
      ? request.chart.title
      : `${request.title} — ${request.contextLabel}`;
  const dialogTitle =
    totalCount === null
      ? baseTitle
      : `${baseTitle} · ${filtered ? `${shownCount} of ${totalCount}` : totalCount} rows`;

  const truncated =
    (fetchState.status === 'underlying' && fetchState.result.meta.truncated) ||
    (fetchState.status === 'aggregated' && fetchState.result.meta.truncated);

  const exportUnderlying = async () => {
    if (request.kind !== 'underlying') return;
    try {
      const { blob, truncated: capped } = await runtime.api.exportQueryCsv({
        spec: request.spec,
        mode: 'underlying',
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${csvFileName(baseTitle)}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
      if (capped) onNotice('Export truncated: the server capped the row count.');
    } catch (error) {
      onNotice(`Export failed: ${messageOf(error)}`);
    }
  };

  /** XLSX of exactly what the dialog shows (client filters + sort applied). */
  const exportXlsx = () => {
    if (!displayResult) return;
    const seriesLabels =
      request.kind === 'aggregated' ? request.chart.format.seriesLabels : undefined;
    try {
      downloadXlsx(csvFileName(baseTitle), {
        sheetName: request.kind === 'aggregated' ? 'Data' : 'Records',
        columns: displayResult.columns.map((column) => ({
          name:
            column.role === 'measure'
              ? (seriesLabels?.[column.label] ?? column.label)
              : column.label,
        })),
        rows: displayResult.rows,
      });
    } catch (error) {
      onNotice(`Export failed: ${messageOf(error)}`);
    }
  };

  return (
    <RcdDialog
      title={dialogTitle}
      open
      onClose={onClose}
      wide
      draggable
      resizable
      footer={
        <>
          {truncated && (
            <span className="mr-auto self-center text-xs text-rcd-muted">
              Showing the first {totalCount} rows (server cap) — export for the full set.
            </span>
          )}
          <RcdButton
            disabled={fetchState.status === 'loading'}
            onClick={() =>
              request.kind === 'aggregated'
                ? onExportSummarized(request.tileId)
                : void exportUnderlying()
            }
          >
            <FileDown size={14} />
            Export CSV
          </RcdButton>
          <RcdButton disabled={displayResult === null} onClick={exportXlsx}>
            <FileSpreadsheet size={14} />
            Export XLSX
          </RcdButton>
          <RcdButton variant="primary" onClick={onClose}>
            Close
          </RcdButton>
        </>
      }
    >
      <div className="h-[26rem] min-h-full">
        {fetchState.status === 'loading' && (
          <div className="flex h-full items-center justify-center">
            <RcdSpinner label="Loading data…" />
          </div>
        )}

        {fetchState.status === 'error' && (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <AlertTriangle size={22} className="text-[var(--rcd-status-warn)]" />
            <p className="max-w-md break-words text-sm text-rcd-text-2">{fetchState.message}</p>
            <RcdButton onClick={() => setRetryToken((token) => token + 1)}>
              <RefreshCw size={14} />
              Retry
            </RcdButton>
          </div>
        )}

        {displayResult && tableSpec && (
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center">
                <RcdSpinner label="Loading table…" />
              </div>
            }
          >
            {baseResult && baseResult.rows.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-rcd-muted">
                {request.kind === 'underlying'
                  ? 'No underlying records match this point.'
                  : 'No rows.'}
              </div>
            ) : (
              <ChartRenderer
                spec={tableSpec}
                result={displayResult}
                tableSort={clientSort}
                onTableSortChange={setClientSort}
                tableFilters={clientFilters}
                onTableFilterChange={setClientFilters}
                onRequestColumnValues={handleRequestColumnValues}
              />
            )}
          </Suspense>
        )}
      </div>
    </RcdDialog>
  );
}
