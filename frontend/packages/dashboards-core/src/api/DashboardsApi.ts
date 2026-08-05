import type { RcdFetcher } from './fetcher';
import type { Catalog, ConnectionInfo } from '../types/schema';
import type { ModelDefinition, ModelDetail, ModelSummary } from '../types/model';
import type {
  ChartQuerySpec,
  DistinctValuesResult,
  DistinctValuesSpec,
  QueryResult,
} from '../types/query';
import type { DashboardDetail, DashboardLayoutDoc, DashboardSummary } from '../types/dashboard';

export interface SaveModelBody {
  name: string;
  description?: string | null;
  dataSourceName: string;
  definition: ModelDefinition;
  isShared?: boolean;
  expectedUpdatedAtUtc?: string | null;
}

export interface SaveDashboardBody {
  name: string;
  description?: string | null;
  modelId: number | null;
  layout: DashboardLayoutDoc;
  isShared?: boolean;
  expectedUpdatedAtUtc?: string | null;
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
}
