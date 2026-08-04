export interface DashboardViewProps {
  dashboardId: number;
  /** Hides all editing affordances (host capability-driven). */
  readonly?: boolean;
}

/** The embeddable entry point: toolbar + slicers + tile grid, view/edit modes. */
export function DashboardView(_props: DashboardViewProps) {
  return <div className="p-4 text-sm text-rcd-muted">Dashboard view under construction.</div>;
}
