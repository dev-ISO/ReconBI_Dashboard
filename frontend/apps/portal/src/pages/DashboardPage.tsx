import { useNavigate, useParams } from 'react-router-dom';
import { DashboardView } from '@recon/dashboards-ui';

export function DashboardPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const dashboardId = Number(id);
  if (!Number.isFinite(dashboardId)) {
    return <div className="p-8 text-sm opacity-70">Invalid dashboard id.</div>;
  }
  return (
    <div className="h-full">
      <DashboardView
        dashboardId={dashboardId}
        // "Make a copy" opens the copy; delete / remove-from-list goes home.
        onOpenDashboard={(copyId) => navigate(`/dashboards/${copyId}`)}
        onDeleted={() => navigate('/')}
      />
    </div>
  );
}
