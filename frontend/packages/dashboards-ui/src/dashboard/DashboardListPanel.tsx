export interface DashboardListPanelProps {
  onOpen: (id: number) => void;
  /** Called after a successful create (typically navigates into edit). */
  onCreated?: (id: number) => void;
}

/** Own + shared dashboards with create/duplicate/delete. */
export function DashboardListPanel(_props: DashboardListPanelProps) {
  return <div className="p-4 text-sm text-rcd-muted">Dashboard list under construction.</div>;
}
