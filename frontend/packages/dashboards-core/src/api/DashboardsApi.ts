import type { RcdFetcher } from './fetcher';
import type { Catalog, ConnectionInfo } from '../types/schema';
import type { ModelDefinition, ModelDetail, ModelSummary } from '../types/model';
import type {
  CellValue,
  ChartQuerySpec,
  DistinctValuesResult,
  DistinctValuesSpec,
  QueryColumn,
  QueryResult,
} from '../types/query';
import type {
  ActivityEntry,
  AlertFiring,
  AlertTestResult,
  DashboardAlert,
  DashboardDetail,
  DashboardLayoutDoc,
  DashboardShare,
  DashboardSubscription,
  DashboardSummary,
  RcdUser,
  SaveAlertBody,
  SaveSubscriptionBody,
} from '../types/dashboard';

export interface SaveModelBody {
  name: string;
  description?: string | null;
  dataSourceName: string;
  definition: ModelDefinition;
  isShared?: boolean;
  expectedUpdatedAtUtc?: string | null;
}

/**
 * Portable model document — the body of GET /models/{id}/export, accepted back
 * unchanged by importModel. Deliberately carries no id, owner or sharing flag:
 * those belong to an installation, not to the definition. This is the shape
 * committed to source control for the seeded default model.
 */
export interface ModelExportDocument {
  name: string;
  description?: string | null;
  dataSourceName: string;
  definition: ModelDefinition;
}

export interface SaveDashboardBody {
  name: string;
  description?: string | null;
  modelId: number | null;
  layout: DashboardLayoutDoc;
  isShared?: boolean;
  expectedUpdatedAtUtc?: string | null;
}

/** One grant of PUT dashboards/{id}/shares (all flags false = view-only). */
export interface DashboardShareInput {
  userId: string;
  canEditLayout: boolean;
  canManagePages: boolean;
  canEditCharts: boolean;
}

/** Body of PUT dashboards/{id}/shares — REPLACES the dashboard's full grant set. */
export interface SaveDashboardSharesBody {
  shares: DashboardShareInput[];
}

/** Paging options of GET dashboards/{id}/activity. */
export interface ListActivityOptions {
  /** Server default 100. */
  limit?: number;
  /** Return entries with id strictly below this ("Load more" cursor). */
  beforeId?: number;
}

export interface ValidationOutcome {
  valid: boolean;
  issues: { code: string; severity: string; message: string; path: string | null }[];
}

/** Body of POST /query/export. */
export interface ExportQueryBody {
  spec: ChartQuerySpec;
  /** 'summarized' = the aggregated result grid; 'underlying' = matching source rows. */
  mode: 'summarized' | 'underlying';
  maxRows?: number;
}

export interface ExportCsvResult {
  blob: Blob;
  /** True when the server capped the row count (X-Rcd-Truncated header). */
  truncated: boolean;
}

/** Body of POST /query/underlying (raw source rows behind an aggregate). */
export interface UnderlyingQueryBody {
  spec: ChartQuerySpec;
  /** Server default 1000. */
  maxRows?: number;
}

/** JSON result of POST /query/underlying. */
export interface UnderlyingQueryResult {
  columns: QueryColumn[];
  rows: CellValue[][];
  meta: { rowCount: number; truncated: boolean };
}

/** Typed client over the api/rcd/v1 surface. baseUrl has no trailing slash. */
export class DashboardsApi {
  constructor(
    private readonly baseUrl: string,
    private readonly fetcher: RcdFetcher,
  ) {}

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  listConnections(signal?: AbortSignal): Promise<ConnectionInfo[]> {
    return this.fetcher(this.url('/connections'), { signal });
  }

  getCatalog(connection: string, signal?: AbortSignal): Promise<Catalog> {
    return this.fetcher(this.url(`/connections/${encodeURIComponent(connection)}/catalog`), { signal });
  }

  refreshCatalog(connection: string): Promise<Catalog> {
    return this.fetcher(this.url(`/connections/${encodeURIComponent(connection)}/catalog/refresh`), {
      method: 'POST',
    });
  }

  listModels(signal?: AbortSignal): Promise<ModelSummary[]> {
    return this.fetcher(this.url('/models'), { signal });
  }

  getModel(id: number, signal?: AbortSignal): Promise<ModelDetail> {
    return this.fetcher(this.url(`/models/${id}`), { signal });
  }

  createModel(body: SaveModelBody): Promise<ModelDetail> {
    return this.fetcher(this.url('/models'), { method: 'POST', body });
  }

  updateModel(id: number, body: SaveModelBody): Promise<ModelDetail> {
    return this.fetcher(this.url(`/models/${id}`), { method: 'PUT', body });
  }

  deleteModel(id: number): Promise<void> {
    return this.fetcher(this.url(`/models/${id}`), { method: 'DELETE' });
  }

  /**
   * Copies a model the caller can see (typically the shared default they cannot
   * edit) into a new one they own. Named "{source} (copy)", de-duplicated
   * server-side against the caller's own models.
   */
  duplicateModel(id: number): Promise<ModelDetail> {
    return this.fetcher(this.url(`/models/${id}/duplicate`), { method: 'POST' });
  }

  /** The model as a portable document — readable by anyone who can see it. */
  exportModel(id: number, signal?: AbortSignal): Promise<ModelExportDocument> {
    return this.fetcher(this.url(`/models/${id}/export`), { signal });
  }

  /**
   * Creates a caller-owned (never shared) model from an exported document.
   * Validation, size/count limits and name conflicts surface exactly as they do
   * for createModel — notably RcdApiError 'rcd.model.name_conflict' on a name
   * the caller already uses.
   */
  importModel(body: ModelExportDocument): Promise<ModelDetail> {
    return this.fetcher(this.url('/models/import'), { method: 'POST', body });
  }

  validateModel(dataSourceName: string, definition: ModelDefinition): Promise<ValidationOutcome> {
    return this.fetcher(this.url('/models/validate'), {
      method: 'POST',
      body: { dataSourceName, definition },
    });
  }

  runQuery(spec: ChartQuerySpec, signal?: AbortSignal): Promise<QueryResult> {
    return this.fetcher(this.url('/query'), { method: 'POST', body: spec, signal });
  }

  getDistinctValues(spec: DistinctValuesSpec, signal?: AbortSignal): Promise<DistinctValuesResult> {
    return this.fetcher(this.url('/query/values'), { method: 'POST', body: spec, signal });
  }

  /**
   * Raw source rows behind an aggregate (the spec's filters apply; dimensions/
   * measures are ignored server-side). Same auth/RLS as /query/export.
   */
  queryUnderlying(body: UnderlyingQueryBody, signal?: AbortSignal): Promise<UnderlyingQueryResult> {
    return this.fetcher(this.url('/query/underlying'), { method: 'POST', body, signal });
  }

  /**
   * Downloads a query's data as CSV (text/csv attachment). Uses the fetcher's
   * raw mode — same auth headers, same RcdApiError contract on non-2xx — and
   * surfaces the X-Rcd-Truncated header as `truncated`.
   */
  async exportQueryCsv(body: ExportQueryBody, signal?: AbortSignal): Promise<ExportCsvResult> {
    const response = await this.fetcher<Response>(this.url('/query/export'), {
      method: 'POST',
      body,
      signal,
      raw: true,
    });
    return { blob: await response.blob(), truncated: response.headers.get('X-Rcd-Truncated') !== null };
  }

  listDashboards(signal?: AbortSignal): Promise<DashboardSummary[]> {
    return this.fetcher(this.url('/dashboards'), { signal });
  }

  getDashboard(id: number, signal?: AbortSignal): Promise<DashboardDetail> {
    return this.fetcher(this.url(`/dashboards/${id}`), { signal });
  }

  createDashboard(body: SaveDashboardBody): Promise<DashboardDetail> {
    return this.fetcher(this.url('/dashboards'), { method: 'POST', body });
  }

  updateDashboard(id: number, body: SaveDashboardBody): Promise<DashboardDetail> {
    return this.fetcher(this.url(`/dashboards/${id}`), { method: 'PUT', body });
  }

  deleteDashboard(id: number): Promise<void> {
    return this.fetcher(this.url(`/dashboards/${id}`), { method: 'DELETE' });
  }

  duplicateDashboard(id: number): Promise<DashboardDetail> {
    return this.fetcher(this.url(`/dashboards/${id}/duplicate`), { method: 'POST' });
  }

  /* ------------------------------------------------- shares/activity/users */

  /** The dashboard's per-user grant rows — owner/admin only. */
  async listDashboardShares(id: number, signal?: AbortSignal): Promise<DashboardShare[]> {
    const result = await this.fetcher<{ shares: DashboardShare[] }>(
      this.url(`/dashboards/${id}/shares`),
      { signal },
    );
    return result.shares ?? [];
  }

  /**
   * REPLACES the dashboard's full grant set (owner/admin, non-system). The
   * owner/caller as a target is rejected server-side
   * ('rcd.dashboard.share_target_invalid'). Response body, if any, is ignored
   * — callers re-list to refresh.
   */
  saveDashboardShares(id: number, body: SaveDashboardSharesBody): Promise<void> {
    return this.fetcher(this.url(`/dashboards/${id}/shares`), { method: 'PUT', body });
  }

  /** Removes the CALLER's share row ("Remove from my list"). */
  leaveDashboard(id: number): Promise<void> {
    return this.fetcher(this.url(`/dashboards/${id}/leave`), { method: 'POST' });
  }

  /**
   * Activity log, newest first — owner/admin/grantees holding any edit flag.
   * Page backwards with `beforeId` (the last received entry's id).
   */
  async listDashboardActivity(
    id: number,
    options: ListActivityOptions = {},
    signal?: AbortSignal,
  ): Promise<ActivityEntry[]> {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.beforeId !== undefined) params.set('beforeId', String(options.beforeId));
    const query = params.toString();
    const result = await this.fetcher<{ entries: ActivityEntry[] }>(
      this.url(`/dashboards/${id}/activity${query === '' ? '' : `?${query}`}`),
      { signal },
    );
    return result.entries ?? [];
  }

  /**
   * The host's user directory (share-picker search). An empty array with no
   * query means the host has no IUserDirectory configured — UIs show their
   * "user directory not configured" state.
   */
  listUsers(query?: string, signal?: AbortSignal): Promise<RcdUser[]> {
    const suffix =
      query === undefined || query === '' ? '' : `?query=${encodeURIComponent(query)}`;
    return this.fetcher(this.url(`/users${suffix}`), { signal });
  }

  /* --------------------------------------------------- email subscriptions */

  /** My subscriptions, optionally scoped to one dashboard. */
  listSubscriptions(dashboardId?: number, signal?: AbortSignal): Promise<DashboardSubscription[]> {
    const suffix = dashboardId === undefined ? '' : `?dashboardId=${dashboardId}`;
    return this.fetcher(this.url(`/subscriptions${suffix}`), { signal });
  }

  createSubscription(body: SaveSubscriptionBody): Promise<DashboardSubscription> {
    return this.fetcher(this.url('/subscriptions'), { method: 'POST', body });
  }

  updateSubscription(id: number, body: SaveSubscriptionBody): Promise<DashboardSubscription> {
    return this.fetcher(this.url(`/subscriptions/${id}`), { method: 'PUT', body });
  }

  deleteSubscription(id: number): Promise<void> {
    return this.fetcher(this.url(`/subscriptions/${id}`), { method: 'DELETE' });
  }

  /* -------------------------------------------------------- metric alerts */

  /** My alerts, optionally scoped to one dashboard. */
  listAlerts(dashboardId?: number, signal?: AbortSignal): Promise<DashboardAlert[]> {
    const suffix = dashboardId === undefined ? '' : `?dashboardId=${dashboardId}`;
    return this.fetcher(this.url(`/alerts${suffix}`), { signal });
  }

  createAlert(body: SaveAlertBody): Promise<DashboardAlert> {
    return this.fetcher(this.url('/alerts'), { method: 'POST', body });
  }

  updateAlert(id: number, body: SaveAlertBody): Promise<DashboardAlert> {
    return this.fetcher(this.url(`/alerts/${id}`), { method: 'PUT', body });
  }

  deleteAlert(id: number): Promise<void> {
    return this.fetcher(this.url(`/alerts/${id}`), { method: 'DELETE' });
  }

  /** Evaluates a SAVED alert now: current value + whether it would fire. */
  testAlert(id: number, signal?: AbortSignal): Promise<AlertTestResult> {
    return this.fetcher(this.url(`/alerts/${id}/test`), { method: 'POST', signal });
  }

  /** Recent alert firings (badge/dropdown), optionally per dashboard. */
  listRecentAlertFirings(dashboardId?: number, signal?: AbortSignal): Promise<AlertFiring[]> {
    const suffix = dashboardId === undefined ? '' : `?dashboardId=${dashboardId}`;
    return this.fetcher(this.url(`/alerts/recent-firings${suffix}`), { signal });
  }
}
