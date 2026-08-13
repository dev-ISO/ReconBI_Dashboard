import { useEffect, useRef, useState } from 'react';
import { Copy, Download, Lock, Network, Plus, RefreshCw, Share2, Trash2, Upload, User } from 'lucide-react';
import { RcdApiError } from '@recon/dashboards-core';
import type { ModelExportDocument, ModelSummary } from '@recon/dashboards-core';
import { useModelState, useRuntime } from '../provider/DashboardsProvider';
import { ConfirmDialog, RcdButton, RcdDialog, RcdIconButton, RcdSpinner } from '../primitives';
import { downloadBlob } from '../util/downloadBlob';

export interface ModelListPanelProps {
  /** Open an existing model — typically navigates into the model editor. */
  onOpen: (id: number) => void;
  /**
   * Start a new model against the chosen data source. Omit to hide the "New
   * model" button (the panel still offers import when authoring is allowed).
   */
  onNew?: (dataSourceName: string) => void;
  /**
   * Hides every authoring action — new, import, duplicate and delete — leaving
   * a browse-and-export list. Hosts embedding the panel for viewers set this;
   * it is a UI courtesy, not a security boundary (the server enforces the
   * Author policy on each of those endpoints regardless).
   */
  readOnly?: boolean;
}

const updatedFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

const formatUpdated = (iso: string): string => {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : updatedFormat.format(parsed);
};

/** Mirrors modelStore's helper: unwraps RcdApiError and appends its error-severity issues. */
const messageOf = (error: unknown): string => {
  if (error instanceof RcdApiError) {
    const issueText = error.issues
      .filter((issue) => issue.severity === 'error')
      .map((issue) => issue.message)
      .join(' ');
    return issueText ? `${error.message} ${issueText}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
};

/** "Sales model" -> "Sales model.model.json"; strips what filesystems reject. */
const downloadName = (name: string): string => {
  const cleaned = name.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();
  return `${cleaned.length > 0 ? cleaned : 'model'}.model.json`;
};

/**
 * Narrows a parsed file to an export document. Deliberately shallow — the
 * server re-validates the definition against the live catalog — but enough to
 * tell "wrong file" apart from "model the database no longer fits".
 */
const asExportDocument = (parsed: unknown): ModelExportDocument | null => {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;
  const definition = candidate.definition;
  if (
    typeof candidate.name !== 'string'
    || typeof candidate.dataSourceName !== 'string'
    || typeof definition !== 'object'
    || definition === null
  ) {
    return null;
  }

  return {
    name: candidate.name,
    description: typeof candidate.description === 'string' ? candidate.description : null,
    dataSourceName: candidate.dataSourceName,
    definition: definition as ModelExportDocument['definition'],
  };
};

/**
 * Own + shared semantic models with the lifecycle actions around them: create,
 * duplicate, export, import and delete.
 *
 * Sharing shapes what a row offers. A shared model the caller does not own is
 * read-only to them, so it shows Duplicate (take your own copy to customize)
 * and Export, but no Delete — the server would refuse, and offering it would
 * only teach the button lies.
 */
export function ModelListPanel({ onOpen, onNew, readOnly = false }: ModelListPanelProps) {
  const runtime = useRuntime();

  const models = useModelState((state) => state.models);
  const modelsStatus = useModelState((state) => state.modelsStatus);
  const connections = useModelState((state) => state.connections);
  const connectionsStatus = useModelState((state) => state.connectionsStatus);
  const storeError = useModelState((state) => state.error);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ModelSummary | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void runtime.models.loadModels();
    void runtime.models.loadConnections();
  }, [runtime]);

  const authoring = !readOnly;

  const goToNew = (source: string) => {
    setPickerOpen(false);
    onNew?.(source);
  };

  const startNew = () => {
    const only = connections[0];
    if (connections.length === 1 && only) goToNew(only.name);
    else setPickerOpen(true);
  };

  const handleDuplicate = async (model: ModelSummary) => {
    setBusyId(model.id);
    setActionError(null);
    try {
      const copy = await runtime.api.duplicateModel(model.id);
      await runtime.models.loadModels();
      onOpen(copy.id);
    } catch (error) {
      setActionError(messageOf(error));
    } finally {
      setBusyId(null);
    }
  };

  const handleExport = async (model: ModelSummary) => {
    setBusyId(model.id);
    setActionError(null);
    try {
      const exported = await runtime.api.exportModel(model.id);
      const blob = new Blob([`${JSON.stringify(exported, null, 2)}\n`], {
        type: 'application/json',
      });
      downloadBlob(downloadName(model.name), blob);
    } catch (error) {
      setActionError(messageOf(error));
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (model: ModelSummary) => {
    setPendingDelete(null);
    setBusyId(model.id);
    setActionError(null);
    try {
      await runtime.api.deleteModel(model.id);
      await runtime.models.loadModels();
    } catch (error) {
      setActionError(messageOf(error));
    } finally {
      setBusyId(null);
    }
  };

  const handleImportFile = async (file: File) => {
    setImporting(true);
    setActionError(null);
    try {
      const document_ = asExportDocument(JSON.parse(await file.text()) as unknown);
      if (document_ === null) {
        setActionError(
          `"${file.name}" is not a model export — expected a JSON object with name, dataSourceName and definition.`,
        );
        return;
      }

      const created = await runtime.api.importModel(document_);
      await runtime.models.loadModels();
      onOpen(created.id);
    } catch (error) {
      setActionError(
        error instanceof SyntaxError
          ? `"${file.name}" is not valid JSON.`
          : messageOf(error),
      );
    } finally {
      setImporting(false);
    }
  };

  const loading = (modelsStatus === 'loading' || modelsStatus === 'idle') && models.length === 0;

  return (
    <div className="p-8">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">Semantic models</h1>
        {authoring && (
          <div className="flex items-center gap-2">
            <RcdButton disabled={importing} onClick={() => fileRef.current?.click()}>
              <Upload size={14} /> {importing ? 'Importing…' : 'Import'}
            </RcdButton>
            {onNew && (
              <RcdButton variant="primary" onClick={startNew}>
                <Plus size={14} /> New model
              </RcdButton>
            )}
          </div>
        )}
      </div>

      {actionError && (
        <p className="mt-3 text-sm text-[var(--rcd-status-critical)]" role="alert">
          {actionError}
        </p>
      )}

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
          {authoring && onNew && (
            <RcdButton variant="primary" onClick={startNew}>
              <Plus size={14} /> Create your first model
            </RcdButton>
          )}
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
                <th className="px-4 py-2" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {models.map((model) => (
                <tr
                  key={model.id}
                  className="cursor-pointer border-b border-rcd-border bg-rcd-surface last:border-b-0 hover:bg-black/5 dark:hover:bg-white/10"
                  onClick={() => onOpen(model.id)}
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
                      {model.isSystem && (
                        <span
                          className="inline-flex items-center gap-1 rounded-md border border-rcd-border px-2 py-0.5 text-[11px] font-medium text-rcd-text-2"
                          title="Built-in content managed by the application. Make a copy to edit it."
                        >
                          <Lock size={11} /> Built-in
                        </span>
                      )}
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
                    {formatUpdated(model.updatedAtUtc)}
                  </td>
                  {/* The row itself opens the model, so actions must not bubble. */}
                  <td className="px-2 py-1.5" onClick={(event) => event.stopPropagation()}>
                    <div className="flex items-center justify-end gap-1">
                      {authoring && (
                        <RcdIconButton
                          aria-label={`Make a copy of ${model.name}`}
                          // Built-ins are copy-to-edit; the copy is the caller's.
                          title={model.isSystem ? 'Make a copy' : 'Duplicate'}
                          disabled={busyId === model.id}
                          onClick={() => void handleDuplicate(model)}
                        >
                          <Copy size={15} />
                        </RcdIconButton>
                      )}
                      <RcdIconButton
                        aria-label={`Export ${model.name}`}
                        title="Export"
                        disabled={busyId === model.id}
                        onClick={() => void handleExport(model)}
                      >
                        <Download size={15} />
                      </RcdIconButton>
                      {authoring && model.ownerIsMe && (
                        <RcdIconButton
                          aria-label={`Delete ${model.name}`}
                          title="Delete"
                          disabled={busyId === model.id}
                          onClick={() => setPendingDelete(model)}
                        >
                          <Trash2 size={15} />
                        </RcdIconButton>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Re-armed after every pick so the same file can be retried after an error. */}
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void handleImportFile(file);
        }}
      />

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

      <ConfirmDialog
        title="Delete model"
        message={
          pendingDelete
            ? `Delete "${pendingDelete.name}"? Dashboards built on it will stop loading. This cannot be undone.`
            : 'Delete this model?'
        }
        confirmLabel="Delete"
        danger
        open={pendingDelete !== null}
        onConfirm={() => pendingDelete && void handleDelete(pendingDelete)}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
