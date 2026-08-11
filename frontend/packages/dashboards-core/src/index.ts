export const RCD_CORE_VERSION = '0.5.1';

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
  ModelExportDocument,
  SaveDashboardBody,
  ValidationOutcome,
  ExportQueryBody,
  ExportCsvResult,
  UnderlyingQueryBody,
  UnderlyingQueryResult,
} from './api/DashboardsApi';

export { QueryCache } from './state/queryCache';
export type { QueryCacheEntry, QueryCacheState } from './state/queryCache';
export { ModelStore } from './state/modelStore';
export type { AsyncStatus, EditableModel, ModelStoreState, NewRelationshipInput } from './state/modelStore';
export {
  DashboardStore,
  bucketDateOf,
  crossFilterClauseFor,
  dateBucketRange,
  dateRangeClauseFor,
  formatDateOnly,
} from './state/dashboardStore';
export type {
  CalendarDate,
  CrossFilterClauseOptions,
  DashboardStoreState,
  FilterCardOverride,
  HoverHighlight,
  OpenDashboard,
} from './state/dashboardStore';
export { createDashboardsRuntime } from './state/createRuntime';
export type { DashboardsRuntime } from './state/createRuntime';

export { dateOnlyPartOf, displayDateBound, inclusiveDateUpperBound } from './util/dateBounds';
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
export { buildXlsx, downloadXlsx } from './util/xlsx';
export type { XlsxSheetInput } from './util/xlsx';
