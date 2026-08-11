import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Copy, Lock, RefreshCw, Save, ShieldCheck, X } from 'lucide-react';
import type {
  CatalogTable,
  CanvasPosition,
  RelationshipSuggestion,
  ValidationOutcome,
} from '@recon/dashboards-core';
import { useModelState, useRuntime } from '../provider/DashboardsProvider';
import { ConfirmDialog, RcdButton, RcdIconButton, RcdInput, RcdSpinner } from '../primitives';
import { SchemaExplorer } from '../data-pane/SchemaExplorer';
import { ModelCanvas, type ModelCanvasConnectInput } from '../model-canvas/ModelCanvas';
import { RelationshipDialog } from '../model-canvas/RelationshipDialog';
import { MeasuresPanel } from './MeasuresPanel';
import { DateTablesPanel } from './DateTablesPanel';

export interface ModelEditorProps {
  /** Existing model id, or 'new' with a data source to start from. */
  modelId: number | 'new';
  /** Required when modelId is 'new'. */
  dataSourceName?: string;
  onSaved?: (id: number) => void;
}

const EMPTY_SUGGESTIONS: RelationshipSuggestion[] = [];

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Full editor: SchemaExplorer | relationship canvas | measures panel + save. */
export function ModelEditor({ modelId, dataSourceName, onSaved }: ModelEditorProps) {
  const runtime = useRuntime();
  const models = runtime.models;

  const current = useModelState((s) => s.current);
  const dirty = useModelState((s) => s.dirty);
  const saveStatus = useModelState((s) => s.saveStatus);
  const saveError = useModelState((s) => (s.saveStatus === 'error' ? s.error : null));
  const catalog = useModelState((s) => s.catalog);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [validation, setValidation] = useState<ValidationOutcome | null>(null);
  const [validating, setValidating] = useState(false);
  const [editingRelId, setEditingRelId] = useState<string | null>(null);
  const [removingTable, setRemovingTable] = useState<string | null>(null);

  useEffect(() => {
    setLoadError(null);
    setValidation(null);
    if (modelId === 'new') {
      if (dataSourceName) models.newModel(dataSourceName);
      return;
    }
    models.openModel(modelId).catch((error: unknown) => setLoadError(errorMessage(error)));
  }, [models, modelId, dataSourceName]);

  const handleAddTable = useCallback(
    (table: CatalogTable) => {
      const count = models.store.getState().current?.definition.tables.length ?? 0;
      models.addTable(table, {
        x: 80 + (count % 3) * 340,
        y: 80 + Math.floor(count / 3) * 300,
      });
    },
    [models],
  );

  const handleMoveTable = useCallback(
    (key: string, position: CanvasPosition) => models.setTablePosition(key, position),
    [models],
  );

  const handleConnect = useCallback(
    (input: ModelCanvasConnectInput) => {
      const definition = models.store.getState().current?.definition;
      if (!definition) return;
      const exists = definition.relationships.some(
        (r) =>
          (r.fromTable === input.fromTable &&
            r.fromColumn === input.fromColumn &&
            r.toTable === input.toTable &&
            r.toColumn === input.toColumn) ||
          (r.fromTable === input.toTable &&
            r.fromColumn === input.toColumn &&
            r.toTable === input.fromTable &&
            r.toColumn === input.fromColumn),
      );
      if (exists) return;
      models.addRelationship(input);
    },
    [models],
  );

  const handleAcceptSuggestion = useCallback(
    (suggestion: RelationshipSuggestion) => models.acceptSuggestion(suggestion),
    [models],
  );

  const handleEditRelationship = useCallback((id: string) => setEditingRelId(id), []);
  const handleRemoveTable = useCallback((key: string) => setRemovingTable(key), []);

  // Immediate (no-confirm) relationship mutations — the model is local-until-Save.
  const handleDeleteRelationships = useCallback(
    (ids: string[]) => {
      for (const id of ids) models.removeRelationship(id);
    },
    [models],
  );
  const handleSetRelationshipActive = useCallback(
    (id: string, isActive: boolean) => models.updateRelationship(id, { isActive }),
    [models],
  );
  const handleSwapRelationship = useCallback(
    (id: string) => models.swapRelationshipDirection(id),
    [models],
  );

  const handleValidate = useCallback(async () => {
    const state = models.store.getState().current;
    if (!state) return;
    setValidating(true);
    try {
      setValidation(await runtime.api.validateModel(state.dataSourceName, state.definition));
    } catch (error) {
      setValidation({
        valid: false,
        issues: [
          { code: 'requestFailed', severity: 'error', message: errorMessage(error), path: null },
        ],
      });
    } finally {
      setValidating(false);
    }
  }, [models, runtime]);

  const handleSave = useCallback(async () => {
    const wasNew = models.store.getState().current?.id === null;
    const ok = await models.save();
    if (ok && wasNew) {
      const savedId = models.store.getState().current?.id;
      if (savedId != null) onSaved?.(savedId);
    }
  }, [models, onSaved]);

  /** Built-in models are copy-to-edit: duplicate, then hand off to the copy. */
  const [copying, setCopying] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const handleMakeCopy = useCallback(async () => {
    const id = models.store.getState().current?.id;
    if (id == null) return;
    setCopying(true);
    setCopyError(null);
    try {
      const copy = await runtime.api.duplicateModel(id);
      void models.loadModels();
      onSaved?.(copy.id);
    } catch (error) {
      setCopyError(errorMessage(error));
    } finally {
      setCopying(false);
    }
  }, [models, runtime, onSaved]);

  const editingRelationship = useMemo(
    () =>
      editingRelId !== null
        ? (current?.definition.relationships.find((r) => r.id === editingRelId) ?? null)
        : null,
    [current, editingRelId],
  );

  if (modelId === 'new' && !dataSourceName) {
    return (
      <div className="p-6 text-sm text-rcd-text-2">
        A data source is required to create a new model. Go back and pick a connection.
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-col items-start gap-3 p-6">
        <p className="text-sm text-rcd-text-2">{loadError}</p>
        <RcdButton
          onClick={() => {
            setLoadError(null);
            if (modelId !== 'new') {
              models.openModel(modelId).catch((error: unknown) => setLoadError(errorMessage(error)));
            }
          }}
        >
          <RefreshCw size={14} /> Retry
        </RcdButton>
      </div>
    );
  }

  const isReady =
    current !== null && (modelId === 'new' ? current.id === null : current.id === modelId);
  if (!isReady || current === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <RcdSpinner label="Opening model…" />
      </div>
    );
  }

  const catalogForModel = catalog?.connection === current.dataSourceName ? catalog : null;
  const suggestions = catalogForModel ? catalogForModel.suggestions : EMPTY_SUGGESTIONS;
  const saving = saveStatus === 'loading';

  return (
    <div className="flex h-full min-h-0 flex-col bg-rcd-bg text-rcd-text">
      <div className="flex flex-wrap items-center gap-3 border-b border-rcd-border bg-rcd-surface px-4 py-2.5">
        <div className="flex items-center gap-2">
          <RcdInput
            value={current.name}
            onChange={(event) => models.setName(event.target.value)}
            aria-label="Model name"
            className="w-64 font-medium"
            disabled={current.isSystem}
          />
          {current.isSystem && (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-rcd-border bg-rcd-surface px-2 py-0.5 text-[11px] font-medium text-rcd-text-2 shadow-[var(--rcd-shadow-1)]"
              title="Built-in content managed by the application. Make a copy to edit it."
            >
              <Lock size={11} />
              Built-in
            </span>
          )}
          {dirty && !current.isSystem && (
            <span
              className="h-2 w-2 shrink-0 rounded-full bg-rcd-accent"
              title="Unsaved changes"
              aria-label="Unsaved changes"
            />
          )}
        </div>
        <span className="text-xs text-rcd-muted">{current.dataSourceName}</span>
        <div className="ml-auto flex items-center gap-2">
          {(saveError ?? copyError) && (
            <span
              className="max-w-md truncate text-xs text-[var(--rcd-status-critical)]"
              title={saveError ?? copyError ?? undefined}
            >
              {saveError ?? copyError}
            </span>
          )}
          <RcdButton onClick={() => void handleValidate()} disabled={validating}>
            <ShieldCheck size={14} /> {validating ? 'Validating…' : 'Validate'}
          </RcdButton>
          {current.isSystem ? (
            // Built-in: the server refuses updates ('rcd.model.system_readonly')
            // — the honest affordance is a caller-owned copy.
            <RcdButton variant="primary" onClick={() => void handleMakeCopy()} disabled={copying}>
              <Copy size={14} /> {copying ? 'Copying…' : 'Make a copy'}
            </RcdButton>
          ) : (
            <RcdButton variant="primary" onClick={() => void handleSave()} disabled={saving}>
              <Save size={14} /> {saving ? 'Saving…' : 'Save'}
            </RcdButton>
          )}
        </div>
      </div>

      {validation && (
        <div className="flex items-start gap-3 border-b border-rcd-border bg-rcd-surface px-4 py-2">
          <div className="min-w-0 flex-1">
            {validation.valid && validation.issues.length === 0 ? (
              <div className="flex items-center gap-2 text-sm text-[var(--rcd-status-good)]">
                <CheckCircle2 size={14} /> Model is valid.
              </div>
            ) : (
              <ul className="flex flex-col gap-1">
                {validation.issues.map((issue, index) => (
                  <li key={index} className="flex items-start gap-2 text-xs">
                    {issue.severity === 'error' ? (
                      <AlertTriangle
                        size={13}
                        className="mt-0.5 shrink-0 text-[var(--rcd-status-critical)]"
                      />
                    ) : (
                      <AlertTriangle
                        size={13}
                        className="mt-0.5 shrink-0 text-[var(--rcd-status-warn)]"
                      />
                    )}
                    <span
                      className={
                        issue.severity === 'error'
                          ? 'text-[var(--rcd-status-critical)]'
                          : 'text-[var(--rcd-status-warn)]'
                      }
                    >
                      <span className="font-semibold">{issue.code}</span> {issue.message}
                      {issue.path && <span className="text-rcd-muted"> — {issue.path}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <RcdIconButton onClick={() => setValidation(null)} aria-label="Dismiss validation results">
            <X size={14} />
          </RcdIconButton>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <aside className="w-72 shrink-0 border-r border-rcd-border bg-rcd-surface">
          <SchemaExplorer connection={current.dataSourceName} onAddTable={handleAddTable} />
        </aside>

        <div className="min-w-0 flex-1">
          <ModelCanvas
            definition={current.definition}
            catalog={catalogForModel}
            suggestions={suggestions}
            onMoveTable={handleMoveTable}
            onConnect={handleConnect}
            onEditRelationship={handleEditRelationship}
            onAcceptSuggestion={handleAcceptSuggestion}
            onRemoveTable={handleRemoveTable}
            onDeleteRelationships={handleDeleteRelationships}
            onSetRelationshipActive={handleSetRelationshipActive}
            onSwapRelationship={handleSwapRelationship}
          />
        </div>

        <aside className="flex w-72 shrink-0 flex-col border-l border-rcd-border bg-rcd-surface">
          <div className="min-h-0 flex-1">
            <MeasuresPanel />
          </div>
          <div className="flex max-h-[45%] min-h-0 shrink-0 flex-col border-t border-rcd-border">
            <DateTablesPanel />
          </div>
        </aside>
      </div>

      {editingRelationship && (
        <RelationshipDialog
          key={editingRelationship.id}
          relationship={editingRelationship}
          open
          onClose={() => setEditingRelId(null)}
          onSave={(patch) => {
            models.updateRelationship(editingRelationship.id, {
              cardinality: patch.cardinality,
              isActive: patch.isActive,
            });
            // One-to-many = many-to-one with swapped endpoints (from = many side).
            if (patch.swapEndpoints) models.swapRelationshipDirection(editingRelationship.id);
          }}
          onDelete={() => models.removeRelationship(editingRelationship.id)}
        />
      )}

      <ConfirmDialog
        title="Remove table"
        message={
          removingTable
            ? `Remove ${removingTable} from the model? Its relationships and measures are removed too.`
            : ''
        }
        confirmLabel="Remove"
        danger
        open={removingTable !== null}
        onCancel={() => setRemovingTable(null)}
        onConfirm={() => {
          if (removingTable) models.removeTable(removingTable);
          setRemovingTable(null);
        }}
      />
    </div>
  );
}
