import type { ChartSpec, ModelDefinition } from '@recon/dashboards-core';

export interface ChartBuilderProps {
  modelId: number;
  model: ModelDefinition;
  initial: ChartSpec;
  onSave: (spec: ChartSpec) => void;
  onCancel: () => void;
}

/** Field list | type picker + wells | live preview. */
export function ChartBuilder(_props: ChartBuilderProps) {
  return <div className="p-4 text-sm text-rcd-muted">Chart builder under construction.</div>;
}
