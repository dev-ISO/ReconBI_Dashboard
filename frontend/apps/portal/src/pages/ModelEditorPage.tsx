import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ModelEditor } from '@recon/dashboards-ui';

export function ModelEditorPage() {
  const { id } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();

  const modelId = id === 'new' ? ('new' as const) : Number(id);
  if (modelId !== 'new' && !Number.isFinite(modelId)) {
    return <div className="p-8 text-sm opacity-70">Invalid model id.</div>;
  }

  return (
    <div className="h-full">
      <ModelEditor
        modelId={modelId}
        dataSourceName={search.get('source') ?? undefined}
        onSaved={(savedId) => navigate(`/models/${savedId}`, { replace: true })}
      />
    </div>
  );
}
