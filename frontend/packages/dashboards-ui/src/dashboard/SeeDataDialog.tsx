import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
} from 'react';
import { AlertTriangle, FileDown, RefreshCw } from 'lucide-react';
import {
  formatCellValue,
  RcdApiError,
  toWireSpec,
  type ChartQuerySpec,
  type ChartSpec,
  type FilterClause,
  type QueryResult,
  type UnderlyingQueryResult,
} from '@recon/dashboards-core';
import { useRuntime } from '../provider/DashboardsProvider';
import { RcdButton, RcdDialog, RcdSpinner } from '../primitives';
// Type-only import (same doctrine as ChartTile): the lazy chunk split survives.
import type { ChartRendererProps } from '../chart/ChartRenderer';
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

const NUMERIC_TYPES = new Set(['integer', 'decimal']);

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
 * rendered through the real table renderer (formatting comes free), or the
 * UNDERLYING source rows behind one clicked point (plain grid of raw columns).
 * Same draggable/resizable dialog pattern as the chart builder.
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

  /**
   * Synthetic table spec over the SAME query: the real table renderer shows
   * the aggregated result with the chart's value/date formatting riding along.
   */
  const tableSpec = useMemo<ChartSpec | null>(() => {
    if (request?.kind !== 'aggregated') return null;
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
        table: {
          borders: 'rows',
          density: 'compact',
          stripes: true,
          filterable: false,
          sortable: false,
        },
      },
    };
  }, [request]);

  if (!request) return null;

  const rowCount =
    fetchState.status === 'aggregated'
      ? fetchState.result.rows.length
      : fetchState.status === 'underlying'
        ? fetchState.result.rows.length
        : null;

  const baseTitle =
    request.kind === 'aggregated'
      ? request.chart.title
      : `${request.title} — ${request.contextLabel}`;
  const dialogTitle = rowCount === null ? baseTitle : `${baseTitle} · ${rowCount} rows`;

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
              Showing the first {rowCount} rows (server cap) — export for the full set.
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

        {fetchState.status === 'aggregated' && tableSpec && (
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center">
                <RcdSpinner label="Loading table…" />
              </div>
            }
          >
            <ChartRenderer spec={tableSpec} result={fetchState.result} />
          </Suspense>
        )}

        {fetchState.status === 'underlying' && (
          <UnderlyingGrid result={fetchState.result} />
        )}
      </div>
    </RcdDialog>
  );
}

/** Plain scrollable grid of the raw underlying columns (sticky header). */
function UnderlyingGrid({ result }: { result: UnderlyingQueryResult }) {
  if (result.rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-rcd-muted">
        No underlying records match this point.
      </div>
    );
  }
  return (
    <div className="h-full overflow-auto rounded-md border border-rcd-border">
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 z-10 bg-rcd-surface">
          <tr>
            {result.columns.map((column) => (
              <th
                key={column.name}
                className={`whitespace-nowrap border-b border-rcd-border px-2.5 py-1.5 font-semibold text-rcd-text-2 ${
                  NUMERIC_TYPES.has(column.type) ? 'text-right' : 'text-left'
                }`}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-b border-rcd-grid-line last:border-b-0">
              {result.columns.map((column, columnIndex) => (
                <td
                  key={column.name}
                  className={`whitespace-nowrap px-2.5 py-1 text-rcd-text ${
                    NUMERIC_TYPES.has(column.type) ? 'text-right tabular-nums' : 'text-left'
                  }`}
                >
                  {formatCellValue(row[columnIndex] ?? null, column)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
