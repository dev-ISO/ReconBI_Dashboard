import './styles/rcd.css';

export const RCD_UI_VERSION = '0.15.0';

export {
  DashboardsProvider,
  useRuntime,
  useModelState,
  useDashboardState,
  useQueryCacheState,
} from './provider/DashboardsProvider';
export type { DashboardsProviderProps } from './provider/DashboardsProvider';

export { DashboardGrid } from './dashboard/DashboardGrid';
export type { DashboardGridItem, DashboardGridProps } from './dashboard/DashboardGrid';

export { ModelCanvas } from './model-canvas/ModelCanvas';
export type { ModelCanvasProps, CanvasNode, CanvasEdge } from './model-canvas/ModelCanvas';

export { ChartTile } from './chart/ChartTile';
export type { ChartTileProps } from './chart/ChartTile';
export { shapeChartData, shapePieData, shapeScatterData, SCATTER_SERIES_CAP } from './chart/chartData';
export type {
  ChartSeries,
  ShapedChartData,
  PieSlice,
  ShapedPieData,
  ScatterPoint,
  ScatterSeries,
  ShapedScatterData,
} from './chart/chartData';
export { FormatPanel } from './chart/FormatPanel';
export type { FormatPanelProps } from './chart/FormatPanel';
export { textStyleToCss } from './chart/textStyle';

export {
  RcdButton,
  RcdIconButton,
  RcdInput,
  RcdSelect,
  RcdSpinner,
  RcdDialog,
  ConfirmDialog,
} from './primitives';
export type { RcdButtonProps, RcdDialogProps, ConfirmDialogProps } from './primitives';

export { SchemaExplorer } from './data-pane/SchemaExplorer';
export type { SchemaExplorerProps } from './data-pane/SchemaExplorer';
export { ModelEditor } from './model-editor/ModelEditor';
export type { ModelEditorProps } from './model-editor/ModelEditor';
export { ChartBuilder } from './chart-builder/ChartBuilder';
export type { ChartBuilderProps } from './chart-builder/ChartBuilder';
export { DashboardView } from './dashboard/DashboardView';
export type { DashboardViewProps } from './dashboard/DashboardView';
export { DashboardListPanel } from './dashboard/DashboardListPanel';
export type { DashboardListPanelProps } from './dashboard/DashboardListPanel';
export { ModelListPanel } from './model-list/ModelListPanel';
export type { ModelListPanelProps } from './model-list/ModelListPanel';
export { ShareDialog } from './dashboard/ShareDialog';
export type { ShareDialogProps } from './dashboard/ShareDialog';
export { SubscriptionsManager } from './dashboard/SubscriptionsManager';
export type { SubscriptionsManagerProps } from './dashboard/SubscriptionsManager';
export { ActivityPanel } from './dashboard/ActivityPanel';
export type { ActivityPanelProps } from './dashboard/ActivityPanel';
