import { useNavigate } from 'react-router-dom';
import { DashboardListPanel } from '@recon/dashboards-ui';

export function DashboardListPage() {
  const navigate = useNavigate();
  const goToDashboard = (id: number) => navigate(`/dashboards/${id}`);

  return (
    <div className="h-full">
      <DashboardListPanel onOpen={goToDashboard} onCreated={goToDashboard} />
    </div>
  );
}
