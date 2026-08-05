import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Network, Plus, RefreshCw, Share2, User } from 'lucide-react';
import {
  RcdButton,
  RcdDialog,
  RcdSpinner,
  useModelState,
  useRuntime,
} from '@recon/dashboards-ui';

const updatedFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

export function ModelListPage() {
  const navigate = useNavigate();
  const runtime = useRuntime();
  const models = useModelState((s) => s.models);
  const modelsStatus = useModelState((s) => s.modelsStatus);
  const connections = useModelState((s) => s.connections);
  const connectionsStatus = useModelState((s) => s.connectionsStatus);
  const storeError = useModelState((s) => s.error);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    void runtime.models.loadModels();
    void runtime.models.loadConnections();
  }, [runtime]);

  const goToNew = (source: string) => {
    setPickerOpen(false);
    navigate(`/models/new?source=${encodeURIComponent(source)}`);
  };

  const startNew = () => {
    const only = connections[0];
    if (connections.length === 1 && only) goToNew(only.name);
    else setPickerOpen(true);
  };

  const loading = (modelsStatus === 'loading' || modelsStatus === 'idle') && models.length === 0;

  return (
    <div className="p-8">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">Semantic models</h1>
        <RcdButton variant="primary" onClick={startNew}>
          <Plus size={14} /> New model
        </RcdButton>
      </div>

      {modelsStatus === 'error' ? (
        <div className="mt-6 flex flex-col items-start gap-3">
          <p className="text-sm text-rcd-text-2">{storeError ?? 'Failed to load models.'}</p>
          <RcdButton onClick={() => void runtime.models.loadModels()}>
            <RefreshCw size={14} /> Retry
          </RcdButton>
        </div>
      ) : loading ? (
        <div className="mt-6">
          <RcdSpinner label="Loading models…" />
        </div>
      ) : models.length === 0 ? (
        <div className="mt-16 flex flex-col items-center gap-3 text-center">
          <Network size={32} className="text-rcd-muted" />
          <div>
            <p className="text-sm font-medium text-rcd-text">No models yet</p>
            <p className="mt-1 max-w-sm text-sm text-rcd-muted">
              A semantic model picks tables from a connection, wires up relationships, and defines
              the measures charts can plot.
            </p>
          </div>
          <RcdButton variant="primary" onClick={startNew}>
            <Plus size={14} /> Create your first model
          </RcdButton>
        </div>
      ) : (
        <div className="mt-6 overflow-hidden rounded-xl border border-rcd-border shadow-[var(--rcd-shadow-1)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-rcd-border bg-rcd-surface text-left text-xs text-rcd-muted">
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Data source</th>
                <th className="px-4 py-2 font-medium">Access</th>
                <th className="px-4 py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {models.map((model) => (
                <tr
                  key={model.id}
                  className="cursor-pointer border-b border-rcd-border bg-rcd-surface last:border-b-0 hover:bg-black/5 dark:hover:bg-white/10"
                  onClick={() => navigate(`/models/${model.id}`)}
                >
                  <td className="px-4 py-2.5">
                    <span className="font-medium text-rcd-text">{model.name}</span>
                    {model.description && (
                      <span className="mt-0.5 block text-xs text-rcd-muted">{model.description}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-rcd-text-2">{model.dataSourceName}</td>
                  <td className="px-4 py-2.5">
                    <span className="flex flex-wrap items-center gap-1.5">
                      {model.ownerIsMe && (
                        <span className="inline-flex items-center gap-1 rounded-md border border-rcd-border px-2 py-0.5 text-[11px] font-medium text-rcd-text-2">
                          <User size={11} /> Yours
                        </span>
                      )}
                      {model.isShared && (
                        <span className="inline-flex items-center gap-1 rounded-md border border-rcd-border px-2 py-0.5 text-[11px] font-medium text-rcd-text-2">
                          <Share2 size={11} /> Shared
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-rcd-text-2 tabular-nums">
                    {updatedFormat.format(new Date(model.updatedAtUtc))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <RcdDialog title="Choose a data source" open={pickerOpen} onClose={() => setPickerOpen(false)}>
        {connectionsStatus === 'loading' || connectionsStatus === 'idle' ? (
          <RcdSpinner label="Loading connections…" />
        ) : connections.length === 0 ? (
          <p className="text-sm text-rcd-muted">
            No data source connections are registered. Connections are configured server-side.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {connections.map((connection) => (
              <li key={connection.name}>
                <button
                  type="button"
                  className="w-full rounded-lg border border-rcd-border px-3 py-2 text-left shadow-[var(--rcd-shadow-1)] transition-colors hover:bg-black/5 dark:hover:bg-white/10"
                  onClick={() => goToNew(connection.name)}
                >
                  <span className="block text-sm font-medium text-rcd-text">{connection.name}</span>
                  <span className="block text-xs text-rcd-muted">
                    {connection.description ?? connection.provider}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </RcdDialog>
    </div>
  );
}
