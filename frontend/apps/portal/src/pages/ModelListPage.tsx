import { useNavigate } from 'react-router-dom';
import { ModelListPanel } from '@recon/dashboards-ui';

export function ModelListPage() {
  const navigate = useNavigate();

  return (
    <ModelListPanel
      onOpen={(id) => navigate(`/models/${id}`)}
      onNew={(source) => navigate(`/models/new?source=${encodeURIComponent(source)}`)}
    />
  );
}
