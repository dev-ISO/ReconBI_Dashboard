import { useEffect, useMemo, useState } from 'react';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import {
  isNumericType,
  isQueryableType,
  tableKey,
  type Aggregation,
  type DashboardParameter,
  type DashboardParameterOption,
} from '@recon/dashboards-core';
import { useDashboardState, useModelState, useRuntime } from '../provider/DashboardsProvider';
import { ConfirmDialog, RcdButton, RcdDialog, RcdIconButton, RcdInput, RcdSelect } from '../primitives';

export interface FieldParameterDialogProps {
  open: boolean;
  onClose: () => void;
}

const AGGREGATIONS: { value: Aggregation; label: string }[] = [
  { value: 'sum', label: 'Sum' },
  { value: 'avg', label: 'Average' },
  { value: 'min', label: 'Min' },
  { value: 'max', label: 'Max' },
  { value: 'count', label: 'Count' },
  { value: 'countDistinct', label: 'Count distinct' },
  { value: 'stdDev', label: 'Std dev' },
  { value: 'variance', label: 'Variance' },
  { value: 'median', label: 'Median' },
];

/** Editable option row state (superset of both kinds; compiled on save). */
interface OptionDraft {
  label: string;
  table: string;
  column: string;
  /** measure kind: model measure id ('' = inline aggregation). */
  measureId: string;
  aggregation: Aggregation;
}

interface ParameterDraft {
  id: string | null;
  name: string;
  kind: 'dimension' | 'measure';
  options: OptionDraft[];
  defaultIndex: number;
}

const emptyOption = (): OptionDraft => ({
  label: '',
  table: '',
  column: '',
  measureId: '',
  aggregation: 'sum',
});

const emptyDraft = (): ParameterDraft => ({
  id: null,
  name: '',
  kind: 'dimension',
  options: [emptyOption()],
  defaultIndex: 0,
});

const draftFrom = (parameter: DashboardParameter): ParameterDraft => ({
  id: parameter.id,
  name: parameter.name,
  kind: parameter.kind,
  options: parameter.options.map((option) => ({
    label: option.label,
    table: option.dimension?.table ?? option.measure?.table ?? '',
    column: option.dimension?.column ?? option.measure?.column ?? '',
    measureId: option.measure?.measureId ?? '',
    aggregation: option.measure?.aggregation ?? 'sum',
  })),
  defaultIndex: parameter.defaultIndex ?? 0,
});

/**
 * Manage dialog for dashboard field parameters: lists existing parameters
 * (edit/delete) and hosts the create/edit form — name, kind, and an options
 * list built from model-driven table/column selects (measure options pick an
 * aggregation, or reference a model measure directly).
 */
export function FieldParameterDialog({ open, onClose }: FieldParameterDialogProps) {
  const runtime = useRuntime();
  // Stable fallback — a fresh [] per snapshot would loop useSyncExternalStore.
  const parameters = useDashboardState((state) => state.current?.layout.parameters) ?? [];
  const openModel = useModelState((state) => state.current);
  const catalog = useModelState((state) => state.catalog);

  const [draft, setDraft] = useState<ParameterDraft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<DashboardParameter | null>(null);

  useEffect(() => {
    if (!open) {
      setDraft(null);
      setConfirmDelete(null);
    }
  }, [open]);

  const usableCatalog =
    openModel !== null && catalog !== null && catalog.connection === openModel.dataSourceName
      ? catalog
      : null;

  const tables = useMemo(
    () => (openModel !== null ? openModel.definition.tables.filter((t) => !t.hidden) : []),
    [openModel],
  );

  const modelMeasures = openModel?.definition.measures ?? [];

  const columnsFor = (table: string, numericOnly: boolean) => {
    if (!usableCatalog || table === '') return [];
    const modelTable = tables.find((t) => tableKey(t.schema, t.name) === table);
    const overrides = new Map((modelTable?.columns ?? []).map((c) => [c.name, c]));
    return (usableCatalog.tables.find((t) => t.key === table)?.columns ?? [])
      .filter(
        (c) =>
          isQueryableType(c.type) &&
          (!numericOnly || isNumericType(c.type)) &&
          !overrides.get(c.name)?.hidden,
      )
      .map((c) => ({ name: c.name, label: overrides.get(c.name)?.friendlyName ?? c.name }));
  };

  const patchOption = (index: number, patch: Partial<OptionDraft>) => {
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            options: prev.options.map((option, i) =>
              i === index ? { ...option, ...patch } : option,
            ),
          }
        : prev,
    );
  };

  const optionComplete = (kind: 'dimension' | 'measure', option: OptionDraft): boolean => {
    if (option.label.trim() === '') return false;
    if (kind === 'dimension') return option.table !== '' && option.column !== '';
    return option.measureId !== '' || (option.table !== '' && option.column !== '');
  };

  const canSave =
    draft !== null &&
    draft.name.trim() !== '' &&
    draft.options.length > 0 &&
    draft.options.every((option) => optionComplete(draft.kind, option));

  const handleSave = () => {
    if (!draft || !canSave) return;
    const options: DashboardParameterOption[] = draft.options.map((option) =>
      draft.kind === 'dimension'
        ? {
            label: option.label.trim(),
            dimension: { table: option.table, column: option.column },
          }
        : {
            label: option.label.trim(),
            measure:
              option.measureId !== ''
                ? { measureId: option.measureId }
                : {
                    table: option.table,
                    column: option.column,
                    aggregation: option.aggregation,
                    alias: option.label.trim(),
                  },
          },
    );
    const body = {
      name: draft.name.trim(),
      kind: draft.kind,
      options,
      defaultIndex: Math.min(Math.max(draft.defaultIndex, 0), options.length - 1),
    };
    if (draft.id === null) runtime.dashboards.addParameter(body);
    else runtime.dashboards.updateParameter(draft.id, body);
    setDraft(null);
  };

  return (
    <RcdDialog
      title={draft ? (draft.id === null ? 'New field parameter' : 'Edit field parameter') : 'Field parameters'}
      open={open}
      onClose={onClose}
      footer={
        draft ? (
          <>
            <RcdButton onClick={() => setDraft(null)}>Back</RcdButton>
            <RcdButton variant="primary" disabled={!canSave} onClick={handleSave}>
              {draft.id === null ? 'Create parameter' : 'Save parameter'}
            </RcdButton>
          </>
        ) : (
          <RcdButton onClick={onClose}>Close</RcdButton>
        )
      }
    >
      {draft === null ? (
        <div className="flex flex-col gap-2">
          {parameters.length === 0 ? (
            <p className="text-sm text-rcd-text-2">
              Field parameters let viewers swap the dimension or measure a chart
              plots. Create one, bind charts to it in the chart builder, then add
              a &quot;Field parameter&quot; slicer to drive it.
            </p>
          ) : (
            parameters.map((parameter) => (
              <div
                key={parameter.id}
                className="flex items-center gap-2 rounded-md border border-rcd-border px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-rcd-text">{parameter.name}</p>
                  <p className="truncate text-xs text-rcd-muted">
                    {parameter.kind === 'dimension' ? 'Dimension' : 'Measure'} ·{' '}
                    {parameter.options.map((o) => o.label).join(', ')}
                  </p>
                </div>
                <RcdIconButton
                  aria-label={`Edit parameter ${parameter.name}`}
                  title="Edit"
                  onClick={() => setDraft(draftFrom(parameter))}
                >
                  <Pencil size={14} />
                </RcdIconButton>
                <RcdIconButton
                  aria-label={`Delete parameter ${parameter.name}`}
                  title="Delete"
                  onClick={() => setConfirmDelete(parameter)}
                >
                  <Trash2 size={14} />
                </RcdIconButton>
              </div>
            ))
          )}
          <div>
            <RcdButton onClick={() => setDraft(emptyDraft())}>
              <Plus size={14} />
              New field parameter
            </RcdButton>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm text-rcd-text-2">
            Name
            <RcdInput
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder="e.g. Break down by"
            />
          </label>

          <div className="flex flex-col gap-1 text-sm text-rcd-text-2">
            Kind
            <div className="flex items-center gap-4">
              {(['dimension', 'measure'] as const).map((kind) => (
                <label key={kind} className="flex cursor-pointer items-center gap-1.5 text-sm text-rcd-text">
                  <input
                    type="radio"
                    name="rcd-param-kind"
                    className="accent-[var(--rcd-accent)]"
                    checked={draft.kind === kind}
                    // Kind switches invalidate the field picks, not the labels.
                    onChange={() =>
                      setDraft({
                        ...draft,
                        kind,
                        options: draft.options.map((o) => ({
                          ...o,
                          table: '',
                          column: '',
                          measureId: '',
                        })),
                      })
                    }
                  />
                  {kind === 'dimension' ? 'Dimension (axis)' : 'Measure (values)'}
                </label>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-sm text-rcd-text-2">Options</span>
            {draft.options.map((option, index) => {
              const numericOnly = draft.kind === 'measure';
              const columns = columnsFor(option.table, numericOnly);
              return (
                <div key={index} className="flex flex-col gap-1.5 rounded-md border border-rcd-border p-2">
                  <div className="flex items-center gap-1.5">
                    <RcdInput
                      value={option.label}
                      onChange={(event) => patchOption(index, { label: event.target.value })}
                      placeholder="Option label"
                      aria-label={`Option ${index + 1} label`}
                      className="min-w-0 flex-1"
                    />
                    <label
                      className="flex shrink-0 items-center gap-1 text-xs text-rcd-text-2"
                      title="Selected when the dashboard opens"
                    >
                      <input
                        type="radio"
                        name="rcd-param-default"
                        className="accent-[var(--rcd-accent)]"
                        checked={draft.defaultIndex === index}
                        onChange={() => setDraft({ ...draft, defaultIndex: index })}
                      />
                      Default
                    </label>
                    <RcdIconButton
                      aria-label={`Remove option ${index + 1}`}
                      title="Remove option"
                      disabled={draft.options.length <= 1}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          options: draft.options.filter((_, i) => i !== index),
                          defaultIndex:
                            draft.defaultIndex >= index && draft.defaultIndex > 0
                              ? draft.defaultIndex - 1
                              : draft.defaultIndex,
                        })
                      }
                    >
                      <X size={13} />
                    </RcdIconButton>
                  </div>

                  {draft.kind === 'measure' && modelMeasures.length > 0 && (
                    <RcdSelect
                      aria-label={`Option ${index + 1} model measure`}
                      value={option.measureId}
                      onChange={(event) => {
                        const measureId = event.target.value;
                        const measure = modelMeasures.find((m) => m.id === measureId);
                        patchOption(index, {
                          measureId,
                          ...(measure && option.label.trim() === '' ? { label: measure.name } : {}),
                        });
                      }}
                    >
                      <option value="">Inline aggregation (pick a column below)…</option>
                      {modelMeasures.map((measure) => (
                        <option key={measure.id} value={measure.id}>
                          Model measure: {measure.name}
                        </option>
                      ))}
                    </RcdSelect>
                  )}

                  {(draft.kind === 'dimension' || option.measureId === '') && (
                    <div className="flex items-center gap-1.5">
                      <RcdSelect
                        aria-label={`Option ${index + 1} table`}
                        value={option.table}
                        onChange={(event) =>
                          patchOption(index, { table: event.target.value, column: '' })
                        }
                        className="min-w-0 flex-1"
                      >
                        <option value="">Table…</option>
                        {tables.map((t) => {
                          const key = tableKey(t.schema, t.name);
                          return (
                            <option key={key} value={key}>
                              {t.friendlyName ?? t.name}
                            </option>
                          );
                        })}
                      </RcdSelect>
                      <RcdSelect
                        aria-label={`Option ${index + 1} column`}
                        value={option.column}
                        onChange={(event) => {
                          const column = event.target.value;
                          patchOption(index, {
                            column,
                            ...(option.label.trim() === ''
                              ? { label: columns.find((c) => c.name === column)?.label ?? column }
                              : {}),
                          });
                        }}
                        disabled={option.table === '' || usableCatalog === null}
                        className="min-w-0 flex-1"
                      >
                        <option value="">Column…</option>
                        {columns.map((c) => (
                          <option key={c.name} value={c.name}>
                            {c.label}
                          </option>
                        ))}
                      </RcdSelect>
                      {draft.kind === 'measure' && (
                        <RcdSelect
                          aria-label={`Option ${index + 1} aggregation`}
                          value={option.aggregation}
                          onChange={(event) =>
                            patchOption(index, { aggregation: event.target.value as Aggregation })
                          }
                          className="w-32 shrink-0"
                        >
                          {AGGREGATIONS.map((agg) => (
                            <option key={agg.value} value={agg.value}>
                              {agg.label}
                            </option>
                          ))}
                        </RcdSelect>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            <div>
              <RcdButton
                onClick={() => setDraft({ ...draft, options: [...draft.options, emptyOption()] })}
              >
                <Plus size={14} />
                Add option
              </RcdButton>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        title="Delete field parameter"
        message={
          confirmDelete
            ? `Delete "${confirmDelete.name}"? Charts bound to it fall back to their own fields; slicers driving it stop working.`
            : ''
        }
        confirmLabel="Delete"
        danger
        open={confirmDelete !== null}
        onConfirm={() => {
          if (confirmDelete) runtime.dashboards.removeParameter(confirmDelete.id);
          setConfirmDelete(null);
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </RcdDialog>
  );
}
