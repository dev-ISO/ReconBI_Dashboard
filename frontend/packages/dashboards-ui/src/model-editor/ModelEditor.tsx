export interface ModelEditorProps {
  /** Existing model id, or 'new' with a data source to start from. */
  modelId: number | 'new';
  /** Required when modelId is 'new'. */
  dataSourceName?: string;
  onSaved?: (id: number) => void;
}

/** Full editor: SchemaExplorer | relationship canvas | measures panel + save. */
export function ModelEditor(_props: ModelEditorProps) {
  return <div className="p-4 text-sm text-rcd-muted">Model editor under construction.</div>;
}
