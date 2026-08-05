export const RCD_CORE_VERSION = '0.1.0';

export * from './types/schema';
export * from './types/model';
export * from './types/query';
export * from './types/chart';
export * from './types/dashboard';

export { RcdApiError, createFetchFetcher } from './api/fetcher';
export type { RcdFetcher, RcdRequestInit } from './api/fetcher';
export { DashboardsApi } from './api/DashboardsApi';
export type {
  SaveModelBody,
  SaveDashboardBody,
  ValidationOutcome,
  ExportQueryBody,
  ExportCsvResult,
} from './api/DashboardsApi';

export { QueryCache } from './state/queryCache';
export type { QueryCacheEntry, QueryCacheState } from './state/queryCache';
export { ModelStore } from './state/modelStore';
export type { AsyncStatus, EditableModel, ModelStoreState, NewRelationshipInput } from './state/modelStore';
export { DashboardStore } from './state/dashboardStore';
export type {
  DashboardStoreState,
  FilterCardOverride,
  HoverHighlight,
  OpenDashboard,
} from './state/dashboardStore';
export { createDashboardsRuntime } from './state/createRuntime';
export type { DashboardsRuntime } from './state/createRuntime';

export { stableStringify } from './util/hash';
export { newId } from './util/ids';
export { sanitizeRichHtml } from './util/richText';
export {
  formatCellValue,
  formatAxisValue,
  formatDateLabel,
  formatNumberPattern,
  formatDatePattern,
} from './util/format';
export { seriesColor, CATEGORICAL_SLOTS, CHART_THEMES } from './util/palette';
