import './styles/rcd.css';

export const RCD_UI_VERSION = '0.1.0';

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
export { shapeChartData } from './chart/chartData';
export type { ChartSeries, ShapedChartData } from './chart/chartData';

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
