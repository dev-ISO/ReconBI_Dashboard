export const RCD_CORE_VERSION = '0.15.0';

export * from './types/schema';
export * from './types/model';
export * from './types/query';
export * from './types/chart';
export * from './types/dashboard';
export * from './types/ops';

export { RcdApiError, createFetchFetcher, rcdErrorMessage } from './api/fetcher';
export type { RcdFetcher, RcdRequestInit } from './api/fetcher';
export { DashboardsApi, opResultStampOf } from './api/DashboardsApi';
export type {
  SaveModelBody,
  ModelExportDocument,
  SaveDashboardBody,
  DashboardShareInput,
  SaveDashboardSharesBody,
  ListActivityOptions,
  ValidationOutcome,
  ExportQueryBody,
  ExportCsvResult,
  UnderlyingQueryBody,
  UnderlyingQueryResult,
  RcdMeta,
  SendDashboardOpBody,
  SendDashboardOpResult,
  DashboardTileLockResult,
  PatchDashboardMetaBody,
} from './api/DashboardsApi';

export { QueryCache } from './state/queryCache';
export type { QueryCacheEntry, QueryCacheOptions, QueryCacheState } from './state/queryCache';
export { ModelStore } from './state/modelStore';
export type { AsyncStatus, EditableModel, ModelStoreState, NewRelationshipInput } from './state/modelStore';
export {
  DashboardStore,
  bucketDateOf,
  crossFilterClauseFor,
  dateBucketRange,
  dateRangeClauseFor,
  formatDateOnly,
  isCollabLiveDashboard,
} from './state/dashboardStore';
export type {
  CalendarDate,
  CrossFilterClauseOptions,
  DashboardCollabSenders,
  DashboardStoreState,
  DispatchLiveProgress,
  FilterCardOverride,
  HoverHighlight,
  OpenDashboard,
  RemoteCursor,
  RemoteTileLock,
} from './state/dashboardStore';
export { applyOpToDoc, diffLayoutDocs, invertLocalOp } from './state/collabOps';
export { createDashboardsRuntime } from './state/createRuntime';
export type { DashboardsRuntime, DashboardsRuntimeOptions } from './state/createRuntime';

export { pathToWell, validateChartSpec, wireDimensionWells } from './validation/chartValidation';
export type { ChartIssue } from './validation/chartValidation';

export { dateOnlyPartOf, displayDateBound, inclusiveDateUpperBound } from './util/dateBounds';
export { stableStringify } from './util/hash';
export { newId } from './util/ids';
export { boldRunText, retitleInnerTitleHtml, sanitizeRichHtml } from './util/richText';
export { BUTTON_STYLE_PROPERTIES, buttonStyleFromCss, sanitizeButtonCss } from './util/buttonStyle';
export { reconcileOrder, reconcileOrderBy } from './util/ordering';
export { composeDataLabel } from './util/dataLabels';
export {
  formatCellValue,
  formatAxisValue,
  formatDateLabel,
  formatNumberPattern,
  formatDatePattern,
} from './util/format';
export { seriesColor, CATEGORICAL_SLOTS, CHART_THEMES } from './util/palette';
export { seriesStyleLookup, legacyInlineMeasureLabel } from './util/seriesStyle';
export { buildXlsx, downloadXlsx } from './util/xlsx';
export type { XlsxSheetInput } from './util/xlsx';
