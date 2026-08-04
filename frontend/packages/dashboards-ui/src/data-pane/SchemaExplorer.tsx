import type { CatalogTable } from '@recon/dashboards-core';

export interface SchemaExplorerProps {
  /** Registered data source name whose catalog to browse. */
  connection: string;
  /** Invoked when the user adds a table to the model. */
  onAddTable?: (table: CatalogTable) => void;
}

/** Catalog tree: schema > table > columns with type icons, search, add-to-model. */
export function SchemaExplorer(_props: SchemaExplorerProps) {
  return <div className="p-4 text-sm text-rcd-muted">Schema explorer under construction.</div>;
}
